use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use cc_panes_core::models::{
    CliTool, CreateSessionRequest as CoreCreateSessionRequest, LaunchProviderSelection,
    SshConnectionInfo, TerminalReplaySnapshot, WslLaunchInfo,
};
use cc_panes_core::services::terminal_service::{KillReason, SessionOutput, SessionStatus};
use cc_panes_core::services::{SessionStatusInfo, TerminalBackend};
use cc_panes_core::utils::{atomic_file, normalize_session_request_for_current_host};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tracing::info;

use crate::ws_emitter::WsEmitter;

const MANIFEST_FILE: &str = "daemon-manifest.json";

fn summarize_terminal_input(data: &str) -> serde_json::Value {
    let chars: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| ch.escape_default().to_string())
        .collect();
    let code_points: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| format!("{:x}", ch as u32))
        .collect();
    let bytes: Vec<String> = data
        .as_bytes()
        .iter()
        .take(32)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    serde_json::json!({
        "chars": chars,
        "charCount": data.chars().count(),
        "utf8Bytes": data.len(),
        "codePoints": code_points,
        "bytes": bytes,
        "truncated": data.chars().count() > 24 || data.len() > 32,
    })
}

#[derive(Clone)]
pub struct DaemonConfig {
    inner: Arc<DaemonState>,
}

impl DaemonConfig {
    pub fn new(
        token: String,
        addr: SocketAddr,
        terminal_backend: Arc<dyn TerminalBackend>,
        ws_emitter: Arc<WsEmitter>,
        default_cwd: String,
    ) -> Self {
        let started_at = current_epoch_millis();
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        Self {
            inner: Arc::new(DaemonState {
                token,
                addr,
                started_at,
                shutdown_tx,
                terminal_backend,
                ws_emitter,
                default_cwd,
                last_activity: parking_lot::RwLock::new(HashMap::new()),
                desktop_control_clients: AtomicUsize::new(0),
            }),
        }
    }

    pub fn token(&self) -> &str {
        &self.inner.token
    }

    pub fn addr(&self) -> SocketAddr {
        self.inner.addr
    }

    pub fn status(&self) -> DaemonStatus {
        let session_count = self
            .inner
            .terminal_backend
            .get_all_status()
            .map(|sessions| sessions.len())
            .unwrap_or(0);
        DaemonStatus {
            status: "ok".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            addr: self.inner.addr.to_string(),
            started_at: self.inner.started_at,
            session_count,
            desktop_client_count: self.desktop_client_count(),
        }
    }

    /// 当前保持控制 WS 连接的桌面客户端数。前端孤儿对账据此 fail-closed：
    /// >1 说明多个桌面实例共享本 daemon，任何单实例的"引用全集"都是残缺视图。
    pub(crate) fn desktop_client_count(&self) -> usize {
        self.inner.desktop_control_clients.load(Ordering::SeqCst)
    }

    fn register_desktop_client(&self) -> DesktopClientGuard {
        self.inner
            .desktop_control_clients
            .fetch_add(1, Ordering::SeqCst);
        DesktopClientGuard {
            config: self.clone(),
        }
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.inner.shutdown_tx.subscribe()
    }

    pub(crate) fn request_shutdown(&self) {
        let _ = self.inner.shutdown_tx.send(true);
    }

    pub(crate) fn terminal_backend(&self) -> &dyn TerminalBackend {
        self.inner.terminal_backend.as_ref()
    }

    pub(crate) fn terminal_backend_arc(&self) -> Arc<dyn TerminalBackend> {
        self.inner.terminal_backend.clone()
    }

    fn ws_emitter(&self) -> Arc<WsEmitter> {
        self.inner.ws_emitter.clone()
    }

    fn default_cwd(&self) -> &str {
        &self.inner.default_cwd
    }

