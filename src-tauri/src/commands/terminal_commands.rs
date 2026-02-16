use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::{TerminalService, SessionStatusInfo};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// 创建终端会话
#[tauri::command]
pub fn create_terminal_session(
    app_handle: AppHandle,
    service: State<'_, Arc<TerminalService>>,
    request: CreateSessionRequest,
) -> AppResult<String> {
    Ok(service.create_session(
        app_handle,
        &request.project_path,
        request.cols,
        request.rows,
        request.workspace_name.as_deref(),
        request.provider_id.as_deref(),
    )?)
}

/// 向终端写入数据
#[tauri::command]
pub fn write_terminal(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    Ok(service.write(&session_id, &data)?)
}

/// 调整终端大小
#[tauri::command]
pub fn resize_terminal(
    service: State<'_, Arc<TerminalService>>,
    request: ResizeRequest,
) -> AppResult<()> {
    Ok(service.resize(&request.session_id, request.cols, request.rows)?)
}

/// 关闭终端会话
#[tauri::command]
pub fn kill_terminal(
    service: State<'_, Arc<TerminalService>>,
    session_id: String,
) -> AppResult<()> {
    Ok(service.kill(&session_id)?)
}

/// 获取所有终端状态
#[tauri::command]
pub fn get_all_terminal_status(
    service: State<'_, Arc<TerminalService>>,
) -> AppResult<Vec<SessionStatusInfo>> {
    Ok(service.get_all_status()?)
}
