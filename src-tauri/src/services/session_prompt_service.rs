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
    Ok(extract_claude_prompt_from_content(&content))
}

/// 从 Claude session jsonl 内容中提取最后一条有效用户 prompt（纯函数，便于测试）
fn extract_claude_prompt_from_content(content: &str) -> Option<String> {
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
                return Some(truncate_prompt(content_str));
            }

            if let Some(content_arr) = message.get("content").and_then(|c| c.as_array()) {
                for item in content_arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            if should_skip_prompt(text) {
                                continue;
                            }
                            return Some(truncate_prompt(text));
                        }
                    }
                }
            }
        }
    }

    None
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
    let mut lines = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        lines.push(line);
    }
    Ok(extract_codex_prompt_from_lines(lines))
}

/// 从 Codex session jsonl 行中提取最后一条有效用户 prompt（纯函数，便于测试）
fn extract_codex_prompt_from_lines<I>(lines: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut prompts = Vec::new();

    for line in lines {
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

    prompts.pop().map(|prompt| truncate_prompt(&prompt))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── should_skip_prompt / truncate_prompt ──

    #[test]
    fn should_skip_prompt_filters_interrupted_plan_and_short_text() {
        assert!(should_skip_prompt("[Request interrupted by user]"));
        assert!(should_skip_prompt("Implement the following plan: xxx"));
        assert!(should_skip_prompt("abcd")); // len < 5
        assert!(!should_skip_prompt("hello world"));
    }

    #[test]
    fn truncate_prompt_counts_chars_not_bytes() {
        let long_ascii = "a".repeat(250);
        assert_eq!(truncate_prompt(&long_ascii).chars().count(), 200);

        let long_cjk = "测".repeat(250);
        let truncated = truncate_prompt(&long_cjk);
        assert_eq!(truncated.chars().count(), 200);

        assert_eq!(truncate_prompt("short"), "short");
    }

    // ── extract_last_prompt 分发 ──

    #[test]
    fn extract_last_prompt_returns_none_for_unknown_cli_tool() {
        let result = extract_last_prompt("gemini", None, None, "C:/proj", "sid");
        assert_eq!(result, Ok(None));
    }

    // ── Claude jsonl 解析 ──

    fn claude_user_line(content: &str) -> String {
        serde_json::json!({"type": "user", "message": {"content": content}}).to_string()
    }

    #[test]
    fn claude_picks_last_valid_user_prompt() {
        let content = format!(
            "{}\n{}\n",
            claude_user_line("first prompt"),
            claude_user_line("second prompt")
        );
        assert_eq!(
            extract_claude_prompt_from_content(&content),
            Some("second prompt".to_string())
        );
    }

    #[test]
    fn claude_skips_non_user_types_and_data_lines() {
        let assistant =
            serde_json::json!({"type": "assistant", "message": {"content": "assistant text"}})
                .to_string();
        let with_data = serde_json::json!({
            "type": "user",
            "data": {"kind": "hook"},
            "message": {"content": "hook injected text"}
        })
        .to_string();
        let content = format!(
            "{}\n{}\n{}\n",
            claude_user_line("real prompt"),
            assistant,
            with_data
        );
        assert_eq!(
            extract_claude_prompt_from_content(&content),
            Some("real prompt".to_string())
        );
    }

    #[test]
    fn claude_skips_interrupted_and_short_prompts() {
        let content = format!(
            "{}\n{}\n{}\n",
            claude_user_line("usable prompt"),
            claude_user_line("[Request interrupted by user]"),
            claude_user_line("hi")
        );
        assert_eq!(
            extract_claude_prompt_from_content(&content),
            Some("usable prompt".to_string())
        );
    }

    #[test]
    fn claude_reads_text_item_from_array_content() {
        let line = serde_json::json!({
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "content": "tool output"},
                {"type": "text", "text": "[Request interrupted by user]"},
                {"type": "text", "text": "array prompt text"}
            ]}
        })
        .to_string();
        assert_eq!(
            extract_claude_prompt_from_content(&line),
            Some("array prompt text".to_string())
        );
    }

    #[test]
    fn claude_skips_invalid_json_lines() {
        let content = format!(
            "not json at all\n{}\n{{broken\n",
            claude_user_line("valid prompt")
        );
        assert_eq!(
            extract_claude_prompt_from_content(&content),
            Some("valid prompt".to_string())
        );
    }

    #[test]
    fn claude_truncates_long_prompt_to_200_chars() {
        let long = "x".repeat(300);
        let content = claude_user_line(&long);
        let result = extract_claude_prompt_from_content(&content).expect("prompt");
        assert_eq!(result.chars().count(), 200);
    }

    #[test]
    fn claude_returns_none_when_no_valid_prompt() {
        assert_eq!(extract_claude_prompt_from_content(""), None);
        let only_assistant =
            serde_json::json!({"type": "assistant", "message": {"content": "text here"}})
                .to_string();
        assert_eq!(extract_claude_prompt_from_content(&only_assistant), None);
    }

    // ── Codex jsonl 解析 ──

    fn codex_user_line(texts: &[&str]) -> String {
        let content: Vec<_> = texts
            .iter()
            .map(|text| serde_json::json!({"type": "input_text", "text": text}))
            .collect();
        serde_json::json!({
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": content}
        })
        .to_string()
    }

    #[test]
    fn codex_returns_last_user_prompt() {
        let lines = vec![
            codex_user_line(&["first codex prompt"]),
            codex_user_line(&["last codex prompt"]),
        ];
        assert_eq!(
            extract_codex_prompt_from_lines(lines),
            Some("last codex prompt".to_string())
        );
    }

    #[test]
    fn codex_merges_multiple_input_text_items_with_newline() {
        let lines = vec![codex_user_line(&["line one", "line two"])];
        assert_eq!(
            extract_codex_prompt_from_lines(lines),
            Some("line one\nline two".to_string())
        );
    }

    #[test]
    fn codex_skips_non_user_and_non_message_entries() {
        let assistant = serde_json::json!({
            "type": "response_item",
            "payload": {"type": "message", "role": "assistant",
                "content": [{"type": "input_text", "text": "assistant reply"}]}
        })
        .to_string();
        let reasoning = serde_json::json!({
            "type": "response_item",
            "payload": {"type": "reasoning", "role": "user",
                "content": [{"type": "input_text", "text": "reasoning text"}]}
        })
        .to_string();
        let other_type = serde_json::json!({
            "type": "turn_context",
            "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "context text"}]}
        })
        .to_string();
        let lines = vec![
            codex_user_line(&["real codex prompt"]),
            assistant,
            reasoning,
            other_type,
        ];
        assert_eq!(
            extract_codex_prompt_from_lines(lines),
            Some("real codex prompt".to_string())
        );
    }

    #[test]
    fn codex_skips_empty_and_skip_worthy_text_items() {
        let lines = vec![
            codex_user_line(&["kept codex prompt"]),
            codex_user_line(&["   ", "[Request interrupted by user]", "hi"]),
        ];
        assert_eq!(
            extract_codex_prompt_from_lines(lines),
            Some("kept codex prompt".to_string())
        );
    }

    #[test]
    fn codex_skips_invalid_json_and_missing_payload() {
        let no_payload = serde_json::json!({"type": "response_item"}).to_string();
        let lines = vec![
            "garbage line".to_string(),
            no_payload,
            codex_user_line(&["survivor prompt"]),
        ];
        assert_eq!(
            extract_codex_prompt_from_lines(lines),
            Some("survivor prompt".to_string())
        );
    }

    #[test]
    fn codex_truncates_long_prompt_and_returns_none_when_empty() {
        let long = "y".repeat(300);
        let result =
            extract_codex_prompt_from_lines(vec![codex_user_line(&[&long])]).expect("prompt");
        assert_eq!(result.chars().count(), 200);

        assert_eq!(extract_codex_prompt_from_lines(Vec::<String>::new()), None);
    }
}
