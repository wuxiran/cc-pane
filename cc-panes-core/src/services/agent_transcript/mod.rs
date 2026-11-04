//! 只读 agent transcript（Terminal|Chat 互切）。
//! Grok / Claude / Codex 都能读；对话视图是否开放由前端 TRANSCRIPT_SUPPORTED_CLI_TOOLS 决定。

mod claude_codex;
mod grok;

pub use grok::{
    decode_grok_transcript_line, encode_uri_component, find_grok_chat_history_by_session_id,
    is_safe_grok_session_id, read_grok_transcript_messages, resolve_grok_chat_history_path_sync,
    resolve_grok_transcript_file, GROK_CHAT_HISTORY_FILE,
};

use crate::models::{
    AgentTranscriptErrorCode, ReadAgentTranscriptParams, ReadAgentTranscriptResult,
    TranscriptMessage, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT,
};
use crate::services::usage_stats_service::{claude_session_roots, codex_session_roots};
use std::path::{Path, PathBuf};

/// 读取 agent 对话 transcript（不经 PTY）。错误以 result.errorCode 返回，不抛 IPC 失败，
/// 方便前端展示空态。
pub fn read_agent_transcript(params: ReadAgentTranscriptParams) -> ReadAgentTranscriptResult {
    let cli = params.cli_tool.trim().to_ascii_lowercase();
    let resume_id = params.resume_session_id.trim();
    if resume_id.is_empty() {
        return ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::InvalidSessionId,
            "resumeSessionId is empty",
        );
    }

    match cli.as_str() {
        "grok" => read_grok(params),
        "claude" => read_native(params, &cli, claude_codex::read_claude_messages),
        "codex" => read_native(params, &cli, claude_codex::read_codex_messages),
        "none" | "" => ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::UnsupportedCli,
            "shell sessions have no agent transcript",
        ),
        other => ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::UnsupportedCli,
            format!("unsupported cliTool: {other}"),
        ),
    }
}

/// 只认「一个安全的 id + 已知目录」，文件路径绝不来自调用方。
fn native_transcript_file(cli: &str, session_id: &str) -> Option<PathBuf> {
    match cli {
        "claude" => claude_codex::find_claude_file(session_id, &claude_session_roots()),
        "codex" => claude_codex::find_codex_file(session_id, &codex_session_roots()),
        _ => None,
    }
}

fn read_native(
    params: ReadAgentTranscriptParams,
    cli: &str,
    decode: fn(&Path) -> Result<Vec<TranscriptMessage>, String>,
) -> ReadAgentTranscriptResult {
    let resume_id = params.resume_session_id.trim();
    if !is_safe_grok_session_id(resume_id) {
        return ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::InvalidSessionId,
            "invalid session id",
        );
    }
    let Some(path) = native_transcript_file(cli, resume_id) else {
        return ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::NotFound,
            format!("no {cli} transcript for session {resume_id}"),
        );
    };
    let messages = match decode(&path) {
        Ok(messages) => messages,
        Err(e) => {
            return ReadAgentTranscriptResult::err(
                AgentTranscriptErrorCode::IoError,
                format!("failed to read {}: {e}", path.display()),
            );
        }
    };
    let limit = params
        .limit
        .unwrap_or(DEFAULT_TRANSCRIPT_LIMIT)
        .clamp(1, MAX_TRANSCRIPT_LIMIT) as usize;
    page_messages(
        messages,
        &path,
        limit,
        params.offset_from_end.unwrap_or(0) as usize,
        params.before_message_id.as_deref(),
    )
}

/// 把会话的原始记录文件复制到用户选定的位置（「导出完整记录」）。
pub fn export_agent_transcript(
    cli_tool: &str,
    resume_session_id: &str,
    cwd: Option<&str>,
    destination: &Path,
) -> Result<u64, String> {
    let cli = cli_tool.trim().to_ascii_lowercase();
    let id = resume_session_id.trim();
    if !is_safe_grok_session_id(id) {
        return Err("invalid session id".to_string());
    }
    let source = match cli.as_str() {
        "grok" => resolve_grok_transcript_file(id, cwd.map(str::trim).filter(|c| !c.is_empty())),
        "claude" | "codex" => native_transcript_file(&cli, id),
        other => return Err(format!("unsupported cliTool: {other}")),
    }
    .ok_or_else(|| format!("no {cli} transcript for session {id}"))?;
    std::fs::copy(&source, destination).map_err(|e| {
        format!(
            "failed to copy {} to {}: {e}",
            source.display(),
            destination.display()
        )
    })
}

