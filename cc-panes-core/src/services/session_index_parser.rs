use crate::models::ParsedSessionTranscript;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const TAIL_BLOCK_SIZE: usize = 8192;
const MAX_PI_SESSION_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PI_SESSION_LINES: usize = 200_000;
const MAX_PI_SESSION_LINE_BYTES: usize = 1024 * 1024;
const MAX_PI_SESSION_ENTRIES: usize = 100_000;
const MAX_PI_ID_BYTES: usize = 512;
const MAX_PI_CWD_BYTES: usize = 8 * 1024;
const MAX_PI_TIMESTAMP_BYTES: usize = 128;

#[derive(Debug, Clone)]
struct PiSessionEntry {
    parent_id: Option<String>,
    user_prompt: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct PiTranscriptLimits {
    max_file_bytes: u64,
    max_lines: usize,
    max_line_bytes: usize,
    max_entries: usize,
}

const PI_TRANSCRIPT_LIMITS: PiTranscriptLimits = PiTranscriptLimits {
    max_file_bytes: MAX_PI_SESSION_FILE_BYTES,
    max_lines: MAX_PI_SESSION_LINES,
    max_line_bytes: MAX_PI_SESSION_LINE_BYTES,
    max_entries: MAX_PI_SESSION_ENTRIES,
};

#[derive(Debug, Clone, Copy)]
struct BoundedJsonlLine {
    bytes_read: usize,
    oversized: bool,
}

pub fn parse_session_transcript(
    cli_tool: &str,
    path: &Path,
) -> Result<ParsedSessionTranscript, String> {
    if cli_tool == "pi" {
        return parse_pi_session_transcript(path);
    }

    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut bytes_read = 0u64;
    let mut session_id = (cli_tool == "claude")
        .then(|| {
            path.file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .flatten()
        .unwrap_or_default();
    let mut cwd = String::new();
    let mut first_prompt = String::new();
    let mut message_count = 0u64;

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        bytes_read += read as u64;
        let Ok(json) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match cli_tool {
            "claude" => parse_claude_line(&json, &mut cwd, &mut first_prompt, &mut message_count),
            "codex" => parse_codex_line(
                &json,
                &mut session_id,
                &mut cwd,
                &mut first_prompt,
                &mut message_count,
            ),
            _ => return Err(format!("Unsupported session CLI: {cli_tool}")),
        }
    }

    if session_id.is_empty() {
        return Err("Session id is missing from transcript".to_string());
    }
    let (last_summary, tail_bytes) = extract_last_summary(cli_tool, path)?;
    Ok(ParsedSessionTranscript {
        session_id,
        cwd,
        header_timestamp: None,
        first_prompt,
        last_summary,
        message_count,
        bytes_read: bytes_read + tail_bytes,
    })
}

/// Pi persists an append-only tree rather than a linear transcript. Its last
/// persisted entry is the active leaf, so summary fields must be resolved from
/// that leaf's ancestry rather than from the last text anywhere in the file.
fn parse_pi_session_transcript(path: &Path) -> Result<ParsedSessionTranscript, String> {
    parse_pi_session_transcript_with_limits(path, PI_TRANSCRIPT_LIMITS)
}

fn parse_pi_session_transcript_with_limits(
    path: &Path,
    limits: PiTranscriptLimits,
) -> Result<ParsedSessionTranscript, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > limits.max_file_bytes {
        return Err(format!(
            "Pi session file exceeds the {} byte indexing limit",
            limits.max_file_bytes
        ));
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut bytes_read = 0u64;
    let mut lines_read = 0usize;
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut header_timestamp = None;
    let mut message_count = 0u64;
    let mut entries = HashMap::<String, PiSessionEntry>::new();
    let mut active_leaf_id = None;

    while let Some(read) = read_bounded_jsonl_line(&mut reader, &mut line, limits.max_line_bytes)
        .map_err(|error| error.to_string())?
    {
        lines_read += 1;
        if lines_read > limits.max_lines {
            return Err(format!(
                "Pi session exceeds the {} line indexing limit",
                limits.max_lines
            ));
        }
        bytes_read = bytes_read.saturating_add(read.bytes_read as u64);
        if read.oversized {
            continue;
        }
        let Ok(json) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let entry_type = json.get("type").and_then(Value::as_str);
        if entry_type == Some("session") {
            if session_id.is_empty() {
                session_id = pi_string(&json, "id", MAX_PI_ID_BYTES).unwrap_or_default();
            }
            if cwd.is_empty() {
                cwd = pi_string(&json, "cwd", MAX_PI_CWD_BYTES).unwrap_or_default();
            }
            if header_timestamp.is_none() {
                header_timestamp = pi_string(&json, "timestamp", MAX_PI_TIMESTAMP_BYTES);
            }
            continue;
        }

        if entry_type == Some("message") {
            // Count all message entries, including tool results and malformed
            // content, so Pi's transcript cardinality remains faithful.
            message_count += 1;
        }
        let Some(id) = pi_string(&json, "id", MAX_PI_ID_BYTES) else {
            continue;
        };
        if !entries.contains_key(&id) && entries.len() >= limits.max_entries {
            return Err(format!(
                "Pi session exceeds the {} entry indexing limit",
                limits.max_entries
            ));
        }
        let parent_id = pi_string(&json, "parentId", MAX_PI_ID_BYTES);
        let user_prompt = (entry_type == Some("message")
            && json.pointer("/message/role").and_then(Value::as_str) == Some("user"))
        .then(|| pi_message_text(&json))
        .flatten();
        entries.insert(
            id.clone(),
            PiSessionEntry {
                parent_id,
                user_prompt,
                summary: pi_summary_from_entry(&json),
            },
        );
        active_leaf_id = Some(id);
    }

    if session_id.is_empty() {
        return Err("Session id is missing from transcript".to_string());
    }
    let ancestry = pi_active_ancestry(&entries, active_leaf_id.as_deref());
    let first_prompt = ancestry
        .iter()
        .find_map(|entry| entry.user_prompt.clone())
        .unwrap_or_default();
    let last_summary = ancestry
        .iter()
        .rev()
        .find_map(|entry| entry.summary.clone())
        .unwrap_or_default();

    Ok(ParsedSessionTranscript {
        session_id,
        cwd,
        header_timestamp,
        first_prompt,
        last_summary,
        message_count,
        bytes_read,
    })
}

fn read_bounded_jsonl_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    max_line_bytes: usize,
) -> std::io::Result<Option<BoundedJsonlLine>> {
    line.clear();
    let mut bytes_read = 0usize;
    let mut oversized = false;

    loop {
        let (take, has_newline) = {
            let buffer = reader.fill_buf()?;
            if buffer.is_empty() {
                return Ok((bytes_read > 0).then_some(BoundedJsonlLine {
                    bytes_read,
                    oversized,
                }));
            }
            let newline = buffer.iter().position(|byte| *byte == b'\n');
            let take = newline.map_or(buffer.len(), |index| index + 1);
            if !oversized && line.len().saturating_add(take) <= max_line_bytes {
                line.extend_from_slice(&buffer[..take]);
            } else {
                oversized = true;
            }
            (take, newline.is_some())
        };
        reader.consume(take);
        bytes_read = bytes_read.saturating_add(take);
        if has_newline {
            return Ok(Some(BoundedJsonlLine {
                bytes_read,
                oversized,
            }));
        }
    }
}

fn pi_string(json: &Value, key: &str, max_bytes: usize) -> Option<String> {
    json.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes)
        .map(str::to_string)
}

