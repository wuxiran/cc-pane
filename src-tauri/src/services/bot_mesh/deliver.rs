//! 投递到本机 Bot：校验（共享 / hops / traceId）→ 受理并立即回执 → 后台跑一轮，
//! 期间按远程策略处理审批，结果写进 inbound 记录供轮询。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use super::policy::{self, PolicyAction, RemotePolicy};
use super::records::{MeshError, MeshFrom, MeshMessage, MeshMessageStatus, PendingPermission};
use super::{trace, BotMeshService};
use crate::services::bot_service::{
    bot_chat_id, is_own_external_prompt, BotMessageOrigin, ExternalTurnOptions,
};
use crate::utils::{AppError, AppResult};

/// 同时在途的远程投递上限（超出 429 `MESH_BUSY`）。
const MAX_INFLIGHT: usize = 32;
const TEXT_MAX: usize = 100_000;

/// `POST /api/bots/{id}/messages` 的请求体。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRequest {
    pub text: String,
    #[serde(default)]
    pub prompt_id: Option<String>,
    /// 缺省 = 新对话（服务端生成）。
    #[serde(default)]
    pub trace_id: Option<String>,
    /// 缺省 = 0（人发起）。
    #[serde(default)]
    pub hops: Option<u32>,
    #[serde(default)]
    pub from: MeshFrom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeliverAck {
    pub chat_id: String,
    pub prompt_id: String,
    pub trace_id: String,
    pub hops: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<RemotePolicy>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub duplicate: bool,
}

