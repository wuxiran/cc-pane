//! 设备（其他运行 CC-Panes 的服务器 / 电脑）：注册、部署、状态快照。
//! docs/111-multi-device.md
//!
//! 与对端的所有通信都走对端 cc-panes-web 的 HTTP API + 设备令牌：
//! - SSH 设备：`DeviceService` 建本地端口转发，访问 `http://127.0.0.1:<转发端口>`
//! - 直连设备：访问用户填写的地址（局域网 / Tailscale）

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cc_panes_core::models::CreateSessionRequest;
use cc_panes_core::models::{DeviceAddRequest, DeviceConnection, DeviceEndpoint, DeviceSummary};
use cc_panes_core::services::device_deploy::{self, RemotePlatform};
use cc_panes_core::services::remote_terminal::RemoteSessionRouter;
use cc_panes_core::services::{DeviceService, TerminalBackend};
use cc_panes_core::utils::AppPaths;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::utils::{AppError, AppResult};

pub const DEVICE_DEPLOY_PROGRESS_EVENT: &str = "device-deploy-progress";
/// 开发期指定一个本地构建的服务端二进制（或发布包 .tar.gz），跳过下载。
const SERVER_BINARY_ENV: &str = "CCPANES_DEVICE_SERVER_BINARY";
const RELEASE_BASE: &str = "https://github.com/wuxiran/cc-pane/releases/download";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

async fn blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(|error| AppError::from(format!("{error:#}")))
}

/// 设备流量一律不走系统代理：回环转发端口和 tailnet 地址都会被代理拦截。
fn device_http_client(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|error| AppError::from(error.to_string()))
}

#[derive(Debug)]
enum DeviceHttpError {
    Unreachable(String),
    Unauthorized,
    Status(u16, String),
}

impl std::fmt::Display for DeviceHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(message) => write!(f, "unreachable: {message}"),
            Self::Unauthorized => write!(f, "device token rejected"),
            Self::Status(code, body) => write!(f, "HTTP {code}: {body}"),
        }
    }
}

async fn get_json(
    client: &reqwest::Client,
    endpoint: &DeviceEndpoint,
    path: &str,
) -> Result<serde_json::Value, DeviceHttpError> {
    let mut request = client.get(format!("{}{path}", endpoint.base_url));
    if let Some(token) = &endpoint.token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| DeviceHttpError::Unreachable(error.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(DeviceHttpError::Unauthorized);
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(DeviceHttpError::Status(
            status.as_u16(),
            body.chars().take(300).collect(),
        ));
    }
    response
        .json()
        .await
        .map_err(|error| DeviceHttpError::Status(status.as_u16(), error.to_string()))
}

#[tauri::command]
pub async fn device_list(service: State<'_, Arc<DeviceService>>) -> AppResult<Vec<DeviceSummary>> {
    let service = service.inner().clone();
    blocking(move || Ok(service.list())).await
}

#[tauri::command]
pub async fn device_add(
    request: DeviceAddRequest,
    service: State<'_, Arc<DeviceService>>,
) -> AppResult<DeviceSummary> {
    let service = service.inner().clone();
    blocking(move || {
        let device = service.add(request)?;
        service
            .summary(&device.id)
            .ok_or_else(|| anyhow::anyhow!("device vanished after add"))
    })
    .await
}

#[tauri::command]
pub async fn device_rename(
    id: String,
    name: String,
    service: State<'_, Arc<DeviceService>>,
) -> AppResult<()> {
    let service = service.inner().clone();
    blocking(move || service.rename(&id, &name).map(|_| ())).await
}

#[tauri::command]
pub async fn device_remove(
    id: String,
    service: State<'_, Arc<DeviceService>>,
    router: State<'_, Arc<RemoteSessionRouter>>,
) -> AppResult<()> {
    let service = service.inner().clone();
    router.forget_device(&id);
    blocking(move || service.remove(&id)).await
}