    /// 刷新会话活跃时间——所有会话级 HTTP/WS 访问都算"仍被引用"
    /// （app 侧 WS 失败会退化成 HTTP 轮询，不能只看 WS 订阅）。
    pub(crate) fn touch_session(&self, session_id: &str) {
        self.inner
            .last_activity
            .write()
            .insert(session_id.to_string(), Instant::now());
    }

    pub(crate) fn remove_session_activity(&self, session_id: &str) {
        self.inner.last_activity.write().remove(session_id);
        self.inner.ws_emitter.cleanup_session(session_id);
    }

    pub(crate) fn session_activity_snapshot(&self) -> HashMap<String, Instant> {
        self.inner.last_activity.read().clone()
    }

    pub(crate) fn has_active_subscriber(&self, session_id: &str) -> bool {
        self.inner.ws_emitter.has_active_subscriber(session_id)
    }
}

struct DaemonState {
    token: String,
    addr: SocketAddr,
    started_at: u64,
    shutdown_tx: watch::Sender<bool>,
    terminal_backend: Arc<dyn TerminalBackend>,
    ws_emitter: Arc<WsEmitter>,
    default_cwd: String,
    /// 会话最后活跃时间（HTTP 访问 / WS 连接 / WS 入站输入均刷新），
    /// 供 session_reaper 做孤儿过期判定。
    last_activity: parking_lot::RwLock<HashMap<String, Instant>>,
    /// 活跃桌面控制 WS 连接数（`/ws/control?kind=desktop`）。
    /// 连接存活 = 该桌面实例仍可能发起 kill；web 客户端不计入。
    desktop_control_clients: AtomicUsize,
}

/// RAII：控制 WS handler 退出（连接断开）即减一，实例崩溃也不会留下 stale 计数。
struct DesktopClientGuard {
    config: DaemonConfig,
}

