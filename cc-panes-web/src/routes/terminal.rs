use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::CliTool;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateSessionRequest {
    /// Working directory (optional, falls back to server default)
    pub cwd: Option<String>,
    /// Terminal columns
    pub cols: Option<u16>,
    /// Terminal rows
    pub rows: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
}

#[derive(Deserialize)]
pub struct ResizeRequest {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub status: String,
    pub pid: Option<u32>,
}

/// POST /api/sessions — create a new terminal session
pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), (StatusCode, String)> {
    let cwd = req.cwd.as_deref().unwrap_or(&state.default_cwd);
    let cols = req.cols.unwrap_or(120);
    let rows = req.rows.unwrap_or(30);

    let session_id = state
        .terminal_service
        .create_session(
            cwd,
            cols,
            rows,
            None, // workspace_name
            None, // provider_id
            None, // workspace_path
            CliTool::None,
            None, // resume_id
            true, // skip_mcp
            None, // append_system_prompt
            None, // initial_prompt
            None, // ssh
            None, // wsl
        )
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to create session");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create session".to_string(),
            )
        })?;

    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    ))
}

/// GET /api/sessions — list all active sessions
pub async fn list_sessions(
    State(state): State<AppState>,
) -> Result<Json<Vec<SessionInfo>>, (StatusCode, String)> {
    let statuses = state.terminal_service.get_all_status().map_err(|e| {
        tracing::error!(error = %e, "Failed to get sessions");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to list sessions".to_string(),
        )
    })?;

    let sessions = statuses
        .into_iter()
        .map(|s| SessionInfo {
            session_id: s.session_id,
            status: format!("{:?}", s.status),
            pid: s.pid,
        })
        .collect();

    Ok(Json(sessions))
}

/// POST /api/sessions/:id/resize — resize terminal
pub async fn resize_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ResizeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .terminal_service
        .resize(&id, req.cols, req.rows)
        .map_err(|e| {
            tracing::error!(session_id = id, error = %e, "Failed to resize");
            (StatusCode::NOT_FOUND, "Session not found".to_string())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/sessions/:id — kill terminal session
pub async fn kill_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state.terminal_service.kill(&id).map_err(|e| {
        tracing::error!(session_id = id, error = %e, "Failed to kill session");
        (StatusCode::NOT_FOUND, "Session not found".to_string())
    })?;

    Ok(StatusCode::NO_CONTENT)
}
