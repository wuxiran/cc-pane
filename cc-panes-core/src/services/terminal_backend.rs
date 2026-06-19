use std::sync::Arc;

use crate::models::{CreateSessionRequest, TerminalReplaySnapshot};
use crate::services::terminal_service::SessionOutput;
use crate::services::terminal_service::TerminalService;
use crate::services::SessionStatusInfo;
use crate::utils::error::AppError;
use crate::utils::AppResult;

/// Backend boundary for terminal session operations.
///
/// The default implementation delegates to the in-process `TerminalService`.
/// Future daemon support should implement this trait without changing the
/// Tauri IPC command contract.
pub trait TerminalBackend: Send + Sync {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String>;
    fn write(&self, session_id: &str, data: &str) -> AppResult<()>;
    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()>;
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()>;
    fn kill(&self, session_id: &str) -> AppResult<()>;
    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>>;
    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput>;
    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>>;
}

#[derive(Clone)]
pub struct InProcessTerminalBackend {
    service: Arc<TerminalService>,
}

impl InProcessTerminalBackend {
    pub fn new(service: Arc<TerminalService>) -> Self {
        Self { service }
    }
}

impl TerminalBackend for TerminalService {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        TerminalService::create_session(
            self,
            request.launch_id.as_deref(),
            &request.project_path,
            request.cols,
            request.rows,
            request.workspace_name.as_deref(),
            request.provider_id.as_deref(),
            request.provider_selection,
            request.launch_profile_id.as_deref(),
            request.workspace_path.as_deref(),
            request.workspace_snapshot_id.as_deref(),
            request.effective_cli_tool(),
            request.resume_id.as_deref(),
            request.skip_mcp,
            request.append_system_prompt.as_deref(),
            request.initial_prompt.as_deref(),
            None,
            request.ssh.as_ref(),
            request.wsl.as_ref(),
        )
        .map_err(AppError::from)
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        TerminalService::write(self, session_id, data).map_err(AppError::from)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        TerminalService::submit_text_to_session(self, session_id, text)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        TerminalService::resize(self, session_id, cols, rows).map_err(AppError::from)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        TerminalService::kill(self, session_id)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        TerminalService::get_all_status(self).map_err(AppError::from)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        TerminalService::get_session_output(self, session_id, lines).map_err(AppError::from)
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        TerminalService::get_session_replay_snapshot(self, session_id).map_err(AppError::from)
    }
}

impl TerminalBackend for InProcessTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        <TerminalService as TerminalBackend>::create_session(self.service.as_ref(), request)
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::write(self.service.as_ref(), session_id, data)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::submit_text_to_session(
            self.service.as_ref(),
            session_id,
            text,
        )
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        <TerminalService as TerminalBackend>::resize(self.service.as_ref(), session_id, cols, rows)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::kill(self.service.as_ref(), session_id)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        <TerminalService as TerminalBackend>::get_all_status(self.service.as_ref())
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        <TerminalService as TerminalBackend>::get_session_output(
            self.service.as_ref(),
            session_id,
            lines,
        )
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        <TerminalService as TerminalBackend>::get_session_replay_snapshot(
            self.service.as_ref(),
            session_id,
        )
    }
}
