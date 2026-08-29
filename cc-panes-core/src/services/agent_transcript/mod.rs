//! 只读 agent transcript（Terminal|Chat 互切）。
//! 首批 Grok；Claude/Codex 返回 unsupported，后续补 decoder。

mod grok;

pub use grok::{
    decode_grok_transcript_line, encode_uri_component, find_grok_chat_history_by_session_id,
    is_safe_grok_session_id, read_grok_transcript_messages, resolve_grok_chat_history_path_sync,
    resolve_grok_transcript_file, GROK_CHAT_HISTORY_FILE,
};

use crate::models::{
    AgentTranscriptErrorCode, ReadAgentTranscriptParams, ReadAgentTranscriptResult,
    DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT,
};

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
        "claude" | "codex" => ReadAgentTranscriptResult::err(
            AgentTranscriptErrorCode::UnsupportedCli,
            format!(
                "Chat transcript for '{cli}' is not implemented yet (Grok only in this release)"
            ),
        ),
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

    let total = messages.len() as u64;
    let limit = params
        .limit
        .unwrap_or(DEFAULT_TRANSCRIPT_LIMIT)
        .clamp(1, MAX_TRANSCRIPT_LIMIT) as usize;
    let offset_from_end = params.offset_from_end.unwrap_or(0) as usize;

    // 窗口：从末尾往前 offset，再取 limit 条，保持时间正序。
    // [0 .. total) 中取 [end-limit-offset, end-offset)
    let end = total.saturating_sub(offset_from_end as u64) as usize;
    let start = end.saturating_sub(limit);
    let window = if start < end {
        messages[start..end].to_vec()
    } else {
        Vec::new()
    };
    let truncated = start > 0 || end < messages.len();

    ReadAgentTranscriptResult::ok(window, path.display().to_string(), total, truncated)
}

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
    fn unsupported_claude_returns_code() {
        let result = read_agent_transcript(ReadAgentTranscriptParams {
            cli_tool: "claude".into(),
            resume_session_id: "x".into(),
            cwd: None,
            limit: None,
            offset_from_end: None,
        });
        assert_eq!(
            result.error_code,
            Some(AgentTranscriptErrorCode::UnsupportedCli)
        );
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
