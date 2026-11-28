//! 本机发出的消息：发给本机或其他电脑上的 Bot，跟踪回复与待审批（outbox）。
//!
//! 每条在途发件一个跟踪任务（总数有上限），终态即停——不按对端常驻轮询。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::warn;

use super::deliver::InboundRequest;
use super::peers::{self, PeerEndpoint};
use super::records::{MeshError, MeshFrom, MeshMessage, MeshMessageStatus, OutboxEntry};
use super::{trace, BotMeshService, LOCAL_DEVICE, OUTBOX_CHANGED_EVENT};
use crate::services::bot_service::bot_chat_id;
use crate::utils::{AppError, AppResult};

const MAX_TRACKED: usize = 16;
const POLL_EVERY: Duration = Duration::from_millis(1200);
const TRACK_LIMIT: Duration = Duration::from_secs(65 * 60);
const MAX_POLL_FAILURES: u32 = 10;

/// 谁在发：界面（人）或某个 Bot / agent 经 MCP。
#[derive(Debug, Clone)]
pub struct Sender {
    /// 本机桌面界面 = `desktop`；MCP = `bot:<id>` 或 `mcp`。
    pub label: String,
    /// 经 MCP 调用的 Bot（接力它正在服务的 trace）。
    pub caller_bot: Option<String>,
    /// agent 发起（MCP）至少算 1 跳。
    pub agent: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    /// `local` / 缺省 = 本机；否则设备 id。
    #[serde(default)]
    pub device_id: Option<String>,
    pub bot_id: String,
    pub text: String,
    #[serde(default)]
    pub prompt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitResult {
    pub timed_out: bool,
    pub entry: OutboxEntry,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_local(device_id: Option<&str>) -> bool {
    device_id.is_none_or(|id| id.is_empty() || id == LOCAL_DEVICE)
}

impl BotMeshService {
    /// 本条消息的 trace / hops：调用方 Bot 正在服务某条远程消息就接力，否则开新 trace。
    pub fn next_hop(&self, sender: &Sender) -> AppResult<(String, u32)> {
        let inherited = sender
            .caller_bot
            .as_deref()
            .and_then(|bot| self.active_trace(bot));
        let (trace_id, hops) = match inherited {
            Some((trace_id, hops)) => (trace_id, hops + 1),
            None => (trace::new_trace_id(), u32::from(sender.agent)),
        };
        trace::check_hops(hops)?;
        if let Some(bot) = &sender.caller_bot {
            self.guard.mark(&trace_id, bot);
        }
        Ok((trace_id, hops))
    }

    pub async fn send(
        self: &Arc<Self>,
        request: SendRequest,
        sender: Sender,
    ) -> AppResult<OutboxEntry> {
        if self.outbox.count_where(|e| !e.status.is_terminal()) >= MAX_TRACKED {
            return Err(AppError::coded(
                "MESH_BUSY",
                "Too many messages waiting for replies; retry later",
            ));
        }
        let (trace_id, hops) = self.next_hop(&sender)?;
        let device_id = request.device_id.clone().filter(|id| !is_local(Some(id)));
        let prompt_id = request
            .prompt_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let from = MeshFrom {
            device: Some(self.device_name()),
            instance_id: self.instance_id(),
            bot: sender.caller_bot.clone(),
            bot_name: sender
                .caller_bot
                .as_deref()
                .and_then(|id| self.bots.get(id).ok())
                .map(|bot| bot.name),
            user: (!sender.agent).then(|| "owner".to_string()),
        };
        let inbound = InboundRequest {
            text: request.text.clone(),
            prompt_id: Some(prompt_id.clone()),
            trace_id: Some(trace_id.clone()),
            hops: Some(hops),
            from,
        };
        let (device_name, bot_name, accepted_prompt) = match &device_id {
            None => {
                let bot_name = self
                    .bots
                    .get(&request.bot_id)
                    .map(|b| b.name)
                    .unwrap_or_default();
                let ack = self
                    .deliver(&request.bot_id, inbound, sender.label.clone())
                    .await?;
                (self.device_name(), bot_name, ack.prompt_id)
            }
            Some(device_id) => {
                let endpoint = self.peers.endpoint(device_id).await?;
                let body = serde_json::to_value(RemoteBody::from(&inbound)).unwrap_or(Value::Null);
                let ack = peers::peer_post(
                    &endpoint,
                    &format!(
                        "/api/bots/{}/messages",
                        urlencoding::encode(&request.bot_id)
                    ),
                    &body,
                )
                .await
                .map_err(|e| e.into_app_error())?;
                let bot_name = self.remote_bot_name(device_id, &request.bot_id);
                let prompt = ack
                    .get("promptId")
                    .and_then(Value::as_str)
                    .unwrap_or(&prompt_id)
                    .to_string();
                (endpoint.name, bot_name, prompt)
            }
        };
        let entry = OutboxEntry {
            id: accepted_prompt,
            device_id: device_id
                .clone()
                .unwrap_or_else(|| LOCAL_DEVICE.to_string()),
            device_name,
            bot_id: request.bot_id.clone(),
            bot_name,
            text: request.text.trim().to_string(),
            trace_id,
            hops,
            sender: sender.label,
            status: MeshMessageStatus::Queued,
            reply: None,
            error: None,
            pending_permissions: Vec::new(),
            created_at: now_ms(),
            updated_at: now_ms(),
        };
        self.outbox.insert(entry.id.clone(), entry.clone());
        self.emit(OUTBOX_CHANGED_EVENT, entry.clone());
        let this = self.clone();
        let id = entry.id.clone();
        tauri::async_runtime::spawn(async move { this.track(id).await });
        Ok(entry)
    }

    fn remote_bot_name(&self, device_id: &str, bot_id: &str) -> String {
        self.contacts_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(device_id)
            .and_then(|(_, group)| {
                group
                    .bots
                    .iter()
                    .find(|b| b.id == bot_id)
                    .map(|b| b.name.clone())
            })
            .unwrap_or_else(|| bot_id.to_string())
    }

    pub fn outbox(&self) -> Vec<OutboxEntry> {
        self.outbox.list()
    }

    pub fn outbox_entry(&self, id: &str) -> Option<OutboxEntry> {
        self.outbox.get(id)
    }

    pub fn clear_outbox_entry(&self, id: &str) {
        self.outbox.remove(id);
    }

    /// 等一条发件到终态（MCP `message_contact` 用）。
    pub async fn wait(&self, id: &str, timeout: Duration) -> AppResult<WaitResult> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let entry = self
                .outbox
                .get(id)
                .ok_or_else(|| AppError::coded("MESH_MESSAGE_NOT_FOUND", "Message expired"))?;
            if entry.status.is_terminal() {
                return Ok(WaitResult {
                    timed_out: false,
                    entry,
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(WaitResult {
                    timed_out: true,
                    entry,
                });
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn fetch_status(&self, entry: &OutboxEntry) -> AppResult<MeshMessage> {
        if entry.device_id == LOCAL_DEVICE {
            return self.inbound_message(&entry.bot_id, &entry.id);
        }
        let endpoint = self.peers.endpoint(&entry.device_id).await?;
        let path = format!(
            "/api/bots/{}/messages/{}",
            urlencoding::encode(&entry.bot_id),
            urlencoding::encode(&entry.id)
        );
        let value = peers::peer_get(&endpoint, &path)
            .await
            .map_err(|e| e.into_app_error())?;
        serde_json::from_value(value)
            .map_err(|e| AppError::coded("MESH_PEER_ERROR", format!("Bad status payload: {e}")))
    }

    async fn track(self: Arc<Self>, id: String) {
        let deadline = tokio::time::Instant::now() + TRACK_LIMIT;
        let mut failures = 0;
        loop {
            tokio::time::sleep(POLL_EVERY).await;
            let Some(entry) = self.outbox.get(&id) else {
                return;
            };
            let next = match self.fetch_status(&entry).await {
                Ok(message) => {
                    failures = 0;
                    apply_status(entry.clone(), &message)
                }
                Err(error) => {
                    failures += 1;
                    if failures < MAX_POLL_FAILURES
                        && error.code() != Some("MESH_MESSAGE_NOT_FOUND")
                    {
                        continue;
                    }
                    warn!(id = %id, error = %error, "bot mesh: reply tracking gave up");
                    fail(entry.clone(), &error)
                }
            };
            let next = if tokio::time::Instant::now() >= deadline && !next.status.is_terminal() {
                fail(
                    next,
                    &AppError::coded("MESH_REPLY_TIMEOUT", "No reply in time"),
                )
            } else {
                next
            };
            if next != entry {
                self.outbox.insert(id.clone(), next.clone());
                self.emit(OUTBOX_CHANGED_EVENT, next.clone());
            }
            if next.status.is_terminal() {
                return;
            }
        }
    }

    /// 处理一条待审批（本机主人代批 / 发起方审批）。本机 Bot 直接答；远程 Bot 经
    /// 对方 `/api/acp/chats/bot-{id}/permission`（来源记为本机设备名）。
    pub async fn respond_permission(
        &self,
        device_id: &str,
        bot_id: &str,
        request_key: String,
        option_id: Option<String>,
    ) -> AppResult<()> {
        let chat_id = bot_chat_id(bot_id);
        if is_local(Some(device_id)) {
            return self
                .acp
                .respond_permission_by(&chat_id, request_key, option_id, "desktop")
                .await;
        }
        let endpoint: PeerEndpoint = self.peers.endpoint(device_id).await?;
        peers::peer_post(
            &endpoint,
            &format!(
                "/api/acp/chats/{}/permission",
                urlencoding::encode(&chat_id)
            ),
            &json!({"requestKey": request_key, "optionId": option_id}),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.into_app_error())
    }
}

/// 发往对端的请求体（`InboundRequest` 只实现了 Deserialize）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteBody<'a> {
    text: &'a str,
    prompt_id: Option<&'a str>,
    trace_id: Option<&'a str>,
    hops: Option<u32>,
    from: &'a MeshFrom,
}

impl<'a> From<&'a InboundRequest> for RemoteBody<'a> {
    fn from(request: &'a InboundRequest) -> Self {
        Self {
            text: &request.text,
            prompt_id: request.prompt_id.as_deref(),
            trace_id: request.trace_id.as_deref(),
            hops: request.hops,
            from: &request.from,
        }
    }
}

/// 把对端 / 本机的消息状态套到发件上；没变化时原样返回（不刷新 updatedAt，不发事件）。
pub fn apply_status(entry: OutboxEntry, message: &MeshMessage) -> OutboxEntry {
    let mut next = entry.clone();
    next.status = message.status;
    next.reply = message.reply.clone();
    next.error = message.error.clone();
    next.pending_permissions = message.pending_permissions.clone();
    if next != entry {
        next.updated_at = now_ms();
    }
    next
}

fn fail(mut entry: OutboxEntry, error: &AppError) -> OutboxEntry {
    entry.status = MeshMessageStatus::Failed;
    entry.error = Some(MeshError {
        code: error.code().unwrap_or("MESH_ERROR").to_string(),
        message: error.message().to_string(),
    });
    entry.pending_permissions.clear();
    entry.updated_at = now_ms();
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_device_ids() {
        assert!(is_local(None));
        assert!(is_local(Some("")));
        assert!(is_local(Some("local")));
        assert!(!is_local(Some("dev-1")));
    }

    #[test]
    fn remote_body_carries_trace_and_hops() {
        let request = InboundRequest {
            text: "hi".into(),
            prompt_id: Some("p".into()),
            trace_id: Some("t".into()),
            hops: Some(2),
            from: MeshFrom {
                bot: Some("b".into()),
                ..Default::default()
            },
        };
        let value = serde_json::to_value(RemoteBody::from(&request)).unwrap();
        assert_eq!(value["traceId"], "t");
        assert_eq!(value["hops"], 2);
        assert_eq!(value["from"]["bot"], "b");
    }
}
