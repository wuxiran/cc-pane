use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{SessionIndexEntry, SessionIndexListParams, SessionIndexScanReport};
use cc_panes_core::services::SessionIndexService;
use cc_panes_core::services::{claude_session_service, codex_session_service};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionsQuery {
    pub project_path: String,
    pub runtime_kind: Option<String>,
    pub wsl_distro: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLimitQuery {
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRolloutQuery {
    pub session_id: String,
    pub wsl_distro: Option<String>,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_claude_sessions(
    Query(query): Query<ProjectSessionsQuery>,
) -> Result<Json<Vec<claude_session_service::ClaudeSession>>, (StatusCode, String)> {
    claude_session_service::list_sessions(&query.project_path, query.limit.unwrap_or(10))
        .map(Json)
        .map_err(service_error)
}

pub async fn list_all_claude_sessions(
    Query(query): Query<SessionLimitQuery>,
) -> Result<Json<Vec<claude_session_service::ClaudeSession>>, (StatusCode, String)> {
    claude_session_service::list_all_sessions(query.limit.unwrap_or(20))
        .map(Json)
        .map_err(service_error)
}

pub async fn list_codex_sessions(
    Query(query): Query<ProjectSessionsQuery>,
) -> Result<Json<Vec<codex_session_service::CodexSession>>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(10);
    let result = if query.runtime_kind.as_deref() == Some("wsl") {
        codex_session_service::list_wsl_sessions(
            &query.project_path,
            limit,
            query.wsl_distro.as_deref(),
        )
    } else {
        codex_session_service::list_sessions(&query.project_path, limit)
    };
    result.map(Json).map_err(service_error)
}

pub fn list_session_index_with_service(
    service: &SessionIndexService,
    params: SessionIndexListParams,
) -> Result<Json<Vec<SessionIndexEntry>>, (StatusCode, String)> {
    let query = params.into_query().map_err(service_error)?;
    service
        .list_sessions(query)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_session_index(
    State(state): State<AppState>,
    Query(params): Query<SessionIndexListParams>,
) -> Result<Json<Vec<SessionIndexEntry>>, (StatusCode, String)> {
    list_session_index_with_service(&state.session_index_service, params)
}

pub async fn refresh_session_index(
    State(state): State<AppState>,
) -> Result<Json<SessionIndexScanReport>, (StatusCode, String)> {
    state
        .session_index_service
        .clone()
        .refresh_session_index()
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn check_codex_rollout_exists(
    State(state): State<AppState>,
    Query(query): Query<CodexRolloutQuery>,
) -> Json<Option<bool>> {
    Json(
        state
            .session_index_service
            .codex_rollout_exists(&query.session_id, query.wsl_distro.as_deref()),
    )
}

#[cfg(test)]
#[path = "agent_sessions_tests.rs"]
mod agent_sessions_tests;