/// 来源是否算「远程」（远程策略生效）：设备令牌与 Cookie 网页会话。
pub fn is_remote_origin(origin: &str) -> bool {
    origin == "mobile" || origin.starts_with("device:")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl BotMeshService {
    /// 受理一条发给本机 Bot 的消息。`origin` 是权威来源（web 依设备令牌填写，
    /// 本机调用方填 `desktop` / `bot:<id>`）。
    pub async fn deliver(
        self: &Arc<Self>,
        bot_id: &str,
        request: InboundRequest,
        origin: String,
    ) -> AppResult<DeliverAck> {
        let text = request.text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::coded(
                "ACP_PROMPT_REQUIRED",
                "text cannot be empty",
            ));
        }
        if text.chars().count() > TEXT_MAX {
            return Err(AppError::coded("MESH_BAD_REQUEST", "text is too long"));
        }
        let bot = self
            .bots
            .get(bot_id)
            .map_err(|_| AppError::coded("BOT_NOT_FOUND", format!("Bot not found: {bot_id}")))?;
        let remote = is_remote_origin(&origin);
        if remote && !bot.remote_shared {
            return Err(AppError::coded(
                "BOT_REMOTE_DENIED",
                "This bot does not accept messages from other devices",
            ));
        }
        let prompt_id = request
            .prompt_id
            .filter(|id| !id.trim().is_empty() && id.len() <= 128)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let chat_id = bot_chat_id(&bot.id);
        // 网络重试幂等：同一 promptId 已受理过就回原回执。
        if let Some(existing) = self.inbound.get(&prompt_id) {
            if existing.bot_id == bot.id {
                return Ok(DeliverAck {
                    chat_id,
                    prompt_id,
                    trace_id: existing.trace_id,
                    hops: existing.hops,
                    policy: existing.policy,
                    duplicate: true,
                });
            }
        }
        let hops = request.hops.unwrap_or(0);
        trace::check_hops(hops)?;
        let trace_id = match request.trace_id.filter(|t| !t.is_empty()) {
            Some(trace_id) if trace::valid_trace_id(&trace_id) => trace_id,
            Some(_) => return Err(AppError::coded("MESH_BAD_REQUEST", "traceId is invalid")),
            None => trace::new_trace_id(),
        };
        if self.inbound.count_where(|m| !m.status.is_terminal()) >= MAX_INFLIGHT {
            return Err(AppError::coded(
                "MESH_BUSY",
                "Too many bot messages in flight; retry later",
            ));
        }
        self.guard.enter(&trace_id, &bot.id)?;
        let policy = remote
            .then(|| policy::effective_policy(bot.remote_policy, origin.starts_with("device:")));
        let record = MeshMessage {
            prompt_id: prompt_id.clone(),
            trace_id: trace_id.clone(),
            hops,
            bot_id: bot.id.clone(),
            chat_id: chat_id.clone(),
            status: MeshMessageStatus::Queued,
            policy,
            origin: origin.clone(),
            from: request.from.clone(),
            reply: None,
            error: None,
            pending_permissions: Vec::new(),
            created_at: now_ms(),
            finished_at: None,
        };
        self.inbound.insert(prompt_id.clone(), record);
        info!(bot = %bot.id, trace = %trace_id, hops, origin = %origin, policy = ?policy, "bot mesh: message accepted");
        let this = self.clone();
        let job = InboundJob {
            bot_id: bot.id.clone(),
            allow_kinds: bot.remote_allow_kinds.clone(),
            prompt_id: prompt_id.clone(),
            trace_id: trace_id.clone(),
            hops,
            text,
            origin,
            from: request.from,
            policy,
        };
        tauri::async_runtime::spawn(async move { this.run_inbound(job).await });
        Ok(DeliverAck {
            chat_id,
            prompt_id,
            trace_id,
            hops,
            policy,
            duplicate: false,
        })
    }

    pub fn inbound_message(&self, bot_id: &str, prompt_id: &str) -> AppResult<MeshMessage> {
        self.inbound
            .get(prompt_id)
            .filter(|m| m.bot_id == bot_id)
            .ok_or_else(|| {
                AppError::coded(
                    "MESH_MESSAGE_NOT_FOUND",
                    "No such message (expired or never delivered here)",
                )
            })
    }

    async fn run_inbound(self: Arc<Self>, job: InboundJob) {
        let chat_id = bot_chat_id(&job.bot_id);
        // 先订阅再提交：审批事件一个不漏。
        let events = self.acp.subscribe_chat(&chat_id);
        let enforcer = tauri::async_runtime::spawn(self.clone().enforce(
            events,
            chat_id.clone(),
            job.prompt_id.clone(),
            job.policy,
            job.allow_kinds.clone(),
        ));
        self.set_active_trace(&job.bot_id, Some((job.trace_id.clone(), job.hops)));
        let options = ExternalTurnOptions {
            prompt_origin: Some(job.origin.clone()),
            auto_approve_override: job
                .policy
                .map(|p| policy::remote_auto_approve_kinds(p, &job.allow_kinds)),
            announce_extra: Some(json!({
                "from": job.from,
                "sender": job.origin,
                "traceId": job.trace_id,
                "hops": job.hops,
            })),
        };
        let result = self
            .bots
            .submit_external_with(
                &self.app,
                &job.bot_id,
                &job.prompt_id,
                &job.text,
                BotMessageOrigin::Remote,
                options,
            )
            .await;
        self.set_active_trace(&job.bot_id, None);
        enforcer.abort();
        self.inbound.update(&job.prompt_id, |record| {
            record.finished_at = Some(now_ms());
            record.pending_permissions.clear();
            match &result {
                Ok(reply) => {
                    record.status = MeshMessageStatus::Done;
                    record.reply = Some(reply.clone());
                }
                Err(error) => {
                    record.status = MeshMessageStatus::Failed;
                    record.error = Some(MeshError {
                        code: error.code().unwrap_or("MESH_ERROR").to_string(),
                        message: error.message().to_string(),
                    });
                }
            }
        });
        if let Err(error) = &result {
            warn!(bot = %job.bot_id, error = %error, "bot mesh: delivery failed");
        }
    }

    /// 本回合的审批：deny 自动拒、full 兜底放行，其余登记为待处理（发起方 /
    /// 本机主人任一方处理后由 `permission_resolved` 收掉）。
    async fn enforce(
        self: Arc<Self>,
        mut events: crate::services::ChatEventStream,
        chat_id: String,
        prompt_id: String,
        policy: Option<RemotePolicy>,
        allow_kinds: Vec<String>,
    ) {
        let mut started = false;
        while let Some(event) = events.recv().await {
            if !started {
                if is_own_external_prompt(&event, &chat_id, &prompt_id) {
                    started = true;
                    self.inbound
                        .update(&prompt_id, |r| r.status = MeshMessageStatus::Running);
                }
                continue;
            }
            match event.kind.as_str() {
                "turn_ended" => break,
                "permission_request" => {
                    let Some(key) = event.payload["requestKey"].as_str().map(str::to_string) else {
                        continue;
                    };
                    let params = event.payload["params"].clone();
                    let action = match policy {
                        Some(policy) => policy::decide(policy, &allow_kinds, &params),
                        None => PolicyAction::Ask,
                    };
                    let by = format!("policy:{}", policy.map_or("local", RemotePolicy::as_str));
                    let answered = match &action {
                        PolicyAction::Approve(option) => {
                            self.answer(&chat_id, &key, Some(option.clone()), &by).await
                        }
                        PolicyAction::Reject(option) => {
                            self.answer(&chat_id, &key, option.clone(), &by).await
                        }
                        PolicyAction::Ask => false,
                    };
                    if !answered {
                        self.inbound.update(&prompt_id, |r| {
                            r.pending_permissions.push(PendingPermission {
                                request_key: key.clone(),
                                params,
                            });
                            r.status = MeshMessageStatus::WaitingPermission;
                        });
                    }
                }
                "elicitation_request" if policy == Some(RemotePolicy::Deny) => {
                    if let Some(key) = event.payload["requestKey"].as_str() {
                        let _ = self
                            .acp
                            .respond_elicitation_by(
                                &chat_id,
                                key.to_string(),
                                json!({"action": "decline"}),
                                "policy:deny",
                            )
                            .await;
                    }
                }
                "permission_resolved" => {
                    let key = event.payload["requestKey"].as_str().unwrap_or_default();
                    self.inbound.update(&prompt_id, |r| {
                        r.pending_permissions.retain(|p| p.request_key != key);
                        if r.pending_permissions.is_empty()
                            && r.status == MeshMessageStatus::WaitingPermission
                        {
                            r.status = MeshMessageStatus::Running;
                        }
                    });
                }
                _ => {}
            }
        }
    }

    async fn answer(&self, chat_id: &str, key: &str, option: Option<String>, by: &str) -> bool {
        match self
            .acp
            .respond_permission_by(chat_id, key.to_string(), option, by)
            .await
        {
            Ok(()) => true,
            Err(error) => {
                debug!(chat = %chat_id, error = %error, "bot mesh: policy answer failed");
                false
            }
        }
    }
}

