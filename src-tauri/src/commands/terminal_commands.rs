use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::{TerminalService, SessionStatusInfo, ShellInfo};
use crate::utils::error::AppError;
use crate::utils::{AppResult, validate_path};
use std::sync::Arc;
use tauri::{AppHandle, State};
use crate::services::terminal_service;
use tracing::debug;

/// 创建终端会话
#[tauri::command]
pub fn create_terminal_session(
    app_handle: AppHandle,
    service: State<'_, Arc<TerminalService>>,
    request: CreateSessionRequest,
) -> AppResult<String> {
    debug!(project_path = %request.project_path, "cmd::create_terminal_session");
    validate_path(&request.project_path)?;
    if let Some(ref ws_path) = request.workspace_path {
        validate_path(ws_path)?;
    }
    Ok(service.create_session(
        app_handle,
        &request.project_path,
        request.cols,
        request.rows,
        request.workspace_name.as_deref(),
        request.provider_id.as_deref(),
        request.workspace_path.as_deref(),
        request.launch_claude,
        request.resume_id.as_deref(),
    )?)
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
pub fn get_available_shells(
    service: State<'_, Arc<TerminalService>>,
) -> AppResult<Vec<ShellInfo>> {
    Ok(service.get_available_shells())
}

/// 获取 Windows Build Number（用于 xterm.js windowsPty 配置）
#[tauri::command]
pub fn get_windows_build_number() -> AppResult<u32> {
    Ok(terminal_service::get_windows_build_number())
}
