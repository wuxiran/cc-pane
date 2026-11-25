//! 会话历史 meta 里与「怎么启动」相关的两个字段：
//! - `engineId`：续接时的传输路由依据（`codex` = ACP 桥，`codex-app-server` = 原生）；
//! - `launchProfileId`：会话启动时应用的运行配置，续接 / 重启时沿用。
//!
//! meta 由 `write_chat_meta` 在握手成功时创建；这里只读，或在它之后补写运行配置。
use serde_json::{json, Value};
use tracing::warn;

use super::{meta_path_in, read_meta, AcpChatService};

/// meta 里与启动相关的字段（缺失 = None）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatLaunchMeta {
    pub engine_id: Option<String>,
    pub launch_profile_id: Option<String>,
}

fn string_field(meta: &Value, key: &str) -> Option<String> {
    meta.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

impl AcpChatService {
    pub fn chat_launch_meta(&self, acp_session_id: &str) -> ChatLaunchMeta {
        let Some(meta) = meta_path_in(&self.chats_dir, acp_session_id).and_then(|p| read_meta(&p))
        else {
            return ChatLaunchMeta::default();
        };
        ChatLaunchMeta {
            engine_id: string_field(&meta, "engineId"),
            launch_profile_id: string_field(&meta, "launchProfileId"),
        }
    }

    /// 记下（或清除）该会话的运行配置。meta 不存在时不新建（握手失败的会话没有历史）。
    pub fn note_launch_profile(&self, acp_session_id: &str, launch_profile_id: Option<&str>) {
        let Some(path) = meta_path_in(&self.chats_dir, acp_session_id) else {
            return;
        };
        let Some(mut meta) = read_meta(&path).filter(Value::is_object) else {
            return;
        };
        match launch_profile_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => meta["launchProfileId"] = json!(id),
            None => {
                if let Some(map) = meta.as_object_mut() {
                    map.remove("launchProfileId");
                }
            }
        }
        if let Err(error) = std::fs::write(&path, meta.to_string()) {
            warn!(error = %error, "failed to record agent chat launch profile");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_meta_round_trips_profile_and_keeps_engine() {
        let dir = tempfile::tempdir().unwrap();
        let service = AcpChatService::new(dir.path().join("agent-chats"));
        std::fs::create_dir_all(dir.path().join("agent-chats")).unwrap();
        let path = dir.path().join("agent-chats").join("thread-1.json");
        std::fs::write(
            &path,
            r#"{"acpSessionId":"thread-1","engineId":"codex","title":"t"}"#,
        )
        .unwrap();

        service.note_launch_profile("thread-1", Some("profile-a"));
        assert_eq!(
            service.chat_launch_meta("thread-1"),
            ChatLaunchMeta {
                engine_id: Some("codex".into()),
                launch_profile_id: Some("profile-a".into()),
            }
        );
        service.note_launch_profile("thread-1", None);
        assert_eq!(service.chat_launch_meta("thread-1").launch_profile_id, None);
        // 不存在的会话不新建 meta。
        service.note_launch_profile("missing", Some("profile-a"));
        assert!(!dir.path().join("agent-chats").join("missing.json").exists());
    }
}
