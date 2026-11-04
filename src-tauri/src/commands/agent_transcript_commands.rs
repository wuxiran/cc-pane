use cc_panes_core::models::{
    AgentTranscriptErrorCode, ReadAgentTranscriptParams, ReadAgentTranscriptResult,
};
use cc_panes_core::services::{export_agent_transcript, read_agent_transcript};

#[tauri::command]
pub async fn read_agent_transcript_cmd(
    params: ReadAgentTranscriptParams,
) -> ReadAgentTranscriptResult {
    read_on_worker(move || read_agent_transcript(params)).await
}

/// 把会话原始记录复制到 `destination`（用户在保存对话框里选的路径），返回字节数。
#[tauri::command]
pub async fn export_agent_transcript_cmd(
    cli_tool: String,
    resume_session_id: String,
    cwd: Option<String>,
    destination: String,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_agent_transcript(
            &cli_tool,
            &resume_session_id,
            cwd.as_deref(),
            std::path::Path::new(&destination),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// File IO and JSON decoding must not block or unwind through the native IPC callback.
async fn read_on_worker(
    read: impl FnOnce() -> ReadAgentTranscriptResult + Send + 'static,
) -> ReadAgentTranscriptResult {
    match tauri::async_runtime::spawn_blocking(read).await {
        Ok(result) => result,
        Err(_) => {
            // Panic payloads can contain transcript text; keep diagnostics content-free.
            tracing::error!("Agent transcript reader worker failed");
            ReadAgentTranscriptResult::err(
                AgentTranscriptErrorCode::ParseError,
                "Transcript reader failed; the conversation could not be loaded",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_worker_preserves_typed_errors() {
        let result = tauri::async_runtime::block_on(read_on_worker(|| {
            ReadAgentTranscriptResult::err(AgentTranscriptErrorCode::NotFound, "missing")
        }));
        assert_eq!(result.error_code, Some(AgentTranscriptErrorCode::NotFound));
        assert_eq!(result.error_message.as_deref(), Some("missing"));
    }

    #[test]
    fn transcript_worker_contains_parser_panic() {
        let result = tauri::async_runtime::block_on(read_on_worker(|| {
            panic!("synthetic private transcript payload")
        }));
        assert_eq!(
            result.error_code,
            Some(AgentTranscriptErrorCode::ParseError)
        );
        assert!(result.messages.is_empty());
        assert!(!result.error_message.unwrap().contains("private"));
    }
}