/// 在设备上新建会话（由对方按它自己的工作空间配置启动，MCP / 技能 / 记忆齐全）。
///
/// 只负责创建和登记路由；前端随后用 `adoptSession` 打开标签，经现有恢复路径
/// （`get_terminal_recovery_snapshot`）接上输出流，与重连本机会话走同一条路。
#[tauri::command]
pub async fn device_create_session(
    id: String,
    request: CreateSessionRequest,
    router: State<'_, Arc<RemoteSessionRouter>>,
) -> AppResult<String> {
    let router = router.inner().clone();
    let backend = router.device_backend(&id);
    let session_id = tauri::async_runtime::spawn_blocking(move || backend.create_session(request))
        .await
        .map_err(|error| AppError::from(error.to_string()))??;
    router.register(&session_id, &id);
    Ok(session_id)
}

/// 把设备上已在运行的会话登记到本机，随后由前端 `adoptSession` 打开。
#[tauri::command]
pub async fn device_attach_session(
    id: String,
    session_id: String,
    router: State<'_, Arc<RemoteSessionRouter>>,
) -> AppResult<()> {
    let router = router.inner().clone();
    let backend = router.device_backend(&id);
    let probe_id = session_id.clone();
    let status =
        tauri::async_runtime::spawn_blocking(move || backend.get_session_status(&probe_id))
            .await
            .map_err(|error| AppError::from(error.to_string()))??;
    if status.is_none() {
        return Err(AppError::from(format!(
            "Session {session_id} no longer exists on this device"
        )));
    }
    router.register(&session_id, &id);
    Ok(())
}

