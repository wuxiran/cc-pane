//! Bot 组网的 MCP 面（docs/112 §5.4）：`list_contacts` / `message_contact`。
//!
//! 调用方是 Bot 时（MCP 地址带 `acpChatId=bot-<id>`），它正在服务的远程消息的
//! traceId / hops 会接力下去，bot→bot→bot 的环被 hops≤3 与 traceId 去重截断。
use super::*;
use crate::services::bot_mesh::outbound::{SendRequest, Sender};
use crate::services::bot_service::BOT_CHAT_PREFIX;
use crate::services::BotMeshService;

const DEFAULT_WAIT_SECS: u64 = 300;
const MAX_WAIT_SECS: u64 = 1800;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpListContactsParams {
    /// true = 不用缓存，立刻重新询问每台已配对电脑
    #[serde(default)]
    pub(super) refresh: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpMessageContactParams {
    /// 目标电脑：list_contacts 返回的 deviceId，或电脑名；省略 / "local" = 本机
    #[serde(default)]
    pub(super) device: Option<String>,
    /// 目标 Bot：id 或名字
    pub(super) bot: String,
    /// 消息正文
    pub(super) text: String,
    /// 是否等待回复（默认 true）
    #[serde(default, rename = "waitReply")]
    pub(super) wait_reply: Option<bool>,
    /// 最多等多少秒（默认 300，上限 1800）
    #[serde(default, rename = "timeoutSecs")]
    pub(super) timeout_secs: Option<u64>,
}

/// MCP URL 上的 `acpChatId=bot-<id>` → 调用方 Bot id。
pub(super) fn caller_bot_from_extensions(extensions: &Extensions) -> Option<String> {
    extensions
        .get::<http::request::Parts>()
        .and_then(|parts| parts.uri.query())
        .and_then(|query| {
            query.split('&').find_map(|pair| {
                let value = pair.strip_prefix("acpChatId=")?;
                let value = urlencoding::decode(value).ok()?.into_owned();
                value
                    .strip_prefix(BOT_CHAT_PREFIX)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
            })
        })
}

fn mesh(handler: &McpToolHandler) -> Option<Arc<BotMeshService>> {
    handler
        .state
        .app_handle
        .try_state::<Arc<BotMeshService>>()
        .map(|s| s.inner().clone())
}

fn error_text(code: &str, message: &str) -> String {
    serde_json::json!({"error": {"code": code, "message": message}}).to_string()
}

impl McpToolHandler {
    pub(super) async fn list_contacts_impl(&self, params: McpListContactsParams) -> String {
        let Some(mesh) = mesh(self) else {
            return error_text("ACP_HOST_UNAVAILABLE", "Bot mesh is not ready");
        };
        let view = mesh.contacts(params.refresh, true).await;
        serde_json::to_string(&view).unwrap_or_default()
    }

    pub(super) async fn message_contact_impl(
        &self,
        params: McpMessageContactParams,
        extensions: Extensions,
    ) -> String {
        let Some(mesh) = mesh(self) else {
            return error_text("ACP_HOST_UNAVAILABLE", "Bot mesh is not ready");
        };
        let caller_bot = caller_bot_from_extensions(&extensions);
        let contacts = mesh.contacts(false, true).await;
        let (device_id, bot_id) =
            match resolve_contact(&contacts, params.device.as_deref(), &params.bot) {
                Ok(found) => found,
                Err(message) => return error_text("BOT_NOT_FOUND", &message),
            };
        info!(device = %device_id, bot = %bot_id, caller = ?caller_bot, "mcp::message_contact");
        let sender = Sender {
            label: caller_bot
                .as_ref()
                .map(|id| format!("bot:{id}"))
                .unwrap_or_else(|| "mcp".to_string()),
            caller_bot,
            agent: true,
        };
        let request = SendRequest {
            device_id: Some(device_id),
            bot_id,
            text: params.text,
            prompt_id: None,
        };
        let entry = match mesh.send(request, sender).await {
            Ok(entry) => entry,
            Err(error) => {
                return error_text(error.code().unwrap_or("MESH_ERROR"), error.message());
            }
        };
        if !params.wait_reply.unwrap_or(true) {
            return serde_json::to_string(&entry).unwrap_or_default();
        }
        let wait = params
            .timeout_secs
            .unwrap_or(DEFAULT_WAIT_SECS)
            .clamp(1, MAX_WAIT_SECS);
        match mesh
            .wait(&entry.id, std::time::Duration::from_secs(wait))
            .await
        {
            Ok(result) => serde_json::to_string(&result).unwrap_or_default(),
            Err(error) => error_text(error.code().unwrap_or("MESH_ERROR"), error.message()),
        }
    }
}

/// 在联系人里按 (电脑, Bot) 找目标：电脑按 deviceId / 名字（不分大小写），Bot 按 id / 名字。
pub(super) fn resolve_contact(
    contacts: &crate::services::bot_mesh::ContactsView,
    device: Option<&str>,
    bot: &str,
) -> std::result::Result<(String, String), String> {
    let device = device.map(str::trim).filter(|d| !d.is_empty());
    let bot = bot.trim();
    let groups: Vec<_> = contacts
        .groups
        .iter()
        .filter(|group| match device {
            None => group.local,
            Some("local") => group.local,
            Some(device) => group.device_id == device || group.name.eq_ignore_ascii_case(device),
        })
        .collect();
    if groups.is_empty() {
        return Err(format!(
            "找不到电脑 '{}'（先用 list_contacts 查 deviceId）",
            device.unwrap_or("local")
        ));
    }
    for group in groups {
        if let Some(found) = group.bots.iter().find(|b| b.id == bot).or_else(|| {
            group
                .bots
                .iter()
                .find(|b| b.name.trim().eq_ignore_ascii_case(bot))
        }) {
            return Ok((group.device_id.clone(), found.id.clone()));
        }
    }
    Err(format!("找不到 Bot '{bot}'（先用 list_contacts 查）"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::bot_mesh::{ContactGroup, ContactsView, SharedBot};

    fn bot(id: &str, name: &str) -> SharedBot {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "avatar": "", "color": "", "engineId": "claude",
            "personaSummary": "", "status": "idle", "remotePolicy": "ask_origin", "chatId": format!("bot-{id}")
        }))
        .unwrap()
    }

    fn group(device_id: &str, name: &str, local: bool, bots: Vec<SharedBot>) -> ContactGroup {
        ContactGroup {
            device_id: device_id.into(),
            name: name.into(),
            local,
            status: "online".into(),
            online: true,
            error: None,
            address: None,
            instance_id: None,
            last_seen_at: None,
            bots,
        }
    }

    #[test]
    fn resolves_by_device_and_bot_name() {
        let contacts = ContactsView {
            instance_id: None,
            device_name: "me".into(),
            groups: vec![
                group("local", "me", true, vec![bot("a", "Alice")]),
                group("dev-1", "Studio", false, vec![bot("b", "Bob")]),
            ],
        };
        assert_eq!(
            resolve_contact(&contacts, None, "alice").unwrap(),
            ("local".into(), "a".into())
        );
        assert_eq!(
            resolve_contact(&contacts, Some("studio"), "Bob").unwrap(),
            ("dev-1".into(), "b".into())
        );
        assert_eq!(
            resolve_contact(&contacts, Some("dev-1"), "b").unwrap(),
            ("dev-1".into(), "b".into())
        );
        assert!(resolve_contact(&contacts, Some("nowhere"), "b").is_err());
        assert!(resolve_contact(&contacts, None, "Bob").is_err());
    }
}
