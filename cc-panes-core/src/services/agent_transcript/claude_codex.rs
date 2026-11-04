//! Claude / Codex 原生 JSONL → TranscriptMessage。
//!
//! 只读、按 session id 精确匹配文件名。工具输入/输出按 [`MAX_TOOL_TEXT_CHARS`] 截断：
//! 一条工具结果可达数 MB，而消费方（对话视图、复制为 Markdown）都不需要完整内容；
//! 要原始内容走「导出完整记录」。

use crate::models::{TranscriptMessage, TranscriptRole};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_TOOL_TEXT_CHARS: usize = 2_000;

/// CLI 自动注入、不是用户亲手输入的内容。
const CLAUDE_INJECTED_PREFIXES: &[&str] = &[
    "<system-reminder>",
    "<local-command-",
    "<command-name>",
    "<command-message>",
];
const CODEX_INJECTED_PREFIXES: &[&str] = &[
    "<environment_context>",
    "<user_instructions>",
    "<turn_aborted>",
    "<permissions instructions>",
    "# AGENTS.md instructions",
];

fn is_injected(text: &str, prefixes: &[&str]) -> bool {
    let text = text.trim_start();
    prefixes.iter().any(|prefix| text.starts_with(prefix))
}

fn truncate_tool_text(text: &str) -> String {
    if text.chars().count() <= MAX_TOOL_TEXT_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_TOOL_TEXT_CHARS).collect();
    format!("{head}…")
}

fn timestamp_ms(line: &Value) -> Option<i64> {
    let raw = line.get("timestamp")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn message(
    id: String,
    role: TranscriptRole,
    text: String,
    tool_name: Option<String>,
    timestamp_ms: Option<i64>,
) -> TranscriptMessage {
    TranscriptMessage {
        id,
        role,
        text,
        tool_name,
        timestamp_ms,
    }
}

/// `tool_result.content` 可能是字符串或 `[{type:text,text}]`。
fn claude_tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn decode_claude_block(
    block: &Value,
    id: String,
    is_user: bool,
    timestamp: Option<i64>,
) -> Option<TranscriptMessage> {
    let text_of = |key: &str| block.get(key).and_then(Value::as_str).unwrap_or_default();
    match block.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = text_of("text");
            if text.trim().is_empty() || (is_user && is_injected(text, CLAUDE_INJECTED_PREFIXES)) {
                return None;
            }
            let role = if is_user {
                TranscriptRole::User
            } else {
                TranscriptRole::Assistant
            };
            Some(message(id, role, text.to_string(), None, timestamp))
        }
        "thinking" => {
            let text = text_of("thinking");
            (!text.trim().is_empty()).then(|| {
                message(
                    id,
                    TranscriptRole::Reasoning,
                    text.to_string(),
                    None,
                    timestamp,
                )
            })
        }
        "tool_use" => Some(message(
            id,
            TranscriptRole::Tool,
            truncate_tool_text(&block.get("input").map(Value::to_string).unwrap_or_default()),
            block
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            timestamp,
        )),
        "tool_result" => Some(message(
            id,
            TranscriptRole::Tool,
            truncate_tool_text(&claude_tool_result_text(block.get("content"))),
            None,
            timestamp,
        )),
        _ => None,
    }
}

/// 解码一行 Claude 记录。子 agent（`isSidechain`）与注入消息（`isMeta`）不属于主对话。
pub fn decode_claude_line(raw: &str, line_no: usize) -> Vec<TranscriptMessage> {
    let Ok(line) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let kind = line.get("type").and_then(Value::as_str).unwrap_or_default();
    let is_user = match kind {
        "user" => true,
        "assistant" => false,
        _ => return Vec::new(),
    };
    let flag = |key: &str| line.get(key).and_then(Value::as_bool).unwrap_or(false);
    if flag("isMeta") || flag("isSidechain") {
        return Vec::new();
    }
    let timestamp = timestamp_ms(&line);
    // 流式写入时同一消息会拆到多行，uuid 逐行唯一；没有 uuid 时退回行号。
    let base = line
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("L{line_no}"));
    let content = line.get("message").and_then(|value| value.get("content"));
    match content {
        Some(Value::String(text)) => decode_claude_block(
            &serde_json::json!({ "type": "text", "text": text }),
            format!("{base}:0"),
            is_user,
            timestamp,
        )
        .into_iter()
        .collect(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| {
                decode_claude_block(block, format!("{base}:{index}"), is_user, timestamp)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn codex_message_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn codex_reasoning_text(payload: &Value) -> String {
    payload
        .get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// 解码一行 Codex rollout。只取 `response_item`：`event_msg` 是同一内容的 UI 事件，
/// 一起取会重复。
pub fn decode_codex_line(raw: &str, line_no: usize) -> Option<TranscriptMessage> {
    let line = serde_json::from_str::<Value>(raw).ok()?;
    if line.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = line.get("payload")?;
    let id = format!("L{line_no}");
    let timestamp = timestamp_ms(&line);
    let text_of = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default();
    let tool_name = || {
        payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let (role, text, name) = match payload.get("type").and_then(Value::as_str)? {
        "message" => {
            let text = codex_message_text(payload);
            match payload.get("role").and_then(Value::as_str)? {
                "user" if !is_injected(&text, CODEX_INJECTED_PREFIXES) => {
                    (TranscriptRole::User, text, None)
                }
                "assistant" => (TranscriptRole::Assistant, text, None),
                _ => return None,
            }
        }
        "reasoning" => (
            TranscriptRole::Reasoning,
            codex_reasoning_text(payload),
            None,
        ),
        "function_call" => (
            TranscriptRole::Tool,
            truncate_tool_text(text_of("arguments")),
            tool_name(),
        ),
        "custom_tool_call" => (
            TranscriptRole::Tool,
            truncate_tool_text(text_of("input")),
            tool_name(),
        ),
        "function_call_output" | "custom_tool_call_output" => (
            TranscriptRole::Tool,
            truncate_tool_text(text_of("output")),
            None,
        ),
        _ => return None,
    };
    if text.trim().is_empty() && name.is_none() {
        return None;
    }
    Some(message(id, role, text, name, timestamp))
}

pub fn read_claude_messages(path: &Path) -> Result<Vec<TranscriptMessage>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(content
        .lines()
        .enumerate()
        .flat_map(|(index, line)| decode_claude_line(line, index))
        .collect())
}

pub fn read_codex_messages(path: &Path) -> Result<Vec<TranscriptMessage>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| decode_codex_line(line, index))
        .collect())
}

/// `<root>/<encoded-project>/<session>.jsonl`。id 已由调用方校验不含路径分隔符。
pub fn find_claude_file(session_id: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    roots.iter().find_map(|root| {
        fs::read_dir(root)
            .ok()?
            .flatten()
            .map(|project| project.path().join(&file_name))
            .find(|candidate| candidate.is_file())
    })
}

fn find_codex_file_under(dir: &Path, suffix: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_codex_file_under(&path, suffix) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(suffix))
        {
            return Some(path);
        }
    }
    None
}

