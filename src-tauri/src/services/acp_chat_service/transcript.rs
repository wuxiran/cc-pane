//! 消息正文本地落盘兜底（docs/94 §8）。
//!
//! 引擎不广告 `loadSession`（或 load 被拒）时，续接只能开新会话，协议侧没有任何
//! 历史可回放。这里按 **acpSessionId** 存前端渲染层的转写条目
//! （`<data>/agent-chats/transcripts/<id>.json`），降级时把旧会话的转写以只读前缀
//! 推给前端，并作为新会话的 `inherited` 段继承下去（链式续接不丢更早的记录）。
//! loadSession 成功时不推送——协议回放才是真相，避免重复。
//!
//! 有界：单会话条目数 / 字节数 / 单字符串长度封顶，全目录文件数封顶（按修改时间
//! 淘汰最旧的转写，不动 meta）；删除历史会话时一起删。
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tracing::warn;

use crate::utils::{AppError, AppResult};

pub(super) const TRANSCRIPT_DIR: &str = "transcripts";
pub(super) const MAX_ITEMS: usize = 2000;
pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_STRING_BYTES: usize = 64 * 1024;
pub(super) const MAX_FILES: usize = 200;
const FORMAT_VERSION: u64 = 1;
const ITEM_TYPES: &[&str] = &[
    "user",
    "assistant",
    "thought",
    "image",
    "tool_call",
    "plan",
    "notice",
];

fn io_error(error: impl std::fmt::Display) -> AppError {
    AppError::coded(
        "ACP_TRANSCRIPT_FAILED",
        format!("Unable to save Agent chat transcript: {error}"),
    )
}

/// 与 meta 同一套 id 白名单（`[A-Za-z0-9_-]`，≤128）——id 直接拼进文件名。
pub(super) fn transcript_path_in(chats_dir: &Path, acp_session_id: &str) -> Option<PathBuf> {
    let meta = super::meta_path_in(chats_dir, acp_session_id)?;
    let name = meta.file_name()?.to_owned();
    Some(chats_dir.join(TRANSCRIPT_DIR).join(name))
}

fn truncate_string(text: &mut String) {
    if text.len() <= MAX_STRING_BYTES {
        return;
    }
    let mut end = MAX_STRING_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n… [truncated in local transcript]");
}

/// 递归钳制：超长字符串截断；超长内嵌图片去掉 data（截断的 base64 只会渲染成坏图）。
fn clamp_value(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            let is_image = fields.get("type").and_then(Value::as_str) == Some("image");
            let oversized = |key: &str, fields: &Map<String, Value>| {
                fields
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.len() > MAX_STRING_BYTES)
            };
            if is_image && oversized("data", fields) {
                fields.remove("data");
                fields.insert("dataOmitted".into(), Value::Bool(true));
            }
            for nested in fields.values_mut() {
                clamp_value(nested);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(clamp_value),
        Value::String(text) => truncate_string(text),
        _ => {}
    }
}

fn is_transcript_item(item: &Value) -> bool {
    item.get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| ITEM_TYPES.contains(&kind))
        && item.get("id").and_then(Value::as_str).is_some()
}

/// 过滤未知形状、钳制大字段，再按条目数/总字节从最旧一端淘汰。
/// 返回 (inherited, items, truncated)。inherited 是更早会话的记录，优先淘汰。
pub(super) fn bound(inherited: Vec<Value>, items: Vec<Value>) -> (Vec<Value>, Vec<Value>, bool) {
    let mut truncated = false;
    let prepare = |list: Vec<Value>, truncated: &mut bool| -> Vec<(Value, usize)> {
        list.into_iter()
            .filter(|item| {
                let keep = is_transcript_item(item);
                *truncated |= !keep;
                keep
            })
            .map(|mut item| {
                clamp_value(&mut item);
                let size = serde_json::to_string(&item).map(|s| s.len()).unwrap_or(0);
                (item, size)
            })
            .collect()
    };
    let mut older = prepare(inherited, &mut truncated);
    let mut newer = prepare(items, &mut truncated);
    let mut count = older.len() + newer.len();
    let mut bytes: usize = older.iter().chain(newer.iter()).map(|(_, size)| size).sum();
    let mut drop_front = 0usize;
    while (count > MAX_ITEMS || bytes > MAX_BYTES) && count > 0 {
        let size = if drop_front < older.len() {
            older[drop_front].1
        } else {
            newer[drop_front - older.len()].1
        };
        drop_front += 1;
        count -= 1;
        bytes -= size;
        truncated = true;
    }
    let drop_older = drop_front.min(older.len());
    older.drain(..drop_older);
    newer.drain(..drop_front - drop_older);
    (
        older.into_iter().map(|(item, _)| item).collect(),
        newer.into_iter().map(|(item, _)| item).collect(),
        truncated,
    )
}

