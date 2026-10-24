use super::*;

pub(super) const MANUAL_CLI_RESTORE_BLOCKED: &str = "Manual CLI recordings are review-only: CLI or background processes may still write files; automatic turn boundaries are unavailable";

impl TurnCheckpointService {
    /// PTY identity deliberately scopes an interval to one terminal lifetime.
    /// Resuming a provider conversation in another PTY must not join recordings
    /// from two independently writable terminals.
    pub fn cli_chat_id(session_id: &str) -> AppResult<String> {
        if session_id.trim().is_empty()
            || session_id.len() > 1000
            || session_id.chars().any(char::is_control)
        {
            return Err("Invalid CLI checkpoint session identity".into());
        }
        Ok(format!("cli:{session_id}"))
    }

    /// Call only after resolving the local launch directory from backend-owned
    /// session metadata. This records the user-selected interval, never an
    /// inferred provider turn or a diff against HEAD.
    pub fn begin_cli(&self, session_id: &str, cwd: &Path) -> AppResult<TurnCheckpointRecord> {
        let chat_id = Self::cli_chat_id(session_id)?;
        let turn_id = format!("manual-{}", uuid::Uuid::new_v4());
        self.begin_inner(&chat_id, &turn_id, cwd, true)
    }

    pub fn finish_cli(&self, session_id: &str, id: &str) -> AppResult<TurnCheckpointRecord> {
        let chat_id = Self::cli_chat_id(session_id)?;
        // Verify before calling finish, which releases the live lease. A stale
        // UI callback from a different tab must not finalize this recording.
        if self.load(id)?.chat_id != chat_id {
            return Err(AppError::coded(
                "CHECKPOINT_SESSION_MISMATCH",
                "This recording belongs to a different CLI session",
            ));
        }
        self.finish(id, "manual-completed")
    }
}