/// `<sessions>/YYYY/MM/DD/rollout-<time>-<session>.jsonl`。
pub fn find_codex_file(session_id: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    roots
        .iter()
        .find_map(|root| find_codex_file_under(root, &suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn claude_keeps_conversation_and_drops_injected_lines() {
        let body = [
            r#"{"type":"user","uuid":"u1","timestamp":"2026-11-02T10:00:00Z","message":{"content":"你好"}}"#,
            r#"{"type":"user","uuid":"u2","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","uuid":"u3","message":{"content":"<system-reminder>x</system-reminder>"}}"#,
            r#"{"type":"assistant","uuid":"a0","isSidechain":true,"message":{"content":[{"type":"text","text":"sub"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"答"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","uuid":"u4","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"out"}]}]}}"#,
            r#"{"type":"mode","sessionId":"s"}"#,
            "not json",
        ];
        let messages: Vec<_> = body
            .iter()
            .enumerate()
            .flat_map(|(index, line)| decode_claude_line(line, index))
            .collect();
        let shape: Vec<_> = messages
            .iter()
            .map(|m| (m.role, m.text.as_str(), m.tool_name.as_deref()))
            .collect();
        assert_eq!(
            shape,
            vec![
                (TranscriptRole::User, "你好", None),
                (TranscriptRole::Reasoning, "想", None),
                (TranscriptRole::Assistant, "答", None),
                (TranscriptRole::Tool, r#"{"command":"ls"}"#, Some("Bash")),
                (TranscriptRole::Tool, "out", None),
            ]
        );
        assert_eq!(messages[0].id, "u1:0");
        assert_eq!(messages[0].timestamp_ms, Some(1_793_613_600_000));
    }

    #[test]
    fn claude_block_ids_stay_unique_within_a_line() {
        let raw = r#"{"type":"assistant","uuid":"a","message":{"content":[{"type":"text","text":"1"},{"type":"text","text":"2"}]}}"#;
        let ids: Vec<_> = decode_claude_line(raw, 0)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["a:0", "a:1"]);
    }

    #[test]
    fn codex_reads_response_items_only() {
        let body = [
            r#"{"type":"session_meta","payload":{"id":"x"}}"#,
            r#"{"type":"event_msg","payload":{"type":"agent_message","message":"重复"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"问"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"想"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"ok"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"答"}]}}"#,
        ];
        let shape: Vec<_> = body
            .iter()
            .enumerate()
            .filter_map(|(index, line)| decode_codex_line(line, index))
            .map(|m| (m.role, m.text, m.tool_name))
            .collect();
        assert_eq!(
            shape,
            vec![
                (TranscriptRole::User, "问".to_string(), None),
                (TranscriptRole::Reasoning, "想".to_string(), None),
                (
                    TranscriptRole::Tool,
                    "{}".to_string(),
                    Some("shell".to_string())
                ),
                (TranscriptRole::Tool, "ok".to_string(), None),
                (TranscriptRole::Assistant, "答".to_string(), None),
            ]
        );
    }

    #[test]
    fn tool_text_is_truncated_on_char_boundaries() {
        let long = "汉".repeat(MAX_TOOL_TEXT_CHARS + 5);
        let cut = truncate_tool_text(&long);
        assert_eq!(cut.chars().count(), MAX_TOOL_TEXT_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn finds_session_files_by_exact_id() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("claude/-work");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("abc.jsonl"), "").unwrap();
        fs::write(project.join("abcd.jsonl"), "").unwrap();
        let roots = vec![dir.path().join("missing"), dir.path().join("claude")];
        assert_eq!(
            find_claude_file("abc", &roots),
            Some(project.join("abc.jsonl"))
        );
        assert_eq!(find_claude_file("ab", &roots), None);

        let day = dir.path().join("codex/2026/11/02");
        fs::create_dir_all(&day).unwrap();
        let rollout = day.join("rollout-2026-11-02T10-00-00-abc.jsonl");
        fs::write(&rollout, "").unwrap();
        let roots = vec![dir.path().join("codex")];
        assert_eq!(find_codex_file("abc", &roots), Some(rollout));
        assert_eq!(find_codex_file("bc", &roots), None);
    }
}
