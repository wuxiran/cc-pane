//! 对端（已配对的其他 CC-Panes）：地址择优 + HTTP 调用（设备令牌）。
//!
//! 对端本体 = `DeviceService` 里的设备（docs/111，令牌在 keyring），组网附加信息
//! （地址候选 / 实例 id / 最近在线）在 `mesh_peers` 表。探测只在被调用时做
//! （列联系人 / 发消息），不起任何按对端的常驻轮询。

use std::sync::Arc;
use std::time::Duration;

use cc_panes_core::models::{DeviceConnection, DeviceSummary, MeshAddressSource, MeshPeerRecord};
use cc_panes_core::repository::MeshPeerRepository;
use cc_panes_core::services::DeviceService;
use serde::Serialize;
use serde_json::Value;

use crate::utils::{AppError, AppResult};

const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct PeerEndpoint {
    pub device_id: String,
    pub name: String,
    pub base_url: String,
    pub token: Option<String>,
}

/// 「其他电脑」列表视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPeerView {
    pub device_id: String,
    pub name: String,
    /// `direct` / `ssh`。
    pub kind: &'static str,
    pub target_label: String,
    pub has_token: bool,
    #[serde(flatten)]
    pub mesh: MeshPeerRecord,
}

#[derive(Debug)]
pub enum PeerHttpError {
    Unreachable(String),
    Unauthorized,
    /// 对端回了 `{code,message}` 的错误体（或别的非 2xx）。
    Status(u16, Option<String>, String),
}

impl PeerHttpError {
    pub fn into_app_error(self) -> AppError {
        match self {
            Self::Unreachable(message) => AppError::coded(
                "MESH_PEER_UNREACHABLE",
                format!("Peer is unreachable: {message}"),
            ),
            Self::Unauthorized => AppError::coded(
                "MESH_PEER_UNAUTHORIZED",
                "The other computer rejected the saved device token; pair again",
            ),
            Self::Status(status, code, message) => AppError::coded(
                code.as_deref().unwrap_or("MESH_PEER_ERROR"),
                format!("Peer answered HTTP {status}: {message}"),
            ),
        }
    }

    /// 对端在线但不支持组网（旧版本 / headless 服务端没有 orchestrator）。
    pub fn unsupported(&self) -> bool {
        matches!(self, Self::Status(404 | 405, _, _))
            || matches!(self, Self::Status(503, Some(code), _) if code == "ACP_HOST_UNAVAILABLE")
    }
}

/// 组网流量不走系统代理（回环 / tailnet / 局域网都会被代理带偏）。
pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .unwrap_or_default()
}

async fn read_response(response: reqwest::Response) -> Result<Value, PeerHttpError> {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(PeerHttpError::Unauthorized);
    }
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let parsed = serde_json::from_str::<Value>(&text).ok();
        let code = parsed
            .as_ref()
            .and_then(|v| v.get("code")?.as_str().map(str::to_string));
        let message = parsed
            .as_ref()
            .and_then(|v| v.get("message")?.as_str().map(str::to_string))
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(PeerHttpError::Status(status.as_u16(), code, message));
    }
    // 旧版本对未知 /api 路径回 SPA 的 HTML：当成不支持。
    serde_json::from_str(&text).map_err(|_| {
        PeerHttpError::Status(
            404,
            None,
            "Peer does not speak the bot mesh API".to_string(),
        )
    })
}

pub async fn peer_request(
    endpoint: &PeerEndpoint,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value, PeerHttpError> {
    let client = http_client(timeout);
    let mut request = client.request(method, format!("{}{path}", endpoint.base_url));
    if let Some(token) = &endpoint.token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| PeerHttpError::Unreachable(error.to_string()))?;
    read_response(response).await
}

pub async fn peer_get(endpoint: &PeerEndpoint, path: &str) -> Result<Value, PeerHttpError> {
    peer_request(endpoint, reqwest::Method::GET, path, None, CALL_TIMEOUT).await
}

pub async fn peer_post(
    endpoint: &PeerEndpoint,
    path: &str,
    body: &Value,
) -> Result<Value, PeerHttpError> {
    peer_request(
        endpoint,
        reqwest::Method::POST,
        path,
        Some(body),
        CALL_TIMEOUT,
    )
    .await
}

/// 免鉴权存活探针。
pub async fn health_ok(base_url: &str) -> bool {
    let client = http_client(HEALTH_TIMEOUT);
    match client.get(format!("{base_url}/api/health")).send().await {
        Ok(response) => response
            .json::<Value>()
            .await
            .is_ok_and(|v| v.get("ok").and_then(Value::as_bool) == Some(true)),
        Err(_) => false,
    }
}

