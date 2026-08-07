use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use cc_panes_core::models::{
    CliTool, CreateSessionRequest as CoreCreateSessionRequest, LaunchProviderSelection,
    SshConnectionInfo, StoreCheckpointOutcome, TerminalCheckpoint, TerminalReplaySnapshot,
    TerminalSessionProvenance, WslLaunchInfo,
};
use cc_panes_core::services::terminal_service::{KillReason, SessionOutput, SessionStatus};
use cc_panes_core::services::{SessionStatusInfo, TerminalAdoptionSnapshot, TerminalBackend};
use cc_panes_core::utils::error::AppError;
use cc_panes_core::utils::project_paths_equivalent;
use cc_panes_core::utils::{atomic_file, normalize_session_request_for_current_host};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, RwLock};
use tracing::info;

use crate::ws_emitter::WsEmitter;

const MANIFEST_FILE: &str = "daemon-manifest.json";
/// Server-side launch deadline. The handler returns promptly while the blocking worker is
/// cancelled/cleaned asynchronously, so a slow WSL or hook step cannot leave the client waiting.
const DAEMON_CREATE_DEADLINE: Duration = Duration::from_secs(45);

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
                session_claims: parking_lot::RwLock::new(HashMap::new()),
                session_provenance: parking_lot::RwLock::new(HashMap::new()),
                restore_replacements: parking_lot::RwLock::new(HashMap::new()),
                session_visibility: RwLock::new(()),
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
            claims_supported: true,
        }
    }

    /// 当前保持控制 WS 连接的桌面客户端数。前端孤儿对账据此 fail-closed：
    /// >1 说明多个桌面实例共享本 daemon，任何单实例的"引用全集"都是残缺视图。
    pub(crate) fn desktop_client_count(&self) -> usize {
        self.inner.desktop_control_clients.load(Ordering::SeqCst)
    }

    /// 申请或续租一条会话的写权限。
    ///
    /// 同一 owner 重复调用即续租（幂等）；租约过期后任何实例都可以接手。
    /// 返回 `Err(existing_owner)` 表示会话正被别的实例持有。
    pub(crate) fn try_claim_session(
        &self,
        session_id: &str,
        owner: &str,
        ttl_ms: Option<u64>,
    ) -> Result<SessionClaim, String> {
        let ttl = ttl_ms
            .unwrap_or(CLAIM_TTL_DEFAULT_MS)
            .clamp(CLAIM_TTL_MIN_MS, CLAIM_TTL_MAX_MS);
        let now = Instant::now();
        let mut claims = self.inner.session_claims.write();

        if let Some(existing) = claims.get(session_id) {
            if existing.is_live(now) && existing.owner != owner {
                return Err(existing.owner.clone());
            }
        }

        let claim = SessionClaim {
            owner: owner.to_string(),
            expires_at: now + Duration::from_millis(ttl),
        };
        claims.insert(session_id.to_string(), claim.clone());
        Ok(claim)
    }

    /// 释放租约。只有持有者能释放；过期租约任何人都可以清掉。
    pub(crate) fn release_session_claim(&self, session_id: &str, owner: &str) -> bool {
        let now = Instant::now();
        let mut claims = self.inner.session_claims.write();
        match claims.get(session_id) {
            Some(existing) if existing.owner == owner || !existing.is_live(now) => {
                claims.remove(session_id);
                true
            }
            Some(_) => false,
            None => true,
        }
    }

    /// 当前**仍在有效期内**的持有者。过期租约视为无人持有。
    pub(crate) fn session_claim_owner(&self, session_id: &str) -> Option<String> {
        let now = Instant::now();
        self.inner
            .session_claims
            .read()
            .get(session_id)
            .filter(|claim| claim.is_live(now))
            .map(|claim| claim.owner.clone())
    }

    /// 判断某调用方是否可以写这条会话。
    ///
    /// 无有效租约 → 放行（向后兼容，见 `session_claims` 注释）。
    /// 有租约 → 只有持有者能写；匿名调用方一律拒绝。
    pub(crate) fn may_write_session(&self, session_id: &str, caller: Option<&str>) -> bool {
        match self.session_claim_owner(session_id) {
            None => true,
            Some(owner) => caller == Some(owner.as_str()),
        }
    }

    /// 会话结束时丢弃租约，避免 map 随会话数无限增长。
    pub(crate) fn forget_session_claim(&self, session_id: &str) {
        self.inner.session_claims.write().remove(session_id);
    }

    /// 清理已过期的租约项。读路径不写锁，所以由 claim/list 这类低频写路径顺带调用，
    /// 避免租约表随着"曾被 claim 过但早已过期"的会话无界增长（docs/61 评审 #4）。
    pub(crate) fn prune_expired_claims(&self) {
        let now = Instant::now();
        self.inner
            .session_claims
            .write()
            .retain(|_, claim| claim.is_live(now));
    }

    /// 全部仍在有效期内的租约。过期项不返回（也不在这里清理——读路径不写锁）。
    pub(crate) fn live_session_claims(&self) -> HashMap<String, String> {
        let now = Instant::now();
        self.inner
            .session_claims
            .read()
            .iter()
            .filter(|(_, claim)| claim.is_live(now))
            .map(|(session_id, claim)| (session_id.clone(), claim.owner.clone()))
            .collect()
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

    pub(crate) fn ws_emitter(&self) -> Arc<WsEmitter> {
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

    /// 会话拆除：活跃时间与写权限租约一起丢弃，避免两张 map 随会话数无限增长。
    pub(crate) fn remove_session_activity(&self, session_id: &str) {
        self.forget_session_claim(session_id);
        self.inner.session_provenance.write().remove(session_id);
        self.inner
            .restore_replacements
            .write()
            .retain(|expected, replacement| expected != session_id && replacement != session_id);
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
    /// 会话写权限租约（docs/61 阶段 2）。
    ///
    /// daemon 是唯一同时持有 PTY、连接生命周期与全部客户端视图的一方，
    /// 所以裁决必须发生在这里——放到 SQLite 里做 CAS 消不掉 attach 前的 TOCTOU 窗口。
    ///
    /// 语义刻意做成**「有租约才强制」**：没有任何实例 claim 过的会话，写入照旧放行。
    /// 否则运行中的旧版客户端（不会发实例头）会在升级瞬间全部失去输入能力。
    session_claims: parking_lot::RwLock<HashMap<String, SessionClaim>>,
    /// Immutable daemon-side PTY birth evidence. It is exposed separately from mutable layout
    /// observations so a later app instance can prove that a saved anchor still refers to the
    /// exact live PTY it was created for.
    session_provenance: parking_lot::RwLock<HashMap<String, TerminalSessionProvenance>>,
    /// Idempotency aliases for restore requests whose original PTY was already gone. The alias
    /// stays daemon-local and prevents a second app instance from spawning another replacement
    /// for the same saved session while the first replacement is still live.
    restore_replacements: parking_lot::RwLock<HashMap<String, String>>,
    /// Creation visibility fence. Every externally observable session operation takes a read
    /// guard; create holds the write guard until provenance and the initial claim are registered.
    session_visibility: RwLock<()>,
}

/// 一条会话写权限租约。
#[derive(Debug, Clone)]
pub(crate) struct SessionClaim {
    owner: String,
    expires_at: Instant,
}

impl SessionClaim {
    fn is_live(&self, now: Instant) -> bool {
        self.expires_at > now
    }
}

/// 租约 TTL 边界：太短会让一次 GC 停顿就丢掉写权限，太长会让崩溃的实例长期占着会话。
const CLAIM_TTL_DEFAULT_MS: u64 = 30_000;
const CLAIM_TTL_MIN_MS: u64 = 5_000;
const CLAIM_TTL_MAX_MS: u64 = 300_000;
/// 调用方声明自身实例身份的请求头。缺失 = 匿名客户端（旧版本）。
const INSTANCE_HEADER: &str = "x-cc-panes-instance";

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
    /// 本 daemon 是否支持会话写权限租约（docs/61 阶段 2）。
    /// 旧 daemon 没有这个字段，客户端 deserialize 成 None → 视为不支持，
    /// 据此禁用自动接管（评审 #11：404 只保证"不报错"，不等于有互斥）。
    pub claims_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub pid: u32,
    pub started_at: u64,
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
    pub model_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
    pub origin_layout_id: Option<String>,
    pub origin_tab_id: Option<String>,
    pub origin_terminal_pane_id: Option<String>,
    pub expected_saved_session_id: Option<String>,
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
    #[serde(default)]
    pub reused_existing: bool,
    #[serde(default)]
    pub resolved_model_id: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    /// 申请方实例身份。也可以走 `X-CC-Panes-Instance` 头。
    #[serde(default)]
    pub app_instance_id: Option<String>,
    /// 租约时长，缺省 30s，服务端 clamp 到 [5s, 300s]
    #[serde(default)]
    pub ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub session_id: String,
    pub owner: String,
    pub granted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsQuery {
    pub token: Option<String>,
    /// 订阅方实例身份（可缺失=匿名旧客户端）。决定这条连接能不能写。
    pub instance_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlWsQuery {
    pub token: Option<String>,
    /// 客户端类型：desktop（默认，计入 desktopClientCount）/ web（不计入）
    pub kind: Option<String>,
    /// 订阅方实例身份（与 per-session WS 的 instanceId 同源）。hidden 闸门
    /// 按它把本连接的上报关联到该实例的全部会话订阅；缺失=旧客户端，
    /// 上报无法关联（闸门对其不生效）。
    pub instance_id: Option<String>,
}

pub fn router(config: DaemonConfig) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/daemon/status", get(status))
        .route("/api/daemon/shutdown", post(shutdown))
        .route("/api/sessions", post(create_session))
        .route("/api/launches/{launch_id}", delete(cancel_launch))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}/status", get(get_session_status))
        .route(
            "/api/sessions-by-launch/{launch_id}",
            get(find_session_by_launch),
        )
        .route("/api/sessions/{id}/hook-status", post(hook_status))
        .route("/api/sessions/{id}/output", get(get_session_output))
        .route("/api/sessions/{id}/snapshot", get(get_session_snapshot))
        .route(
            "/api/sessions/{id}/recovery-snapshot",
            get(get_session_recovery_snapshot),
        )
        .route(
            "/api/sessions/{id}/checkpoint",
            // 显式 16MB body 上限：axum 默认 2MB 会把大照片静默 413（M3b 风险表）。
            post(upload_session_checkpoint)
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/api/sessions/{id}/write", post(write_session))
        .route("/api/sessions/{id}/submit", post(submit_session))
        .route("/api/sessions/{id}/resize", post(resize_session))
        .route(
            "/api/sessions/adoption-snapshot",
            get(get_adoption_snapshot),
        )
        .route("/api/sessions/claims", get(list_session_claims))
        .route(
            "/api/sessions/identity",
            get(crate::identity_routes::list_identity_events),
        )
        .route("/api/sessions/{id}/provenance", get(get_session_provenance))
        .route("/api/sessions/{id}/claim", post(claim_session))
        .route("/api/sessions/{id}/claim", delete(release_session_claim))
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

async fn health(State(config): State<DaemonConfig>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "cc-panes-daemon".to_string(),
        pid: std::process::id(),
        started_at: config.inner.started_at,
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

fn normalized_resume_id(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "new")
}

fn request_runtime_kind(request: &CoreCreateSessionRequest) -> &'static str {
    if request.ssh.is_some() {
        "ssh"
    } else if request.wsl.is_some() {
        "wsl"
    } else {
        "local"
    }
}

fn restore_identity_matches(
    request: &CoreCreateSessionRequest,
    provenance: &TerminalSessionProvenance,
) -> bool {
    project_paths_equivalent(&request.project_path, &provenance.project_path)
        && request_runtime_kind(request) == provenance.runtime_kind
        && request.effective_cli_tool().as_id() == provenance.cli_tool
        && normalized_resume_id(request.resume_id.as_deref())
            == normalized_resume_id(provenance.resume_id.as_deref())
}

fn reuse_expected_session(
    config: &DaemonConfig,
    request: &CoreCreateSessionRequest,
    owner: Option<&str>,
) -> Result<Option<String>, (StatusCode, Json<serde_json::Value>)> {
    let Some(expected_session_id) = request.expected_saved_session_id.as_deref() else {
        return Ok(None);
    };
    let direct_status = config
        .terminal_backend()
        .get_session_status(expected_session_id)
        .map_err(internal_error)?;
    let session_id = if direct_status.is_some_and(|status| status.status != SessionStatus::Exited) {
        expected_session_id.to_string()
    } else {
        let replacement = config
            .inner
            .restore_replacements
            .read()
            .get(expected_session_id)
            .cloned();
        let Some(replacement) = replacement else {
            return Ok(None);
        };
        let replacement_status = config
            .terminal_backend()
            .get_session_status(&replacement)
            .map_err(internal_error)?;
        if !replacement_status.is_some_and(|status| status.status != SessionStatus::Exited) {
            config
                .inner
                .restore_replacements
                .write()
                .remove(expected_session_id);
            return Ok(None);
        }
        replacement
    };

    let owner = owner.ok_or_else(|| {
        json_error(
            StatusCode::CONFLICT,
            "RESTORE_OWNER_MISSING",
            "live expected session requires an instance identity",
        )
    })?;
    let provenance = config
        .inner
        .session_provenance
        .read()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| {
            json_error(
                StatusCode::CONFLICT,
                "RESTORE_PROVENANCE_MISSING",
                "live expected session has no immutable provenance",
            )
        })?;
    if !restore_identity_matches(request, &provenance) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "RESTORE_IDENTITY_MISMATCH",
            "live expected session does not match the restore request",
        ));
    }
    config
        .try_claim_session(&session_id, owner, None)
        .map_err(|existing| {
            json_error(
                StatusCode::CONFLICT,
                "SESSION_CLAIMED",
                format!("expected session is already claimed by {existing}"),
            )
        })?;
    config.touch_session(&session_id);
    Ok(Some(session_id))
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
    let provenance_project_path = project_path.clone();
    let provenance_runtime_kind = if req.core.ssh.is_some() {
        "ssh"
    } else if req.core.wsl.is_some() {
        "wsl"
    } else {
        "local"
    }
    .to_string();
    let provenance_cli_tool = req.core.cli_tool.as_id().to_string();
    let provenance_resume_id = req.core.resume_id.clone();
    let provenance_origin_layout_id = req.core.origin_layout_id.clone();
    let provenance_origin_tab_id = req.core.origin_tab_id.clone();
    let provenance_origin_terminal_pane_id = req.core.origin_terminal_pane_id.clone();
    let owner = caller_instance(&headers);
    let core_request = normalize_session_request_for_current_host(CoreCreateSessionRequest {
        launch_id: req.core.launch_id,
        project_path,
        cols: req.core.cols.unwrap_or(120),
        rows: req.core.rows.unwrap_or(30),
        workspace_name: req.core.workspace_name,
        provider_id: req.core.provider_id,
        model_id: req.core.model_id,
        provider_selection: req.core.provider_selection,
        launch_profile_id: req.core.launch_profile_id,
        workspace_path: req.core.workspace_path,
        workspace_snapshot_id: req.core.workspace_snapshot_id,
        origin_layout_id: req.core.origin_layout_id,
        origin_tab_id: req.core.origin_tab_id,
        origin_terminal_pane_id: req.core.origin_terminal_pane_id,
        expected_saved_session_id: req.core.expected_saved_session_id,
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
    // All readers wait until PTY creation, immutable provenance, and the initial claim form one
    // externally visible unit. The backend may emit a session-created event before returning, but
    // any operation triggered by that event blocks on the matching read guard.
    let _visibility = config.inner.session_visibility.write().await;
    if let Some(session_id) = reuse_expected_session(&config, &core_request, owner.as_deref())? {
        return Ok((
            StatusCode::CREATED,
            Json(CreateSessionResponse {
                session_id,
                reused_existing: true,
                resolved_model_id: None,
            }),
        ));
    }
    let expected_saved_session_id = core_request.expected_saved_session_id.clone();
    // create_session 里 WSL 冷启动 + 探活 + spawn_pty 是同步阻塞操作，
    // 挪到 blocking 线程池，避免慢请求占死 tokio worker。
    let launch_id = core_request.launch_id.clone();
    let runtime_kind = provenance_runtime_kind.clone();
    let backend = config.terminal_backend_arc();
    let mut create_task =
        tokio::task::spawn_blocking(move || backend.create_session_with_outcome(core_request));
    let outcome = match tokio::time::timeout(DAEMON_CREATE_DEADLINE, &mut create_task).await {
        Ok(result) => result
            .map_err(|error| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "JOIN_ERROR",
                    error.to_string(),
                )
            })?
            .map_err(app_error)?,
        Err(_) => {
            let late_backend = config.terminal_backend_arc();
            tokio::spawn(async move {
                if let Ok(Ok(outcome)) = create_task.await {
                    let _ = tokio::task::spawn_blocking(move || {
                        late_backend
                            .kill_with_reason(&outcome.session_id, KillReason::LaunchTimeout)
                    })
                    .await;
                }
            });
            if let Some(launch_id) = launch_id.clone() {
                let cancel_backend = config.terminal_backend_arc();
                tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        cancel_backend.cancel_launch(&launch_id)
                    })
                    .await;
                });
            }
            return Err(json_error_with_params(
                StatusCode::GATEWAY_TIMEOUT,
                "LAUNCH_TIMEOUT",
                format!(
                    "Terminal launch exceeded {}ms",
                    DAEMON_CREATE_DEADLINE.as_millis()
                ),
                serde_json::json!({
                    "launchId": launch_id,
                    "runtime": runtime_kind,
                    "stage": "backend.create_session",
                    "timeoutMs": DAEMON_CREATE_DEADLINE.as_millis().to_string(),
                }),
            ));
        }
    };
    let session_id = outcome.session_id;
    let resolved_model_id = outcome.resolved_model_id;
    config.touch_session(&session_id);
    // create+claim 原子化（docs/61 评审 #2）：会话对外可见前就把写权限归给创建者，
    // 否则"先创建后 claim"之间存在窗口，另一实例可以抢走刚建好的会话。
    // 这里在 session_id 返回给调用方之前完成，故不存在可被观察到的未认领态。
    if let Some(owner) = owner.as_deref() {
        if let Err(existing) = config.try_claim_session(&session_id, owner, None) {
            let _ = config
                .terminal_backend()
                .kill_with_reason(&session_id, KillReason::Unknown);
            config.remove_session_activity(&session_id);
            return Err(json_error(
                StatusCode::CONFLICT,
                "SESSION_CLAIMED",
                format!("fresh session id is already claimed by {existing}"),
            ));
        }
    }
    config.inner.session_provenance.write().insert(
        session_id.clone(),
        TerminalSessionProvenance {
            session_id: session_id.clone(),
            daemon_generation: config.inner.started_at,
            birth_nonce: generate_token(),
            origin_instance_id: owner,
            origin_layout_id: provenance_origin_layout_id,
            origin_tab_id: provenance_origin_tab_id,
            origin_terminal_pane_id: provenance_origin_terminal_pane_id,
            project_path: provenance_project_path,
            runtime_kind: provenance_runtime_kind,
            cli_tool: provenance_cli_tool,
            resume_id: provenance_resume_id,
            created_at_ms: current_epoch_millis(),
        },
    );
    if let Some(expected_session_id) = expected_saved_session_id {
        config
            .inner
            .restore_replacements
            .write()
            .insert(expected_session_id, session_id.clone());
    }
    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            session_id,
            reused_existing: false,
            resolved_model_id,
        }),
    ))
}

