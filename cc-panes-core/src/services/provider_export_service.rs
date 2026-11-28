//! 「导出到手机」：把选中的供应商（含密钥）一次性交给已配对的手机（docs/112 §6）。
//!
//! 流程与设备配对同构：桌面生成 6 位一次性导出码（5 分钟有效、最多试 5 次、用一次即作废），
//! 手机凭**设备令牌 + 导出码**兑换。导出码只存摘要，且只活在桌面进程内存里——
//! 兑换由 cc-panes-web 转发到桌面 orchestrator 完成，密钥由桌面主程序读钥匙串
//! （避免另一个可执行文件读同一条目触发 macOS 授权框）。
//!
//! 安全性质：
//! - 码错消耗尝试次数，耗尽即作废；另有全局失败窗口（10 分钟内 10 次）→ 一律 429，
//!   既不消耗尝试次数也不比对码，防止换码暴力枚举。
//! - 审计日志只记来源、供应商 id / 名称与数量，**从不**记码或密钥。
//! - 本服务只在兑换时返回密钥；候选列表（`candidates`）只给「有没有密钥」。

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Result};
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::models::provider::{AccountKind, EndpointKind, Provider, ProviderType};
use crate::services::device_token_service::{constant_time_eq, sha256_hex};
use crate::services::ProviderService;

pub const EXPORT_CODE_TTL_SECS: i64 = 5 * 60;
pub const EXPORT_MAX_ATTEMPTS: u8 = 5;
/// 一次最多导出多少条（防止误选整个列表后一次性带出过多密钥）。
pub const EXPORT_MAX_PROVIDERS: usize = 32;
const FAILURE_WINDOW_SECS: i64 = 10 * 60;
const FAILURE_WINDOW_LIMIT: usize = 10;

const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com/v1";
const GEMINI_OPENAI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/openai";

/// 手机端能直连的协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhoneProtocol {
    /// Anthropic Messages API（`POST {base}/v1/messages`，SSE）。
    Anthropic,
    /// OpenAI 兼容 Chat Completions（`POST {base}/chat/completions`，SSE）。
    OpenaiChat,
}

/// 桌面导出对话框里的一行（不含密钥）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCandidate {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    pub protocol: Option<PhoneProtocol>,
    pub base_url: Option<String>,
    pub model_count: usize,
    pub has_key: bool,
    /// 不可导出的原因：`NO_API_KEY` / `UNSUPPORTED_TYPE`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTicket {
    pub code: String,
    pub expires_at: String,
    pub provider_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub active: bool,
    pub expires_at: Option<String>,
    pub provider_count: usize,
    pub attempts_left: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// 兑换结果里的一条供应商。**含明文密钥**——只经兑换接口出去一次。
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedProvider {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    pub protocol: PhoneProtocol,
    pub base_url: String,
    pub models: Vec<ExportedModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,
    pub api_key: String,
}

impl std::fmt::Debug for ExportedProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExportedProvider")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedProvider {
    pub id: String,
    pub name: String,
    /// `NOT_FOUND` / `NO_API_KEY` / `UNSUPPORTED_TYPE` / `SECRET_UNAVAILABLE`
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub version: u32,
    pub exported_at: String,
    pub providers: Vec<ExportedProvider>,
    pub skipped: Vec<SkippedProvider>,
}

/// 兑换失败的原因；对应 HTTP 状态与错误码见 [`ExportRejection::status_and_code`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportRejection {
    /// 码错（或当前没有进行中的导出——两者不区分，避免成为探测信号）。
    Invalid {
        attempts_left: u8,
    },
    Expired,
    /// 本次导出的尝试次数耗尽，已作废。
    Locked,
    /// 全局失败窗口超限。
    RateLimited,
}

impl ExportRejection {
    pub fn status_and_code(self) -> (u16, &'static str, &'static str) {
        match self {
            Self::Invalid { .. } => (400, "EXPORT_CODE_INVALID", "Export code is invalid"),
            Self::Expired => (410, "EXPORT_CODE_EXPIRED", "Export code has expired"),
            Self::Locked => (
                429,
                "EXPORT_CODE_LOCKED",
                "Too many wrong attempts; export cancelled",
            ),
            Self::RateLimited => (
                429,
                "EXPORT_RATE_LIMITED",
                "Too many failed attempts; try again later",
            ),
        }
    }
}