fn pi_active_ancestry<'a>(
    entries: &'a HashMap<String, PiSessionEntry>,
    active_leaf_id: Option<&str>,
) -> Vec<&'a PiSessionEntry> {
    let mut ancestry = Vec::new();
    let mut seen = HashSet::new();
    let mut current_id = active_leaf_id.map(str::to_string);

    while let Some(id) = current_id {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(entry) = entries.get(&id) else {
            break;
        };
        current_id = entry.parent_id.clone();
        ancestry.push(entry);
    }
    ancestry.reverse();
    ancestry
}

fn pi_message_text(json: &Value) -> Option<String> {
    pi_content_preview(json.pointer("/message/content")?, "text")
}

fn pi_summary_from_entry(json: &Value) -> Option<String> {
    match json.get("type").and_then(Value::as_str) {
        Some("message")
            if matches!(
                json.pointer("/message/role").and_then(Value::as_str),
                Some("user" | "assistant")
            ) =>
        {
            pi_message_text(json)
        }
        Some("compaction" | "branch_summary") => pi_string_preview(json, "summary"),
        _ => None,
    }
}

fn pi_string_preview(json: &Value, key: &str) -> Option<String> {
    json.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(truncate_text)
}

fn pi_content_preview(content: &Value, text_key: &str) -> Option<String> {
    if let Some(text) = content
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(truncate_text(text));
    }

    let mut preview = String::new();
    let mut found_text = false;
    let mut truncated = false;
    for text in content
        .as_array()?
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|item| item.get(text_key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty() && !text.contains("tool_use_id"))
    {
        if found_text && append_pi_preview(&mut preview, "\n") {
            truncated = true;
            break;
        }
        found_text = true;
        if append_pi_preview(&mut preview, text) {
            truncated = true;
            break;
        }
    }
    if !found_text {
        return None;
    }
    if truncated {
        preview.push_str("...");
    }
    Some(preview)
}