async fn cancel_launch(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(launch_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let backend = config.terminal_backend_arc();
    tokio::task::spawn_blocking(move || backend.cancel_launch(&launch_id))
        .await
        .map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "JOIN_ERROR",
                error.to_string(),
            )
        })?
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_sessions(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionStatusInfo>>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
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
    let _visibility = config.inner.session_visibility.read().await;
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
    let _visibility = config.inner.session_visibility.read().await;
    ensure_may_write(&config, &id, &headers)?;
    config.touch_session(&id);
    config
        .terminal_backend()
        .resize(&id, req.cols, req.rows)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// 读取调用方声明的实例身份。缺失即匿名（旧版客户端）。
fn caller_instance(headers: &HeaderMap) -> Option<String> {
    headers
        .get(INSTANCE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 写入类操作的租约闸门。无租约放行，有租约只放持有者。
fn ensure_may_write(
    config: &DaemonConfig,
    session_id: &str,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let caller = caller_instance(headers);
    if config.may_write_session(session_id, caller.as_deref()) {
        return Ok(());
    }
    let owner = config.session_claim_owner(session_id).unwrap_or_default();
    Err((
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "code": "SESSION_CLAIMED",
            "message": format!("session is claimed by another instance: {owner}"),
            "owner": owner,
        })),
    ))
}