/// 挑一个能连上的地址：先试上次成功的，再并发试其余，按来源优先级取胜者。
pub async fn pick_reachable(record: &MeshPeerRecord) -> Option<String> {
    let order = record.probe_order();
    let first = order.first()?.clone();
    if health_ok(&first).await {
        return Some(first);
    }
    let rest: Vec<String> = order.into_iter().skip(1).collect();
    let results = futures_util::future::join_all(rest.iter().map(|url| health_ok(url))).await;
    rest.into_iter()
        .zip(results)
        .find_map(|(url, ok)| ok.then_some(url))
}

pub fn peer_kind(device: &DeviceSummary) -> &'static str {
    match device.device.connection {
        DeviceConnection::Direct { .. } => "direct",
        DeviceConnection::Ssh { .. } => "ssh",
    }
}

/// 设备注册表 + 组网附加信息。
pub struct PeerDirectory {
    devices: Arc<DeviceService>,
    repo: Arc<MeshPeerRepository>,
}

impl PeerDirectory {
    pub fn new(devices: Arc<DeviceService>, repo: Arc<MeshPeerRepository>) -> Self {
        Self { devices, repo }
    }

    pub fn devices(&self) -> &Arc<DeviceService> {
        &self.devices
    }

    pub fn record(&self, device_id: &str) -> MeshPeerRecord {
        let mut record =
            self.repo
                .get(device_id)
                .ok()
                .flatten()
                .unwrap_or_else(|| MeshPeerRecord {
                    device_id: device_id.to_string(),
                    ..Default::default()
                });
        if let Some(device) = self.devices.get(device_id) {
            if let DeviceConnection::Direct { base_url } = &device.connection {
                record.merge_address(base_url, MeshAddressSource::Manual);
            }
        }
        record
    }

    pub fn save(&self, record: &MeshPeerRecord) {
        if let Err(error) = self.repo.upsert(record) {
            tracing::warn!(device = %record.device_id, error = %error, "mesh peer save failed");
        }
    }

    pub fn forget(&self, device_id: &str) {
        let _ = self.repo.delete(device_id);
    }

    /// 读 keyring（`has_token`）：必须在阻塞线程上调用。
    pub fn list(&self) -> Vec<MeshPeerView> {
        self.devices
            .list()
            .into_iter()
            .map(|device| MeshPeerView {
                device_id: device.device.id.clone(),
                name: device.device.name.clone(),
                kind: peer_kind(&device),
                target_label: device.target_label.clone(),
                has_token: device.has_token,
                mesh: self.record(&device.device.id),
            })
            .collect()
    }

    /// 给发现到的地址找主人：按实例 id 或主机名对上已配对的对端，就记成它的候选。
    pub fn attach_address(
        &self,
        instance_id: Option<&str>,
        hostname: Option<&str>,
        url: &str,
        source: MeshAddressSource,
    ) -> Option<String> {
        let normalize = |name: &str| {
            name.trim()
                .trim_end_matches('.')
                .trim_end_matches(".local")
                .to_ascii_lowercase()
        };
        // 只读设备清单，不碰 keyring（调用方可能在异步线程上）。
        for device in self.devices.devices() {
            let mut record = self.record(&device.id);
            let by_instance = instance_id
                .zip(record.instance_id.as_deref())
                .is_some_and(|(a, b)| a == b);
            let by_host = hostname
                .zip(record.hostname.as_deref())
                .is_some_and(|(a, b)| !a.is_empty() && normalize(a) == normalize(b));
            if by_instance || by_host {
                if record.merge_address(url, source) {
                    self.save(&record);
                }
                return Some(device.id.clone());
            }
        }
        None
    }

    /// 解析可用端点。直连设备按地址候选择优；SSH 设备走 DeviceService 的转发（阻塞）。
    pub async fn endpoint(&self, device_id: &str) -> AppResult<PeerEndpoint> {
        let device = self.devices.get(device_id).ok_or_else(|| {
            AppError::coded(
                "MESH_PEER_NOT_FOUND",
                format!("Unknown computer: {device_id}"),
            )
        })?;
        let devices = self.devices.clone();
        let id = device_id.to_string();
        let resolved = tauri::async_runtime::spawn_blocking(move || devices.endpoint(&id))
            .await
            .map_err(|error| AppError::from(error.to_string()))?
            .map_err(|error| AppError::coded("MESH_PEER_UNREACHABLE", format!("{error:#}")))?;
        let base_url = match device.connection {
            DeviceConnection::Ssh { .. } => resolved.base_url,
            DeviceConnection::Direct { .. } => {
                let mut record = self.record(device_id);
                match pick_reachable(&record).await {
                    Some(url) => {
                        record.preferred_url = Some(url.clone());
                        record.last_seen_at = Some(chrono::Utc::now().to_rfc3339());
                        record.last_error = None;
                        if let Some(address) = record.addresses.iter_mut().find(|a| a.url == url) {
                            address.last_ok_at = record.last_seen_at.clone();
                        }
                        self.save(&record);
                        url
                    }
                    None => {
                        record.last_error = Some("No address answered /api/health".into());
                        self.save(&record);
                        return Err(AppError::coded(
                            "MESH_PEER_UNREACHABLE",
                            format!("{} is offline or unreachable", device.name),
                        ));
                    }
                }
            }
        };
        Ok(PeerEndpoint {
            device_id: device_id.to_string(),
            name: device.name,
            base_url,
            token: resolved.token,
        })
    }

