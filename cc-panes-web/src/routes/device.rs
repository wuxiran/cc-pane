//! 设备信息与环境检测：供另一台 CC-Panes 在「设备」视图里展示本机状态
//! （docs/111-multi-device.md）。
use std::sync::OnceLock;
use std::time::Instant;

use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

use crate::state::AppState;

pub const APP_VERSION: &str = env!("CC_PANES_APP_VERSION");

static STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// 在进程启动时调用一次，作为 uptime 起点。
pub fn mark_started() {
    let _ = STARTED_AT.set(Instant::now());
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub hostname: Option<String>,
    pub os: &'static str,
    pub os_version: Option<String>,
    pub arch: &'static str,
    pub app_version: &'static str,
    pub uptime_secs: u64,
    pub home_dir: Option<String>,
    pub default_cwd: String,
    /// 是否以 headless/require-token 方式运行
    pub headless: bool,
}

pub async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(DeviceInfo {
        hostname: sysinfo::System::host_name(),
        os: std::env::consts::OS,
        os_version: sysinfo::System::long_os_version(),
        arch: std::env::consts::ARCH,
        app_version: APP_VERSION,
        uptime_secs: STARTED_AT.get().map_or(0, |at| at.elapsed().as_secs()),
        home_dir: dirs::home_dir().map(|path| path.to_string_lossy().to_string()),
        default_cwd: state.default_cwd.clone(),
        headless: state.web_auth.require_auth(),
    })
}

pub async fn get_environment(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let registry = state.cli_registry.clone();
    tokio::task::spawn_blocking(move || {
        cc_panes_core::services::environment_check::check_environment(&registry)
    })
    .await
    .map(Json)
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}
