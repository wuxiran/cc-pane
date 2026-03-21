use crate::services::claude_session_service;
use crate::utils::AppResult;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tracing::debug;

// 重导出 ClaudeSession，保持对外 API 兼容
pub use crate::services::claude_session_service::ClaudeSession;

use crate::utils::is_claude_project_match;

/// 列出项目的 Claude 会话历史
#[tauri::command]
pub fn list_claude_sessions(project_path: String) -> AppResult<Vec<ClaudeSession>> {
    claude_session_service::list_sessions(&project_path, 10).map_err(|e| e.into())
}

/// 获取所有 Claude 项目的会话
#[tauri::command]
pub fn list_all_claude_sessions() -> AppResult<Vec<ClaudeSession>> {
    claude_session_service::list_all_sessions(20).map_err(|e| e.into())
}

// ============ 会话清理功能 ============

#[derive(Debug, Serialize, Clone)]
pub struct BrokenSession {
    pub id: String,
    pub file_path: String,
    pub project_path: String,
    pub thinking_blocks: u32,
    pub file_size: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CleanResult {
    pub file_path: String,
    pub removed_blocks: u32,
    pub success: bool,
    pub error: Option<String>,
}

/// 检查一行 JSON 中是否包含 thinking/redacted_thinking 块，返回块数量
fn count_thinking_blocks(line: &str) -> u32 {
    let parsed: Result<Value, _> = serde_json::from_str(line);
    let json = match parsed {
        Ok(v) => v,
        Err(_) => return 0,
    };

    let content = match json
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(arr) => arr,
        None => return 0,
    };

    content
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(|t| t.as_str()),
                Some("thinking") | Some("redacted_thinking")
            )
        })
        .count() as u32
}

/// 扫描含有 thinking 块的损坏会话文件
#[tauri::command]
pub fn scan_broken_sessions(project_path: Option<String>) -> AppResult<Vec<BrokenSession>> {
    let mut results = Vec::new();

    let home = dirs::home_dir().ok_or("Failed to get user home directory")?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(results);
    }

    let entries = fs::read_dir(&claude_projects)?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };

        // 如果指定了 project_path，只扫描匹配的目录
        if let Some(ref pp) = project_path {
            if !is_claude_project_match(&dir_name, pp) {
                continue;
            }
        }

        let files = match fs::read_dir(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        for file in files.flatten() {
            let file_path = file.path();
            if file_path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }

            let f = match File::open(&file_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let reader = BufReader::new(f);
            let mut total_thinking = 0u32;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                total_thinking += count_thinking_blocks(&line);
            }

            if total_thinking > 0 {
                let file_size = fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

                let file_name = file_path
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(BrokenSession {
                    id: file_name,
                    file_path: file_path.to_string_lossy().to_string(),
                    project_path: dir_name.clone(),
                    thinking_blocks: total_thinking,
                    file_size,
                });
            }
        }
    }

    // 按 thinking_blocks 降序排序
    results.sort_by(|a, b| b.thinking_blocks.cmp(&a.thinking_blocks));
    Ok(results)
}

