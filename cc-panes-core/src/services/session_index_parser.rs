use crate::models::ParsedSessionTranscript;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

const TAIL_BLOCK_SIZE: usize = 8192;

pub fn parse_session_transcript(
    cli_tool: &str,
    path: &Path,
) -> Result<ParsedSessionTranscript, String> {
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
        first_prompt,
        last_summary,
        message_count,
        bytes_read: bytes_read + tail_bytes,
    })
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
