use crate::models::TerminalReplaySnapshot;
use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::terminal_service;
use crate::services::terminal_service::SessionOutput;
use crate::services::{SessionStatusInfo, ShellInfo, TerminalService};
use crate::utils::error::AppError;
use crate::utils::{validate_path, validate_ssh_info, AppResult};
use cc_cli_adapters::{CliToolInfo, CliToolRegistry};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tracing::debug;

/// 创建终端会话
#[tauri::command]
pub async fn create_terminal_session(
    _app_handle: AppHandle,
    service: State<'_, Arc<TerminalService>>,
    request: CreateSessionRequest,
) -> AppResult<String> {
    debug!(
        project_path = %request.project_path,
        ssh = request.ssh.is_some(),
        wsl = request.wsl.is_some(),
        "cmd::create_terminal_session"
    );

    if request.ssh.is_some() && request.wsl.is_some() {
        return Err(AppError::from(
            "SSH and WSL launch options cannot be combined",
        ));
    }

    if let Some(ref ssh_info) = request.ssh {
        validate_ssh_info(ssh_info)?;
    } else {
        validate_path(&request.project_path)?;
        if let Some(ref ws_path) = request.workspace_path {
            validate_path(ws_path)?;
        }
    }

    let svc = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        svc.create_session(
            &request.project_path,
            request.cols,
            request.rows,
            request.workspace_name.as_deref(),
            request.provider_id.as_deref(),
            request.workspace_path.as_deref(),
            request.effective_cli_tool(),
            request.resume_id.as_deref(),
            request.skip_mcp,
            request.append_system_prompt.as_deref(),
            None,
            request.ssh.as_ref(),
            request.wsl.as_ref(),
        )
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?;
    Ok(result?)
}

/// 向终端写入数据
#[tauri::command]
pub fn write_terminal(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::write_terminal");
    Ok(service.write(&session_id, &data)?)
}

/// 调整终端大小
#[tauri::command]
pub fn resize_terminal(
    service: State<'_, Arc<TerminalService>>,
    request: ResizeRequest,
) -> AppResult<()> {
    debug!(session_id = %request.session_id, "cmd::resize_terminal");
    Ok(service.resize(&request.session_id, request.cols, request.rows)?)
}

/// 关闭终端会话（async + spawn_blocking 防止阻塞主线程）
#[tauri::command]
pub async fn kill_terminal(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::kill_terminal");
    let svc = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || svc.kill(&session_id))
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    Ok(result?)
}

/// 获取所有终端状态
#[tauri::command]
pub fn get_all_terminal_status(
    service: State<'_, Arc<TerminalService>>,
) -> AppResult<Vec<SessionStatusInfo>> {
    Ok(service.get_all_status()?)
}

/// 获取可用 Shell 列表
#[tauri::command]
pub fn get_available_shells(service: State<'_, Arc<TerminalService>>) -> AppResult<Vec<ShellInfo>> {
    Ok(service.get_available_shells())
}

/// 获取 Windows Build Number（用于 xterm.js windowsPty 配置）
#[tauri::command]
pub fn get_windows_build_number() -> AppResult<u32> {
    Ok(terminal_service::get_windows_build_number())
}

/// 检测开发环境（Node.js + CLI 工具，所有子进程调用均带 5s 超时）
/// async + spawn_blocking 防止阻塞 IPC 线程
#[tauri::command]
pub async fn check_environment(
    registry: State<'_, Arc<CliToolRegistry>>,
) -> AppResult<serde_json::Value> {
    let registry = registry.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let node_path = which::which("node").ok();
        let node_installed = node_path.is_some();
        let node_version = node_path.and_then(|path| {
            cc_cli_adapters::run_with_timeout(
                &path,
                &["--version".to_string()],
                std::time::Duration::from_secs(5),
            )
        });

        let cli_tools = registry.detect_all();

        serde_json::json!({
            "node": { "installed": node_installed, "version": node_version },
            "cliTools": cli_tools
        })
    })
    .await
    .map_err(|e| AppError::from(format!("Environment check failed: {}", e)))?;
    Ok(result)
}

/// 列出所有已注册的 CLI 工具（含实时检测状态）
/// async + spawn_blocking 防止阻塞 IPC 线程
#[tauri::command]
pub async fn list_cli_tools(
    registry: State<'_, Arc<CliToolRegistry>>,
) -> AppResult<Vec<CliToolInfo>> {
    let registry = registry.inner().clone();
    let tools = tauri::async_runtime::spawn_blocking(move || registry.detect_all())
        .await
        .map_err(|e| AppError::from(format!("List CLI tools failed: {}", e)))?;
    Ok(tools)
}

/// 读取终端会话的最近输出（纯文本，ANSI 已剥离）
#[tauri::command]
pub fn get_terminal_output(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
    lines: Option<usize>,
) -> AppResult<SessionOutput> {
    debug!(session_id = %session_id, "cmd::get_terminal_output");
    Ok(service.get_session_output(&session_id, lines.unwrap_or(0))?)
}

/// 获取 attach-existing 所需的原始 VT replay 快照
#[tauri::command]
pub fn get_terminal_replay_snapshot(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
) -> AppResult<Option<TerminalReplaySnapshot>> {
    debug!(session_id = %session_id, "cmd::get_terminal_replay_snapshot");
    Ok(service.get_session_replay_snapshot(&session_id)?)
}
