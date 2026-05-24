use crate::utils::AppResult;
use cc_panes_core::models::UsageQueryResult;
use cc_panes_core::services::UsageStatsService;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn record_terminal_input(
    service: State<'_, Arc<UsageStatsService>>,
    session_id: String,
    char_count: u32,
) -> AppResult<()> {
    debug!(
        session_id = %session_id,
        char_count,
        "cmd::record_terminal_input"
    );
    service.record_input_chars(&session_id, char_count)
}

#[tauri::command]
pub fn query_usage_stats(
    service: State<'_, Arc<UsageStatsService>>,
    range_days: Option<u32>,
    workspace_filter: Option<String>,
) -> AppResult<UsageQueryResult> {
    service.query_usage(range_days.unwrap_or(30), workspace_filter)
}

#[tauri::command]
pub async fn refresh_usage_stats(service: State<'_, Arc<UsageStatsService>>) -> AppResult<()> {
    let svc = service.inner().clone();
    svc.refresh_usage_stats().await
}
