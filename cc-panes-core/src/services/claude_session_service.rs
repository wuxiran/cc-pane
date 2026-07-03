//! Claude Session Service — 从 ~/.claude/projects/ 读取 Claude Code 历史会话
//!
//! 提供按项目或全局列举 Claude 会话的能力，供 Tauri Command 和 MCP 共用。

use crate::models::UsageEntry;
use crate::utils::is_claude_project_match;
use chrono::{DateTime, Local};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::warn;

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSession {
    pub id: String,
    pub project_path: String,
    pub modified_at: u64,
    pub file_path: String,
    pub description: String,
}

/// 从会话文件中提取描述（优先从用户消息的 content 字符串）
fn extract_session_description(file_path: &PathBuf) -> String {
    let file = match File::open(file_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };

    let reader = BufReader::new(file);

    for line in reader.lines().take(100) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        let parsed: Result<Value, _> = serde_json::from_str(&line);
        if let Ok(json) = parsed {
            if json.get("type").and_then(|t| t.as_str()) != Some("user") {
                continue;
            }

            // 跳过 progress 类型（agent 内部消息）
            if json.get("data").is_some() {
                continue;
            }

            if let Some(message) = json.get("message") {
                // 情况1: content 是字符串
                if let Some(content) = message.get("content").and_then(|c| c.as_str()) {
                    if content.starts_with("[Request interrupted")
                        || content.starts_with("Implement the following plan")
                        || content.len() < 5
                    {
                        continue;
                    }

                    let desc: String = content.chars().take(80).collect();
                    if desc.len() < content.len() {
                        return format!("{}...", desc);
                    }
                    return desc;
                }

                // 情况2: content 是数组
                if let Some(content_arr) = message.get("content").and_then(|c| c.as_array()) {
                    for item in content_arr {
                        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                if text.starts_with("[Request interrupted")
                                    || text.contains("tool_use_id")
                                    || text.len() < 5
                                {
                                    continue;
                                }

                                let desc: String = text.chars().take(80).collect();
                                if desc.len() < text.len() {
                                    return format!("{}...", desc);
                                }
                                return desc;
                            }
                        }
                    }
                }
            }
        }
    }

    String::new()
}

/// 解析会话文件
fn parse_session_file(file_path: &PathBuf, project_path: &str) -> Option<ClaudeSession> {
    let file_name = file_path.file_stem()?.to_string_lossy().to_string();

    let metadata = fs::metadata(file_path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_at = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let description = extract_session_description(file_path);

    Some(ClaudeSession {
        id: file_name,
        project_path: project_path.to_string(),
        modified_at,
        file_path: file_path.to_string_lossy().to_string(),
        description,
    })
}

/// 列出指定项目的 Claude 会话历史
pub fn list_sessions(project_path: &str, limit: usize) -> Result<Vec<ClaudeSession>, String> {
    let mut sessions = Vec::new();

    let home = dirs::home_dir().ok_or_else(|| "Failed to get user home directory".to_string())?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(sessions);
    }

    let entries = fs::read_dir(&claude_projects).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };

        if !is_claude_project_match(&dir_name, project_path) {
            continue;
        }

        if let Ok(files) = fs::read_dir(&path) {
            for file in files.flatten() {
                let file_path = file.path();
                if file_path.extension().is_some_and(|e| e == "jsonl") {
                    if let Some(session) = parse_session_file(&file_path, project_path) {
                        sessions.push(session);
                    }
                }
            }
        }
    }

    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

/// 列出所有项目的 Claude 会话历史
pub fn list_all_sessions(limit: usize) -> Result<Vec<ClaudeSession>, String> {
    let mut sessions = Vec::new();

    let home = dirs::home_dir().ok_or_else(|| "Failed to get user home directory".to_string())?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(sessions);
    }

    let entries = fs::read_dir(&claude_projects).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if let Ok(files) = fs::read_dir(&path) {
            for file in files.flatten() {
                let file_path = file.path();
                if file_path.extension().is_some_and(|e| e == "jsonl") {
                    if let Some(session) = parse_session_file(&file_path, &dir_name) {
                        sessions.push(session);
                    }
                }
            }
        }
    }

    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

pub fn read_session_usage(
    jsonl_path: &Path,
    from_byte_offset: u64,
) -> Result<(Vec<UsageEntry>, u64), String> {
    read_usage_entries(jsonl_path, from_byte_offset, extract_claude_usage)
}

