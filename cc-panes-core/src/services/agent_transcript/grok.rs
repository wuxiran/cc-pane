//! Grok `chat_history.jsonl` 路径解析与行解码。
//! 路径规则对齐 Orca `shared/grok-session-paths.ts`；解码对齐
//! `transcript-line-decoders-grok.ts`（扁平 text，非全 block AST）。

use crate::models::{TranscriptMessage, TranscriptRole};
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const GROK_CHAT_HISTORY_FILE: &str = "chat_history.jsonl";
/// encodeURIComponent(cwd) 超过 255 字节时 Grok 改用 slug+hash 布局。
pub const GROK_ENCODED_CWD_DIR_MAX_BYTES: usize = 255;
pub const GROK_SESSION_ID_MAX_LENGTH: usize = 128;
pub const GROK_SESSION_GROUP_SCAN_MAX_ENTRIES: usize = 2_048;

/// Official ids are UUIDs; keep legacy/test token ids while rejecting paths.
pub fn is_safe_grok_session_id(session_id: &str) -> bool {
    let id = session_id.trim();
    !id.is_empty()
        && id.len() <= GROK_SESSION_ID_MAX_LENGTH
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn resolve_grok_home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

pub fn resolve_grok_sessions_dir() -> PathBuf {
    resolve_grok_home_dir().join("sessions")
}

/// JS `encodeURIComponent` 等价：除 `A-Za-z0-9-_.!~*'()` 外全部 percent-encode。
/// `urlencoding` 会多编一些字符；Grok 磁盘目录用的是 encodeURIComponent。
pub fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        let c = *b;
        let unreserved = matches!(c,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' |
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        );
        if unreserved {
            out.push(c as char);
        } else {
            out.push('%');
            out.push(char::from(hex_digit(c >> 4)));
            out.push(char::from(hex_digit(c & 0xf)));
        }
    }
    out
}

fn hex_digit(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        10..=15 => b'A' + (n - 10),
        _ => b'0',
    }
}

/// Return Grok's safe cwd-group component, or None for slug/invalid layouts.
pub fn grok_encoded_cwd_dir_name(cwd: &str) -> Option<String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return None;
    }
    let encoded = encode_uri_component(trimmed);
    if encoded == "." || encoded == ".." || encoded.contains('/') || encoded.contains('\\') {
        return None;
    }
    if encoded.len() > GROK_ENCODED_CWD_DIR_MAX_BYTES {
        return None;
    }
    Some(encoded)
}

fn is_path_within(root: &Path, candidate: &Path) -> bool {
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return false;
    }
    // 优先用组件前缀判断（避免 Windows canonicalize 前后缀不一致）；
    // 两边都能 canonicalize 时再严校一次。
    let root_norm = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let cand_norm = dunce::canonicalize(candidate)
        .or_else(|_| {
            candidate
                .parent()
                .map(dunce::canonicalize)
                .transpose()
                .map(|p| p.unwrap_or_else(|| candidate.to_path_buf()))
        })
        .unwrap_or_else(|_| candidate.to_path_buf());
    cand_norm.starts_with(&root_norm)
        || candidate.starts_with(root)
        || candidate.starts_with(&root_norm)
}

fn is_safe_chat_history_file(sessions_dir: &Path, path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_none_or(|n| n != GROK_CHAT_HISTORY_FILE)
    {
        return false;
    }
    if !is_path_within(sessions_dir, path) {
        return false;
    }
    path.is_file()
}

/// Fast-path：已知 cwd 时的候选路径。
pub fn build_grok_chat_history_path_candidates(
    session_id: &str,
    cwd: Option<&str>,
    sessions_dir: &Path,
) -> Vec<PathBuf> {
    let session_id = session_id.trim();
    if !is_safe_grok_session_id(session_id) {
        return Vec::new();
    }
    let Some(cwd) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return Vec::new();
    };
    let Some(encoded) = grok_encoded_cwd_dir_name(cwd) else {
        return Vec::new();
    };
    let candidate = sessions_dir
        .join(&encoded)
        .join(session_id)
        .join(GROK_CHAT_HISTORY_FILE);
    if is_path_within(sessions_dir, &candidate) {
        vec![candidate]
    } else {
        Vec::new()
    }
}