/// 当前所有**仍在有效期内**的写权限租约：sessionId → ownerInstanceId。
/// 前端据此判断某条无主会话是否已被别的实例持有，从而不去提供接管。
async fn list_session_claims(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<HashMap<String, String>>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    config.prune_expired_claims();
    Ok(Json(config.live_session_claims()))
}

async fn get_adoption_snapshot(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<TerminalAdoptionSnapshot>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    let sessions = config
        .terminal_backend()
        .get_all_status()
        .map_err(internal_error)?;
    let live_ids: std::collections::HashSet<&str> = sessions
        .iter()
        .filter(|status| !status.status.is_terminal())
        .map(|status| status.session_id.as_str())
        .collect();
    config.prune_expired_claims();
    config
        .inner
        .session_claims
        .write()
        .retain(|session_id, _| live_ids.contains(session_id.as_str()));
    config
        .inner
        .session_provenance
        .write()
        .retain(|session_id, _| live_ids.contains(session_id.as_str()));
    Ok(Json(TerminalAdoptionSnapshot {
        claims_supported: true,
        daemon_generation: Some(config.inner.started_at),
        owner_instance_id: caller_instance(&headers),
        captured_at_ms: current_epoch_millis(),
        complete: true,
        sessions,
        claims: config.live_session_claims(),
        provenance: config.inner.session_provenance.read().clone(),
    }))
}

