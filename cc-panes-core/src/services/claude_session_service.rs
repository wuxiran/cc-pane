//! Claude Session Service — 从 ~/.claude/projects/ 读取 Claude Code 历史会话
//!
//! 提供按项目或全局列举 Claude 会话的能力，供 Tauri Command 和 MCP 共用。

use crate::utils::is_claude_project_match;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

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

    let home = dirs::home_dir()
        .ok_or_else(|| "Failed to get user home directory".to_string())?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(sessions);
    }

    let entries = fs::read_dir(&claude_projects)
        .map_err(|e| e.to_string())?;

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

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}

/// 列出所有项目的 Claude 会话历史
pub fn list_all_sessions(limit: usize) -> Result<Vec<ClaudeSession>, String> {
    let mut sessions = Vec::new();

    let home = dirs::home_dir()
        .ok_or_else(|| "Failed to get user home directory".to_string())?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(sessions);
    }

    let entries = fs::read_dir(&claude_projects)
        .map_err(|e| e.to_string())?;

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

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    sessions.truncate(limit);
    Ok(sessions)
}