fn read_grok(params: ReadAgentTranscriptParams) -> ReadAgentTranscriptResult {
    let resume_id = params.resume_session_id.trim();
    if !is_safe_grok_session_id(resume_id) {
        return ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::InvalidSessionId,
            "invalid Grok session id",
        );
    }

    let cwd = params
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());

    let Some(path) = resolve_grok_transcript_file(resume_id, cwd) else {
        return ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::NotFound,
            format!("no Grok chat_history.jsonl for session {resume_id}"),
        );
    };

    let messages = match read_grok_transcript_messages(&path) {
        Ok(m) => m,
        Err(e) => {
            return ReadAgentTranscriptResult::err(
                AgentTranscriptErrorCode::IoError,
                format!("failed to read {}: {e}", path.display()),
            );
        }
    };

    let limit = params
        .limit
        .unwrap_or(DEFAULT_TRANSCRIPT_LIMIT)
        .clamp(1, MAX_TRANSCRIPT_LIMIT) as usize;
    let offset_from_end = params.offset_from_end.unwrap_or(0) as usize;

    page_messages(
        messages,
        &path,
        limit,
        offset_from_end,
        params.before_message_id.as_deref(),
    )
}

fn page_messages(
    messages: Vec<crate::models::TranscriptMessage>,
    path: &std::path::Path,
    limit: usize,
    offset_from_end: usize,
    before_message_id: Option<&str>,
) -> ReadAgentTranscriptResult {
    let total = messages.len();
    let end = if let Some(id) = before_message_id {
        let Some(index) = messages.iter().position(|message| message.id == id) else {
            return ReadAgentTranscriptResult::err(
                AgentTranscriptErrorCode::CursorExpired,
                "Conversation history changed; refresh before loading earlier messages",
            );
        };
        index
    } else {
        total.saturating_sub(offset_from_end)
    };
    let start = end.saturating_sub(limit);
    let window = messages[start..end].to_vec();
    let mut result = ReadAgentTranscriptResult::ok(
        window,
        path.display().to_string(),
        total as u64,
        start > 0 || end < total,
    );
    result.has_earlier = start > 0;
    result.next_before_message_id = if result.has_earlier {
        result.messages.first().map(|message| message.id.clone())
    } else {
        None
    };
    result
}

