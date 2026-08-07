//! Token usage readers for CLI tools whose session formats are not JSONL.

use crate::models::UsageEntry;
use chrono::{DateTime, Local, TimeZone};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SESSION_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_COLLECT_DEPTH: usize = 16;

pub fn collect_gemini_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files_named(&root.join("tmp"), "", &mut files, 0, |path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("session-") && name.ends_with(".json"))
    });
    files
}

pub fn collect_grok_usage_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files_named(root, "updates.jsonl", &mut files, 0, |_| true);
    files
}

pub fn opencode_db_path(home: &Path, use_environment_override: bool) -> PathBuf {
    if use_environment_override {
        if let Some(path) = std::env::var_os("OPENCODE_DB").filter(|value| !value.is_empty()) {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                return path;
            }
            if let Some(data_home) =
                std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty())
            {
                return PathBuf::from(data_home).join("opencode").join(path);
            }
        }
        if let Some(data_home) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty())
        {
            return PathBuf::from(data_home)
                .join("opencode")
                .join("opencode.db");
        }
    }
    home.join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db")
}

pub fn read_gemini_session_usage(path: &Path) -> Result<Vec<UsageEntry>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err("Gemini session file exceeds read limit".to_string());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let document: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    let Some(messages) = document.get("messages").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("gemini") {
            continue;
        }
        let Some(tokens) = message.get("tokens") else {
            continue;
        };
        let input_total = number(tokens, "input");
        let cache_read = number(tokens, "cached");
        let entry = UsageEntry {
            date: date_from_rfc3339(message.get("timestamp").and_then(Value::as_str)),
            token_input: input_total.saturating_sub(cache_read),
            token_output: number(tokens, "output").saturating_add(number(tokens, "thoughts")),
            token_cache_read: cache_read,
            token_cache_creation: 0,
        };
        if !entry.is_empty() {
            entries.push(entry);
        }
    }
    Ok(entries)
}

pub fn read_opencode_session_usage(path: &Path) -> Result<Vec<UsageEntry>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT data FROM message ORDER BY time_created")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let data = row.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant")
            || message.pointer("/time/completed").is_none()
        {
            continue;
        }
        let Some(tokens) = message.get("tokens") else {
            continue;
        };
        let cache = tokens.get("cache");
        let entry = UsageEntry {
            date: date_from_epoch_ms(message.pointer("/time/created").and_then(Value::as_i64)),
            token_input: number(tokens, "input"),
            token_output: number(tokens, "output").saturating_add(number(tokens, "reasoning")),
            token_cache_read: cache.map_or(0, |value| number(value, "read")),
            token_cache_creation: cache.map_or(0, |value| number(value, "write")),
        };
        if !entry.is_empty() {
            entries.push(entry);
        }
    }
    Ok(entries)
}

pub fn read_grok_session_usage(path: &Path) -> Result<Vec<UsageEntry>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err("Grok Build session file exceeds read limit".to_string());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut latest = HashMap::<String, UsageEntry>::new();

    for (index, line) in content.lines().enumerate() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("method").and_then(Value::as_str) != Some("_x.ai/session/update") {
            continue;
        }
        let Some(update) = record.pointer("/params/update") else {
            continue;
        };
        if update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "turn_completed")
        {
            continue;
        }
        let Some(usage) = update.get("usage").filter(|value| value.is_object()) else {
            continue;
        };
        let Some(timestamp) = epoch_seconds(record.get("timestamp")) else {
            continue;
        };
        let prompt_id = update
            .get("prompt_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("index-{index}"));
        if let Some(models) = usage.get("modelUsage").and_then(Value::as_object) {
            for (model, counters) in models {
                latest.insert(
                    format!("{prompt_id}:{model}"),
                    grok_entry(counters, timestamp),
                );
            }
        } else {
            latest.insert(prompt_id, grok_entry(usage, timestamp));
        }
    }
    Ok(latest
        .into_values()
        .filter(|entry| !entry.is_empty())
        .collect())
}

fn grok_entry(counters: &Value, timestamp: i64) -> UsageEntry {
    let input_total = number(counters, "inputTokens");
    let cache_read = number(counters, "cachedReadTokens");
    UsageEntry {
        date: date_from_epoch(timestamp),
        token_input: input_total.saturating_sub(cache_read),
        token_output: number(counters, "outputTokens"),
        token_cache_read: cache_read,
        token_cache_creation: 0,
    }
}

fn collect_files_named<F>(
    root: &Path,
    name: &str,
    files: &mut Vec<PathBuf>,
    depth: usize,
    matches: F,
) where
    F: Fn(&Path) -> bool + Copy,
{
    if depth > MAX_COLLECT_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_files_named(&path, name, files, depth + 1, matches);
        } else if (name.is_empty()
            || path.file_name().and_then(|value| value.to_str()) == Some(name))
            && matches(&path)
        {
            files.push(path);
        }
    }
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn date_from_rfc3339(value: Option<&str>) -> String {
    value
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| {
            timestamp
                .with_timezone(&Local)
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(today)
}

fn epoch_seconds(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .map(|timestamp| {
            if timestamp > 100_000_000_000 {
                timestamp / 1000
            } else {
                timestamp
            }
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
                .map(|timestamp| timestamp.timestamp())
        })
}

fn date_from_epoch_ms(value: Option<i64>) -> String {
    date_from_epoch(value.unwrap_or_else(|| Local::now().timestamp_millis()) / 1000)
}

fn date_from_epoch(timestamp: i64) -> String {
    Local
        .timestamp_opt(timestamp, 0)
        .single()
        .map(|value| value.date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_else(today)
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_normalizes_cached_input_and_reasoning_output() {
        let path = tempfile::NamedTempFile::new().expect("temp file");
        fs::write(
            path.path(),
            r#"{"messages":[{"type":"gemini","timestamp":"2026-08-08T00:00:00Z","tokens":{"input":100,"cached":40,"output":5,"thoughts":7}}]}"#,
        )
        .expect("write fixture");
        let entries = read_gemini_session_usage(path.path()).expect("read usage");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token_input, 60);
        assert_eq!(entries[0].token_cache_read, 40);
        assert_eq!(entries[0].token_output, 12);
    }

    #[test]
    fn grok_keeps_latest_turn_snapshot() {
        let path = tempfile::NamedTempFile::new().expect("temp file");
        fs::write(
            path.path(),
            concat!(
                r#"{"timestamp":1700000000,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"p1","usage":{"modelUsage":{"grok":{"inputTokens":100,"cachedReadTokens":20,"outputTokens":3}}}}}}"#,
                "\n",
                r#"{"timestamp":1700000001,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"p1","usage":{"modelUsage":{"grok":{"inputTokens":140,"cachedReadTokens":40,"outputTokens":4}}}}}}"#,
            ),
        )
        .expect("write fixture");
        let entries = read_grok_session_usage(path.path()).expect("read usage");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token_input, 100);
        assert_eq!(entries[0].token_cache_read, 40);
        assert_eq!(entries[0].token_output, 4);
    }
}