fn append_pi_preview(preview: &mut String, text: &str) -> bool {
    for character in text.chars() {
        if preview.chars().count() >= 80 {
            return true;
        }
        preview.push(character);
    }
    false
}

fn parse_claude_line(
    json: &Value,
    cwd: &mut String,
    first_prompt: &mut String,
    message_count: &mut u64,
) {
    if cwd.is_empty() {
        *cwd = json
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }
    let role = json.get("type").and_then(Value::as_str);
    if !matches!(role, Some("user" | "assistant")) {
        return;
    }
    *message_count += 1;
    if role == Some("user") && first_prompt.is_empty() && json.get("data").is_none() {
        if let Some(text) = claude_message_text(json).filter(|text| !skip_claude_prompt(text)) {
            *first_prompt = truncate_text(&text);
        }
    }
}

fn parse_codex_line(
    json: &Value,
    session_id: &mut String,
    cwd: &mut String,
    first_prompt: &mut String,
    message_count: &mut u64,
) {
    if json.get("type").and_then(Value::as_str) == Some("session_meta") {
        if let Some(payload) = json.get("payload") {
            *session_id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            *cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        return;
    }
    let Some(payload) = json.get("payload") else {
        return;
    };
    if json.get("type").and_then(Value::as_str) != Some("response_item")
        || payload.get("type").and_then(Value::as_str) != Some("message")
    {
        return;
    }
    *message_count += 1;
    if payload.get("role").and_then(Value::as_str) == Some("user") && first_prompt.is_empty() {
        if let Some(text) = codex_message_text(payload).filter(|text| !skip_codex_prompt(text)) {
            *first_prompt = truncate_text(&text);
        }
    }
}

fn extract_last_summary(cli_tool: &str, path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut position = file.metadata().map_err(|error| error.to_string())?.len();
    let mut carry = Vec::new();
    let mut bytes_read = 0u64;

    while position > 0 {
        let chunk_size = position.min(TAIL_BLOCK_SIZE as u64) as usize;
        position -= chunk_size as u64;
        file.seek(SeekFrom::Start(position))
            .map_err(|error| error.to_string())?;
        let mut chunk = vec![0u8; chunk_size];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        bytes_read += chunk_size as u64;
        chunk.extend_from_slice(&carry);

        let mut lines = chunk.split(|byte| *byte == b'\n');
        let first = lines.next().unwrap_or_default().to_vec();
        let complete = lines.collect::<Vec<_>>();
        for raw in complete.into_iter().rev() {
            if let Some(summary) = summary_from_line(cli_tool, raw) {
                return Ok((truncate_text(&summary), bytes_read));
            }
        }
        carry = first;
    }

    Ok((
        summary_from_line(cli_tool, &carry)
            .map(|summary| truncate_text(&summary))
            .unwrap_or_default(),
        bytes_read,
    ))
}

fn summary_from_line(cli_tool: &str, raw: &[u8]) -> Option<String> {
    let json = serde_json::from_slice::<Value>(raw).ok()?;
    match cli_tool {
        "claude" => matches!(
            json.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        )
        .then(|| claude_message_text(&json))
        .flatten(),
        "codex" => {
            let payload = json.get("payload")?;
            (json.get("type").and_then(Value::as_str) == Some("response_item")
                && payload.get("type").and_then(Value::as_str) == Some("message")
                && matches!(
                    payload.get("role").and_then(Value::as_str),
                    Some("user" | "assistant")
                ))
            .then(|| codex_message_text(payload))
            .flatten()
        }
        _ => None,
    }
}

fn claude_message_text(json: &Value) -> Option<String> {
    content_text(json.get("message")?.get("content")?, "text")
}

fn codex_message_text(payload: &Value) -> Option<String> {
    content_text(payload.get("content")?, "text")
}

fn content_text(content: &Value, text_key: &str) -> Option<String> {
    if let Some(text) = content
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    let texts = content
        .as_array()?
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|item| item.get(text_key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty() && !text.contains("tool_use_id"))
        .collect::<Vec<_>>();
    (!texts.is_empty()).then(|| texts.join("\n"))
}

fn skip_claude_prompt(text: &str) -> bool {
    text.starts_with("[Request interrupted")
        || text.starts_with("Implement the following plan")
        || text.chars().count() < 5
}

fn skip_codex_prompt(text: &str) -> bool {
    let text = text.trim();
    text.chars().count() < 3
        || text == "继续"
        || text.eq_ignore_ascii_case("continue")
        || text.starts_with("# AGENTS.md instructions")
        || text.contains("<environment_context>")
}

fn truncate_text(text: &str) -> String {
    let mut chars = text.trim().chars();
    let value = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        format!("{value}...")
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_pi_session_transcript_with_limits, PiTranscriptLimits};
    use std::fs;
    use tempfile::tempdir;

    fn limits() -> PiTranscriptLimits {
        PiTranscriptLimits {
            max_file_bytes: 4 * 1024,
            max_lines: 10,
            max_line_bytes: 256,
            max_entries: 10,
        }
    }

    #[test]
    fn pi_parser_skips_an_oversized_record_without_losing_later_entries() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("bounded-pi.jsonl");
        let header = serde_json::json!({
            "type": "session",
            "id": "bounded-pi",
            "cwd": "/workspace/pi",
        });
        let oversized = serde_json::json!({
            "type": "message",
            "id": "oversized-user",
            "message": {"role": "user", "content": "x".repeat(512)},
        });
        let assistant = serde_json::json!({
            "type": "message",
            "id": "assistant",
            "parentId": "oversized-user",
            "message": {"role": "assistant", "content": "Done"},
        });
        fs::write(&path, format!("{header}\n{oversized}\n{assistant}\n"))
            .expect("write Pi transcript");

        let parsed = parse_pi_session_transcript_with_limits(&path, limits())
            .expect("parse bounded Pi transcript");
        assert_eq!(parsed.session_id, "bounded-pi");
        assert_eq!(parsed.first_prompt, "");
        assert_eq!(parsed.last_summary, "Done");
        assert_eq!(parsed.message_count, 1);
    }

    #[test]
    fn pi_parser_rejects_file_line_and_entry_limits() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("limits-pi.jsonl");
        let header = r#"{"type":"session","id":"limited-pi","cwd":"/workspace/pi"}"#;
        let first = r#"{"type":"message","id":"first","message":{"role":"user","content":"one"}}"#;
        let second = r#"{"type":"message","id":"second","parentId":"first","message":{"role":"assistant","content":"two"}}"#;
        fs::write(&path, format!("{header}\n{first}\n{second}\n")).expect("write Pi transcript");

        let file_error = parse_pi_session_transcript_with_limits(
            &path,
            PiTranscriptLimits {
                max_file_bytes: 1,
                ..limits()
            },
        )
        .expect_err("small file limit must reject transcript");
        assert!(file_error.contains("byte indexing limit"));

        let line_error = parse_pi_session_transcript_with_limits(
            &path,
            PiTranscriptLimits {
                max_lines: 1,
                ..limits()
            },
        )
        .expect_err("small line limit must reject transcript");
        assert!(line_error.contains("line indexing limit"));

        let entry_error = parse_pi_session_transcript_with_limits(
            &path,
            PiTranscriptLimits {
                max_entries: 1,
                ..limits()
            },
        )
        .expect_err("small entry limit must reject transcript");
        assert!(entry_error.contains("entry indexing limit"));
    }
}
