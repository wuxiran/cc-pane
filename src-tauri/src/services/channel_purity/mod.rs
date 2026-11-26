//! 中转纯度检测：对一条供应商的每个型号跑注入 / 复述 / 钓鱼 / 自报四个探针，给出结论和证据。
//!
//! - 一次只跑一个检测任务（后台），界面轮询 [`ChannelPurityService::status`]；
//! - 密钥只在内存里用：从钥匙串读出来直接放进请求头，不进日志、不进报告；
//! - 报告存在 `<data_dir>/channel-purity.json`，每条供应商保留最近一次；
//!   里面有模型回复的片段（最多 600 字），没有密钥。

pub mod client;
pub mod judge;

use crate::services::ProviderService;
use cc_panes_core::models::provider::{AccountKind, EndpointKind, Provider, ProviderType};
use client::{Probe, ProbeClient, ProbeReply, Protocol};
use judge::{Finding, FindingCode, FishingOutcome, Verdict};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 没配型号、只能从 `/models` 拉的时候，最多测几个。
const MAX_LISTED_MODELS: usize = 8;
/// 两次请求之间的间隔，防限流。
const REQUEST_GAP: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReport {
    pub model: String,
    pub verdict: Verdict,
    /// 空 system + `hi` 的输入 token 合计。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    /// 自报的型号（仅 Claude）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_report: Option<String>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurityReport {
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub protocol: Protocol,
    /// 只留主机名，便于核对测的是哪个中转。
    pub host: String,
    /// RFC 3339。
    pub checked_at: String,
    pub verdict: Verdict,
    pub models: Vec<ModelReport>,
    /// 供应商级的证据（整批掺假）。
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStage {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurityJob {
    pub provider_id: String,
    pub stage: JobStage,
    pub done: usize,
    pub total: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurityStatus {
    pub job: Option<PurityJob>,
    pub reports: Vec<PurityReport>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    reports: BTreeMap<String, PurityReport>,
}

struct Running {
    job: PurityJob,
    cancel: Arc<AtomicBool>,
}

pub struct ChannelPurityService {
    path: PathBuf,
    state: Mutex<Option<Running>>,
    store: Mutex<Store>,
    gap: Duration,
}

/// 这条供应商用哪种接口检测、地址是什么。不支持的类型返回错误说明。
pub fn target_of(provider: &Provider) -> Result<(Protocol, String), &'static str> {
    let (protocol, kind) = match provider.provider_type {
        ProviderType::Anthropic | ProviderType::Proxy | ProviderType::LocalGateway => {
            (Protocol::Anthropic, EndpointKind::Anthropic)
        }
        ProviderType::OpenAI => {
            if provider
                .effective_codex_wire_api()
                .is_some_and(|wire| wire.eq_ignore_ascii_case("chat"))
            {
                (Protocol::Chat, EndpointKind::Chat)
            } else {
                (Protocol::Responses, EndpointKind::Responses)
            }
        }
        _ => return Err("PURITY_UNSUPPORTED_TYPE"),
    };
    let url = provider
        .endpoints
        .get(kind)
        .or_else(|| match kind {
            EndpointKind::Responses => provider.endpoints.get(EndpointKind::Chat),
            EndpointKind::Chat => provider.endpoints.get(EndpointKind::Responses),
            _ => None,
        })
        .ok_or("PURITY_NO_ENDPOINT")?;
    Ok((protocol, url.to_string()))
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default()
}

/// 要测的型号：配好的型号 → 默认型号 → 从 `/models` 拉（按系列过滤，最多 8 个）。
fn configured_models(provider: &Provider) -> Vec<String> {
    let mut models: Vec<String> = provider
        .models
        .iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if models.is_empty() {
        if let Some(id) = provider.default_model_id.as_deref().map(str::trim) {
            if !id.is_empty() {
                models.push(id.to_string());
            }
        }
    }
    models.dedup();
    models
}

fn listed_models(protocol: Protocol, listed: Vec<String>) -> Vec<String> {
    let mut models: Vec<String> = listed
        .into_iter()
        .filter(|id| {
            let lower = id.to_lowercase();
            match protocol {
                Protocol::Anthropic => lower.contains("claude"),
                Protocol::Responses | Protocol::Chat => lower.contains("gpt"),
            }
        })
        .collect();
    models.sort();
    models.dedup();
    models.truncate(MAX_LISTED_MODELS);
    models
}

fn probes_per_model(protocol: Protocol) -> usize {
    match protocol {
        Protocol::Anthropic => 4,
        Protocol::Responses | Protocol::Chat => 3,
    }
}

fn request_failed(probe: &str, detail: impl std::fmt::Display) -> Finding {
    Finding::new(
        FindingCode::RequestFailed,
        Some(judge::excerpt(&format!("{probe}: {detail}"))),
    )
}

fn reply_failure(probe: &str, reply: &ProbeReply) -> Finding {
    request_failed(
        probe,
        format!(
            "HTTP {} {}",
            reply.status,
            reply.error_text.as_deref().unwrap_or("")
        ),
    )
}

impl ChannelPurityService {
    pub fn new(data_dir: PathBuf) -> Self {
        let path = data_dir.join("channel-purity.json");
        let store = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(None),
            store: Mutex::new(store),
            gap: REQUEST_GAP,
        }
    }

    pub fn status(&self) -> PurityStatus {
        let job = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|running| running.job.clone());
        let reports = self
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reports
            .values()
            .cloned()
            .collect();
        PurityStatus { job, reports }
    }

    pub fn cancel(&self) {
        if let Some(running) = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            running.cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn forget(&self, provider_id: &str) {
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if store.reports.remove(provider_id).is_some() {
            self.save(&store);
        }
    }

    fn save(&self, store: &Store) {
        match serde_json::to_string_pretty(store) {
            Ok(raw) => {
                if let Err(error) = std::fs::write(&self.path, raw) {
                    tracing::warn!(error = %error, "[purity] failed to save reports");
                }
            }
            Err(error) => tracing::warn!(error = %error, "[purity] failed to encode reports"),
        }
    }

    fn update_job(&self, update: impl FnOnce(&mut PurityJob)) {
        if let Some(running) = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            update(&mut running.job);
        }
    }

    /// 开始检测一条供应商（用它的默认账号，或指定账号）。已有任务在跑时报错。
    pub fn start(
        self: &Arc<Self>,
        providers: &Arc<ProviderService>,
        provider_id: &str,
        account_id: Option<&str>,
    ) -> Result<(), String> {
        let provider = providers
            .get_provider(provider_id)
            .ok_or_else(|| "PURITY_PROVIDER_NOT_FOUND".to_string())?;
        let account = provider
            .account(account_id)
            .cloned()
            .ok_or_else(|| "PURITY_NO_ACCOUNT".to_string())?;
        if account.kind == AccountKind::Login {
            return Err("PURITY_LOGIN_ACCOUNT".to_string());
        }
        let (protocol, base) = target_of(&provider).map_err(str::to_string)?;
        let credentials = providers
            .resolve_api_credentials(provider_id, Some(&account.id))
            .map_err(|error| error.to_string())?;
        let key = credentials
            .api_key
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| "PURITY_NO_KEY".to_string())?;

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state
                .as_ref()
                .is_some_and(|running| running.job.stage == JobStage::Running)
            {
                return Err("PURITY_BUSY".to_string());
            }
            *state = Some(Running {
                job: PurityJob {
                    provider_id: provider_id.to_string(),
                    stage: JobStage::Running,
                    done: 0,
                    total: 0,
                    current_model: None,
                    error: None,
                },
                cancel: Arc::clone(&cancel),
            });
        }

        let service = Arc::clone(self);
        let models = configured_models(&provider);
        let provider_id = provider_id.to_string();
        let account_id = Some(account.id.clone());
        tracing::info!(provider_id = %provider_id, protocol = ?protocol, "[purity] check started");
        tauri::async_runtime::spawn(async move {
            let client = ProbeClient::new(protocol, &base, &key);
            drop(key);
            let models = if models.is_empty() {
                listed_models(protocol, client.list_models().await)
            } else {
                models
            };
            let outcome = if models.is_empty() {
                Err("PURITY_NO_MODELS".to_string())
            } else {
                service
                    .run(&client, &models, &cancel)
                    .await
                    .map(|(models, findings)| {
                        let verdict = models
                            .iter()
                            .fold(Verdict::Inconclusive, |acc, model| acc.worst(model.verdict));
                        let verdict = findings
                            .iter()
                            .fold(verdict, |acc, finding| acc.worst(finding.verdict()));
                        PurityReport {
                            provider_id: provider_id.clone(),
                            account_id,
                            protocol,
                            host: host_of(&base),
                            checked_at: chrono::Utc::now().to_rfc3339(),
                            verdict,
                            models,
                            findings,
                        }
                    })
            };
            match outcome {
                Ok(report) => {
                    tracing::info!(provider_id = %provider_id, verdict = ?report.verdict, "[purity] check finished");
                    {
                        let mut store = service.store.lock().unwrap_or_else(|e| e.into_inner());
                        store.reports.insert(provider_id.clone(), report);
                        service.save(&store);
                    }
                    service.update_job(|job| {
                        job.stage = JobStage::Done;
                        job.current_model = None;
                    });
                }
                Err(error) if error == "PURITY_CANCELLED" => {
                    service.update_job(|job| {
                        job.stage = JobStage::Cancelled;
                        job.current_model = None;
                    });
                }
                Err(error) => {
                    tracing::warn!(provider_id = %provider_id, error = %error, "[purity] check failed");
                    service.update_job(|job| {
                        job.stage = JobStage::Error;
                        job.current_model = None;
                        job.error = Some(error);
                    });
                }
            }
        });
        Ok(())
    }

    async fn run(
        &self,
        client: &ProbeClient,
        models: &[String],
        cancel: &AtomicBool,
    ) -> Result<(Vec<ModelReport>, Vec<Finding>), String> {
        let protocol = client.protocol();
        let per_model = probes_per_model(protocol);
        self.update_job(|job| job.total = models.len() * per_model);

        let mut reports = Vec::with_capacity(models.len());
        let mut identity_checked = 0usize;
        let mut identity_mismatched = 0usize;
        let mut step = 0usize;

        for model in models {
            self.update_job(|job| job.current_model = Some(model.clone()));
            let mut findings = Vec::new();
            let mut any_success = false;
            let mut prompt_tokens = None;
            let mut self_report = None;

            // 每个探针前检查取消，跑完推进进度。
            macro_rules! next_probe {
                () => {{
                    if cancel.load(Ordering::SeqCst) {
                        return Err("PURITY_CANCELLED".to_string());
                    }
                    if step > 0 {
                        tokio::time::sleep(self.gap).await;
                    }
                }};
            }
            macro_rules! done_probe {
                () => {{
                    step += 1;
                    let done = step;
                    self.update_job(|job| job.done = done);
                }};
            }

            // 1. 注入：空 system + hi，看输入 token。
            next_probe!();
            let probe = Probe {
                user: "hi".to_string(),
                max_tokens: 5,
                ..Probe::default()
            };
            match client.send(model, &probe).await {
                Ok(reply) if reply.ok() => {
                    any_success = true;
                    if let Some(tokens) = reply.usage().and_then(judge::prompt_tokens) {
                        prompt_tokens = Some(tokens);
                        findings.extend(judge::judge_hidden_prefix(tokens));
                    }
                    findings.extend(judge::judge_nonstandard_fields(&reply.body));
                    findings.extend(judge::judge_response_model(model, &reply.body));
                }
                Ok(reply) => {
                    findings.extend(judge::judge_nonstandard_fields(&reply.body));
                    findings.push(reply_failure("hi", &reply));
                }
                Err(error) => findings.push(request_failed("hi", error)),
            }
            done_probe!();

            // 2. 复述上下文开头，抓被塞的提示词原文。
            next_probe!();
            let probe = Probe {
                user: judge::ECHO_PROMPT.to_string(),
                max_tokens: 500,
                ..Probe::default()
            };
            match client.send(model, &probe).await {
                Ok(reply) if reply.ok() => {
                    any_success = true;
                    findings.extend(judge::judge_echo(&reply.text(protocol)));
                }
                Ok(reply) => findings.push(reply_failure("echo", &reply)),
                Err(error) => findings.push(request_failed("echo", error)),
            }
            done_probe!();

            // 3. 身份钓鱼。Claude 先带新版参数，被 400 拒时记下错误特征再降级重试。
            next_probe!();
            let mut probe = Probe {
                system: Some(judge::FISHING_SYSTEM.to_string()),
                user: judge::fishing_user_prompt(protocol.family()),
                max_tokens: 1024,
                new_params: protocol == Protocol::Anthropic,
            };
            let mut reply = client.send(model, &probe).await;
            if let Ok(rejected) = &reply {
                if probe.new_params && rejected.status == 400 {
                    findings.push(judge::judge_new_params_rejection(
                        rejected.error_text.as_deref().unwrap_or(""),
                    ));
                    findings.extend(judge::judge_nonstandard_fields(&rejected.body));
                    probe.new_params = false;
                    tokio::time::sleep(self.gap).await;
                    reply = client.send(model, &probe).await;
                }
            }
            match reply {
                Ok(reply) if reply.ok() => {
                    any_success = true;
                    let text = reply.text(protocol);
                    match judge::judge_fishing(&text) {
                        FishingOutcome::Admitted => findings.push(Finding::new(
                            FindingCode::FishingAdmitted,
                            Some(judge::excerpt(&text)),
                        )),
                        FishingOutcome::Unclear => findings.push(Finding::new(
                            FindingCode::FishingUnclear,
                            Some(judge::excerpt(&text)),
                        )),
                        FishingOutcome::Denied => {}
                    }
                }
                Ok(reply) => findings.push(reply_failure("fishing", &reply)),
                Err(error) => findings.push(request_failed("fishing", error)),
            }
            done_probe!();

            // 4. 自报型号（只对 Claude 有意义：GPT 自报不可靠，不判）。
            if protocol == Protocol::Anthropic {
                next_probe!();
                let probe = Probe {
                    user: judge::IDENTITY_PROMPT.to_string(),
                    max_tokens: 400,
                    ..Probe::default()
                };
                match client.send(model, &probe).await {
                    Ok(reply) if reply.ok() => {
                        any_success = true;
                        let text = reply.text(protocol);
                        if judge::claude_family(model).is_some()
                            && judge::claude_family(&text).is_some()
                        {
                            identity_checked += 1;
                            if let Some(mismatch) = judge::judge_self_report(model, &text) {
                                identity_mismatched += 1;
                                findings.push(mismatch);
                            }
                        }
                        if !text.trim().is_empty() {
                            self_report = Some(judge::excerpt(&text));
                        }
                    }
                    Ok(reply) => findings.push(reply_failure("identity", &reply)),
                    Err(error) => findings.push(request_failed("identity", error)),
                }
                done_probe!();
            }

            let verdict = judge::verdict_of(&findings, any_success);
            reports.push(ModelReport {
                model: model.clone(),
                verdict,
                prompt_tokens,
                self_report,
                findings,
            });
        }

        let batch = judge::judge_batch(identity_checked, identity_mismatched)
            .into_iter()
            .collect();
        Ok((reports, batch))
    }
}

#[cfg(test)]
mod tests;