impl Drop for DesktopClientGuard {
    fn drop(&mut self) {
        self.config
            .inner
            .desktop_control_clients
            .fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub status: String,
    pub version: String,
    pub pid: u32,
    pub addr: String,
    pub started_at: u64,
    pub session_count: usize,
    /// 旧 daemon 响应无此字段时反序列化为 0（serde default）
    #[serde(default)]
    pub desktop_client_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResponse {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonManifest {
    pub addr: String,
    pub token: String,
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(flatten)]
    pub core: PartialCreateSessionRequest,
    pub cwd: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialCreateSessionRequest {
    pub launch_id: Option<String>,
    pub project_path: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub workspace_name: Option<String>,
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
    #[serde(default)]
    pub launch_claude: bool,
    #[serde(default)]
    pub cli_tool: CliTool,
    pub resume_id: Option<String>,
    #[serde(default)]
    pub skip_mcp: bool,
    pub append_system_prompt: Option<String>,
    #[serde(default, alias = "prompt")]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub yolo_mode: Option<bool>,
    #[serde(default)]
    pub adapter_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub ssh: Option<SshConnectionInfo>,
    #[serde(default)]
    pub wsl: Option<WslLaunchInfo>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
}

#[derive(Deserialize)]
pub struct ResizeRequest {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputQuery {
    pub lines: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatusRequest {
    pub status: SessionStatus,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindByLaunchResponse {
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsQuery {
    pub token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlWsQuery {
    pub token: Option<String>,
    /// 客户端类型：desktop（默认，计入 desktopClientCount）/ web（不计入）
    pub kind: Option<String>,
}

pub fn router(config: DaemonConfig) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/daemon/status", get(status))
        .route("/api/daemon/shutdown", post(shutdown))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}/status", get(get_session_status))
        .route(
            "/api/sessions-by-launch/{launch_id}",
            get(find_session_by_launch),
        )
        .route("/api/sessions/{id}/hook-status", post(hook_status))
        .route("/api/sessions/{id}/output", get(get_session_output))
        .route("/api/sessions/{id}/snapshot", get(get_session_snapshot))
        .route("/api/sessions/{id}/write", post(write_session))
        .route("/api/sessions/{id}/submit", post(submit_session))
        .route("/api/sessions/{id}/resize", post(resize_session))
        .route("/api/sessions/{id}", delete(kill_session))
        .route("/ws/control", get(ws_control))
        .route("/ws/{id}", get(ws_session))
        .with_state(config)
}

pub fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn write_manifest(runtime_dir: &FsPath, config: &DaemonConfig) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(runtime_dir)?;
    let path = runtime_dir.join(MANIFEST_FILE);
    let manifest = DaemonManifest {
        addr: config.addr().to_string(),
        token: config.token().to_string(),
        pid: std::process::id(),
        started_at: config.inner.started_at,
    };
    let data = serde_json::to_vec_pretty(&manifest)?;
    atomic_file::write_atomic(&path, data)?;
    Ok(path)
}

pub fn read_manifest(runtime_dir: &FsPath) -> Option<DaemonManifest> {
    let content = std::fs::read(runtime_dir.join(MANIFEST_FILE)).ok()?;
    serde_json::from_slice(&content).ok()
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

async fn status(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<DaemonStatus>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    Ok(Json(config.status()))
}

async fn shutdown(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<ShutdownResponse>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.request_shutdown();
    Ok(Json(ShutdownResponse { accepted: true }))
}

async fn create_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    if req.core.ssh.is_some() && req.core.wsl.is_some() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "INVALID_LAUNCH_OPTIONS",
            "SSH and WSL launch options cannot be combined",
        ));
    }

    let project_path = req
        .core
        .project_path
        .or(req.cwd)
        .unwrap_or_else(|| config.default_cwd().to_string());
    let core_request = normalize_session_request_for_current_host(CoreCreateSessionRequest {
        launch_id: req.core.launch_id,
        project_path,
        cols: req.core.cols.unwrap_or(120),
        rows: req.core.rows.unwrap_or(30),
        workspace_name: req.core.workspace_name,
        provider_id: req.core.provider_id,
        provider_selection: req.core.provider_selection,
        launch_profile_id: req.core.launch_profile_id,
        workspace_path: req.core.workspace_path,
        workspace_snapshot_id: req.core.workspace_snapshot_id,
        launch_claude: req.core.launch_claude,
        cli_tool: req.core.cli_tool,
        resume_id: req.core.resume_id,
        skip_mcp: req.core.skip_mcp,
        append_system_prompt: req.core.append_system_prompt,
        initial_prompt: req.core.initial_prompt,
        yolo_mode: req.core.yolo_mode,
        adapter_options: req.core.adapter_options,
        extra_env: req.core.extra_env,
        ssh: req.core.ssh,
        wsl: req.core.wsl,
    });
    // create_session 里 WSL 冷启动 + 探活 + spawn_pty 是同步阻塞操作，
    // 挪到 blocking 线程池，避免慢请求占死 tokio worker。
    let backend = config.terminal_backend_arc();
    let session_id = tokio::task::spawn_blocking(move || backend.create_session(core_request))
        .await
        .map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "JOIN_ERROR",
                error.to_string(),
            )
        })?
        .map_err(internal_error)?;
    config.touch_session(&session_id);
    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    ))
}

async fn list_sessions(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionStatusInfo>>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let statuses = config
        .terminal_backend()
        .get_all_status()
        .map_err(internal_error)?;
    Ok(Json(statuses))
}

async fn get_session_status(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<SessionStatusInfo>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    let status = config
        .terminal_backend()
        .get_session_status(&id)
        .map_err(internal_error)?;
    status
        .map(Json)
        .ok_or_else(|| not_found("Session not found"))
}

async fn find_session_by_launch(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(launch_id): Path<String>,
) -> Result<Json<FindByLaunchResponse>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let session_id = config
        .terminal_backend()
        .find_session_id_by_launch_id(&launch_id)
        .map_err(internal_error)?;
    session_id
        .map(|session_id| Json(FindByLaunchResponse { session_id }))
        .ok_or_else(|| not_found("No session for launch id"))
}