struct Stored {
    inherited: Vec<Value>,
    items: Vec<Value>,
    truncated: bool,
}

fn read(path: &Path) -> Option<Stored> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let list = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Some(Stored {
        inherited: list("inherited"),
        items: list("items"),
        truncated: value.get("truncated").and_then(Value::as_bool) == Some(true),
    })
}

fn write(chats_dir: &Path, path: &Path, acp_session_id: &str, stored: Stored) -> AppResult<()> {
    let dir = chats_dir.join(TRANSCRIPT_DIR);
    std::fs::create_dir_all(&dir).map_err(io_error)?;
    let body = json!({
        "version": FORMAT_VERSION,
        "acpSessionId": acp_session_id,
        "updatedAt": super::unix_millis(),
        "truncated": stored.truncated,
        "inherited": stored.inherited,
        "items": stored.items,
    });
    // 临时文件 + rename：写到一半崩溃不会留下半截 JSON 覆盖掉旧转写。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(io_error)?;
    std::fs::rename(&tmp, path).map_err(io_error)?;
    prune(&dir, path);
    Ok(())
}

/// 目录内转写文件数封顶：按修改时间淘汰最旧的（刚写的那份永远保留）。
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && path != keep)
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    if files.len() < MAX_FILES {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let excess = files.len() + 1 - MAX_FILES;
    for (_, path) in files.into_iter().take(excess) {
        if let Err(error) = std::fs::remove_file(&path) {
            warn!(error = %error, path = %path.display(), "failed to prune ACP transcript");
        }
    }
}

/// 前端保存当前会话的正文段（整段替换 `items`，保留降级时继承的 `inherited`）。
pub(super) fn save(chats_dir: &Path, acp_session_id: &str, items: Vec<Value>) -> AppResult<()> {
    let path = transcript_path_in(chats_dir, acp_session_id)
        .ok_or_else(|| AppError::coded("ACP_BAD_SESSION_ID", "ACP session id is invalid"))?;
    let previous = read(&path);
    let inherited = previous
        .as_ref()
        .map(|stored| stored.inherited.clone())
        .unwrap_or_default();
    let (inherited, items, truncated) = bound(inherited, items);
    let truncated = truncated || previous.is_some_and(|stored| stored.truncated);
    write(
        chats_dir,
        &path,
        acp_session_id,
        Stored {
            inherited,
            items,
            truncated,
        },
    )
}

/// 降级续接：读旧会话转写（inherited + items 拉平），写成新会话的 inherited，
/// 返回推给前端的 `transcript_restore` 负载；旧会话无转写时 None。
pub(super) fn inherit(chats_dir: &Path, from: &str, to: &str) -> Option<Value> {
    if from == to {
        return None;
    }
    let stored = read(&transcript_path_in(chats_dir, from)?)?;
    let mut flat = stored.inherited;
    flat.extend(stored.items);
    let (inherited, _, truncated) = bound(flat, Vec::new());
    if inherited.is_empty() {
        return None;
    }
    let truncated = truncated || stored.truncated;
    let target = transcript_path_in(chats_dir, to)?;
    let payload = json!({
        "fromAcpSessionId": from,
        "acpSessionId": to,
        "truncated": truncated,
        "items": inherited,
    });
    let seeded = Stored {
        inherited,
        items: Vec::new(),
        truncated,
    };
    if let Err(error) = write(chats_dir, &target, to, seeded) {
        warn!(error = %error, "failed to seed inherited ACP transcript");
    }
    Some(payload)
}

/// 拉平读取（测试与排障用；运行时由 `inherit` 直接推送）。
#[cfg(test)]
pub(super) fn load(chats_dir: &Path, acp_session_id: &str) -> Option<(Vec<Value>, bool)> {
    let stored = read(&transcript_path_in(chats_dir, acp_session_id)?)?;
    let mut flat = stored.inherited;
    flat.extend(stored.items);
    Some((flat, stored.truncated))
}

pub(super) fn delete(chats_dir: &Path, acp_session_id: &str) -> AppResult<()> {
    let Some(path) = transcript_path_in(chats_dir, acp_session_id) else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::from(format!(
            "Unable to delete ACP chat transcript: {error}"
        ))),
    }
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
