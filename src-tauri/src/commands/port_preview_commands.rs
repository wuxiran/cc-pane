//! 远程 dev server 端口的本机预览（docs/116 §B）：SSH 本地端口转发的打开 / 列出 / 关闭。
use crate::models::SshConnectionInfo;
use crate::services::{PortPreviewService, PortPreviewTunnel};
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tracing::info;

/// 隧道集合变化（打开 / 关闭 / 会话结束回收）时广播，前端据此刷新列表。
pub const PORT_PREVIEW_CHANGED_EVENT: &str = "port-preview-changed";

/// 为 SSH 会话打开（或复用）一条到远端回环端口的本地转发。阻塞在 SSH 握手上，放进 blocking 线程。
#[tauri::command]
pub async fn open_port_preview(
    session_id: String,
    ssh: SshConnectionInfo,
    remote_host: String,
    remote_port: u16,
    app: AppHandle,
    service: State<'_, Arc<PortPreviewService>>,
) -> AppResult<PortPreviewTunnel> {
    info!(session_id = %session_id, remote_port, "cmd::open_port_preview");
    let service = service.inner().clone();
    let tunnel = tauri::async_runtime::spawn_blocking(move || {
        service.open(&session_id, &ssh, &remote_host, remote_port)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
    .map_err(|error| AppError::from(format!("{error:#}")))?;
    let _ = app.emit(PORT_PREVIEW_CHANGED_EVENT, ());
    Ok(tunnel)
}

#[tauri::command]
pub async fn list_port_previews(
    service: State<'_, Arc<PortPreviewService>>,
) -> AppResult<Vec<PortPreviewTunnel>> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn close_port_preview(
    id: String,
    app: AppHandle,
    service: State<'_, Arc<PortPreviewService>>,
) -> AppResult<bool> {
    let service = service.inner().clone();
    let closed = tauri::async_runtime::spawn_blocking(move || service.close(&id))
        .await
        .map_err(|error| AppError::from(error.to_string()))?;
    if closed {
        let _ = app.emit(PORT_PREVIEW_CHANGED_EVENT, ());
    }
    Ok(closed)
}

/// 会话结束（terminal-exit / session-killed）时回收它的隧道。
pub fn release_port_previews_for_session(
    app: &AppHandle,
    service: Arc<PortPreviewService>,
    session_id: String,
) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let closed = service.close_for_session(&session_id);
        if closed > 0 {
            info!(session_id = %session_id, closed, "port previews released on session end");
            let _ = app.emit(PORT_PREVIEW_CHANGED_EVENT, ());
        }
    });
}