async fn hook_status(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<HookStatusRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config
        .terminal_backend()
        .apply_hook_status(&id, req.status)
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resize_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ResizeRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    config
        .terminal_backend()
        .resize(&id, req.cols, req.rows)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn write_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<WriteRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    tracing::debug!(
        session_id = %id,
        input = %summarize_terminal_input(&req.data),
        "terminal-input.trace daemon.write_session"
    );
    config.touch_session(&id);
    config
        .terminal_backend()
        .write(&id, &req.data)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn submit_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<SubmitRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    config
        .terminal_backend()
        .submit_text_to_session(&id, &req.text)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_session_output(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> Result<Json<SessionOutput>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    let output = config
        .terminal_backend()
        .get_session_output(&id, query.lines.unwrap_or(0))
        .map_err(not_found_from_error)?;
    Ok(Json(output))
}

async fn get_session_snapshot(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<TerminalReplaySnapshot>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    let snapshot = config
        .terminal_backend()
        .get_session_replay_snapshot(&id)
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Session not found"))?;
    Ok(Json(snapshot))
}

#[derive(Deserialize)]
struct KillQuery {
    reason: Option<String>,
}

async fn kill_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<KillQuery>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let reason = KillReason::parse(query.reason.as_deref());
    config
        .terminal_backend()
        .kill_with_reason(&id, reason)
        .map_err(not_found_from_error)?;
    config.remove_session_activity(&id);
    Ok(StatusCode::NO_CONTENT)
}

async fn ws_session(
    State(config): State<DaemonConfig>,
    Path(id): Path<String>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    match query.token.as_deref() {
        Some(token) if token == config.token() => {}
        _ => {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid or missing token",
            ));
        }
    }

    Ok(ws.on_upgrade(move |socket| handle_ws(socket, id, config)))
}

/// 客户端存在性控制连接：桌面实例启动后保持一条，daemon 据此统计
/// `desktopClientCount`。同时承载没有 session WS 订阅者时的低频兜底事件。
async fn ws_control(
    State(config): State<DaemonConfig>,
    Query(query): Query<ControlWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    match query.token.as_deref() {
        Some(token) if token == config.token() => {}
        _ => {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Invalid or missing token",
            ));
        }
    }

    let is_desktop = query.kind.as_deref().unwrap_or("desktop") == "desktop";
    Ok(ws.on_upgrade(move |socket| handle_control_ws(socket, config, is_desktop)))
}

async fn handle_control_ws(socket: WebSocket, config: DaemonConfig, is_desktop: bool) {
    let _guard = is_desktop.then(|| config.register_desktop_client());
    if is_desktop {
        info!(
            desktop_client_count = config.desktop_client_count(),
            "desktop control client connected"
        );
    }

    let mut control_rx = config.ws_emitter().subscribe_control();
    let (mut ws_tx, mut ws_rx) = socket.split();
    loop {
        tokio::select! {
            message = control_rx.recv() => {
                let Some(message) = message else { break };
                if ws_tx.send(Message::Text(message.into())).await.is_err() {
                    break;
                }
            }
            message = ws_rx.next() => {
                let Some(Ok(message)) = message else { break };
                match message {
                    Message::Ping(payload) => {
                        if ws_tx.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    if is_desktop {
        // guard 在函数返回时 drop，这里先打日志（-1 生效前的计数减一即最终值）
        info!(
            desktop_client_count = config.desktop_client_count().saturating_sub(1),
            "desktop control client disconnected"
        );
    }
}

async fn handle_ws(socket: WebSocket, session_id: String, config: DaemonConfig) {
    config.touch_session(&session_id);
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut output_rx = config.ws_emitter().subscribe(&session_id);
    let send_session_id = session_id.clone();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = output_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("type").and_then(|value| value.as_str()) == Some("input") {
                        let data = value
                            .get("data")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        config.touch_session(&session_id);
                        let _ = config.terminal_backend().write(&session_id, data);
                    }
                }
            }
            Message::Binary(data) => {
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    let _ = config.terminal_backend().write(&session_id, &text);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
    config.ws_emitter().cleanup_session(&send_session_id);
}

fn authorize(
    headers: &HeaderMap,
    token: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let expected = format!("Bearer {token}");
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);

    if authorized {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "UNAUTHORIZED",
                "message": "Invalid or missing Bearer token"
            })),
        ))
    }
}

