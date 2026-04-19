use crate::utils::is_claude_project_match;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

fn should_skip_prompt(text: &str) -> bool {
    text.starts_with("[Request interrupted")
        || text.starts_with("Implement the following plan")
        || text.len() < 5
}

fn truncate_prompt(text: &str) -> String {
    text.chars().take(200).collect()
}

pub fn extract_last_prompt(
    cli_tool: &str,
    runtime_kind: Option<&str>,
    wsl_distro: Option<&str>,
    project_path: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    match cli_tool {
        "claude" => extract_claude_last_prompt(project_path, session_id),
        "codex" => extract_codex_last_prompt(runtime_kind, wsl_distro, session_id),
        _ => Ok(None),
    }
}

pub fn extract_claude_last_prompt(
    project_path: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or("Failed to get user home directory".to_string())?;
    let claude_projects = home.join(".claude").join("projects");
    if !claude_projects.exists() {
        return Ok(None);
    }

    let entries = fs::read_dir(&claude_projects).map_err(|e| e.to_string())?;
    let mut session_file = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };
        if is_claude_project_match(&dir_name, project_path) {
            let candidate = path.join(format!("{}.jsonl", session_id));
            if candidate.exists() {
                session_file = Some(candidate);
                break;
            }
        }
    }

    let session_file = match session_file {
        Some(file) => file,
        None => return Ok(None),
    };

    let content = fs::read_to_string(&session_file).map_err(|e| e.to_string())?;
    for line in content.lines().rev() {
        let parsed: Result<Value, _> = serde_json::from_str(line);
        let json = match parsed {
            Ok(value) => value,
            Err(_) => continue,
        };

        if json.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        if json.get("data").is_some() {
            continue;
        }

        if let Some(message) = json.get("message") {
            if let Some(content_str) = message.get("content").and_then(|c| c.as_str()) {
                if should_skip_prompt(content_str) {
                    continue;
                }
                return Ok(Some(truncate_prompt(content_str)));
            }

            if let Some(content_arr) = message.get("content").and_then(|c| c.as_array()) {
                for item in content_arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            if should_skip_prompt(text) {
                                continue;
                            }
                            return Ok(Some(truncate_prompt(text)));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

pub fn extract_codex_last_prompt(
    runtime_kind: Option<&str>,
    wsl_distro: Option<&str>,
    session_id: &str,
) -> Result<Option<String>, String> {
    let sessions = if runtime_kind == Some("wsl") {
        cc_panes_core::services::codex_session_service::list_all_wsl_sessions(500, wsl_distro)?
    } else {
        cc_panes_core::services::codex_session_service::list_all_sessions(500)?
    };
    let file_path = match sessions
        .into_iter()
        .find(|session| session.id == session_id)
    {
        Some(session) => PathBuf::from(session.file_path),
        None => return Ok(None),
    };

    let file = File::open(&file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut prompts = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let json: Value = match serde_json::from_str(&line) {
            Ok(json) => json,
            Err(_) => continue,
        };

        if json.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let payload = match json.get("payload") {
            Some(payload) => payload,
            None => continue,
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        if payload.get("role").and_then(|role| role.as_str()) != Some("user") {
            continue;
        }
        let content = match payload.get("content").and_then(|value| value.as_array()) {
            Some(content) => content,
            None => continue,
        };
        let mut merged = Vec::new();
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) != Some("input_text") {
                continue;
            }
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                let trimmed = text.trim();
                if trimmed.is_empty() || should_skip_prompt(trimmed) {
                    continue;
                }
                merged.push(trimmed.to_string());
            }
        }
        if !merged.is_empty() {
            prompts.push(merged.join("\n"));
        }
    }

    Ok(prompts.pop().map(|prompt| truncate_prompt(&prompt)))
}
