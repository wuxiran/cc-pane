use std::path::PathBuf;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::workspace_snapshot::WorkspaceSnapshotSummary,
    models::{SavedSession, WorkspaceSnapshot},
    repository::LaunchRecord,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default, alias = "claudeSessionId")]
    pub resume_session_id: Option<String>,
    pub cli_tool: Option<String>,
    pub runtime_kind: Option<String>,
    pub started_at: Option<String>,
    pub status: Option<String>,
    pub last_prompt: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLaunchHistoryRequest {
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub cli_tool: Option<String>,
    pub runtime_kind: Option<String>,
    pub wsl_distro: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub launch_cwd: Option<String>,
    pub provider_id: Option<String>,
    pub provider_selection: Option<String>,
    pub launch_profile_id: Option<String>,
    pub workspace_snapshot_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLaunchHistoryQuery {
    pub limit: Option<usize>,
    pub project_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindByPtyQuery {
    pub pty_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindByResumeQuery {
    pub resume_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindByLaunchQuery {
    pub launch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionIdRequest {
    pub resume_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResumeSourceRequest {
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLastPromptRequest {
    pub last_prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchBySessionRequest {
    pub resume_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResumeByPtyRequest {
    pub pty_session_id: String,
    pub resume_session_id: String,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLastPromptByPtyRequest {
    pub pty_session_id: String,
    pub last_prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionStartedRequest {
    pub launch_id: String,
    pub pty_session_id: String,
    pub resume_session_id: String,
    pub cli_tool: String,
    pub runtime_kind: String,
    pub wsl_distro: Option<String>,
    pub launch_cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSessionStartedRequest {
    #[serde(flatten)]
    pub started: UpdateSessionStartedRequest,
    pub project_path: String,
    pub project_name: String,
    pub workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateQuery {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionOutputRequest {
    pub lines: Vec<String>,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn add_launch_history(
    State(state): State<AppState>,
    Json(req): Json<AddLaunchHistoryRequest>,
) -> Result<(StatusCode, Json<i64>), (StatusCode, String)> {
    let id = state
        .launch_history_service
        .add(
            &req.project_id,
            &req.project_name,
            &req.project_path,
            req.cli_tool.as_deref().unwrap_or("none"),
            req.runtime_kind.as_deref().unwrap_or("local"),
            req.wsl_distro.as_deref(),
            req.workspace_name.as_deref(),
            req.workspace_path.as_deref(),
            req.launch_cwd.as_deref(),
            req.provider_id.as_deref(),
            req.provider_selection.as_deref(),
            req.launch_profile_id.as_deref(),
            req.workspace_snapshot_id.as_deref(),
        )
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(id)))
}

pub async fn list_launch_history(
    State(state): State<AppState>,
    Query(query): Query<ListLaunchHistoryQuery>,
) -> Result<Json<Vec<LaunchRecord>>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(20);
    match query.project_path {
        Some(project_path) => state
            .launch_history_service
            .list_by_project(&project_path, limit),
        None => state.launch_history_service.list(limit),
    }
    .map(Json)
    .map_err(service_error)
}

pub async fn delete_launch_history(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_history_service
        .delete(id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn clear_launch_history(
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_history_service
        .clear()
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn find_launch_history_by_pty_session(
    State(state): State<AppState>,
    Query(query): Query<FindByPtyQuery>,
) -> Result<Json<Option<LaunchRecord>>, (StatusCode, String)> {
    state
        .launch_history_service
        .find_by_pty_session_id(&query.pty_session_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn find_launch_history_by_resume_session(
    State(state): State<AppState>,
    Query(query): Query<FindByResumeQuery>,
) -> Result<Json<Option<LaunchRecord>>, (StatusCode, String)> {
    state
        .launch_history_service
        .find_by_resume_session_id(&query.resume_session_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn find_launch_history_by_launch_id(
    State(state): State<AppState>,
    Query(query): Query<FindByLaunchQuery>,
) -> Result<Json<Option<LaunchRecord>>, (StatusCode, String)> {
    state
        .launch_history_service
        .find_by_launch_id(&query.launch_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_launch_session_id(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateSessionIdRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_history_service
        .update_session_id(id, &req.resume_session_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_launch_resume_source(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateResumeSourceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_history_service
        .update_resume_source(id, &req.source)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_launch_last_prompt(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateLastPromptRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_history_service
        .update_last_prompt(id, &req.last_prompt)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn touch_launch_by_session(
    State(state): State<AppState>,
    Json(req): Json<TouchBySessionRequest>,
) -> Result<Json<Option<i64>>, (StatusCode, String)> {
    state
        .launch_history_service
        .touch_by_session_id(&req.resume_session_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_launch_resume_by_pty(
    State(state): State<AppState>,
    Json(req): Json<UpdateResumeByPtyRequest>,
) -> Result<Json<Option<i64>>, (StatusCode, String)> {
    state
        .launch_history_service
        .update_resume_session_with_source_by_pty(
            &req.pty_session_id,
            &req.resume_session_id,
            &req.source,
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn update_launch_last_prompt_by_pty(
    State(state): State<AppState>,
    Json(req): Json<UpdateLastPromptByPtyRequest>,
) -> Result<Json<Option<i64>>, (StatusCode, String)> {
    state
        .launch_history_service
        .update_last_prompt_by_pty_session_id(&req.pty_session_id, &req.last_prompt)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_launch_session_started(
    State(state): State<AppState>,
    Json(req): Json<UpdateSessionStartedRequest>,
) -> Result<Json<Option<i64>>, (StatusCode, String)> {
    state
        .launch_history_service
        .update_session_started(
            &req.launch_id,
            &req.pty_session_id,
            &req.resume_session_id,
            &req.cli_tool,
            &req.runtime_kind,
            req.wsl_distro.as_deref(),
            req.launch_cwd.as_deref(),
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn upsert_launch_session_started(
    State(state): State<AppState>,
    Json(req): Json<UpsertSessionStartedRequest>,
) -> Result<Json<i64>, (StatusCode, String)> {
    state
        .launch_history_service
        .upsert_session_started(
            &req.started.launch_id,
            &req.started.pty_session_id,
            &req.started.resume_session_id,
            &req.started.cli_tool,
            &req.started.runtime_kind,
            req.started.wsl_distro.as_deref(),
            req.started.launch_cwd.as_deref(),
            &req.project_path,
            &req.project_name,
            req.workspace_path.as_deref(),
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn read_session_state(
    Query(query): Query<SessionStateQuery>,
) -> Result<Json<Option<SessionState>>, (StatusCode, String)> {
    let state_path = PathBuf::from(&query.project_path)
        .join(".ccpanes")
        .join("session-state.json");

    if !state_path.exists() {
        return Ok(Json(None));
    }

    let content = std::fs::read_to_string(&state_path).map_err(service_error)?;
    let state = serde_json::from_str(&content).map_err(service_error)?;
    Ok(Json(Some(state)))
}

pub async fn save_terminal_sessions(
    State(state): State<AppState>,
    Json(sessions): Json<Vec<SavedSession>>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .session_restore_service
        .save_sessions(&sessions)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn load_terminal_sessions(
    State(state): State<AppState>,
) -> Result<Json<Vec<SavedSession>>, (StatusCode, String)> {
    state
        .session_restore_service
        .load_sessions()
        .map(Json)
        .map_err(service_error)
}

pub async fn clear_terminal_sessions(
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .session_restore_service
        .clear_sessions()
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn save_session_output(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<SaveSessionOutputRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .session_restore_service
        .save_session_output(&session_id, &req.lines)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn load_session_output(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Option<Vec<String>>>, (StatusCode, String)> {
    state
        .session_restore_service
        .load_session_output(&session_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn clear_session_output(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .session_restore_service
        .clear_session_output(&session_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_workspace_snapshots(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<WorkspaceSnapshotSummary>>, (StatusCode, String)> {
    state
        .session_restore_service
        .list_workspace_snapshots(&workspace_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_workspace_snapshot(
    State(state): State<AppState>,
    Path((workspace_id, snapshot_id)): Path<(String, String)>,
) -> Result<Json<Option<WorkspaceSnapshot>>, (StatusCode, String)> {
    state
        .session_restore_service
        .get_workspace_snapshot(&workspace_id, &snapshot_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_workspace_snapshot(
    State(state): State<AppState>,
    Path((workspace_id, snapshot_id)): Path<(String, String)>,
) -> Result<Json<bool>, (StatusCode, String)> {
    state
        .session_restore_service
        .delete_workspace_snapshot(&workspace_id, &snapshot_id)
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod history_tests;
