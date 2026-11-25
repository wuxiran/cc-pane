use std::sync::Arc;

use crate::services::{
    detect_tailscale, tailscale_serve_disable, tailscale_serve_enable, tailscale_serve_status,
    SettingsService, TailscaleServeError, TailscaleServeStatus, TailscaleStatus,
};
use crate::utils::AppResult;
use serde::Serialize;
use tauri::State;
use tracing::{debug, info};

/// 探测本机 Tailscale 状态（只读，不执行 up/serve、不碰凭证）。
/// async + spawn_blocking：子进程探测最长 3s，不能阻塞 IPC 线程。
#[tauri::command]
pub async fn detect_tailscale_status() -> AppResult<TailscaleStatus> {
    debug!("cmd::detect_tailscale_status");
    tauri::async_runtime::spawn_blocking(detect_tailscale)
        .await
        .map_err(|error| crate::utils::AppError::from(error.to_string()))
}

/// serve 操作的结果：成功给出当前状态，失败给出分类后的原因（前端按 kind 显示文案）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleServeOutcome {
    pub status: Option<TailscaleServeStatus>,
    pub error: Option<TailscaleServeError>,
}

impl From<Result<TailscaleServeStatus, TailscaleServeError>> for TailscaleServeOutcome {
    fn from(result: Result<TailscaleServeStatus, TailscaleServeError>) -> Self {
        match result {
            Ok(status) => Self {
                status: Some(status),
                error: None,
            },
            Err(error) => Self {
                status: None,
                error: Some(error),
            },
        }
    }
}

async fn run_serve<F>(task: F) -> AppResult<TailscaleServeOutcome>
where
    F: FnOnce() -> Result<TailscaleServeStatus, TailscaleServeError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map(TailscaleServeOutcome::from)
        .map_err(|error| crate::utils::AppError::from(error.to_string()))
}

/// 读 `tailscale serve status`（只读）：HTTPS 是否已指向本机 Web 服务。
#[tauri::command]
pub async fn tailscale_serve_get_status(
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<TailscaleServeOutcome> {
    let port = settings.get_settings().web_access.port;
    run_serve(move || tailscale_serve_status(port)).await
}

/// 用户点击「一键开启」才执行：`tailscale serve --bg --https=443 http://127.0.0.1:<port>`。
/// 经 Serve 进来的流量算远程访问，没设密码时拒绝开启。
#[tauri::command]
pub async fn tailscale_serve_start(
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<TailscaleServeOutcome> {
    debug!("cmd::tailscale_serve_start");
    let web_access = settings.get_settings().web_access;
    if !web_access.auth_required() {
        return Ok(TailscaleServeOutcome::from(Err(
            TailscaleServeError::PasswordRequired,
        )));
    }
    let port = web_access.port;
    info!(port, "user requested tailscale serve");
    run_serve(move || tailscale_serve_enable(port)).await
}

/// 用户点击「关闭」：只在 HTTPS 443 指向本机 Web 服务时执行 `tailscale serve --https=443 off`。
#[tauri::command]
pub async fn tailscale_serve_stop(
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<TailscaleServeOutcome> {
    debug!("cmd::tailscale_serve_stop");
    let port = settings.get_settings().web_access.port;
    info!(port, "user requested tailscale serve off");
    run_serve(move || tailscale_serve_disable(port)).await
}
