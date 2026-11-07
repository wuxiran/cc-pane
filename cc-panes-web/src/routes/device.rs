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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    /// 发起配对的设备名（对端主机名），记在令牌上方便日后辨认和吊销
    pub name: String,
}

/// 用一次性配对码换设备令牌（免鉴权路由；配对码本身是凭据）。
///
/// 只有本机打开了「允许其他设备连接」或以 headless 运行时才受理；对端地址仍受
/// 局域网开关 / 白名单约束。配对码 5 分钟有效、最多试 5 次。
pub async fn pair_device(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<PairRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let settings = state.settings_service.get_settings().web_access;
    let headless = state.web_auth.require_auth();
    if !settings.allow_devices && !headless {
        return Err((
            StatusCode::FORBIDDEN,
            "This computer does not accept device connections".to_string(),
        ));
    }
    if !crate::web_auth::device_peer_allowed(peer.ip(), &settings, headless) {
        return Err((
            StatusCode::FORBIDDEN,
            "Remote access is not allowed by Web access settings".to_string(),
        ));
    }
    let Some(tokens) = state.web_auth.device_tokens().cloned() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Device tokens are not available".to_string(),
        ));
    };
    let outcome = tokio::task::spawn_blocking(move || {
        tokens.redeem_pairing_code(&request.code, &request.name)
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    match outcome {
        cc_panes_core::services::PairingOutcome::Paired { token, .. } => {
            Ok(Json(serde_json::json!({
                "token": token,
                "hostname": sysinfo::System::host_name(),
                "appVersion": APP_VERSION,
            })))
        }
        cc_panes_core::services::PairingOutcome::Rejected => Err((
            StatusCode::UNAUTHORIZED,
            "Pairing code is wrong or has expired".to_string(),
        )),
    }
}
