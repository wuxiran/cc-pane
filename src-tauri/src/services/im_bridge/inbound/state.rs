//! 渠道状态（offset + 当前 Bot + 已收下还没处理的消息），落盘以便重启后不重放。
//!
//! 语义是「至多一次」：每条 update 在处理**之前**就把 offset 推进并落盘，
//! 中途退出不会重放（不会重复执行 prompt、重复开新话题）。已排队还没交给
//! Bot 的消息记在 `pending` 里；下次启动不再执行（可能已经过时），只告诉
//! 用户哪几条被丢下了。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingMessage {
    pub(super) update_id: i64,
    pub(super) text: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChannelState {
    #[serde(default)]
    pub(super) offset: Option<i64>,
    #[serde(default)]
    pub(super) current_bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) pending: Vec<PendingMessage>,
}

impl ChannelState {
    /// 推进 offset（只进不退）。
    pub(super) fn advance(&mut self, update_id: i64) {
        self.offset = Some(self.offset.unwrap_or(0).max(update_id + 1));
    }
}

pub(super) fn state_path(dir: &Path, channel_id: &str) -> PathBuf {
    let safe: String = channel_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("telegram-{safe}.json"))
}

pub(super) fn load_state(path: &Path) -> ChannelState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// 先写临时文件再改名，崩溃时不会留下半截 JSON（那会让 offset 丢失、重放积压）。
pub(super) fn save_state(path: &Path, state: &ChannelState) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(raw) = serde_json::to_string(state) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 启动时告诉用户上次没来得及处理的消息（不执行）。
pub(super) fn dropped_notice(pending: &[PendingMessage]) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    let lines: Vec<String> = pending
        .iter()
        .take(10)
        .map(|message| {
            let preview: String = message.text.chars().take(40).collect();
            format!("· {preview}")
        })
        .collect();
    let more = pending.len().saturating_sub(10);
    let mut text = format!(
        "CC-Panes 上次退出时有 {} 条消息还没处理，为避免执行过时的指令已丢弃，需要的话请重发：\n{}",
        pending.len(),
        lines.join("\n")
    );
    if more > 0 {
        text.push_str(&format!("\n……另有 {more} 条"));
    }
    Some(text)
}
