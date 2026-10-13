use crate::utils::{AppError, AppResult};
use cc_panes_core::models::{
    KillProcessResult, ResourcePolicyStatus, ResourceTree, SessionResourcePolicy, SystemStats,
};
use cc_panes_core::services::SystemStatsService;
use std::sync::Arc;
use tauri::State;

use crate::services::heavy_command_sampler::{
    clear_recovered_job_memory_warnings, job_memory_warnings_of, session_roots,
};
use crate::services::TerminalBackendState;

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

#[tauri::command]
pub async fn get_resource_tree(
    stats_service: State<'_, Arc<SystemStatsService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<ResourceTree> {
    let backend = terminal_backend.backend();
    let statuses = backend.get_all_status()?;
    let warnings = job_memory_warnings_of(&statuses);
    let roots = session_roots(statuses);
    let service = stats_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tree = service.get_resource_tree(&roots);
        // W5：弹层刷新也是一次树采样，顺手清掉已回落的 Job 内存告警（不另起轮询）。
        if !warnings.is_empty() {
            clear_recovered_job_memory_warnings(backend.as_ref(), &warnings, &tree.sessions);
        }
        tree
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn kill_orphan_processes(
    pids: Vec<u32>,
    stats_service: State<'_, Arc<SystemStatsService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<Vec<KillProcessResult>> {
    let roots = session_roots(terminal_backend.backend().get_all_status()?);
    let service = stats_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.kill_orphan_processes(&pids, &roots))
        .await
        .map_err(|error| AppError::from(error.to_string()))
}

/// 资源管理器会话行三态（正常 / 让路 / 效率模式）。daemon 模式下打到 daemon；
/// 旧 daemon 缺路由回 `Unsupported("daemon too old")`，由 UI 显示而非报错。
#[tauri::command]
pub async fn set_session_resource_policy(
    session_id: String,
    policy: SessionResourcePolicy,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<ResourcePolicyStatus> {
    let backend = terminal_backend.backend();
    tauri::async_runtime::spawn_blocking(move || backend.set_resource_policy(&session_id, policy))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::models::ManagedSessionRoot;
    use cc_panes_core::services::terminal_service::SessionStatus;
    use cc_panes_core::services::{SessionStatusInfo, SystemStatsService};
    use std::sync::Arc;

    fn status(session_id: &str, status: SessionStatus, pid: Option<u32>) -> SessionStatusInfo {
        SessionStatusInfo {
            session_id: session_id.to_string(),
            status,
            last_output_at: 0,
            pid,
            exit_code: None,
            current_tool_name: None,
            current_tool_use_id: None,
            current_tool_summary: None,
            updated_at: 0,
            osc_progress: None,
            resource_policy: None,
            job_memory_warning: None,
            runtime_kind: None,
            wsl_distro: None,
            heavy_queue: None,
        }
    }

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

    #[test]
    fn resource_tree_command_uses_only_live_terminal_pid_ledger_entries() {
        let roots = session_roots(vec![
            status("live", SessionStatus::Thinking, Some(42)),
            status("exited", SessionStatus::Exited, Some(43)),
            status("missing-pid", SessionStatus::Idle, None),
        ]);

        assert_eq!(
            roots,
            vec![ManagedSessionRoot {
                session_id: "live".to_string(),
                root_pid: 42,
                runtime_kind: None,
                wsl_distro: None,
            }]
        );
    }
}