#[tauri::command]
pub async fn device_set_token(
    id: String,
    token: String,
    service: State<'_, Arc<DeviceService>>,
) -> AppResult<()> {
    let service = service.inner().clone();
    blocking(move || service.set_token(&id, &token)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSnapshot {
    pub device_id: String,
    pub online: bool,
    /// `ssh` 连不上 SSH；`unreachable` SSH 通但服务没起来（多半未部署）；
    /// `unauthorized` 令牌无效；`error` 其他
    pub error_kind: Option<&'static str>,
    pub error: Option<String>,
    pub info: Option<serde_json::Value>,
    pub environment: Option<serde_json::Value>,
    pub workspaces: Option<serde_json::Value>,
    pub sessions: Option<serde_json::Value>,
    /// 最近启动记录：前端用 ptySessionId 把会话对到项目 / CLI
    pub launches: Option<serde_json::Value>,
}

impl DeviceSnapshot {
    fn failed(device_id: String, kind: &'static str, error: String) -> Self {
        Self {
            device_id,
            online: false,
            error_kind: Some(kind),
            error: Some(error),
            info: None,
            environment: None,
            workspaces: None,
            sessions: None,
            launches: None,
        }
    }
}

async fn resolve_endpoint(
    service: &Arc<DeviceService>,
    id: &str,
) -> Result<DeviceEndpoint, DeviceSnapshot> {
    let service = service.clone();
    let device_id = id.to_string();
    let is_ssh = service
        .get(id)
        .is_some_and(|device| matches!(device.connection, DeviceConnection::Ssh { .. }));
    blocking(move || service.endpoint(&device_id))
        .await
        .map_err(|error| {
            DeviceSnapshot::failed(
                id.to_string(),
                if is_ssh { "ssh" } else { "error" },
                error.to_string(),
            )
        })
}

#[tauri::command]
pub async fn device_snapshot(
    id: String,
    service: State<'_, Arc<DeviceService>>,
) -> AppResult<DeviceSnapshot> {
    let service = service.inner().clone();
    let client = device_http_client(Duration::from_secs(12))?;

    let mut endpoint = match resolve_endpoint(&service, &id).await {
        Ok(endpoint) => endpoint,
        Err(snapshot) => return Ok(snapshot),
    };
    let mut info = get_json(&client, &endpoint, "/api/device/info").await;
    if matches!(info, Err(DeviceHttpError::Unreachable(_))) {
        // 转发端口可能挂在一条已经断掉的 SSH 会话上：丢掉重建一次。
        service.drop_forward(&id);
        endpoint = match resolve_endpoint(&service, &id).await {
            Ok(endpoint) => endpoint,
            Err(snapshot) => return Ok(snapshot),
        };
        info = get_json(&client, &endpoint, "/api/device/info").await;
    }
    let info = match info {
        Ok(info) => info,
        Err(DeviceHttpError::Unauthorized) => {
            return Ok(DeviceSnapshot::failed(
                id,
                "unauthorized",
                "The device rejected the saved token".to_string(),
            ))
        }
        Err(DeviceHttpError::Unreachable(message)) => {
            return Ok(DeviceSnapshot::failed(id, "unreachable", message))
        }
        Err(other) => return Ok(DeviceSnapshot::failed(id, "error", other.to_string())),
    };

    let (environment, workspaces, sessions, launches) = tokio::join!(
        get_json(&client, &endpoint, "/api/environment"),
        get_json(&client, &endpoint, "/api/workspaces"),
        get_json(&client, &endpoint, "/api/sessions"),
        get_json(&client, &endpoint, "/api/launch-history?limit=50"),
    );
    Ok(DeviceSnapshot {
        device_id: id,
        online: true,
        error_kind: None,
        error: None,
        info: Some(info),
        environment: environment.ok(),
        workspaces: workspaces.ok(),
        sessions: sessions.ok(),
        launches: launches.ok(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployProgress<'a> {
    device_id: &'a str,
    /// connect / detect / download / upload / install / start / token / verify / done
    step: &'a str,
    detail: Option<String>,
    /// 0..=1，仅 download / upload 有
    fraction: Option<f64>,
}

fn emit_progress(
    app: &AppHandle,
    device_id: &str,
    step: &str,
    detail: Option<String>,
    fraction: Option<f64>,
) {
    let _ = app.emit(
        DEVICE_DEPLOY_PROGRESS_EVENT,
        DeployProgress {
            device_id,
            step,
            detail,
            fraction,
        },
    );
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployReport {
    pub platform: RemotePlatform,
    pub previous_version: Option<String>,
    pub version: String,
    pub manager: String,
    pub warnings: Vec<String>,
}

fn local_hostname() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "cc-panes-desktop".to_string())
}

/// 选服务端二进制：环境变量 > 与本机同平台时用随包的 cc-panes-web > 下载同版本发布包。
async fn resolve_server_binary(
    app: &AppHandle,
    device_id: &str,
    platform: &RemotePlatform,
) -> AppResult<PathBuf> {
    if let Ok(explicit) = std::env::var(SERVER_BINARY_ENV) {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Ok(path);
        }
    }
    if platform.os == std::env::consts::OS && platform.arch == std::env::consts::ARCH {
        let resource_dir = app.path().resource_dir().ok();
        if let Ok(path) = crate::services::resolve_web_binary(resource_dir.as_deref()) {
            return Ok(path);
        }
    }
    if platform.os != "linux" {
        return Err(AppError::from(format!(
            "No server build for {}-{}. Set {SERVER_BINARY_ENV} to a cc-panes-web binary built for that machine.",
            platform.os, platform.arch
        )));
    }

    let asset = format!(
        "cc-panes-web_{APP_VERSION}_{}.tar.gz",
        platform.asset_suffix()
    );
    let cache_dir = app
        .state::<Arc<AppPaths>>()
        .data_dir()
        .join("cache")
        .join("server-binaries");
    let target = cache_dir.join(&asset);
    if target.exists() {
        return Ok(target);
    }
    std::fs::create_dir_all(&cache_dir).map_err(|e| AppError::from(e.to_string()))?;

    let url = format!("{RELEASE_BASE}/v{APP_VERSION}/{asset}");
    emit_progress(app, device_id, "download", Some(asset.clone()), Some(0.0));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| AppError::from(e.to_string()))?;
    let expected_sha = client
        .get(format!("{url}.sha256"))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| {
            AppError::from(format!(
                "Server build {asset} is not available for download ({e}). For unreleased builds set {SERVER_BINARY_ENV}."
            ))
        })?
        .text()
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut response = client
        .get(&url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| AppError::from(format!("Failed to download {asset}: {e}")))?;
    let total = response.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::from(format!("Failed to download {asset}: {e}")))?
    {
        bytes.extend_from_slice(&chunk);
        if let Some(total) = total.filter(|total| *total > 0) {
            emit_progress(
                app,
                device_id,
                "download",
                Some(asset.clone()),
                Some(bytes.len() as f64 / total as f64),
            );
        }
    }
    use sha2::Digest;
    let actual: String = sha2::Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual != expected_sha {
        return Err(AppError::from(format!(
            "Checksum mismatch for {asset}; refusing to deploy it"
        )));
    }
    let partial = target.with_extension("partial");
    std::fs::write(&partial, &bytes).map_err(|e| AppError::from(e.to_string()))?;
    std::fs::rename(&partial, &target).map_err(|e| AppError::from(e.to_string()))?;
    Ok(target)
}