pub fn resolve_grok_chat_history_path_sync(
    session_id: &str,
    cwd: Option<&str>,
    sessions_dir: Option<&Path>,
) -> Option<PathBuf> {
    let session_id = session_id.trim();
    if !is_safe_grok_session_id(session_id) {
        return None;
    }
    let owned = sessions_dir.map(|p| p.to_path_buf());
    let sessions = owned.unwrap_or_else(resolve_grok_sessions_dir);

    build_grok_chat_history_path_candidates(session_id, cwd, &sessions)
        .into_iter()
        .find(|candidate| is_safe_chat_history_file(&sessions, candidate))
}

/// 无 cwd 或 cwd 未命中时：扫 sessions 下一级 group 目录找 sessionId。
pub fn find_grok_chat_history_by_session_id(
    sessions_dir: &Path,
    session_id: &str,
    max_group_entries: usize,
) -> Option<PathBuf> {
    let session_id = session_id.trim();
    if !is_safe_grok_session_id(session_id) {
        return None;
    }
    let max = max_group_entries.min(GROK_SESSION_GROUP_SCAN_MAX_ENTRIES);
    if max == 0 || !sessions_dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(sessions_dir).ok()?;
    let mut eligible = 0usize;
    for entry in entries.flatten() {
        // 单个目录项读失败只跳过该项——用 `?` 会让整个扫描提前返回 None。
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        eligible += 1;
        let history = entry.path().join(session_id).join(GROK_CHAT_HISTORY_FILE);
        if is_safe_chat_history_file(sessions_dir, &history) {
            return Some(history);
        }
        if eligible >= max {
            break;
        }
    }
    None
}

pub fn resolve_grok_transcript_file(session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let sessions = resolve_grok_sessions_dir();
    if let Some(path) = resolve_grok_chat_history_path_sync(session_id, cwd, Some(&sessions)) {
        return Some(path);
    }
    find_grok_chat_history_by_session_id(&sessions, session_id, GROK_SESSION_GROUP_SCAN_MAX_ENTRIES)
}

// ── decode ──────────────────────────────────────────────────────────

fn as_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

fn extract_string(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn extract_string_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(extract_string).map(str::to_string)
}

fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(obj) = as_object(item) {
                    if let Some(t) = extract_string_field(obj, "text")
                        .or_else(|| extract_string_field(obj, "content"))
                    {
                        parts.push(t);
                    }
                } else if let Some(s) = extract_string(item) {
                    parts.push(s.to_string());
                }
            }
            parts.join("\n")
        }
        Value::Object(obj) => extract_string_field(obj, "text")
            .or_else(|| extract_string_field(obj, "content"))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn strip_user_query_wrapper(text: &str) -> String {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(start) = lower.find("<user_query>") {
        let after = start + "<user_query>".len();
        let body = &trimmed[after..];
        let body_lower = body.to_ascii_lowercase();
        if let Some(end) = body_lower.find("</user_query>") {
            return body[..end].trim().to_string();
        }
        return body.trim().to_string();
    }
    trimmed.to_string()
}

fn has_nonempty_synthetic_reason(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("synthetic_reason")
        .and_then(extract_string)
        .is_some()
}

fn is_grok_bootstrap_context(content: &Value) -> bool {
    let text = content_to_text(content);
    let normalized = text.trim().to_ascii_lowercase();
    if !normalized.starts_with("<user_info>") {
        return false;
    }
    let Some(end) = normalized.find("</user_info>") else {
        return false;
    };
    let remainder = normalized[end + "</user_info>".len()..].trim();
    remainder.is_empty()
        || (remainder.starts_with("<git_status>") && remainder.ends_with("</git_status>"))
}

fn grok_tool_call_names(value: &Value) -> Vec<String> {
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for item in arr {
        let Some(obj) = as_object(item) else {
            continue;
        };
        let name = extract_string_field(obj, "name")
            .or_else(|| extract_string_field(obj, "tool"))
            .unwrap_or_else(|| "tool".to_string());
        names.push(name);
    }
    names
}