fn read_usage_entries(
    jsonl_path: &Path,
    from_byte_offset: u64,
    extract: fn(&Value) -> Option<UsageEntry>,
) -> Result<(Vec<UsageEntry>, u64), String> {
    let mut file = File::open(jsonl_path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = from_byte_offset.min(len);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(file);
    let mut offset = start;
    let mut entries = Vec::new();

    loop {
        let mut buf = Vec::new();
        let read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        if !buf.ends_with(b"\n") {
            break;
        }
        let line_offset = offset;
        offset += read as u64;

        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(json) => {
                if let Some(entry) = extract(&json).filter(|entry| !entry.is_empty()) {
                    entries.push(entry);
                }
            }
            Err(error) => {
                warn!(
                    path = %jsonl_path.display(),
                    offset = line_offset,
                    err = %error,
                    "Skipping invalid Claude jsonl line"
                );
            }
        }
    }

    Ok((entries, offset))
}

fn extract_claude_usage(json: &Value) -> Option<UsageEntry> {
    let usage = json.get("message")?.get("usage")?;
    Some(UsageEntry {
        date: usage_date(json),
        token_input: number_field(usage, &["input_tokens"]),
        token_output: number_field(usage, &["output_tokens"]),
        token_cache_read: number_field(usage, &["cache_read_input_tokens"]),
        token_cache_creation: number_field(usage, &["cache_creation_input_tokens"]),
    })
}

fn usage_date(json: &Value) -> String {
    json.get("timestamp")
        .and_then(|value| value.as_str())
        .and_then(parse_local_date)
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string())
}

fn parse_local_date(timestamp: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(timestamp).ok().map(|dt| {
        dt.with_timezone(&Local)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string()
    })
}