async fn get_session_provenance(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<TerminalSessionProvenance>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    config
        .inner
        .session_provenance
        .read()
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| not_found("Session provenance not found"))
}

async fn claim_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ClaimRequest>,
) -> Result<Json<ClaimResponse>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    let owner = req
        .app_instance_id
        .or_else(|| caller_instance(&headers))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "MISSING_INSTANCE_ID",
                "appInstanceId is required to claim a session",
            )
        })?;

    // 只允许对真实存在的活会话 claim（docs/61 评审 #4）：否则调用方可以往
    // 任意字符串上占坑，租约表被垃圾项撑大，且掩盖会话已消失的事实。
    match config.terminal_backend().get_session_status(&id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "SESSION_NOT_FOUND",
                "cannot claim a session that does not exist",
            ));
        }
        Err(error) => return Err(internal_error(error)),
    }
    config.prune_expired_claims();

    match config.try_claim_session(&id, &owner, req.ttl_ms) {
        Ok(_) => {
            config.touch_session(&id);
            Ok(Json(ClaimResponse {
                session_id: id,
                owner,
                granted: true,
            }))
        }
        Err(existing_owner) => Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "code": "SESSION_CLAIMED",
                "message": format!("session is claimed by another instance: {existing_owner}"),
                "owner": existing_owner,
            })),
        )),
    }
}

async fn release_session_claim(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ClaimRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    let owner = req
        .app_instance_id
        .or_else(|| caller_instance(&headers))
        .unwrap_or_default();
    if config.release_session_claim(&id, &owner) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(json_error(
            StatusCode::CONFLICT,
            "SESSION_CLAIMED",
            "session is claimed by another instance",
        ))
    }
}

async fn write_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<WriteRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    ensure_may_write(&config, &id, &headers)?;
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
    let _visibility = config.inner.session_visibility.read().await;
    ensure_may_write(&config, &id, &headers)?;
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