/// 部署 / 升级一台 SSH 设备上的 headless 服务端，并确保本机持有可用令牌。
#[tauri::command]
pub async fn device_deploy(
    id: String,
    app: AppHandle,
    service: State<'_, Arc<DeviceService>>,
) -> AppResult<DeployReport> {
    let service = service.inner().clone();
    let device = service
        .get(&id)
        .ok_or_else(|| AppError::from(format!("Device {id} not found")))?;
    let DeviceConnection::Ssh {
        machine_id,
        remote_port,
    } = device.connection.clone()
    else {
        return Err(AppError::from(
            "Only SSH devices can be deployed from here; install cc-panes-web on that machine yourself.",
        ));
    };

    emit_progress(&app, &id, "connect", None, None);
    let (session, platform) = {
        let service = service.clone();
        let app = app.clone();
        let id = id.clone();
        blocking(move || {
            let machine = service
                .ssh_machines()
                .get(&machine_id)
                .ok_or_else(|| anyhow::anyhow!("SSH machine {machine_id} no longer exists"))?;
            let session = service.ssh_connection().connect_machine(&machine)?;
            emit_progress(&app, &id, "detect", None, None);
            let platform = device_deploy::probe_platform(&session)?;
            Ok((session, platform))
        })
        .await?
    };

    let binary = resolve_server_binary(&app, &id, &platform).await?;

    let outcome = {
        let app = app.clone();
        let id = id.clone();
        let platform = platform.clone();
        blocking(move || {
            emit_progress(&app, &id, "upload", None, Some(0.0));
            device_deploy::upload_binary(&session, &platform, &binary, |sent, total| {
                if total > 0 {
                    emit_progress(&app, &id, "upload", None, Some(sent as f64 / total as f64));
                }
            })?;
            emit_progress(&app, &id, "install", None, None);
            let outcome = device_deploy::install_service(&session, &platform, remote_port)?;
            emit_progress(&app, &id, "start", None, None);
            if let Err(error) =
                device_deploy::wait_until_listening(&session, remote_port, Duration::from_secs(20))
            {
                let logs = device_deploy::recent_logs(&session, &platform);
                anyhow::bail!("{error}\n{logs}");
            }
            Ok((session, outcome))
        })
        .await?
    };
    let (session, install) = outcome;

    // 令牌：已有且可用就沿用，否则在服务器上新建一个。
    emit_progress(&app, &id, "token", None, None);
    service.drop_forward(&id);
    let client = device_http_client(Duration::from_secs(10))?;
    let endpoint = resolve_endpoint(&service, &id)
        .await
        .map_err(|snapshot| AppError::from(snapshot.error.unwrap_or_default()))?;
    let token_ok = endpoint.token.is_some()
        && get_json(&client, &endpoint, "/api/device/info")
            .await
            .is_ok();
    if !token_ok {
        let service = service.clone();
        let platform = platform.clone();
        let id = id.clone();
        blocking(move || {
            let token = device_deploy::create_remote_token(&session, &platform, &local_hostname())?;
            service.set_token(&id, &token)
        })
        .await?;
    }

    emit_progress(&app, &id, "verify", None, None);
    let endpoint = resolve_endpoint(&service, &id)
        .await
        .map_err(|snapshot| AppError::from(snapshot.error.unwrap_or_default()))?;
    let info = get_json(&client, &endpoint, "/api/device/info")
        .await
        .map_err(|error| {
            AppError::from(format!(
                "Deployed, but the server is not answering: {error}"
            ))
        })?;
    let version = info
        .get("appVersion")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    emit_progress(&app, &id, "done", Some(version.clone()), None);

    Ok(DeployReport {
        previous_version: platform.installed_version.clone(),
        platform,
        version,
        manager: install.manager,
        warnings: install.warnings,
    })
}