fn number_field(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(|field| field.as_u64()))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_session_description, number_field, parse_local_date, parse_session_file,
        read_session_usage,
    };
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use tempfile::NamedTempFile;

    fn write_session_file(lines: &[&str]) -> PathBuf {
        let temp_file = NamedTempFile::new().expect("temp file");
        let (_file, path) = temp_file.keep().expect("persist temp file");
        fs::write(&path, lines.join("\n")).expect("write session file");
        path
    }

    /// jsonl 追加写：usage 测试需要精确控制每行是否带结尾换行。
    fn write_raw_file(content: &str) -> PathBuf {
        let temp_file = NamedTempFile::new().expect("temp file");
        let (_file, path) = temp_file.keep().expect("persist temp file");
        fs::write(&path, content).expect("write raw file");
        path
    }

    fn usage_line(input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-01-15T12:00:00Z","message":{{"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    #[test]
    fn extract_description_reads_string_content() {
        let path = write_session_file(&[
            r#"{"type":"user","message":{"content":"fix the resume flow for claude sessions"}}"#,
        ]);

        assert_eq!(
            extract_session_description(&path),
            "fix the resume flow for claude sessions"
        );
    }

    #[test]
    fn extract_description_skips_interrupted_plan_and_short() {
        let path = write_session_file(&[
            r#"{"type":"user","message":{"content":"[Request interrupted by user]"}}"#,
            r#"{"type":"user","message":{"content":"Implement the following plan: do stuff"}}"#,
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"user","message":{"content":"real user question here"}}"#,
        ]);

        assert_eq!(
            extract_session_description(&path),
            "real user question here"
        );
    }

    #[test]
    fn extract_description_skips_progress_data_messages() {
        // 带 data 字段的是 agent 内部 progress 消息，不能当描述。
        let path = write_session_file(&[
            r#"{"type":"user","data":{"step":1},"message":{"content":"internal progress text"}}"#,
            r#"{"type":"assistant","message":{"content":"assistant reply ignored"}}"#,
            r#"{"type":"user","message":{"content":"actual first user message"}}"#,
        ]);

        assert_eq!(
            extract_session_description(&path),
            "actual first user message"
        );
    }

    #[test]
    fn extract_description_reads_array_content_skipping_tool_results() {
        let path = write_session_file(&[
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"tool output"},{"type":"text","text":"result for tool_use_id abc123"},{"type":"text","text":"describe the panes layout bug"}]}}"#,
        ]);

        assert_eq!(
            extract_session_description(&path),
            "describe the panes layout bug"
        );
    }

    #[test]
    fn extract_description_truncates_to_80_chars() {
        let long_text = "a".repeat(100);
        let line = format!(r#"{{"type":"user","message":{{"content":"{long_text}"}}}}"#);
        let path = write_session_file(&[&line]);

        let description = extract_session_description(&path);

        assert_eq!(description, format!("{}...", "a".repeat(80)));
    }

    #[test]
    fn extract_description_empty_when_no_user_message() {
        let path = write_session_file(&[
            r#"{"type":"assistant","message":{"content":"only assistant text"}}"#,
            "not valid json at all",
        ]);

        assert_eq!(extract_session_description(&path), "");
    }

    #[test]
    fn parse_session_file_uses_file_stem_as_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("session-abc-123.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","message":{"content":"hello from parse test"}}"#,
        )
        .expect("write session file");

        let session = parse_session_file(&path, "D:/proj/app").expect("session");

        assert_eq!(session.id, "session-abc-123");
        assert_eq!(session.project_path, "D:/proj/app");
        assert_eq!(session.file_path, path.to_string_lossy());
        assert!(session.modified_at > 0);
        assert_eq!(session.description, "hello from parse test");
    }

    #[test]
    fn read_session_usage_extracts_claude_token_fields() {
        let line = r#"{"type":"assistant","timestamp":"2026-01-15T12:00:00Z","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}}"#;
        let path = write_raw_file(&format!("{line}\n"));

        let (entries, offset) = read_session_usage(&path, 0).expect("usage");

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.token_input, 10);
        assert_eq!(entry.token_output, 20);
        assert_eq!(entry.token_cache_read, 30);
        assert_eq!(entry.token_cache_creation, 40);
        // date 走本地时区转换，与实现同一条路径换算出期望值。
        let expected_date = parse_local_date("2026-01-15T12:00:00Z").expect("date");
        assert_eq!(entry.date, expected_date);
        assert_eq!(offset, (line.len() + 1) as u64);
    }

    #[test]
    fn read_session_usage_filters_missing_or_empty_usage() {
        let content = concat!(
            r#"{"type":"user","message":{"content":"no usage field"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":0,"output_tokens":0}}}"#,
            "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":7}}}"#,
            "\n",
        );
        let path = write_raw_file(content);

        let (entries, _offset) = read_session_usage(&path, 0).expect("usage");

        // 无 usage 的行与全零 usage（is_empty）都被过滤，只留最后一条。
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token_input, 5);
        assert_eq!(entries[0].token_output, 7);
    }

    #[test]
    fn read_session_usage_skips_invalid_json_lines() {
        let content = format!("{{broken json\n{}\n", usage_line(3, 4));
        let path = write_raw_file(&content);

        let (entries, offset) = read_session_usage(&path, 0).expect("usage");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token_input, 3);
        assert_eq!(offset, content.len() as u64);
    }

    #[test]
    fn read_session_usage_stops_before_trailing_partial_line() {
        // 最后一行没有 \n（写入中途），不能消费，offset 停在它之前。
        let complete = usage_line(1, 2);
        let content = format!("{complete}\n{{\"type\":\"assis");
        let path = write_raw_file(&content);

        let (entries, offset) = read_session_usage(&path, 0).expect("usage");

        assert_eq!(entries.len(), 1);
        assert_eq!(offset, (complete.len() + 1) as u64);
    }

    #[test]
    fn read_session_usage_resumes_from_offset() {
        let first = usage_line(1, 1);
        let path = write_raw_file(&format!("{first}\n"));
        let (_entries, offset) = read_session_usage(&path, 0).expect("first pass");

        // 模拟增量写入：追加一条新 usage 行后从上次 offset 续读。
        let second = usage_line(9, 9);
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open for append");
        writeln!(file, "{second}").expect("append line");

        let (entries, new_offset) = read_session_usage(&path, offset).expect("second pass");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].token_input, 9);
        assert_eq!(new_offset, offset + (second.len() + 1) as u64);
    }

    #[test]
    fn read_session_usage_clamps_offset_beyond_len() {
        let content = format!("{}\n", usage_line(1, 2));
        let path = write_raw_file(&content);

        let (entries, offset) = read_session_usage(&path, 999_999).expect("usage");

        assert!(entries.is_empty());
        assert_eq!(offset, content.len() as u64);
    }

    #[test]
    fn number_field_fallback_and_parse_local_date() {
        let value = serde_json::json!({"prompt_tokens": 12});
        assert_eq!(number_field(&value, &["input_tokens", "prompt_tokens"]), 12);
        assert_eq!(number_field(&value, &["missing"]), 0);

        assert!(parse_local_date("not a timestamp").is_none());
        let date = parse_local_date("2026-01-15T12:00:00+08:00").expect("valid rfc3339");
        assert_eq!(date.len(), 10);
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
    }
}
