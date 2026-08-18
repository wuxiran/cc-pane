//! Pi session JSONL readers shared by history, usage, and context views.
//!
//! Pi writes a `session` header followed by append-only tree entries. Keep the
//! format handling here so consumers do not infer identity from file names.

use crate::models::UsageEntry;
use chrono::{DateTime, Local, TimeZone};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

const MAX_HEADER_SCAN_BYTES: usize = 1024 * 1024;
const MAX_CONTEXT_USAGE_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_CONTEXT_USAGE_LINES: usize = 100_000;
const MAX_CONTEXT_USAGE_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PiSessionMetadata {
    pub session_id: String,
    pub cwd: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PiLatestContextUsage {
    pub usage: UsageEntry,
    pub model: Option<String>,
}

/// Read the Pi header without relying on the filename. The upstream reader is
/// deliberately tolerant of blank or malformed prefixes, so ours is too.
pub(crate) fn read_session_metadata(path: &Path) -> Option<PiSessionMetadata> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut scanned = 0usize;

    loop {
        line.clear();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 || scanned.saturating_add(read) > MAX_HEADER_SCAN_BYTES {
            return None;
        }
        scanned += read;
        let Ok(json) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(metadata) = metadata_from_value(&json) {
            return Some(metadata);
        }
    }
}

pub(crate) fn read_session_usage(
    jsonl_path: &Path,
    from_byte_offset: u64,
) -> Result<(Vec<UsageEntry>, u64), String> {
    let mut file = File::open(jsonl_path).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let start = from_byte_offset.min(len);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut offset = start;
    let mut entries = Vec::new();
    let mut seen_entry_ids = HashSet::new();

    loop {
        let mut buffer = Vec::new();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 || !buffer.ends_with(b"\n") {
            break;
        }
        offset = offset.saturating_add(read as u64);
        let Ok(json) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        let Some(entry) = usage_from_entry(&json).filter(|entry| !entry.is_empty()) else {
            continue;
        };
        if let Some(id) = json.get("id").and_then(Value::as_str) {
            if !seen_entry_ids.insert(id.to_string()) {
                continue;
            }
        }
        entries.push(entry);
    }

    Ok((entries, offset))
}

/// Read the latest assistant usage record for a live context indicator.
pub(crate) fn read_latest_context_usage(
    jsonl_path: &Path,
    from_byte_offset: u64,
) -> Result<(Option<PiLatestContextUsage>, u64), String> {
    let mut file = File::open(jsonl_path).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    if len > MAX_CONTEXT_USAGE_FILE_BYTES {
        return Err("Pi context usage file exceeds read limit".to_string());
    }
    let start = from_byte_offset.min(len);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut offset = start;
    let mut lines_read = 0usize;
    let mut latest = None;

    loop {
        if lines_read >= MAX_CONTEXT_USAGE_LINES {
            break;
        }
        let mut buffer = Vec::new();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 || !buffer.ends_with(b"\n") {
            break;
        }
        lines_read += 1;
        offset = offset.saturating_add(read as u64);
        if buffer.len() > MAX_CONTEXT_USAGE_LINE_BYTES {
            continue;
        }
        let Ok(json) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        let Some(value) = context_usage_from_entry(&json) else {
            continue;
        };
        latest = Some(value);
    }

    Ok((latest, offset))
}