/// checkpoint+delta 结构化恢复快照（M3b-3）。无照片/失效照片时 checkpoint
/// 为 null、delta 为全窗口——前端消费方只有一个形状。
async fn get_session_recovery_snapshot(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<
    Json<cc_panes_core::models::TerminalRecoverySnapshot>,
    (StatusCode, Json<serde_json::Value>),
> {
    authorize(&headers, config.token())?;
    config.touch_session(&id);
    let snapshot = config
        .terminal_backend()
        .get_session_recovery_snapshot(&id)
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Session not found"))?;
    Ok(Json(snapshot))
}

/// 前端上传终端画面照片（M3b-2）。
///
/// 写权限过 ensure_may_write（照片影响所有客户端的恢复数据，只读镜像端不得
/// 污染）。拒收以 409 + 结构化 code 返回（幂等：重复上传同锚点 = STALE_ANCHOR）；
/// 会话不存在 404；旧 daemon 无此路由（app 侧 capability 探测点）。
async fn upload_session_checkpoint(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(checkpoint): Json<TerminalCheckpoint>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    let _visibility = config.inner.session_visibility.read().await;
    ensure_may_write(&config, &id, &headers)?;
    config.touch_session(&id);
    let outcome = config
        .terminal_backend()
        .store_session_checkpoint(&id, checkpoint)
        .map_err(not_found_from_error)?;
    match outcome {
        StoreCheckpointOutcome::Accepted { anchor_seq } => Ok(Json(serde_json::json!({
            "accepted": true,
            "anchorSeq": anchor_seq,
        }))),
        rejected => {
            let code = match rejected {
                StoreCheckpointOutcome::RejectedStaleAnchor => "STALE_ANCHOR",
                StoreCheckpointOutcome::RejectedAnchorGap => "ANCHOR_GAP",
                StoreCheckpointOutcome::RejectedFutureAnchor => "FUTURE_ANCHOR",
                StoreCheckpointOutcome::RejectedEpochMismatch => "EPOCH_MISMATCH",
                StoreCheckpointOutcome::RejectedTooLarge => "TOO_LARGE",
                StoreCheckpointOutcome::Accepted { .. } => unreachable!("handled above"),
            };
            Err(json_error(
                StatusCode::CONFLICT,
                code,
                "checkpoint rejected by replay buffer",
            ))
        }
    }
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
    let _visibility = config.inner.session_visibility.read().await;
    // kill 也要过租约闸门（docs/61 评审 #4）：否则任意旧客户端都能杀掉别的实例
    // 正在使用的会话——比输入交错更严重，且不可逆。
    ensure_may_write(&config, &id, &headers)?;
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
    let upgrade_config = config.clone();
    let _visibility = config.inner.session_visibility.read().await;
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

    // WS 订阅永远放行（只读镜像是设计允许的）；写权限在入站 input 处按租约裁决。
    let caller = query.instance_id.clone();
    Ok(ws.on_upgrade(move |socket| handle_ws(socket, id, upgrade_config, caller)))
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
    let instance_id = query.instance_id.clone();
    Ok(ws.on_upgrade(move |socket| handle_control_ws(socket, config, is_desktop, instance_id)))
}

/// control 通道的入站消息（客户端 → daemon）。
///
/// 此前 control 是单向的（入站 Text 直接丢弃），hidden 上报需要这条
/// 上行路。旧 daemon 收到 hidden 上报会静默忽略——所以 app 侧**不能假设上报
/// 生效**，前端 512KB 积压必须继续兜底。
/// 一条已消费身份事件的 ack 键（sessionId + 消费到的 resumeId）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityAckEntry {
    session_id: String,
    resume_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ControlInboundMessage {
    /// 声明该连接当前看不见哪些会话（全量覆盖，不是增量）。
    HiddenSessions { sessions: Vec<String> },
    /// 桌面端确认已消费这些身份事件（outbox ack，docs/86 3.1）。留存条目
    /// 据此移除，app 重启后不再全量重放历史事件。旧 app 不发本消息——
    /// 留存照旧累积，行为等同 ack 机制之前。
    IdentityAck { events: Vec<IdentityAckEntry> },
    #[serde(other)]
    Unknown,
}

async fn handle_control_ws(
    socket: WebSocket,
    config: DaemonConfig,
    is_desktop: bool,
    instance_id: Option<String>,
) {
    let _guard = is_desktop.then(|| config.register_desktop_client());
    // hidden 按连接记账。**优先用客户端自报的 instanceId**——它与该实例全部
    // per-session WS 的 instanceId 同源，闸门靠这个同源性把「control 上报的
    // hidden 集合」关联到「会话订阅」。旧客户端缺失时退回进程内计数（此时
    // 上报无法关联到任何订阅，闸门对其不生效——设计内的降级）。
    static CONTROL_CONNECTION_SEQ: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    let connection_id = instance_id.unwrap_or_else(|| {
        format!(
            "ctl-{}",
            CONTROL_CONNECTION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    });
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
                    Message::Text(text) => {
                        match serde_json::from_str::<ControlInboundMessage>(&text) {
                            Ok(ControlInboundMessage::HiddenSessions { sessions }) => {
                                config
                                    .ws_emitter()
                                    .set_hidden_sessions(&connection_id, &sessions);
                            }
                            Ok(ControlInboundMessage::IdentityAck { events }) => {
                                let keys: Vec<(String, String)> = events
                                    .into_iter()
                                    .map(|entry| (entry.session_id, entry.resume_id))
                                    .collect();
                                config.ws_emitter().ack_identity_events(&keys);
                            }
                            // 未知消息静默忽略：新版 app 对旧 daemon 发新消息时
                            // 不应把连接搞崩。
                            Ok(ControlInboundMessage::Unknown) | Err(_) => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    // 连接结束：清掉它的 hidden 标记，否则重连后的新订阅会被旧标记压住，
    // 表现为「重连后永久收不到输出」且零报错。
    config.ws_emitter().clear_connection_hidden(&connection_id);

    if is_desktop {
        // guard 在函数返回时 drop，这里先打日志（-1 生效前的计数减一即最终值）
        info!(
            desktop_client_count = config.desktop_client_count().saturating_sub(1),
            "desktop control client disconnected"
        );
    }
}

async fn handle_ws(
    socket: WebSocket,
    session_id: String,
    config: DaemonConfig,
    caller: Option<String>,
) {
    config.touch_session(&session_id);
    let (mut ws_tx, mut ws_rx) = socket.split();
    // caller = per-session WS 的 instanceId（WsQuery 既有字段）——与 control
    // 连接同源，hidden 闸门据此定位到本连接。
    let mut output_rx = config
        .ws_emitter()
        .subscribe_with_connection(&session_id, caller.clone());
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
                        // 租约闸门：会话被别的实例持有时，这条连接只能看不能写，
                        // 否则两个实例的输入会交错进同一个 PTY。
                        if config.may_write_session(&session_id, caller.as_deref()) {
                            let _ = config.terminal_backend().write(&session_id, data);
                        } else {
                            tracing::warn!(
                                session_id = %session_id,
                                caller = caller.as_deref().unwrap_or("<anonymous>"),
                                "rejected ws input: session claimed by another instance"
                            );
                        }
                    }
                }
            }
            Message::Binary(data) => {
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    if config.may_write_session(&session_id, caller.as_deref()) {
                        let _ = config.terminal_backend().write(&session_id, &text);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
    config.ws_emitter().cleanup_session(&send_session_id);
}

pub(crate) fn authorize(
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

fn json_error_with_params(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
    params: serde_json::Value,
) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::json!({
            "code": code,
            "message": message.into(),
            "params": params,
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

fn app_error(error: AppError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match &error {
        AppError::NotFound(_) => StatusCode::NOT_FOUND,
        AppError::Message { .. } if error.code().is_some() => StatusCode::BAD_REQUEST,
        AppError::Message { .. } => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let body = serde_json::to_value(&error).unwrap_or_else(|_| {
        serde_json::json!({
            "code": "INTERNAL_ERROR",
            "message": "Failed to serialize daemon error"
        })
    });
    (status, Json(body))
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

    /// 跨侧契约：app 侧 control link 发的 hiddenSessions JSON 必须能被这里
    /// 解析（两边各自演进时这条测试是唯一的形状锁）。
    #[test]
    fn control_inbound_hidden_sessions_parses() {
        let msg: ControlInboundMessage =
            serde_json::from_str(r#"{"type":"hiddenSessions","sessions":["s1","s2"]}"#)
                .expect("parse");
        match msg {
            ControlInboundMessage::HiddenSessions { sessions } => {
                assert_eq!(sessions, vec!["s1".to_string(), "s2".to_string()]);
            }
            other => panic!("expected HiddenSessions, got {other:?}"),
        }
    }

    #[test]
    fn control_inbound_unknown_is_tolerated() {
        let msg: ControlInboundMessage =
            serde_json::from_str(r#"{"type":"futureThing","x":1}"#).expect("parse");
        assert!(matches!(msg, ControlInboundMessage::Unknown));
    }
    use std::sync::{Arc, Mutex};

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use cc_panes_core::models::TerminalBufferMode;
    use cc_panes_core::services::terminal_service::SessionStatus;
    use cc_panes_core::services::CreateSessionOutcome;
    use cc_panes_core::utils::AppResult;
    use tower::ServiceExt;

    use super::*;

    #[test]
    fn app_error_preserves_provider_code_and_safe_params() {
        let error = AppError::coded_with_params(
            "PROVIDER_NOT_FOUND",
            "Provider was not found",
            HashMap::from([
                ("cliTool".to_string(), "claude".to_string()),
                ("providerId".to_string(), "deleted-provider".to_string()),
            ]),
        );

        let (status, Json(body)) = app_error(error);

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "PROVIDER_NOT_FOUND");
        assert_eq!(body["params"]["providerId"], "deleted-provider");
        assert!(!body.to_string().contains("apiKey"));
    }

    #[test]
    fn create_session_response_serializes_an_explicit_null_resolved_model() {
        let value = serde_json::to_value(CreateSessionResponse {
            session_id: "session-native".to_string(),
            reused_existing: false,
            resolved_model_id: None,
        })
        .expect("serialize create response");

        assert!(value.get("resolvedModelId").is_some());
        assert!(value["resolvedModelId"].is_null());
    }

    #[derive(Default)]
    struct MockTerminalBackend {
        created: Mutex<Vec<CoreCreateSessionRequest>>,
        resolved_model_id: Mutex<Option<String>>,
        writes: Mutex<Vec<(String, String)>>,
        submits: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
        kill_reasons: Mutex<Vec<(String, KillReason)>>,
        hook_statuses: Mutex<Vec<(String, SessionStatus)>>,
        checkpoints: Mutex<Vec<(String, TerminalCheckpoint)>>,
        recovery_snapshot_calls: Mutex<Vec<String>>,
    }

    impl TerminalBackend for MockTerminalBackend {
        fn create_session(&self, request: CoreCreateSessionRequest) -> AppResult<String> {
            self.created.lock().unwrap().push(request);
            Ok("session-1".to_string())
        }

        fn create_session_with_outcome(
            &self,
            request: CoreCreateSessionRequest,
        ) -> AppResult<CreateSessionOutcome> {
            let session_id = self.create_session(request)?;
            Ok(CreateSessionOutcome {
                session_id,
                reused_existing: false,
                resolved_model_id: self.resolved_model_id.lock().unwrap().clone(),
            })
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

        fn store_session_checkpoint(
            &self,
            session_id: &str,
            checkpoint: TerminalCheckpoint,
        ) -> AppResult<StoreCheckpointOutcome> {
            // 约定：只有 "session-1" 存在；anchor 0 模拟 stale 拒收。
            if session_id != "session-1" {
                return Err(AppError::NotFound(format!(
                    "Session not found: {session_id}"
                )));
            }
            if checkpoint.anchor_seq == 0 {
                return Ok(StoreCheckpointOutcome::RejectedStaleAnchor);
            }
            let anchor_seq = checkpoint.anchor_seq;
            self.checkpoints
                .lock()
                .unwrap()
                .push((session_id.to_string(), checkpoint));
            Ok(StoreCheckpointOutcome::Accepted { anchor_seq })
        }

        /// 约定同 store：只有 "session-1" 存在，其余返回 None（→ handler 404）。
        fn get_session_recovery_snapshot(
            &self,
            session_id: &str,
        ) -> AppResult<Option<cc_panes_core::models::TerminalRecoverySnapshot>> {
            self.recovery_snapshot_calls
                .lock()
                .unwrap()
                .push(session_id.to_string());
            if session_id != "session-1" {
                return Ok(None);
            }
            Ok(Some(cc_panes_core::models::TerminalRecoverySnapshot {
                checkpoint: Some(TerminalCheckpoint {
                    checkpoint_epoch: 7,
                    anchor_seq: 5,
                    snapshot_ansi: "PHOTO".to_string(),
                    buffer_mode: TerminalBufferMode::Normal,
                    cols: 80,
                    rows: 24,
                    checkpointed_at_ms: 1,
                }),
                delta: "TAIL".to_string(),
                buffer_mode: TerminalBufferMode::Normal,
                end_seq: 9,
                checkpoint_epoch: 7,
            }))
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

    fn mark_session_live(backend: &MockTerminalBackend) {
        let request = serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24
        }))
        .expect("core create request");
        backend
            .create_session(request)
            .expect("mock session creation");
    }

    fn expected_session_create_request(
        expected_session_id: &str,
        instance_id: &str,
        project_path: &str,
    ) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/sessions")
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(INSTANCE_HEADER, instance_id)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({
                    "projectPath": project_path,
                    "cols": 80,
                    "rows": 24,
                    "cliTool": "codex",
                    "resumeId": "resume-1",
                    "expectedSavedSessionId": expected_session_id,
                    "originLayoutId": "layout-current",
                    "originTabId": "tab-current",
                    "originTerminalPaneId": "leaf-current"
                })
                .to_string(),
            ))
            .expect("request")
    }

    fn install_test_provenance(config: &DaemonConfig, project_path: &str) {
        config.inner.session_provenance.write().insert(
            "session-1".to_string(),
            TerminalSessionProvenance {
                session_id: "session-1".to_string(),
                daemon_generation: config.inner.started_at,
                birth_nonce: "birth-1".to_string(),
                origin_instance_id: Some("inst-old".to_string()),
                origin_layout_id: Some("layout-origin".to_string()),
                origin_tab_id: Some("tab-origin".to_string()),
                origin_terminal_pane_id: Some("leaf-origin".to_string()),
                project_path: project_path.to_string(),
                runtime_kind: "local".to_string(),
                cli_tool: "codex".to_string(),
                resume_id: Some("resume-1".to_string()),
                created_at_ms: 1,
            },
        );
    }

    fn checkpoint_upload_request(session_id: &str, anchor_seq: u64, token: bool) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/api/sessions/{session_id}/checkpoint"))
            .header(header::CONTENT_TYPE, "application/json");
        if token {
            builder = builder.header(header::AUTHORIZATION, "Bearer secret");
        }
        builder
            .body(Body::from(
                serde_json::json!({
                    "checkpointEpoch": 7,
                    "anchorSeq": anchor_seq,
                    "snapshotAnsi": "PHOTO",
                    "bufferMode": "normal",
                    "cols": 80,
                    "rows": 24,
                    "checkpointedAtMs": 1,
                })
                .to_string(),
            ))
            .expect("request")
    }

    #[tokio::test]
    async fn checkpoint_upload_accepts_and_returns_anchor_seq() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18094", backend.clone());

        let response = router(config)
            .oneshot(checkpoint_upload_request("session-1", 5, true))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json");
        assert_eq!(body["accepted"], true);
        assert_eq!(body["anchorSeq"], 5);
        let stored = backend.checkpoints.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0, "session-1");
        assert_eq!(stored[0].1.snapshot_ansi, "PHOTO");
    }

    #[tokio::test]
    async fn checkpoint_upload_rejection_maps_to_409_with_structured_code() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18095", backend);

        let response = router(config)
            .oneshot(checkpoint_upload_request("session-1", 0, true))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: serde_json::Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json");
        assert_eq!(body["code"], "STALE_ANCHOR");
    }

    #[tokio::test]
    async fn checkpoint_upload_requires_token_and_existing_session() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18096", backend);

        let unauthorized = router(config.clone())
            .oneshot(checkpoint_upload_request("session-1", 5, false))
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let missing = router(config)
            .oneshot(checkpoint_upload_request("session-nope", 5, true))
            .await
            .expect("missing response");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    // ===== recovery-snapshot 读链（M3b-3）=====

    fn recovery_snapshot_request(session_id: &str, token: bool) -> Request<Body> {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("/api/sessions/{session_id}/recovery-snapshot"));
        if token {
            builder = builder.header(header::AUTHORIZATION, "Bearer secret");
        }
        builder.body(Body::empty()).expect("request")
    }

    async fn json_body(response: axum::response::Response) -> serde_json::Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json")
    }

    #[tokio::test]
    async fn recovery_snapshot_requires_token() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18097", backend.clone());

        let response = router(config)
            .oneshot(recovery_snapshot_request("session-1", false))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            backend.recovery_snapshot_calls.lock().unwrap().is_empty(),
            "鉴权失败必须在碰后端之前短路"
        );
    }

    #[tokio::test]
    async fn recovery_snapshot_returns_checkpoint_and_delta_shape() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18098", backend.clone());

        let response = router(config.clone())
            .oneshot(recovery_snapshot_request("session-1", true))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["checkpoint"]["snapshotAnsi"], "PHOTO");
        assert_eq!(body["checkpoint"]["anchorSeq"], 5);
        assert_eq!(body["delta"], "TAIL");
        assert_eq!(body["bufferMode"], "normal");
        assert_eq!(body["endSeq"], 9);
        assert_eq!(body["checkpointEpoch"], 7);
        assert_eq!(
            backend.recovery_snapshot_calls.lock().unwrap().as_slice(),
            ["session-1"]
        );
        // 读快照算活动：不 touch 的话恢复中的会话会被 idle reaper 当死会话收掉。
        assert!(
            config.session_activity_snapshot().contains_key("session-1"),
            "读 recovery-snapshot 必须刷新会话活跃时间"
        );
    }

    /// 404 必须带结构化 `code=NOT_FOUND`。这是 app 侧区分「会话真没了」与
    /// 「旧 daemon 缺这条路由」的**唯一**信号：裸 404 会被判成
    /// CHECKPOINT_UNSUPPORTED，把一次正常的会话消失升级成永久能力关断。
    #[tokio::test]
    async fn recovery_snapshot_missing_session_is_404_with_structured_code() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18099", backend);

        let response = router(config)
            .oneshot(recovery_snapshot_request("session-nope", true))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(
            body["code"], "NOT_FOUND",
            "裸 404 会被 app 侧误判成旧 daemon 缺路由"
        );
    }

    #[tokio::test]
    async fn create_with_live_expected_session_claims_and_reuses_it_atomically() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let config = test_config("secret", "127.0.0.1:18085", backend.clone());
        install_test_provenance(&config, "/repo");

        let response = router(config.clone())
            .oneshot(expected_session_create_request(
                "session-1",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let response: CreateSessionResponse =
            serde_json::from_slice(&bytes).expect("create response");
        assert_eq!(response.session_id, "session-1");
        assert_eq!(
            backend.created.lock().unwrap().len(),
            1,
            "must not spawn a resume PTY"
        );
        assert_eq!(
            config.session_claim_owner("session-1").as_deref(),
            Some("inst-new")
        );
    }

    #[tokio::test]
    async fn missing_expected_session_creates_only_one_replacement_across_requests() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18089", backend.clone());

        let first = router(config.clone())
            .oneshot(expected_session_create_request(
                "missing-session",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("first response");
        assert_eq!(first.status(), StatusCode::CREATED);
        let first: CreateSessionResponse = serde_json::from_slice(
            &to_bytes(first.into_body(), usize::MAX)
                .await
                .expect("first body"),
        )
        .expect("first create response");
        assert_eq!(first.session_id, "session-1");
        assert!(!first.reused_existing);

        let second = router(config.clone())
            .oneshot(expected_session_create_request(
                "missing-session",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("second response");
        assert_eq!(second.status(), StatusCode::CREATED);
        let second: CreateSessionResponse = serde_json::from_slice(
            &to_bytes(second.into_body(), usize::MAX)
                .await
                .expect("second body"),
        )
        .expect("second create response");
        assert_eq!(second.session_id, "session-1");
        assert!(second.reused_existing);
        assert_eq!(backend.created.lock().unwrap().len(), 1);

        let conflict = router(config)
            .oneshot(expected_session_create_request(
                "missing-session",
                "inst-other",
                "/repo",
            ))
            .await
            .expect("conflict response");
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(backend.created.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_with_live_expected_session_fails_closed_on_claim_conflict() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let config = test_config("secret", "127.0.0.1:18086", backend.clone());
        install_test_provenance(&config, "/repo");
        config
            .try_claim_session("session-1", "inst-other", None)
            .expect("initial claim");

        let response = router(config)
            .oneshot(expected_session_create_request(
                "session-1",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            backend.created.lock().unwrap().len(),
            1,
            "must not spawn after conflict"
        );
    }

    #[tokio::test]
    async fn create_with_live_expected_session_fails_closed_without_provenance() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let config = test_config("secret", "127.0.0.1:18087", backend.clone());

        let response = router(config)
            .oneshot(expected_session_create_request(
                "session-1",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            backend.created.lock().unwrap().len(),
            1,
            "must not spawn without evidence"
        );
    }

    #[tokio::test]
    async fn create_with_live_expected_session_fails_closed_on_identity_mismatch() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let config = test_config("secret", "127.0.0.1:18088", backend.clone());
        install_test_provenance(&config, "/different-repo");

        let response = router(config)
            .oneshot(expected_session_create_request(
                "session-1",
                "inst-new",
                "/repo",
            ))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            backend.created.lock().unwrap().len(),
            1,
            "must not spawn on mismatch"
        );
    }

    // ===== 会话写权限租约（docs/61 阶段 2）=====

    fn write_request(session: &str, instance: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/api/sessions/{session}/write"))
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(instance) = instance {
            builder = builder.header(INSTANCE_HEADER, instance);
        }
        builder
            .body(Body::from(r#"{"data":"hi"}"#))
            .expect("request")
    }

    fn claim_request(session: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/sessions/{session}/claim"))
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("request")
    }

    /// 向后兼容的核心不变式：没有任何实例 claim 过的会话，写入照旧放行。
    /// 否则运行中的旧版客户端会在 daemon 升级瞬间全部失去输入能力。
    #[tokio::test]
    async fn unclaimed_session_accepts_anonymous_writes() {
        let backend = Arc::new(MockTerminalBackend::default());
        let app = router(test_config("secret", "127.0.0.1:18090", backend.clone()));

        let response = app
            .oneshot(write_request("s1", None))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(backend.writes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn claimed_session_rejects_writes_from_other_instances() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let config = test_config("secret", "127.0.0.1:18091", backend.clone());
        let app = router(config);

        let granted = app
            .clone()
            .oneshot(claim_request("session-1", r#"{"appInstanceId":"inst-a"}"#))
            .await
            .expect("response");
        assert_eq!(granted.status(), StatusCode::OK);

        // 持有者可以写
        let owner_write = app
            .clone()
            .oneshot(write_request("session-1", Some("inst-a")))
            .await
            .expect("response");
        assert_eq!(owner_write.status(), StatusCode::NO_CONTENT);

        // 别的实例被挡
        let other_write = app
            .clone()
            .oneshot(write_request("session-1", Some("inst-b")))
            .await
            .expect("response");
        assert_eq!(other_write.status(), StatusCode::CONFLICT);

        // 匿名调用方在有租约时同样被挡
        let anonymous_write = app
            .oneshot(write_request("session-1", None))
            .await
            .expect("response");
        assert_eq!(anonymous_write.status(), StatusCode::CONFLICT);

        assert_eq!(
            backend.writes.lock().unwrap().len(),
            1,
            "只应有持有者的那一次写入"
        );
    }

    #[tokio::test]
    async fn second_instance_cannot_steal_a_live_claim() {
        let backend = Arc::new(MockTerminalBackend::default());
        mark_session_live(&backend);
        let app = router(test_config("secret", "127.0.0.1:18092", backend));

        let first = app
            .clone()
            .oneshot(claim_request("session-1", r#"{"appInstanceId":"inst-a"}"#))
            .await
            .expect("response");
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .clone()
            .oneshot(claim_request("session-1", r#"{"appInstanceId":"inst-b"}"#))
            .await
            .expect("response");
        assert_eq!(second.status(), StatusCode::CONFLICT);

        // 同一持有者重复 claim = 续租，幂等
        let renew = app
            .oneshot(claim_request("session-1", r#"{"appInstanceId":"inst-a"}"#))
            .await
            .expect("response");
        assert_eq!(renew.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn nonexistent_session_cannot_be_claimed() {
        let backend = Arc::new(MockTerminalBackend::default());
        let app = router(test_config("secret", "127.0.0.1:18093", backend));

        let response = app
            .oneshot(claim_request(
                "missing-session",
                r#"{"appInstanceId":"inst-a"}"#,
            ))
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn expired_claim_frees_the_session() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18093", backend);

        // TTL 会被 clamp 到下限 5s，所以直接构造一条已过期的租约验证判定逻辑
        config
            .try_claim_session("s1", "inst-a", Some(CLAIM_TTL_MIN_MS))
            .expect("claim granted");
        assert_eq!(config.session_claim_owner("s1").as_deref(), Some("inst-a"));
        assert!(!config.may_write_session("s1", Some("inst-b")));

        config.inner.session_claims.write().insert(
            "s1".to_string(),
            SessionClaim {
                owner: "inst-a".to_string(),
                expires_at: Instant::now() - Duration::from_secs(1),
            },
        );

        assert_eq!(config.session_claim_owner("s1"), None, "过期租约不算持有");
        assert!(
            config.may_write_session("s1", Some("inst-b")),
            "过期后任何实例都能接手"
        );
        assert!(config.live_session_claims().is_empty());
    }

    #[test]
    fn claim_ttl_is_clamped() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18094", backend);

        let too_short = config
            .try_claim_session("s1", "inst-a", Some(1))
            .expect("claim");
        let too_long = config
            .try_claim_session("s2", "inst-a", Some(u64::MAX))
            .expect("claim");

        let now = Instant::now();
        assert!(too_short.expires_at >= now + Duration::from_millis(CLAIM_TTL_MIN_MS / 2));
        assert!(too_long.expires_at <= now + Duration::from_millis(CLAIM_TTL_MAX_MS));
    }

    #[test]
    fn session_teardown_drops_the_claim() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18095", backend);

        config
            .try_claim_session("s1", "inst-a", None)
            .expect("claim");
        config.remove_session_activity("s1");

        assert_eq!(config.session_claim_owner("s1"), None);
        assert!(config.live_session_claims().is_empty());
    }

    #[test]
    fn only_the_owner_can_release() {
        let backend = Arc::new(MockTerminalBackend::default());
        let config = test_config("secret", "127.0.0.1:18096", backend);

        config
            .try_claim_session("s1", "inst-a", None)
            .expect("claim");

        assert!(!config.release_session_claim("s1", "inst-b"));
        assert_eq!(config.session_claim_owner("s1").as_deref(), Some("inst-a"));
        assert!(config.release_session_claim("s1", "inst-a"));
        assert_eq!(config.session_claim_owner("s1"), None);
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
    async fn health_reports_identity_matching_manifest_generation() {
        let config = test_config(
            "secret",
            "127.0.0.1:18082",
            Arc::new(MockTerminalBackend::default()),
        );
        let expected_started_at = config.inner.started_at;
        let response = router(config)
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let health: HealthResponse = serde_json::from_slice(&bytes).expect("health");
        assert_eq!(health.service, "cc-panes-daemon");
        assert_eq!(health.pid, std::process::id());
        assert_eq!(health.started_at, expected_started_at);
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
        *backend.resolved_model_id.lock().unwrap() = Some("provider-default".to_string());
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
            response.resolved_model_id.as_deref(),
            Some("provider-default")
        );
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
