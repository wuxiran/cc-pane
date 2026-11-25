//! 换引擎「上下文交接」的落盘。
//!
//! 前端在同一 chatId 上用新引擎重开会话（`start` 的 replace 语义会停掉旧进程，
//! 渲染层条目留在前端 store 里作只读前缀）。交接完成后前端调用一次保存：
//! - `inherited`：切换前的只读前缀（含交接分隔线）整段写进新会话转写的继承段，
//!   之后无论降级续接（`inherit` 拉平推送）还是 loadSession 成功（`inherited_restore`）
//!   都能在历史恢复时看到旧引擎的对话；
//! - `engines`：本对话用过的引擎序列写进新会话 meta（侧栏据此显示多个引擎图标）。
use serde_json::{json, Value};
use tracing::debug;

use super::{read_meta, transcript, AcpChatService};
use crate::utils::{AppError, AppResult};

/// meta `engines` 的长度上限（只保留最近的切换）。
pub(super) const MAX_ENGINE_TRAIL: usize = 32;
const MAX_ENGINE_ID_LEN: usize = 128;

/// 规整引擎序列：去掉空白/超长项，合并相邻重复，最多保留最近 [`MAX_ENGINE_TRAIL`] 个。
pub(super) fn normalize_engine_trail(engines: Vec<String>) -> Vec<String> {
    let mut trail: Vec<String> = Vec::new();
    for engine in engines {
        let engine = engine.trim();
        if engine.is_empty() || engine.len() > MAX_ENGINE_ID_LEN {
            continue;
        }
        if trail.last().map(String::as_str) != Some(engine) {
            trail.push(engine.to_string());
        }
    }
    let excess = trail.len().saturating_sub(MAX_ENGINE_TRAIL);
    trail.drain(..excess);
    trail
}

/// 每次写 meta 时维护引擎序列：缺失时以当前引擎起头，末项不同则追加。
pub(super) fn note_engine(meta: &mut Value, engine_id: &str) {
    let mut engines: Vec<String> = meta
        .get("engines")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    engines.push(engine_id.to_string());
    meta["engines"] = json!(normalize_engine_trail(engines));
}

/// 前端交接上下文块的固定开头（web/components/agentchat/chatHandoffSummary.ts）。
const HANDOFF_CONTEXT_PREFIX: &str = "<handoff_context>";

/// 交接上下文块不是用户输入：不能拿来当会话标题。
pub(super) fn is_handoff_context(text: &str) -> bool {
    text.trim_start().starts_with(HANDOFF_CONTEXT_PREFIX)
}

impl AcpChatService {
    /// 保存转写；交接时额外替换继承段并写入引擎序列。没有 meta 的会话不落盘。
    pub fn save_chat_transcript_with(
        &self,
        acp_session_id: &str,
        items: Vec<Value>,
        inherited: Option<Vec<Value>>,
        engines: Option<Vec<String>>,
    ) -> AppResult<()> {
        let path = self
            .meta_path(acp_session_id)
            .ok_or_else(|| AppError::coded("ACP_BAD_SESSION_ID", "ACP session id is invalid"))?;
        if !path.exists() {
            debug!(acp_session_id, "skip transcript save: no chat meta");
            return Ok(());
        }
        if let Some(engines) = engines {
            let trail = normalize_engine_trail(engines);
            if let Some(mut meta) = read_meta(&path).filter(Value::is_object) {
                if !trail.is_empty() {
                    meta["engines"] = json!(trail);
                    std::fs::write(&path, meta.to_string()).map_err(|error| {
                        AppError::from(format!("Unable to write ACP chat meta: {error}"))
                    })?;
                }
            }
        }
        transcript::save_with_inherited(&self.chats_dir, acp_session_id, items, inherited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, text: &str) -> Value {
        json!({"type": kind, "id": id, "at": 1, "text": text})
    }

    fn ids(items: &[Value]) -> Vec<String> {
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn handoff_context_blocks_are_recognized() {
        assert!(is_handoff_context("  <handoff_context>\nThis conversation"));
        assert!(!is_handoff_context("Fix <handoff_context> later"));
    }

    #[test]
    fn engine_trail_is_trimmed_deduped_and_bounded() {
        let trail = normalize_engine_trail(vec![
            "claude".into(),
            " claude ".into(),
            "".into(),
            "x".repeat(200),
            "codex".into(),
            "claude".into(),
        ]);
        assert_eq!(trail, ["claude", "codex", "claude"]);
        let long: Vec<String> = (0..40).map(|index| format!("e{index}")).collect();
        let bounded = normalize_engine_trail(long);
        assert_eq!(bounded.len(), MAX_ENGINE_TRAIL);
        assert_eq!(bounded.last().unwrap(), "e39");
    }

    #[test]
    fn meta_tracks_engines_across_writes() {
        let dir = tempfile::tempdir().unwrap();
        let service = AcpChatService::new(dir.path().into());
        service.write_chat_meta("s1", "claude", "/repo", None);
        service.write_chat_meta("s1", "claude", "/repo", None);
        let history = service.list_chat_history();
        assert_eq!(history[0]["engines"], json!(["claude"]));
    }

    #[test]
    fn handoff_save_replaces_inherited_and_records_engines() {
        let dir = tempfile::tempdir().unwrap();
        let service = AcpChatService::new(dir.path().into());
        service.write_chat_meta("s2", "codex", "/repo", None);
        let divider = json!({"type": "notice", "id": "h", "at": 2, "text": "handoff",
            "handoff": {"from": "Claude", "to": "Codex", "fromEngineId": "claude", "toEngineId": "codex"}});
        service
            .save_chat_transcript_with(
                "s2",
                Vec::new(),
                Some(vec![item("a", "user", "hi"), divider]),
                Some(vec!["claude".into(), "codex".into()]),
            )
            .unwrap();
        // 之后的普通保存只替换本会话正文，继承段（含交接分隔线）保留。
        service
            .save_chat_transcript("s2", vec![item("c", "user", "next")])
            .unwrap();
        let (flat, _) = transcript::load(dir.path(), "s2").unwrap();
        assert_eq!(ids(&flat), ["a", "h", "c"]);
        assert_eq!(flat[1]["handoff"]["toEngineId"], "codex");
        assert_eq!(
            service.list_chat_history()[0]["engines"],
            json!(["claude", "codex"])
        );

        let restore = transcript::inherited_restore(dir.path(), "s2").unwrap();
        assert_eq!(restore["inheritedOnly"], true);
        assert_eq!(restore["acpSessionId"], "s2");
        assert_eq!(ids(restore["items"].as_array().unwrap()), ["a", "h"]);
    }

    #[test]
    fn inherited_restore_is_none_without_inherited_segment() {
        let dir = tempfile::tempdir().unwrap();
        transcript::save(dir.path(), "s1", vec![item("a", "user", "hi")]).unwrap();
        assert!(transcript::inherited_restore(dir.path(), "s1").is_none());
        assert!(transcript::inherited_restore(dir.path(), "missing").is_none());
    }

    #[test]
    fn handoff_save_skips_sessions_without_meta() {
        let dir = tempfile::tempdir().unwrap();
        let service = AcpChatService::new(dir.path().into());
        service
            .save_chat_transcript_with(
                "orphan",
                Vec::new(),
                Some(vec![item("a", "user", "hi")]),
                Some(vec!["claude".into()]),
            )
            .unwrap();
        assert!(transcript::load(dir.path(), "orphan").is_none());
    }
}
