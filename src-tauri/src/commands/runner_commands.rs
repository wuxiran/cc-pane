use cc_panes_core::models::{
    PortClaim, PortConflict, RunnerInstance, RunnerInstanceStatus, RunnerLaunchPlan, RunnerProfile,
    RunnerProfileDraft,
};
use cc_panes_core::services::{ProcessMonitorService, RunnerService, TerminalService};
use cc_panes_core::utils::{error::AppError, AppResult};
use std::sync::Arc;
use tauri::State;

fn map(svc_err: String) -> AppError {
    AppError::from(svc_err)
}

#[tauri::command]
pub async fn runner_list_profiles(
    project_path: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<Vec<RunnerProfile>> {
    service.list_profiles(&project_path).map_err(map)
}

#[tauri::command]
pub async fn runner_get_profile(
    id: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<Option<RunnerProfile>> {
    service.get_profile(&id).map_err(map)
}

#[tauri::command]
pub async fn runner_upsert_profile(
    draft: RunnerProfileDraft,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<RunnerProfile> {
    service.upsert_profile(draft).map_err(map)
}

#[tauri::command]
pub async fn runner_delete_profile(
    id: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<()> {
    service.delete_profile(&id).map_err(map)
}

#[tauri::command]
pub async fn runner_plan_launch(
    profile_id: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<RunnerLaunchPlan> {
    service.plan_launch(&profile_id).map_err(map)
}

#[tauri::command]
pub async fn runner_list_active_instances(
    project_path: Option<String>,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<Vec<RunnerInstance>> {
    service
        .list_active_instances(project_path.as_deref())
        .map_err(map)
}

#[tauri::command]
pub async fn runner_list_port_conflicts(
    ports: Vec<u16>,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<Vec<PortConflict>> {
    service.find_conflicts(&ports, None).map_err(map)
}

#[tauri::command]
pub async fn runner_refresh_port_claims(
    instance_id: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<Vec<PortClaim>> {
    service.refresh_port_claims(&instance_id).map_err(map)
}

#[tauri::command]
pub async fn runner_mark_instance_exited(
    instance_id: String,
    exit_code: Option<i32>,
    orphaned: Option<bool>,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<()> {
    let status = if orphaned.unwrap_or(false) {
        RunnerInstanceStatus::Orphaned
    } else {
        RunnerInstanceStatus::Exited
    };
    service
        .mark_instance_exited(&instance_id, exit_code, status)
        .map_err(map)
}

#[tauri::command]
pub async fn runner_kill_instance(
    instance_id: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<bool> {
    service.kill_instance(&instance_id).map_err(map)
}

/// 薄包装：按 PID 杀进程（用于 skill 决定杀某个具体 PID，可能不是 instance 的 root）
#[tauri::command]
pub async fn runner_kill_pid(
    pid: u32,
    monitor: State<'_, Arc<ProcessMonitorService>>,
) -> AppResult<bool> {
    monitor
        .kill_process(pid)
        .map_err(|e| AppError::from(e.to_string()))
}

/// 组合命令：根据 PTY session_id 反查 root_pid，登记为 runner instance。
/// 用于前端流程：createTerminalSession → submit command → runner_register_for_session。
/// profile_id 可选；填了表示走 explicit profile 启动，会刷新 last_started_at。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn runner_register_for_session(
    session_id: String,
    project_path: String,
    workspace_name: Option<String>,
    profile_id: Option<String>,
    runtime_kind: String,
    command: String,
    cwd: String,
    terminal: State<'_, Arc<TerminalService>>,
    runner: State<'_, Arc<RunnerService>>,
) -> AppResult<RunnerInstance> {
    let statuses = terminal
        .get_all_status()
        .map_err(|e| AppError::from(e.to_string()))?;
    let root_pid = statuses
        .into_iter()
        .find(|s| s.session_id == session_id)
        .and_then(|s| s.pid)
        .ok_or_else(|| AppError::from(format!("session not found or no PID: {}", session_id)))?;

    runner
        .register_instance(
            profile_id.as_deref(),
            &project_path,
            workspace_name.as_deref(),
            Some(&session_id),
            root_pid,
            &runtime_kind,
            &command,
            &cwd,
        )
        .map_err(map)
}

/// 隐式扫描入口：hook / cli-hook 子命令上报"某 PTY 跑了 dev 命令"
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn runner_register_implicit_instance(
    project_path: String,
    workspace_name: Option<String>,
    session_id: Option<String>,
    root_pid: u32,
    runtime_kind: String,
    command: String,
    cwd: String,
    service: State<'_, Arc<RunnerService>>,
) -> AppResult<RunnerInstance> {
    service
        .register_implicit_instance(
            &project_path,
            workspace_name.as_deref(),
            session_id.as_deref(),
            root_pid,
            &runtime_kind,
            &command,
            &cwd,
        )
        .map_err(map)
}
