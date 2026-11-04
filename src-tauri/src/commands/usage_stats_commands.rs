use crate::utils::{AppError, AppResult};
use cc_panes_core::models::{ContextUsageSnapshot, SessionCostSnapshot, UsageQueryResult};
use cc_panes_core::services::UsageStatsService;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub async fn record_terminal_input(
    service: State<'_, Arc<UsageStatsService>>,
    session_id: String,
    char_count: u32,
) -> AppResult<()> {
    debug!(
        session_id = %session_id,
        char_count,
        "cmd::record_terminal_input"
    );
    let service = service.inner().clone();
    run_usage_blocking(move || service.record_input_chars(&session_id, char_count)).await
}

#[tauri::command]
pub async fn query_usage_stats(
    service: State<'_, Arc<UsageStatsService>>,
    range_days: Option<u32>,
    workspace_filter: Option<String>,
) -> AppResult<UsageQueryResult> {
    let service = service.inner().clone();
    run_usage_blocking(move || service.query_usage(range_days.unwrap_or(30), workspace_filter))
        .await
}

#[tauri::command]
pub async fn query_context_usage(
    service: State<'_, Arc<UsageStatsService>>,
    pty_session_id: String,
) -> AppResult<ContextUsageSnapshot> {
    let service = service.inner().clone();
    run_usage_blocking(move || Ok(service.context_usage_for_pty(&pty_session_id))).await
}

#[tauri::command]
pub async fn query_session_cost(
    service: State<'_, Arc<UsageStatsService>>,
    pty_session_id: String,
) -> AppResult<SessionCostSnapshot> {
    let service = service.inner().clone();
    run_usage_blocking(move || Ok(service.session_cost_for_pty(&pty_session_id))).await
}

async fn run_usage_blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    // WSL UNC lookup/parsing and SQLite can take seconds. Neither the native
    // window's command dispatch nor Tokio's async workers may run that I/O.
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn refresh_usage_stats(service: State<'_, Arc<UsageStatsService>>) -> AppResult<()> {
    let svc = service.inner().clone();
    svc.refresh_usage_stats().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn slow_context_reads_do_not_block_command_dispatch() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let query = tokio::spawn(run_usage_blocking(move || {
            let _ = started_tx.send(());
            release_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|error| AppError::from(error.to_string()))?;
            Ok(7)
        }));
        started_rx.await.expect("blocking reader started");
        assert!(
            !query.is_finished(),
            "dispatch must run while the filesystem read is still blocked"
        );
        release_tx.send(()).expect("release reader");
        assert_eq!(query.await.unwrap().unwrap(), 7);
    }

    #[tokio::test]
    async fn usage_query_errors_are_preserved() {
        let error = run_usage_blocking(|| Err::<(), _>(AppError::from("test read failed")))
            .await
            .expect_err("failed query");
        assert!(error.to_string().contains("test read failed"));
    }
}