struct ExportSession {
    code_sha256: String,
    provider_ids: Vec<String>,
    expires_at: DateTime<Utc>,
    attempts_left: u8,
}

#[derive(Default)]
struct ExportState {
    session: Option<ExportSession>,
    failures: VecDeque<DateTime<Utc>>,
}

pub struct ProviderExportService {
    providers: Arc<ProviderService>,
    state: Mutex<ExportState>,
}

impl ProviderExportService {
    pub fn new(providers: Arc<ProviderService>) -> Self {
        Self {
            providers,
            state: Mutex::new(ExportState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ExportState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 导出对话框的候选列表（不读钥匙串，只看「有没有密钥」的标记）。
    pub fn candidates(&self) -> Vec<ExportCandidate> {
        self.providers
            .list_providers_for_display()
            .into_iter()
            .map(|provider| {
                let has_key = provider.default_account().is_some_and(|account| {
                    account.kind == AccountKind::ApiKey && account.has_secret()
                });
                let route = phone_route(&provider);
                let unsupported_reason = if route.is_none() {
                    Some("UNSUPPORTED_TYPE".to_string())
                } else if !has_key {
                    Some("NO_API_KEY".to_string())
                } else {
                    None
                };
                ExportCandidate {
                    id: provider.id.clone(),
                    name: provider.name.clone(),
                    provider_type: provider.provider_type,
                    protocol: route.as_ref().map(|(protocol, _)| *protocol),
                    base_url: route.map(|(_, base)| base),
                    model_count: visible_models(&provider).len(),
                    has_key,
                    unsupported_reason,
                }
            })
            .collect()
    }

    /// 生成导出码（覆盖进行中的旧导出）。
    pub fn start(&self, provider_ids: Vec<String>) -> Result<ExportTicket> {
        self.start_at(provider_ids, Utc::now())
    }

    pub fn start_at(&self, provider_ids: Vec<String>, now: DateTime<Utc>) -> Result<ExportTicket> {
        let mut seen = HashSet::new();
        let ids: Vec<String> = provider_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect();
        if ids.is_empty() {
            bail!("Select at least one provider to export");
        }
        if ids.len() > EXPORT_MAX_PROVIDERS {
            bail!("At most {EXPORT_MAX_PROVIDERS} providers can be exported at once");
        }
        let known: HashSet<String> = self
            .providers
            .list_providers_for_display()
            .into_iter()
            .map(|provider| provider.id)
            .collect();
        if let Some(missing) = ids.iter().find(|id| !known.contains(*id)) {
            bail!("Provider '{missing}' not found");
        }
        let code = format!("{:06}", OsRng.next_u32() % 1_000_000);
        let expires_at = now + Duration::seconds(EXPORT_CODE_TTL_SECS);
        let count = ids.len();
        self.lock().session = Some(ExportSession {
            code_sha256: sha256_hex(&code),
            provider_ids: ids,
            expires_at,
            attempts_left: EXPORT_MAX_ATTEMPTS,
        });
        info!(
            target: "cc_panes::audit",
            providers = count,
            "[provider-export] export code created"
        );
        Ok(ExportTicket {
            code,
            expires_at: expires_at.to_rfc3339(),
            provider_count: count,
        })
    }

    pub fn cancel(&self) {
        self.lock().session = None;
    }

    pub fn status(&self) -> ExportStatus {
        let now = Utc::now();
        let state = self.lock();
        match state.session.as_ref() {
            Some(session) if session.expires_at > now && session.attempts_left > 0 => {
                ExportStatus {
                    active: true,
                    expires_at: Some(session.expires_at.to_rfc3339()),
                    provider_count: session.provider_ids.len(),
                    attempts_left: session.attempts_left,
                }
            }
            _ => ExportStatus {
                active: false,
                expires_at: None,
                provider_count: 0,
                attempts_left: 0,
            },
        }
    }

    /// 兑换导出码。`origin` 是 web 层核实过的来源（`device:<设备名>`），只用于审计日志。
    pub fn redeem(&self, code: &str, origin: &str) -> Result<ExportPayload, ExportRejection> {
        self.redeem_at(code, origin, Utc::now())
    }

    pub fn redeem_at(
        &self,
        code: &str,
        origin: &str,
        now: DateTime<Utc>,
    ) -> Result<ExportPayload, ExportRejection> {
        let provider_ids = {
            let mut state = self.lock();
            let window_start = now - Duration::seconds(FAILURE_WINDOW_SECS);
            while state.failures.front().is_some_and(|at| *at <= window_start) {
                state.failures.pop_front();
            }
            if state.failures.len() >= FAILURE_WINDOW_LIMIT {
                warn!(target: "cc_panes::audit", origin, "[provider-export] redeem rate limited");
                return Err(ExportRejection::RateLimited);
            }
            let rejection = match state.session.as_mut() {
                None => Some(ExportRejection::Invalid { attempts_left: 0 }),
                Some(session) if session.attempts_left == 0 => Some(ExportRejection::Locked),
                Some(session) if session.expires_at <= now => Some(ExportRejection::Expired),
                Some(session) => {
                    let digest = sha256_hex(code.trim());
                    if constant_time_eq(session.code_sha256.as_bytes(), digest.as_bytes()) {
                        None
                    } else {
                        session.attempts_left -= 1;
                        Some(if session.attempts_left == 0 {
                            ExportRejection::Locked
                        } else {
                            ExportRejection::Invalid {
                                attempts_left: session.attempts_left,
                            }
                        })
                    }
                }
            };
            if let Some(rejection) = rejection {
                state.failures.push_back(now);
                if matches!(
                    rejection,
                    ExportRejection::Locked | ExportRejection::Expired
                ) {
                    state.session = None;
                }
                warn!(
                    target: "cc_panes::audit",
                    origin,
                    reason = ?rejection,
                    "[provider-export] redeem rejected"
                );
                return Err(rejection);
            }
            // 成功：立即作废（单次使用），再在锁外读钥匙串。
            state
                .session
                .take()
                .map(|session| session.provider_ids)
                .unwrap_or_default()
        };
        let payload = self.build_payload(&provider_ids, now);
        let names: Vec<&str> = payload.providers.iter().map(|p| p.name.as_str()).collect();
        info!(
            target: "cc_panes::audit",
            origin,
            exported = payload.providers.len(),
            skipped = payload.skipped.len(),
            providers = ?names,
            "[provider-export] providers exported to device"
        );
        Ok(payload)
    }

    fn build_payload(&self, provider_ids: &[String], now: DateTime<Utc>) -> ExportPayload {
        let mut providers = Vec::new();
        let mut skipped = Vec::new();
        for id in provider_ids {
            let Some(provider) = self.providers.get_provider(id) else {
                skipped.push(SkippedProvider {
                    id: id.clone(),
                    name: id.clone(),
                    reason: "NOT_FOUND".into(),
                });
                continue;
            };
            let skip = |reason: &str| SkippedProvider {
                id: provider.id.clone(),
                name: provider.name.clone(),
                reason: reason.into(),
            };
            let Some((protocol, base_url)) = phone_route(&provider) else {
                skipped.push(skip("UNSUPPORTED_TYPE"));
                continue;
            };
            let api_key = match self.providers.resolve_api_credentials(id, None) {
                Ok(credentials) => credentials.api_key.filter(|key| !key.trim().is_empty()),
                Err(error) => {
                    warn!(provider_id = %id, error = %error, "[provider-export] failed to read provider secret");
                    skipped.push(skip("SECRET_UNAVAILABLE"));
                    continue;
                }
            };
            let Some(api_key) = api_key else {
                skipped.push(skip("NO_API_KEY"));
                continue;
            };
            let models = visible_models(&provider);
            let default_model_id = provider
                .default_model_id
                .clone()
                .filter(|id| !id.trim().is_empty())
                .or_else(|| models.first().map(|model| model.id.clone()));
            providers.push(ExportedProvider {
                id: provider.id.clone(),
                name: provider.name.clone(),
                provider_type: provider.provider_type,
                protocol,
                base_url,
                models,
                default_model_id,
                api_key,
            });
        }
        ExportPayload {
            version: 1,
            exported_at: now.to_rfc3339(),
            providers,
            skipped,
        }
    }
}

fn visible_models(provider: &Provider) -> Vec<ExportedModel> {
    provider
        .models
        .iter()
        .filter(|model| !model.hidden && !model.id.trim().is_empty())
        .map(|model| ExportedModel {
            id: model.id.trim().to_string(),
            label: model.label.clone().filter(|label| !label.trim().is_empty()),
        })
        .collect()
}

/// 手机端用哪种协议、哪个根地址直连这条供应商。走不了直连的类型（云厂商签名、登录态、
/// Cursor 等）返回 `None`。
///
/// 地址约定：Anthropic 取**根地址**（手机拼 `/v1/messages`）；OpenAI 兼容取 `/v1` 级地址
/// （手机拼 `/chat/completions`）。
pub fn phone_route(provider: &Provider) -> Option<(PhoneProtocol, String)> {
    let endpoints = &provider.endpoints;
    let anthropic = || {
        Some((
            PhoneProtocol::Anthropic,
            endpoints
                .get(EndpointKind::Anthropic)
                .unwrap_or(ANTHROPIC_DEFAULT_BASE)
                .trim_end_matches('/')
                .to_string(),
        ))
    };
    let openai = |fallback: Option<&str>| {
        endpoints
            .get(EndpointKind::Chat)
            .or_else(|| endpoints.get(EndpointKind::Responses))
            .or(fallback)
            .map(|base| {
                (
                    PhoneProtocol::OpenaiChat,
                    base.trim_end_matches('/').to_string(),
                )
            })
    };
    match provider.provider_type {
        ProviderType::Anthropic | ProviderType::Proxy | ProviderType::LocalGateway => anthropic(),
        ProviderType::OpenAI => openai(Some(OPENAI_DEFAULT_BASE)),
        ProviderType::Gemini => openai(Some(GEMINI_OPENAI_BASE)),
        ProviderType::Kimi | ProviderType::OpenCode | ProviderType::Grok => {
            // 填了 Anthropic 接口也能走（不少中转同时给两种）；优先 Chat。
            openai(None).or_else(|| {
                endpoints
                    .get(EndpointKind::Anthropic)
                    .and_then(|_| anthropic())
            })
        }
        ProviderType::Bedrock
        | ProviderType::Vertex
        | ProviderType::ConfigProfile
        | ProviderType::Cursor => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::{ProviderEndpoints, ProviderModel};

    fn service() -> (Arc<ProviderService>, ProviderExportService) {
        let dir = std::env::temp_dir().join(format!("ccp-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let providers = Arc::new(ProviderService::new(dir.join("providers.json")));
        let export = ProviderExportService::new(providers.clone());
        (providers, export)
    }

    fn provider(id: &str, provider_type: ProviderType, key: Option<&str>) -> Provider {
        Provider {
            id: id.into(),
            name: format!("{id}-name"),
            provider_type,
            api_key: key.map(str::to_string),
            models: vec![
                ProviderModel {
                    id: "model-a".into(),
                    label: Some("A".into()),
                    ..Default::default()
                },
                ProviderModel {
                    id: "model-hidden".into(),
                    hidden: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn fixture() -> (Arc<ProviderService>, ProviderExportService) {
        let (providers, export) = service();
        let mut relay = provider("relay", ProviderType::Proxy, Some("sk-relay-secret"));
        relay.endpoints = ProviderEndpoints {
            anthropic: Some("https://relay.example.com/".into()),
            ..Default::default()
        };
        providers.add_provider(relay).unwrap();
        let mut openai = provider("oai", ProviderType::OpenAI, Some("sk-oai-secret"));
        openai.endpoints = ProviderEndpoints {
            chat: Some("https://oai.example.com/v1".into()),
            ..Default::default()
        };
        providers.add_provider(openai).unwrap();
        providers
            .add_provider(provider("nokey", ProviderType::Anthropic, None))
            .unwrap();
        providers
            .add_provider(provider("bed", ProviderType::Bedrock, Some("x")))
            .unwrap();
        (providers, export)
    }

    #[test]
    fn candidates_never_carry_keys_and_flag_unsupported() {
        let (_p, export) = fixture();
        let candidates = export.candidates();
        let json = serde_json::to_string(&candidates).unwrap();
        assert!(!json.contains("sk-relay-secret") && !json.contains("sk-oai-secret"));
        let by_id = |id: &str| candidates.iter().find(|c| c.id == id).unwrap().clone();
        assert_eq!(by_id("relay").protocol, Some(PhoneProtocol::Anthropic));
        assert_eq!(
            by_id("relay").base_url.as_deref(),
            Some("https://relay.example.com")
        );
        assert_eq!(by_id("relay").model_count, 1);
        assert!(by_id("relay").has_key);
        assert_eq!(
            by_id("nokey").unsupported_reason.as_deref(),
            Some("NO_API_KEY")
        );
        assert_eq!(
            by_id("bed").unsupported_reason.as_deref(),
            Some("UNSUPPORTED_TYPE")
        );
    }

    #[test]
    fn redeem_returns_selected_providers_with_keys_once() {
        let (_p, export) = fixture();
        let ticket = export
            .start(vec![
                "relay".into(),
                "oai".into(),
                "nokey".into(),
                "bed".into(),
            ])
            .unwrap();
        assert_eq!(ticket.code.len(), 6);
        assert!(export.status().active);
        let payload = export.redeem(&ticket.code, "device:phone").unwrap();
        assert_eq!(payload.providers.len(), 2);
        let relay = &payload.providers[0];
        assert_eq!(relay.api_key, "sk-relay-secret");
        assert_eq!(relay.protocol, PhoneProtocol::Anthropic);
        assert_eq!(relay.default_model_id.as_deref(), Some("model-a"));
        assert_eq!(relay.models.len(), 1);
        assert_eq!(payload.providers[1].protocol, PhoneProtocol::OpenaiChat);
        assert_eq!(payload.providers[1].base_url, "https://oai.example.com/v1");
        let reasons: Vec<_> = payload.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert_eq!(reasons, ["NO_API_KEY", "UNSUPPORTED_TYPE"]);
        // 单次使用
        assert_eq!(
            export.redeem(&ticket.code, "device:phone").unwrap_err(),
            ExportRejection::Invalid { attempts_left: 0 }
        );
        assert!(!export.status().active);
        // Debug 不泄露密钥
        assert!(!format!("{relay:?}").contains("sk-relay"));
    }

    #[test]
    fn wrong_codes_burn_attempts_then_lock() {
        let (_p, export) = fixture();
        let ticket = export.start(vec!["relay".into()]).unwrap();
        let wrong = if ticket.code == "000000" {
            "111111"
        } else {
            "000000"
        };
        for left in (1..EXPORT_MAX_ATTEMPTS).rev() {
            assert_eq!(
                export.redeem(wrong, "device:x").unwrap_err(),
                ExportRejection::Invalid {
                    attempts_left: left
                }
            );
        }
        assert_eq!(
            export.redeem(wrong, "device:x").unwrap_err(),
            ExportRejection::Locked
        );
        // 作废后正确码也不行
        assert!(export.redeem(&ticket.code, "device:x").is_err());
    }

    #[test]
    fn expired_code_is_rejected() {
        let (_p, export) = fixture();
        let start = Utc::now();
        let ticket = export.start_at(vec!["relay".into()], start).unwrap();
        let late = start + Duration::seconds(EXPORT_CODE_TTL_SECS + 1);
        assert_eq!(
            export
                .redeem_at(&ticket.code, "device:x", late)
                .unwrap_err(),
            ExportRejection::Expired
        );
    }

    #[test]
    fn global_failure_window_rate_limits_even_fresh_codes() {
        let (_p, export) = fixture();
        let now = Utc::now();
        for _ in 0..FAILURE_WINDOW_LIMIT {
            let _ = export.redeem_at("123456", "device:x", now);
        }
        let ticket = export.start_at(vec!["relay".into()], now).unwrap();
        assert_eq!(
            export.redeem_at(&ticket.code, "device:x", now).unwrap_err(),
            ExportRejection::RateLimited
        );
        // 窗口过后恢复
        let later = now + Duration::seconds(FAILURE_WINDOW_SECS + 1);
        let fresh = export.start_at(vec!["relay".into()], later).unwrap();
        assert!(export.redeem_at(&fresh.code, "device:x", later).is_ok());
    }

    #[test]
    fn start_validates_selection() {
        let (_p, export) = fixture();
        assert!(export.start(vec![]).is_err());
        assert!(export.start(vec!["missing".into()]).is_err());
        let many = (0..=EXPORT_MAX_PROVIDERS)
            .map(|i| format!("p{i}"))
            .collect();
        assert!(export.start(many).is_err());
    }
}
