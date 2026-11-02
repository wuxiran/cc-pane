use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{ContextUsageSnapshot, SessionCostSnapshot, UsageQueryResult};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTerminalInputRequest {
    pub session_id: String,
    pub char_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsQuery {
    pub range_days: Option<u32>,
    pub workspace_filter: Option<String>,
}

pub async fn query_context_usage(
    State(state): State<AppState>,
    Path(pty_session_id): Path<String>,
) -> Result<Json<ContextUsageSnapshot>, (StatusCode, String)> {
    Ok(Json(
        state
            .usage_stats_service
            .context_usage_for_pty(&pty_session_id),
    ))
}

pub async fn query_session_cost(
    State(state): State<AppState>,
    Path(pty_session_id): Path<String>,
) -> Result<Json<SessionCostSnapshot>, (StatusCode, String)> {
    let service = state.usage_stats_service.clone();
    // 首次读长会话的 transcript 可能要几百毫秒，不能占着 async worker。
    tokio::task::spawn_blocking(move || service.session_cost_for_pty(&pty_session_id))
        .await
        .map(Json)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn record_terminal_input(
    State(state): State<AppState>,
    Json(req): Json<RecordTerminalInputRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .usage_stats_service
        .record_input_chars(&req.session_id, req.char_count)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn query_usage_stats(
    State(state): State<AppState>,
    Query(query): Query<UsageStatsQuery>,
) -> Result<Json<UsageQueryResult>, (StatusCode, String)> {
    state
        .usage_stats_service
        .query_usage(query.range_days.unwrap_or(30), query.workspace_filter)
        .map(Json)
        .map_err(service_error)
}

pub async fn refresh_usage_stats(
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    let service = state.usage_stats_service.clone();
    service.refresh_usage_stats().await.map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "usage_stats_tests.rs"]
mod usage_stats_tests;