fn json_error(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::json!({
            "code": code,
            "message": message.into()
        })),
    )
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<serde_json::Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        error.to_string(),
    )
}

fn not_found(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    json_error(StatusCode::NOT_FOUND, "NOT_FOUND", message.into())
}

fn not_found_from_error(error: impl std::fmt::Display) -> (StatusCode, Json<serde_json::Value>) {
    not_found(error.to_string())
}

fn current_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub async fn wait_for_shutdown(mut shutdown_rx: watch::Receiver<bool>) {
    while !*shutdown_rx.borrow_and_update() {
        if shutdown_rx.changed().await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use cc_panes_core::models::TerminalBufferMode;
    use cc_panes_core::services::terminal_service::SessionStatus;
    use cc_panes_core::utils::AppResult;
    use tower::ServiceExt;

    use super::*;

    #[derive(Default)]
    struct MockTerminalBackend {
        created: Mutex<Vec<CoreCreateSessionRequest>>,
        writes: Mutex<Vec<(String, String)>>,
        submits: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
        kill_reasons: Mutex<Vec<(String, KillReason)>>,
        hook_statuses: Mutex<Vec<(String, SessionStatus)>>,
    }

    impl TerminalBackend for MockTerminalBackend {
        fn create_session(&self, request: CoreCreateSessionRequest) -> AppResult<String> {
            self.created.lock().unwrap().push(request);
            Ok("session-1".to_string())
        }

        fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
            self.writes
                .lock()
                .unwrap()
                .push((session_id.to_string(), data.to_string()));
            Ok(())
        }

        fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
            self.submits
                .lock()
                .unwrap()
                .push((session_id.to_string(), text.to_string()));
            Ok(())
        }

        fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
            self.resizes
                .lock()
                .unwrap()
                .push((session_id.to_string(), cols, rows));
            Ok(())
        }

        fn kill(&self, session_id: &str) -> AppResult<()> {
            self.kills.lock().unwrap().push(session_id.to_string());
            Ok(())
        }

        fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
            self.kill_reasons
                .lock()
                .unwrap()
                .push((session_id.to_string(), reason));
            self.kill(session_id)
        }

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            if self.created.lock().unwrap().is_empty() {
                return Ok(Vec::new());
            }

            Ok(vec![SessionStatusInfo {
                session_id: "session-1".to_string(),
                status: SessionStatus::Idle,
                last_output_at: 100,
                pid: Some(42),
                exit_code: None,
                current_tool_name: None,
                current_tool_use_id: None,
                current_tool_summary: None,
                updated_at: 120,
            }])
        }

        fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            Ok(self
                .get_all_status()?
                .into_iter()
                .find(|status| status.session_id == session_id))
        }

        fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
            Ok(SessionOutput {
                session_id: session_id.to_string(),
                lines: vec!["ready".to_string()],
            })
        }

        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            Ok(Some(TerminalReplaySnapshot {
                data: "\u{1b}[2J".to_string(),
                buffer_mode: TerminalBufferMode::Normal,
            }))
        }

        fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
            // 约定：launch id "launch-1" 映射到 "session-1"，其余无。
            Ok((launch_id == "launch-1").then(|| "session-1".to_string()))
        }

        fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
            self.hook_statuses
                .lock()
                .unwrap()
                .push((session_id.to_string(), status));
            Ok(())
        }
    }

    fn test_config(token: &str, addr: &str, backend: Arc<MockTerminalBackend>) -> DaemonConfig {
        DaemonConfig::new(
            token.to_string(),
            addr.parse().expect("socket addr"),
            backend,
            Arc::new(WsEmitter::new()),
            "/default/project".to_string(),
        )
    }

    #[test]
    fn generate_token_returns_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|char| char.is_ascii_hexdigit()));
    }

    #[test]
    fn manifest_contains_connection_details() {
        let temp_dir =
            std::env::temp_dir().join(format!("cc-panes-daemon-test-{}", current_epoch_millis()));
        let config = test_config(
            "test-token",
            "127.0.0.1:18081",
            Arc::new(MockTerminalBackend::default()),
        );

        let path = write_manifest(&temp_dir, &config).expect("write manifest");
        let data = std::fs::read_to_string(&path).expect("read manifest");
        let manifest: DaemonManifest = serde_json::from_str(&data).expect("parse manifest");

        assert_eq!(manifest.addr, "127.0.0.1:18081");
        assert_eq!(manifest.token, "test-token");
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn status_requires_bearer_token() {
        let config = test_config(
            "secret",
            "127.0.0.1:18082",
            Arc::new(MockTerminalBackend::default()),
        );
        let app = router(config);

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/daemon/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let authorized = app
            .oneshot(
                Request::builder()
                    .uri("/api/daemon/status")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(authorized.status(), StatusCode::OK);

        let bytes = to_bytes(authorized.into_body(), usize::MAX)
            .await
            .expect("body");
        let status: DaemonStatus = serde_json::from_slice(&bytes).expect("daemon status");
        assert_eq!(status.status, "ok");
        assert_eq!(status.addr, "127.0.0.1:18082");
        assert_eq!(status.session_count, 0);
    }

    #[tokio::test]
    async fn kill_route_forwards_reason_query_and_defaults_to_unknown() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18090", backend.clone());
        let app = router(config);

        let with_reason = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/sessions/session-1?reason=orphan-reclaim")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(with_reason.status(), StatusCode::NO_CONTENT);

        let without_reason = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/sessions/session-2")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(without_reason.status(), StatusCode::NO_CONTENT);

        let reasons = backend.kill_reasons.lock().unwrap().clone();
        assert_eq!(
            reasons,
            vec![
                ("session-1".to_string(), KillReason::OrphanReclaim),
                ("session-2".to_string(), KillReason::Unknown),
            ]
        );
    }

    #[tokio::test]
    async fn status_reports_desktop_control_client_count() {
        let config = test_config(
            "secret",
            "127.0.0.1:18091",
            Arc::new(MockTerminalBackend::default()),
        );

        assert_eq!(config.status().desktop_client_count, 0);

        let guard_a = config.register_desktop_client();
        let guard_b = config.register_desktop_client();
        assert_eq!(config.status().desktop_client_count, 2);

        drop(guard_a);
        assert_eq!(config.status().desktop_client_count, 1);
        drop(guard_b);
        assert_eq!(config.status().desktop_client_count, 0);
    }

    #[tokio::test]
    async fn shutdown_requires_token_and_signals_graceful_shutdown() {
        let config = test_config(
            "secret",
            "127.0.0.1:18083",
            Arc::new(MockTerminalBackend::default()),
        );
        let mut shutdown_rx = config.shutdown_signal();
        let app = router(config);

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/daemon/shutdown")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert!(!*shutdown_rx.borrow_and_update());

        let authorized = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/daemon/shutdown")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(authorized.status(), StatusCode::OK);
        shutdown_rx.changed().await.expect("shutdown signal");
        assert!(*shutdown_rx.borrow_and_update());
    }

    #[tokio::test]
    async fn find_by_launch_and_hook_status_routes_delegate_to_backend() {
        let backend = Arc::new(MockTerminalBackend::default());
        let app = router(test_config("secret", "127.0.0.1:18091", backend.clone()));

        // by-launch 命中 → 200 + sessionId。
        let hit = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/sessions-by-launch/launch-1")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(hit.status(), StatusCode::OK);
        let bytes = to_bytes(hit.into_body(), usize::MAX).await.expect("body");
        let parsed: FindByLaunchResponse = serde_json::from_slice(&bytes).expect("find response");
        assert_eq!(parsed.session_id, "session-1");

        // by-launch 未命中 → 404。
        let miss = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/sessions-by-launch/nope")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(miss.status(), StatusCode::NOT_FOUND);

        // hook-status → 204 且被 backend 记录。
        let applied = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/session-1/hook-status")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"status":"toolRunning"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(applied.status(), StatusCode::NO_CONTENT);
        let recorded = backend.hook_statuses.lock().unwrap();
        assert_eq!(
            recorded.as_slice(),
            &[("session-1".to_string(), SessionStatus::ToolRunning)]
        );
    }

    #[tokio::test]
    async fn terminal_routes_require_token_and_delegate_to_backend() {
        let backend = Arc::new(MockTerminalBackend::default());
        let app = router(test_config("secret", "127.0.0.1:18084", backend.clone()));

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"projectPath":"/repo"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let created = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"projectPath":"/repo","cols":100,"rows":40,"prompt":"inspect","extraEnv":{"RUNNER_ENV":"1"}}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(created.status(), StatusCode::CREATED);
        let bytes = to_bytes(created.into_body(), usize::MAX)
            .await
            .expect("body");
        let response: CreateSessionResponse =
            serde_json::from_slice(&bytes).expect("create response");
        assert_eq!(response.session_id, "session-1");
        assert_eq!(
            backend.created.lock().unwrap()[0]
                .extra_env
                .as_ref()
                .and_then(|env| env.get("RUNNER_ENV"))
                .map(String::as_str),
            Some("1")
        );

        let status = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/sessions/session-1/status")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(status.status(), StatusCode::OK);

        let write = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/session-1/write")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"data":"abc"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(write.status(), StatusCode::NO_CONTENT);

        let created_requests = backend.created.lock().unwrap();
        assert_eq!(created_requests[0].project_path, "/repo");
        assert_eq!(created_requests[0].cols, 100);
        assert_eq!(created_requests[0].rows, 40);
        assert_eq!(
            created_requests[0].initial_prompt.as_deref(),
            Some("inspect")
        );
        drop(created_requests);
        assert_eq!(
            backend.writes.lock().unwrap().as_slice(),
            &[("session-1".to_string(), "abc".to_string())]
        );
    }

    #[tokio::test]
    async fn daemon_accepts_remote_launch_options() {
        let backend = Arc::new(MockTerminalBackend::default());
        let app = router(test_config("secret", "127.0.0.1:18085", backend.clone()));

        let ssh_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"projectPath":"/repo","ssh":{"host":"example.com","remotePath":"/srv/repo"}}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(ssh_response.status(), StatusCode::CREATED);

        let wsl_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"projectPath":"/repo","wsl":{"remotePath":"/mnt/c/repo","distro":"Ubuntu"}}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(wsl_response.status(), StatusCode::CREATED);

        let created = backend.created.lock().unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(
            created[0].ssh.as_ref().map(|ssh| ssh.host.as_str()),
            Some("example.com")
        );
        assert_eq!(
            created[0].ssh.as_ref().map(|ssh| ssh.remote_path.as_str()),
            Some("/srv/repo")
        );
        if let Some(wsl) = created[1].wsl.as_ref() {
            assert_eq!(wsl.remote_path.as_str(), "/mnt/c/repo");
            assert_eq!(wsl.distro.as_deref(), Some("Ubuntu"));
        } else {
            assert_eq!(created[1].project_path.as_str(), "/mnt/c/repo");
        }
    }

    #[tokio::test]
    async fn daemon_rejects_combined_ssh_and_wsl_launch_options() {
        let app = router(test_config(
            "secret",
            "127.0.0.1:18086",
            Arc::new(MockTerminalBackend::default()),
        ));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"projectPath":"/repo","ssh":{"host":"example.com","remotePath":"/repo"},"wsl":{"remotePath":"/repo"}}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