fn grok_summary_text(value: &Value) -> Option<String> {
    if let Some(s) = extract_string(value) {
        return Some(s.to_string());
    }
    let arr = value.as_array()?;
    let mut parts = Vec::new();
    for item in arr {
        if let Some(obj) = as_object(item) {
            if let Some(t) = extract_string_field(obj, "text")
                .or_else(|| extract_string_field(obj, "summary_text"))
            {
                parts.push(t);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// 单行 JSON → 可选消息。bootstrap / 无法识别 → None。
pub fn decode_grok_transcript_line(line: &str, fallback_id: &str) -> Option<TranscriptMessage> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let obj = as_object(&value)?;
    let type_str = extract_string_field(obj, "type")?;
    let record_id = extract_string_field(obj, "id");
    let id = match record_id {
        Some(rid) => format!("{fallback_id}:{rid}"),
        None => fallback_id.to_string(),
    };
    let timestamp_ms = obj.get("timestamp").and_then(|v| {
        if let Some(n) = v.as_i64() {
            Some(n)
        } else if let Some(s) = v.as_str() {
            // ISO 粗解析：交给 chrono 可选；失败就丢
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp_millis())
        } else {
            None
        }
    });

    match type_str.as_str() {
        "user" => {
            let content = obj.get("content").unwrap_or(&Value::Null);
            if has_nonempty_synthetic_reason(obj) || is_grok_bootstrap_context(content) {
                return None;
            }
            let text = strip_user_query_wrapper(&content_to_text(content));
            if text.trim().is_empty() {
                return None;
            }
            Some(TranscriptMessage {
                id,
                role: TranscriptRole::User,
                text,
                tool_name: None,
                timestamp_ms,
            })
        }
        "assistant" => {
            let content = obj.get("content").unwrap_or(&Value::Null);
            let mut text = content_to_text(content);
            let tool_names = obj
                .get("tool_calls")
                .map(grok_tool_call_names)
                .unwrap_or_default();
            if text.trim().is_empty() && tool_names.is_empty() {
                return None;
            }
            if !tool_names.is_empty() {
                let tools = tool_names.join(", ");
                if text.trim().is_empty() {
                    text = format!("[tools: {tools}]");
                } else {
                    text = format!("{text}\n\n[tools: {tools}]");
                }
            }
            Some(TranscriptMessage {
                id,
                role: TranscriptRole::Assistant,
                text,
                tool_name: tool_names.first().cloned(),
                timestamp_ms,
            })
        }
        "reasoning" => {
            let text = extract_string_field(obj, "text")
                .or_else(|| obj.get("summary").and_then(grok_summary_text))
                .or_else(|| {
                    obj.get("content")
                        .and_then(|c| as_object(c))
                        .and_then(|o| extract_string_field(o, "text"))
                })?;
            if text.trim().is_empty() {
                return None;
            }
            Some(TranscriptMessage {
                id,
                role: TranscriptRole::Reasoning,
                text,
                tool_name: None,
                timestamp_ms,
            })
        }
        "backend_tool_call" | "tool_call" => {
            let name = obj
                .get("kind")
                .and_then(as_object)
                .and_then(|k| extract_string_field(k, "tool_type"))
                .or_else(|| extract_string_field(obj, "name"))
                .or_else(|| extract_string_field(obj, "tool"))
                .unwrap_or_else(|| "tool".to_string());
            Some(TranscriptMessage {
                id,
                role: TranscriptRole::Tool,
                text: format!("call {name}"),
                tool_name: Some(name),
                timestamp_ms,
            })
        }
        "tool_result" => {
            let content = obj
                .get("content")
                .or_else(|| obj.get("output"))
                .or_else(|| obj.get("result"))
                .unwrap_or(&Value::Null);
            let mut text = content_to_text(content);
            if text.trim().is_empty() {
                text = "(empty tool result)".to_string();
            }
            // 截断超长 tool 输出，避免 UI 被刷爆
            const TOOL_TEXT_MAX: usize = 4_000;
            if text.len() > TOOL_TEXT_MAX {
                let mut end = TOOL_TEXT_MAX;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push_str("\n…");
            }
            let is_error = obj
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || obj
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            if is_error {
                text = format!("[error] {text}");
            }
            Some(TranscriptMessage {
                id,
                role: TranscriptRole::Tool,
                text,
                tool_name: None,
                timestamp_ms,
            })
        }
        _ => None,
    }
}

pub fn read_grok_transcript_messages(path: &Path) -> Result<Vec<TranscriptMessage>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let fallback = format!("L{i}");
        if let Some(msg) = decode_grok_transcript_line(line, &fallback) {
            messages.push(msg);
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn encode_uri_component_matches_js_windows_path() {
        assert_eq!(
            encode_uri_component(r"I:\vms-workspace"),
            "I%3A%5Cvms-workspace"
        );
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(!is_safe_grok_session_id("../escape"));
        assert!(!is_safe_grok_session_id("a/b"));
        assert!(is_safe_grok_session_id(
            "40675d34-0812-4b7f-8b42-08e017efaf46"
        ));
    }

    #[test]
    fn resolve_with_cwd_finds_chat_history() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let encoded = encode_uri_component(r"I:\vms-workspace");
        let sess = sessions
            .join(&encoded)
            .join("40675d34-0812-4b7f-8b42-08e017efaf46");
        fs::create_dir_all(&sess).unwrap();
        let history = sess.join(GROK_CHAT_HISTORY_FILE);
        fs::write(&history, "{}\n").unwrap();

        let found = resolve_grok_chat_history_path_sync(
            "40675d34-0812-4b7f-8b42-08e017efaf46",
            Some(r"I:\vms-workspace"),
            Some(&sessions),
        );
        assert_eq!(found.as_deref(), Some(history.as_path()));
    }

    #[test]
    fn scan_finds_session_without_cwd() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let group = sessions.join("some-group");
        let sid = "sess-scan-1";
        let sess = group.join(sid);
        fs::create_dir_all(&sess).unwrap();
        let history = sess.join(GROK_CHAT_HISTORY_FILE);
        fs::write(&history, "{}\n").unwrap();

        let found = find_grok_chat_history_by_session_id(&sessions, sid, 100);
        assert_eq!(found.as_deref(), Some(history.as_path()));
    }

    #[test]
    fn decode_skips_bootstrap_user_info() {
        let line =
            r#"{"type":"user","id":"u1","content":"<user_info>\nOS: windows\n</user_info>"}"#;
        assert!(decode_grok_transcript_line(line, "L0").is_none());
    }

    #[test]
    fn decode_user_query_and_assistant() {
        let user =
            r#"{"type":"user","id":"u2","content":"<user_query>\nhello plan\n</user_query>"}"#;
        let msg = decode_grok_transcript_line(user, "L1").expect("user");
        assert_eq!(msg.role, TranscriptRole::User);
        assert_eq!(msg.text, "hello plan");

        let asst = r#"{"type":"assistant","id":"a1","content":[{"type":"text","text":"world"}]}"#;
        let msg = decode_grok_transcript_line(asst, "L2").expect("asst");
        assert_eq!(msg.role, TranscriptRole::Assistant);
        assert_eq!(msg.text, "world");
    }

    #[test]
    fn tool_preview_truncates_at_utf8_boundaries() {
        for (content, expected) in [
            ("a".repeat(4_001), "a".repeat(4_000)),
            ("中".repeat(1_400), "中".repeat(1_333)),
            (format!("{}🙂tail", "a".repeat(3_998)), "a".repeat(3_998)),
            (format!("{}中tail", "a".repeat(3_999)), "a".repeat(3_999)),
        ] {
            for is_error in [false, true] {
                let line = serde_json::json!({
                    "type": "tool_result", "content": content, "is_error": is_error
                });
                let msg = decode_grok_transcript_line(&line.to_string(), "L0").unwrap();
                let prefix = if is_error { "[error] " } else { "" };
                assert_eq!(msg.role, TranscriptRole::Tool);
                assert_eq!(msg.text, format!("{prefix}{expected}\n…"));
            }
        }
    }

    #[test]
    fn tool_preview_preserves_exact_limit_and_short_unicode() {
        for content in ["a".repeat(4_000), "🙂".repeat(1_000), "中文🙂".into()] {
            let line = serde_json::json!({ "type": "tool_result", "output": content });
            let msg = decode_grok_transcript_line(&line.to_string(), "L0").unwrap();
            assert_eq!(msg.text, content);
        }
    }

    #[test]
    fn read_file_applies_pagination_window_via_caller() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(GROK_CHAT_HISTORY_FILE);
        let mut f = fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","id":"1","content":"<user_query>one</user_query>"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"assistant","id":"2","content":"two"}}"#).unwrap();
        let msgs = read_grok_transcript_messages(&path).unwrap();
        assert_eq!(msgs.len(), 2);
    }
}