struct InboundJob {
    bot_id: String,
    allow_kinds: Vec<String>,
    prompt_id: String,
    trace_id: String,
    hops: u32,
    text: String,
    origin: String,
    from: MeshFrom,
    policy: Option<RemotePolicy>,
}

/// 便于路由层构造（测试也用）。
pub fn parse_inbound(body: Value) -> AppResult<InboundRequest> {
    serde_json::from_value(body)
        .map_err(|error| AppError::coded("MESH_BAD_REQUEST", format!("Invalid body: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_origins() {
        assert!(is_remote_origin("device:mac"));
        assert!(is_remote_origin("mobile"));
        assert!(!is_remote_origin("desktop"));
        assert!(!is_remote_origin("bot:x"));
    }

    #[test]
    fn phone_body_without_trace_or_hops_parses() {
        let parsed =
            parse_inbound(json!({"text": "hi", "promptId": "p1", "from": {"device": "iPhone"}}))
                .unwrap();
        assert_eq!(parsed.prompt_id.as_deref(), Some("p1"));
        assert!(parsed.trace_id.is_none());
        assert!(parsed.hops.is_none());
        assert_eq!(parsed.from.device.as_deref(), Some("iPhone"));
        assert!(parse_inbound(json!({"from": {}})).is_err());
    }

    #[test]
    fn ack_omits_duplicate_when_false() {
        let ack = DeliverAck {
            chat_id: "bot-a".into(),
            prompt_id: "p".into(),
            trace_id: "t".into(),
            hops: 0,
            policy: Some(RemotePolicy::AskOrigin),
            duplicate: false,
        };
        let value = serde_json::to_value(ack).unwrap();
        assert!(value.get("duplicate").is_none());
        assert_eq!(value["policy"], "ask_origin");
        assert_eq!(value["chatId"], "bot-a");
    }
}