fn metadata_from_value(json: &Value) -> Option<PiSessionMetadata> {
    if json.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let session_id = json.get("id")?.as_str()?.trim();
    if session_id.is_empty() {
        return None;
    }
    Some(PiSessionMetadata {
        session_id: session_id.to_string(),
        cwd: json
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        timestamp: json
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn usage_from_entry(json: &Value) -> Option<UsageEntry> {
    let usage = match json.get("type").and_then(Value::as_str) {
        Some("message")
            if json.pointer("/message/role").and_then(Value::as_str) == Some("assistant") =>
        {
            json.pointer("/message/usage")?
        }
        Some("compaction" | "branch_summary") => json.get("usage")?,
        _ => return None,
    };
    Some(usage_entry(usage, usage_date(json)))
}

fn context_usage_from_entry(json: &Value) -> Option<PiLatestContextUsage> {
    if json.get("type").and_then(Value::as_str) != Some("message")
        || json.pointer("/message/role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    let usage = json.pointer("/message/usage")?;
    let input = required_number(usage, &["input", "inputTokens", "input_tokens"])?;
    let entry = UsageEntry {
        date: usage_date(json),
        token_input: input,
        token_output: number(usage, &["output", "outputTokens", "output_tokens"]),
        token_cache_read: number(usage, &["cacheRead", "cache_read"]),
        token_cache_creation: number(usage, &["cacheWrite", "cache_write"]),
    };
    Some(PiLatestContextUsage {
        usage: entry,
        model: json
            .pointer("/message/responseModel")
            .and_then(Value::as_str)
            .or_else(|| json.pointer("/message/model").and_then(Value::as_str))
            .map(str::to_string),
    })
}

fn usage_entry(usage: &Value, date: String) -> UsageEntry {
    UsageEntry {
        date,
        token_input: number(usage, &["input", "inputTokens", "input_tokens"]),
        token_output: number(usage, &["output", "outputTokens", "output_tokens"]),
        token_cache_read: number(usage, &["cacheRead", "cache_read"]),
        token_cache_creation: number(usage, &["cacheWrite", "cache_write"]),
    }
}

fn number(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn required_number(value: &Value, names: &[&str]) -> Option<u64> {
    names
        .iter()
        .find_map(|name| value.get(*name))
        .and_then(Value::as_u64)
}

fn usage_date(json: &Value) -> String {
    json.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_local_date)
        .or_else(|| {
            json.pointer("/message/timestamp")
                .and_then(Value::as_i64)
                .and_then(parse_local_epoch_millis)
        })
        .unwrap_or_else(today)
}

fn parse_local_date(timestamp: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(timestamp).ok().map(|value| {
        value
            .with_timezone(&Local)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    })
}

fn parse_local_epoch_millis(timestamp: i64) -> Option<String> {
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .map(|value| value.date_naive().format("%Y-%m-%d").to_string())
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::{read_latest_context_usage, read_session_metadata, read_session_usage};
    use std::fs;
    use tempfile::NamedTempFile;

    fn write(content: &str) -> std::path::PathBuf {
        let temp = NamedTempFile::new().expect("temp file");
        let (_, path) = temp.keep().expect("persist temp file");
        fs::write(&path, content).expect("write fixture");
        path
    }

    #[test]
    fn reads_pi_header_without_using_the_file_name() {
        let path = write(concat!(
            "\n",
            r#"{"type":"session","id":"pi-session-7","timestamp":"2026-08-18T00:00:00Z","cwd":"/workspace/pi"}"#,
            "\n"
        ));

        let metadata = read_session_metadata(&path).expect("Pi header");
        assert_eq!(metadata.session_id, "pi-session-7");
        assert_eq!(metadata.cwd, "/workspace/pi");
        assert_eq!(metadata.timestamp.as_deref(), Some("2026-08-18T00:00:00Z"));
    }

    #[test]
    fn reads_usage_from_assistant_and_summary_entries_once() {
        let path = write(concat!(
            r#"{"type":"session","id":"pi-1","cwd":"/workspace/pi"}"#,
            "\n",
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-08-18T00:00:00Z","message":{"role":"assistant","usage":{"input":10,"output":3,"cacheRead":4,"cacheWrite":5}}}"#,
            "\n",
            r#"{"type":"compaction","id":"c1","parentId":"a1","timestamp":"2026-08-18T00:01:00Z","usage":{"input":2,"output":1,"cacheRead":0,"cacheWrite":1}}"#,
            "\n",
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-08-18T00:02:00Z","message":{"role":"assistant","usage":{"input":99,"output":99,"cacheRead":99,"cacheWrite":99}}}"#,
            "\n"
        ));

        let (entries, _) = read_session_usage(&path, 0).expect("Pi usage");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].token_input, 10);
        assert_eq!(entries[0].token_output, 3);
        assert_eq!(entries[0].token_cache_read, 4);
        assert_eq!(entries[0].token_cache_creation, 5);
        assert_eq!(entries[1].token_input, 2);
        assert_eq!(entries[1].token_cache_creation, 1);
    }

    #[test]
    fn reads_the_latest_assistant_context_usage() {
        let path = write(concat!(
            r#"{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"hello"}}"#,
            "\n",
            r#"{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","model":"requested","responseModel":"resolved","usage":{"input":50,"output":7,"cacheRead":4,"cacheWrite":6}}}"#,
            "\n"
        ));

        let (latest, _) = read_latest_context_usage(&path, 0).expect("context usage");
        let latest = latest.expect("assistant context usage");
        assert_eq!(latest.usage.token_input, 50);
        assert_eq!(latest.usage.token_cache_read, 4);
        assert_eq!(latest.usage.token_cache_creation, 6);
        assert_eq!(latest.model.as_deref(), Some("resolved"));
    }
}