#[cfg(test)]
mod pagination_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TranscriptRole;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// GROK_HOME 进程级 env，并行测会互踩。
    static GROK_HOME_LOCK: Mutex<()> = Mutex::new(());

    fn with_grok_home<T>(home: &std::path::Path, f: impl FnOnce() -> T) -> T {
        let _guard = GROK_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("GROK_HOME");
        std::env::set_var("GROK_HOME", home);
        let out = f();
        match prev {
            Some(v) => std::env::set_var("GROK_HOME", v),
            None => std::env::remove_var("GROK_HOME"),
        }
        out
    }

    #[test]
    fn read_agent_transcript_grok_end_to_end() {
        let dir = tempdir().unwrap();
        let grok_home = dir.path().join("grok-home");
        let sessions = grok_home.join("sessions");
        let cwd = r"D:\proj";
        let encoded = encode_uri_component(cwd);
        let sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let sess = sessions.join(&encoded).join(sid);
        fs::create_dir_all(&sess).unwrap();
        let body = r#"
{"type":"user","id":"b1","content":"<user_info>\nx\n</user_info>"}
{"type":"user","id":"u1","content":"<user_query>\nplan step 1\n</user_query>"}
{"type":"assistant","id":"a1","content":"long plan body"}
{"type":"user","id":"u2","content":"<user_query>\nmore\n</user_query>"}
{"type":"assistant","id":"a2","content":"ok"}
"#;
        fs::write(sess.join(GROK_CHAT_HISTORY_FILE), body).unwrap();

        let result = with_grok_home(&grok_home, || {
            read_agent_transcript(ReadAgentTranscriptParams {
                cli_tool: "grok".into(),
                resume_session_id: sid.into(),
                cwd: Some(cwd.into()),
                limit: Some(10),
                offset_from_end: None,
                before_message_id: None,
            })
        });

        assert!(
            result.error_code.is_none(),
            "err={:?}",
            result.error_message
        );
        assert_eq!(result.messages.len(), 4); // bootstrap skipped
        assert_eq!(result.messages[0].role, TranscriptRole::User);
        assert_eq!(result.messages[0].text, "plan step 1");
        assert_eq!(result.total_estimate, Some(4));
    }

    #[test]
    fn unsupported_cli_returns_code() {
        let result = read_agent_transcript(ReadAgentTranscriptParams {
            cli_tool: "gemini".into(),
            resume_session_id: "x".into(),
            cwd: None,
            limit: None,
            offset_from_end: None,
            before_message_id: None,
        });
        assert_eq!(
            result.error_code,
            Some(AgentTranscriptErrorCode::UnsupportedCli)
        );
    }

    #[test]
    fn claude_rejects_session_ids_that_could_escape_the_projects_dir() {
        let result = read_agent_transcript(ReadAgentTranscriptParams {
            cli_tool: "claude".into(),
            resume_session_id: "../../secret".into(),
            cwd: None,
            limit: None,
            offset_from_end: None,
            before_message_id: None,
        });
        assert_eq!(
            result.error_code,
            Some(AgentTranscriptErrorCode::InvalidSessionId)
        );
        let dest = tempdir().unwrap();
        assert!(export_agent_transcript(
            "claude",
            "../../secret",
            None,
            &dest.path().join("out.jsonl")
        )
        .is_err());
    }

    #[test]
    fn claude_transcript_reads_and_exports_from_config_dir() {
        let _guard = GROK_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempdir().unwrap();
        let project = dir.path().join("config/projects/-work");
        fs::create_dir_all(&project).unwrap();
        let sid = "11111111-2222-3333-4444-555555555555";
        let body = r#"{"type":"user","uuid":"u","message":{"content":"你好"}}"#;
        fs::write(project.join(format!("{sid}.jsonl")), body).unwrap();

        let prev = std::env::var_os("CLAUDE_CONFIG_DIR");
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("config"));
        let result = read_agent_transcript(ReadAgentTranscriptParams {
            cli_tool: "claude".into(),
            resume_session_id: sid.into(),
            cwd: None,
            limit: None,
            offset_from_end: None,
            before_message_id: None,
        });
        let dest = dir.path().join("out.jsonl");
        let exported = export_agent_transcript("claude", sid, None, &dest);
        match prev {
            Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
            None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
        }

        assert_eq!(result.error_code, None);
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].text, "你好");
        assert_eq!(exported.unwrap(), body.len() as u64);
        assert_eq!(fs::read_to_string(dest).unwrap(), body);
    }

    #[test]
    fn limit_takes_tail() {
        let dir = tempdir().unwrap();
        let grok_home = dir.path().join("g");
        let sessions = grok_home.join("sessions");
        let sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let group = sessions.join("g1");
        let sess = group.join(sid);
        fs::create_dir_all(&sess).unwrap();
        let mut body = String::new();
        for i in 0..10 {
            body.push_str(&format!(
                r#"{{"type":"user","id":"u{i}","content":"<user_query>m{i}</user_query>"}}"#
            ));
            body.push('\n');
        }
        fs::write(sess.join(GROK_CHAT_HISTORY_FILE), body).unwrap();

        let result = with_grok_home(&grok_home, || {
            read_agent_transcript(ReadAgentTranscriptParams {
                cli_tool: "grok".into(),
                resume_session_id: sid.into(),
                cwd: None, // force scan
                limit: Some(3),
                offset_from_end: Some(0),
                before_message_id: None,
            })
        });

        assert!(result.error_code.is_none(), "{:?}", result.error_message);
        assert_eq!(result.messages.len(), 3);
        assert_eq!(result.messages[0].text, "m7");
        assert_eq!(result.messages[2].text, "m9");
        assert!(result.truncated);
        assert_eq!(result.total_estimate, Some(10));
    }
}