    /// 探测成功后记下对方身份（实例 id / 主机名），供日后归并发现到的地址。
    pub fn remember_identity(&self, device_id: &str, info: &Value) {
        let mut record = self.record(device_id);
        let instance = info
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let hostname = info
            .get("hostname")
            .and_then(Value::as_str)
            .map(str::to_string);
        if (instance.is_some() && record.instance_id != instance)
            || (hostname.is_some() && record.hostname != hostname)
        {
            record.instance_id = instance.or(record.instance_id);
            record.hostname = hostname.or(record.hostname);
            self.save(&record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_peer_statuses() {
        assert!(PeerHttpError::Status(404, None, String::new()).unsupported());
        assert!(
            PeerHttpError::Status(503, Some("ACP_HOST_UNAVAILABLE".into()), String::new())
                .unsupported()
        );
        assert!(
            !PeerHttpError::Status(403, Some("BOT_REMOTE_DENIED".into()), String::new())
                .unsupported()
        );
        assert!(!PeerHttpError::Unauthorized.unsupported());
    }

    /// 模拟一台对端：只有它的 Tailscale 地址能通、需要设备令牌。目录应跳过不通的
    /// 手填地址、记住能通的那条，并带令牌拿到 `/api/bots`。
    #[tokio::test]
    async fn endpoint_picks_reachable_address_and_calls_with_token() {
        use axum::{http::HeaderMap, routing::get, Json, Router};
        use cc_panes_core::models::{DeviceAddRequest, DeviceConnection};
        use cc_panes_core::services::{
            MemoryDeviceTokenStore, SshConnectionService, SshCredentialService, SshMachineService,
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/api/health",
                get(|| async { Json(serde_json::json!({"ok": true})) }),
            )
            .route(
                "/api/bots",
                get(|headers: HeaderMap| async move {
                    let ok = headers.get("authorization").and_then(|v| v.to_str().ok())
                        == Some("Bearer ccp_dev_peer");
                    if ok {
                        Ok(Json(serde_json::json!([{"id": "r1", "name": "Remote"}])))
                    } else {
                        Err(axum::http::StatusCode::UNAUTHORIZED)
                    }
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(SshCredentialService::new_memory());
        let devices = Arc::new(DeviceService::new(
            dir.path().join("devices.json"),
            Arc::new(MemoryDeviceTokenStore::default()),
            Arc::new(SshMachineService::new(
                dir.path().join("ssh-machines.json"),
                credentials.clone(),
            )),
            Arc::new(SshConnectionService::new(
                credentials,
                dir.path().join("known-hosts"),
            )),
        ));
        // 手填地址是个关着的端口；真正能通的地址来自「发现」。
        let device = devices
            .add(DeviceAddRequest {
                name: "Studio".into(),
                connection: DeviceConnection::Direct {
                    base_url: "http://127.0.0.1:9".into(),
                },
                token: Some("ccp_dev_peer".into()),
            })
            .unwrap();
        let db =
            Arc::new(cc_panes_core::repository::Database::new(dir.path().join("data.db")).unwrap());
        let directory = PeerDirectory::new(devices, Arc::new(MeshPeerRepository::new(db)));
        let mut record = directory.record(&device.id);
        record.instance_id = Some("inst-b".into());
        directory.save(&record);
        assert_eq!(
            directory.attach_address(Some("inst-b"), None, &live, MeshAddressSource::Tailscale),
            Some(device.id.clone())
        );

        let endpoint = directory.endpoint(&device.id).await.unwrap();
        assert_eq!(endpoint.base_url, live);
        let saved = directory.record(&device.id);
        assert_eq!(saved.preferred_url.as_deref(), Some(live.as_str()));
        assert!(saved.last_seen_at.is_some());
        let bots = peer_get(&endpoint, "/api/bots").await.unwrap();
        assert_eq!(super::super::parse_bot_list(&bots)[0].name, "Remote");
        let anonymous = PeerEndpoint {
            token: None,
            ..endpoint
        };
        assert!(matches!(
            peer_get(&anonymous, "/api/bots").await,
            Err(PeerHttpError::Unauthorized)
        ));
    }

    #[test]
    fn peer_errors_keep_remote_codes() {
        let error = PeerHttpError::Status(409, Some("MESH_LOOP_DETECTED".into()), "x".into())
            .into_app_error();
        assert_eq!(error.code(), Some("MESH_LOOP_DETECTED"));
        assert_eq!(
            PeerHttpError::Unauthorized.into_app_error().code(),
            Some("MESH_PEER_UNAUTHORIZED")
        );
    }
}
