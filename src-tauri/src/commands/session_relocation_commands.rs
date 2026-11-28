//! 项目改路径后迁移历史会话（docs/115 §2）。`dryRun: true` 只预览。

use crate::utils::{AppError, AppResult};
use cc_panes_core::services::session_relocation::{
    SessionRelocationReport, SessionRelocationRequest, SessionRelocationService,
};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub async fn relocate_project_sessions(
    request: SessionRelocationRequest,
    service: State<'_, Arc<SessionRelocationService>>,
) -> AppResult<SessionRelocationReport> {
    debug!(
        old = %request.old_path,
        new = %request.new_path,
        dry_run = request.dry_run,
        "cmd::relocate_project_sessions"
    );
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || service.relocate(&request))
        .await
        .map_err(|error| AppError::from(format!("Session relocation task failed: {error}")))?
}
