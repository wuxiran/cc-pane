use crate::utils::{AppError, AppResult};
use cc_panes_core::models::SystemStats;
use cc_panes_core::services::SystemStatsService;
use std::sync::Arc;
use tauri::State;

async fn get_system_stats_from(service: Arc<SystemStatsService>) -> AppResult<SystemStats> {
    let started = std::time::Instant::now();
    let stats = tauri::async_runtime::spawn_blocking(move || service.get_system_stats())
        .await
        .map_err(|error| AppError::from(error.to_string()))?;
    tracing::debug!(
        elapsed_micros = started.elapsed().as_micros(),
        "[system-stats] pull sample completed"
    );
    Ok(stats)
}

#[tauri::command]
pub async fn get_system_stats(
    service: State<'_, Arc<SystemStatsService>>,
) -> AppResult<SystemStats> {
    get_system_stats_from(service.inner().clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::services::SystemStatsService;
    use std::sync::Arc;

    #[tokio::test]
    async fn get_system_stats_returns_expected_structure_and_memory_range() {
        let started = std::time::Instant::now();
        let stats = get_system_stats_from(Arc::new(SystemStatsService::new()))
            .await
            .expect("system stats command should succeed");
        println!(
            "system stats command sample: {} us",
            started.elapsed().as_micros()
        );

        assert!(stats.cpu_percent.is_finite());
        assert!((0.0..=100.0).contains(&stats.cpu_percent));
        assert!(stats.mem_total > 0);
        assert!(stats.mem_used <= stats.mem_total);

        let json = serde_json::to_value(stats).expect("serialize system stats");
        assert!(json.get("cpuPercent").is_some());
        assert!(json.get("memUsed").is_some());
        assert!(json.get("memTotal").is_some());
    }
}