/// 清理单个会话文件中的 thinking/redacted_thinking 块
#[tauri::command]
pub fn clean_session_file(file_path: String) -> CleanResult {
    debug!(file_path = %file_path, "cmd::clean_session_file");
    let path = PathBuf::from(&file_path);

    // 路径安全校验：必须在 ~/.claude 目录范围内
    let validate = || -> Result<(), String> {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;
        let claude_dir = dirs::home_dir()
            .ok_or_else(|| "Failed to get home directory".to_string())?
            .join(".claude");
        if !canonical.starts_with(&claude_dir) {
            return Err("Path is not within .claude directory".to_string());
        }
        // 扩展名必须为 .jsonl
        if canonical.extension().is_none_or(|e| e != "jsonl") {
            return Err("Only .jsonl files are allowed".to_string());
        }
        Ok(())
    };
    if let Err(e) = validate() {
        return CleanResult {
            file_path,
            removed_blocks: 0,
            success: false,
            error: Some(e),
        };
    }

    // 读取文件
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            return CleanResult {
                file_path,
                removed_blocks: 0,
                success: false,
                error: Some(format!("Failed to read file: {}", e)),
            };
        }
    };

    let mut new_lines = Vec::new();
    let mut removed = 0u32;

    for line in content.lines() {
        let parsed: Result<Value, _> = serde_json::from_str(line);
        match parsed {
            Ok(mut json) => {
                // 检查 message.content 是否为数组
                let has_thinking = json
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                    .is_some_and(|arr| {
                        arr.iter().any(|item| {
                            matches!(
                                item.get("type").and_then(|t| t.as_str()),
                                Some("thinking") | Some("redacted_thinking")
                            )
                        })
                    });

                if has_thinking {
                    // 过滤掉 thinking 块
                    if let Some(message) = json.get_mut("message") {
                        if let Some(content) = message.get_mut("content") {
                            if let Some(arr) = content.as_array() {
                                let before_count = arr.len();
                                let filtered: Vec<Value> = arr
                                    .iter()
                                    .filter(|item| {
                                        !matches!(
                                            item.get("type").and_then(|t| t.as_str()),
                                            Some("thinking") | Some("redacted_thinking")
                                        )
                                    })
                                    .cloned()
                                    .collect();
                                removed += (before_count - filtered.len()) as u32;
                                *content = Value::Array(filtered);
                            }
                        }
                    }
                    new_lines
                        .push(serde_json::to_string(&json).unwrap_or_else(|_| line.to_string()));
                } else {
                    new_lines.push(line.to_string());
                }
            }
            Err(_) => {
                // 非 JSON 行原样保留
                new_lines.push(line.to_string());
            }
        }
    }

    if removed == 0 {
        return CleanResult {
            file_path,
            removed_blocks: 0,
            success: true,
            error: None,
        };
    }

    // 写入临时文件再 rename，确保原子性
    let tmp_path = path.with_extension("jsonl.tmp");
    let write_result = (|| -> Result<(), String> {
        let mut tmp_file =
            File::create(&tmp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;
        for (i, line) in new_lines.iter().enumerate() {
            tmp_file
                .write_all(line.as_bytes())
                .map_err(|e| format!("Failed to write to temp file: {}", e))?;
            if i < new_lines.len() - 1 {
                tmp_file
                    .write_all(b"\n")
                    .map_err(|e| format!("Failed to write newline: {}", e))?;
            }
        }
        tmp_file
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename: {}", e))?;
        Ok(())
    })();

    match write_result {
        Ok(()) => CleanResult {
            file_path,
            removed_blocks: removed,
            success: true,
            error: None,
        },
        Err(e) => {
            // 清理临时文件
            let _ = fs::remove_file(&tmp_path);
            CleanResult {
                file_path,
                removed_blocks: 0,
                success: false,
                error: Some(e),
            }
        }
    }
}

/// 批量清理所有损坏的会话文件
#[tauri::command]
pub fn clean_all_broken_sessions(project_path: Option<String>) -> AppResult<Vec<CleanResult>> {
    debug!(project_path = ?project_path, "cmd::clean_all_broken_sessions");
    let broken = scan_broken_sessions(project_path)?;
    Ok(broken
        .into_iter()
        .map(|session| clean_session_file(session.file_path))
        .collect())
}

/// 从 Claude 会话 JSONL 文件中提取最后一条用户 prompt（反向遍历）
#[tauri::command]
pub fn extract_last_prompt(project_path: String, session_id: String) -> AppResult<Option<String>> {
    let home = dirs::home_dir().ok_or("Failed to get user home directory")?;

    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(None);
    }

    // 找到匹配的项目目录
    let entries = fs::read_dir(&claude_projects)?;
    let mut session_file = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if is_claude_project_match(&dir_name, &project_path) {
            let candidate = path.join(format!("{}.jsonl", session_id));
            if candidate.exists() {
                session_file = Some(candidate);
                break;
            }
        }
    }

    let session_file = match session_file {
        Some(f) => f,
        None => return Ok(None),
    };

    // 读取整个文件并反向遍历行
    let content = fs::read_to_string(&session_file)
        .map_err(|e| format!("Failed to read session file: {}", e))?;

    for line in content.lines().rev() {
        let parsed: Result<Value, _> = serde_json::from_str(line);
        let json = match parsed {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 只查找 user 类型
        if json.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }

        // 跳过 progress/data 类型
        if json.get("data").is_some() {
            continue;
        }

        if let Some(message) = json.get("message") {
            // content 是字符串
            if let Some(content_str) = message.get("content").and_then(|c| c.as_str()) {
                if content_str.starts_with("[Request interrupted")
                    || content_str.starts_with("Implement the following plan")
                    || content_str.len() < 5
                {
                    continue;
                }
                let prompt: String = content_str.chars().take(200).collect();
                return Ok(Some(prompt));
            }

            // content 是数组
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
                            let prompt: String = text.chars().take(200).collect();
                            return Ok(Some(prompt));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}
