use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use cc_panes_core::models::settings::WebAccessSettings;
use cc_panes_core::services::DeviceTokenService;
use std::sync::Arc;

use crate::state::AppState;

const SESSION_COOKIE: &str = "ccp_web_session";
const SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 7);

/// 桌面端（拉起本进程的 CC-Panes）用来管理网页登录会话的控制令牌，经环境变量下发、
/// 启动时立即从环境里删掉（不让本进程派生的终端继承）。
pub const CONTROL_TOKEN_ENV: &str = "CCPANES_WEB_CONTROL_TOKEN";
pub const CONTROL_TOKEN_HEADER: &str = "x-ccpanes-control-token";
static CONTROL_TOKEN: OnceLock<String> = OnceLock::new();

/// 在 `main()` 里、tokio runtime 起来之前（单线程）调用：读取并清除控制令牌环境变量。
pub fn install_control_token_from_env() {
    if let Ok(token) = std::env::var(CONTROL_TOKEN_ENV) {
        std::env::remove_var(CONTROL_TOKEN_ENV);
        let token = token.trim().to_string();
        if token.len() >= 32 {
            let _ = CONTROL_TOKEN.set(token);
        }
    }
}

/// 测试用：安装控制令牌（进程级，只能设一次；重复设同值无副作用）。
#[cfg(test)]
pub fn install_control_token_for_test(token: &str) {
    let _ = CONTROL_TOKEN.set(token.to_string());
}

/// 控制令牌只能用于网页会话管理接口，不是通用凭据。
fn control_path_allowed(path: &str) -> bool {
    path == "/api/auth/sessions"
        || path.starts_with("/api/auth/sessions/")
        || path == "/api/auth/revoke-others"
}

fn control_token_matches(candidate: &str) -> bool {
    CONTROL_TOKEN.get().is_some_and(|expected| {
        cc_panes_core::services::device_token_service::constant_time_eq(
            expected.as_bytes(),
            candidate.trim().as_bytes(),
        )
    })
}

/// 由控制令牌鉴权的请求（桌面端）：不对应任何网页会话或设备令牌。
#[derive(Debug, Clone, Copy)]
pub struct ControlAuth;

/// 一个网页登录会话。键是 cookie 明文，对外只暴露它的 SHA-256。
struct WebSession {
    last_seen: Instant,
    created_at: chrono::DateTime<chrono::Utc>,
    last_activity_at: chrono::DateTime<chrono::Utc>,
    ip: Option<String>,
    user_agent: Option<String>,
}

impl WebSession {
    fn new(ip: Option<String>, user_agent: Option<String>) -> Self {
        let now = chrono::Utc::now();
        Self {
            last_seen: Instant::now(),
            created_at: now,
            last_activity_at: now,
            ip,
            user_agent,
        }
    }
}

/// 会话列表条目（不含 cookie 明文）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionInfo {
    /// cookie 的 SHA-256（十六进制）：可用来吊销，不能用来登录。
    pub id: String,
    pub created_at: String,
    pub last_activity_at: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// 是否是发起本次请求的会话
    pub current: bool,
}

fn session_id(token: &str) -> String {
    cc_panes_core::services::device_token_service::sha256_hex(token)
}

/// 请求来源分类（access_control 中间件写入 request extensions）。
///
/// Tailscale Serve 等本机反向代理会把远程流量转成回环源 IP，
/// 因此回环 + 代理转发头（x-forwarded-for / tailscale-user-login）也判 Remote。
/// 本机进程伪造 XFF 只会把自己降级为只读，方向 fail-safe。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestOrigin {
    Local,
    Remote,
}

pub fn classify_origin(remote_ip: Option<IpAddr>, headers: &HeaderMap) -> RequestOrigin {
    let loopback = remote_ip.is_some_and(|ip| ip.is_loopback());
    if !loopback {
        return RequestOrigin::Remote;
    }
    let proxied =
        headers.contains_key("x-forwarded-for") || headers.contains_key("tailscale-user-login");
    if proxied {
        RequestOrigin::Remote
    } else {
        RequestOrigin::Local
    }
}

/// 远程只读模式下仍放行的查询型 POST 路由（body 承载查询条件、无副作用；
/// 其余非 GET/HEAD 一律拒绝）。auth 登录/登出在免鉴权组，不经过本守卫。
const READ_ONLY_POST_ALLOWLIST: &[&str] = &[
    "/api/todos/query",
    "/api/task-bindings/query",
    "/api/memories/search",
    "/api/memories/format",
    "/api/runner/ports/conflicts",
    "/api/launch-profiles/preview",
    "/api/workspace-migrations/preview",
    "/api/project-migrations/preview",
    "/api/terminal/path-link/resolve",
];

/// 本请求来源在当前设置下是否应被限制为只读。
///
/// `remote_authenticated_write` 是远程只读的例外：开启后，已通过密码鉴权的
/// 远程会话恢复写权限。仅在 `auth_required()` 为真时生效——未配置密码时
/// 不放行任何远程写入（fail-safe）。调用方须保证请求已过 access_control
/// 鉴权（protected 组），未鉴权路径不适用本函数。
pub fn effective_read_only(
    origin: RequestOrigin,
    settings: &cc_panes_core::models::settings::WebAccessSettings,
) -> bool {
    origin == RequestOrigin::Remote
        && settings.remote_read_only
        && !(settings.remote_authenticated_write && settings.auth_required())
}

pub fn read_only_denies(
    origin: RequestOrigin,
    remote_read_only: bool,
    method: &Method,
    path: &str,
) -> bool {
    if !remote_read_only || origin == RequestOrigin::Local {
        return false;
    }
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return false;
    }
    !(*method == Method::POST && READ_ONLY_POST_ALLOWLIST.contains(&path))
}

/// 远程只读守卫：置于 access_control 之后（依赖其写入的 RequestOrigin extension）。
pub async fn read_only_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let settings = state.settings_service.get_settings().web_access;
    let origin = request
        .extensions()
        .get::<RequestOrigin>()
        .copied()
        .unwrap_or(RequestOrigin::Remote);
    if read_only_denies(
        origin,
        effective_read_only(origin, &settings),
        request.method(),
        request.uri().path(),
    ) {
        return json_error(
            StatusCode::FORBIDDEN,
            "READ_ONLY",
            "Remote read-only mode is enabled; write operations are not allowed",
        );
    }
    next.run(request).await
}

pub struct WebAuthStore {
    revocations: tokio::sync::watch::Sender<u64>,
    sessions: Mutex<HashMap<String, WebSession>>,
    /// 其他 CC-Panes 设备的 Bearer 令牌（docs/111-multi-device.md）
    device_tokens: Option<Arc<DeviceTokenService>>,
    /// headless / `--require-token`：未配置密码时也不放行任何未鉴权请求（含回环）。
    /// SSH 隧道进来的流量在本机看来是 127.0.0.1，默认的"回环即本人"假设不成立。
    require_auth: bool,
}

impl Default for WebAuthStore {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            revocations: tokio::sync::watch::channel(0).0,
            device_tokens: None,
            require_auth: false,
        }
    }
}

impl WebAuthStore {
    pub fn with_device_tokens(device_tokens: Arc<DeviceTokenService>, require_auth: bool) -> Self {
        Self {
            device_tokens: Some(device_tokens),
            require_auth,
            ..Self::default()
        }
    }

    pub fn require_auth(&self) -> bool {
        self.require_auth
    }

    pub fn device_tokens(&self) -> Option<&Arc<DeviceTokenService>> {
        self.device_tokens.as_ref()
    }

    /// 校验设备令牌。每次都按文件状态判断，吊销后下一个请求即失效。
    pub fn verify_device_token(&self, token: &str) -> bool {
        self.device_tokens
            .as_ref()
            .is_some_and(|tokens| tokens.verify(token).is_some())
    }

    /// 校验设备令牌并记录最后在线时间 / IP（节流落盘，见 `DeviceTokenService::touch`）。
    pub fn verify_device_token_from(&self, token: &str, ip: Option<IpAddr>) -> bool {
        let ip = ip.map(|ip| ip.to_string());
        self.device_tokens
            .as_ref()
            .is_some_and(|tokens| tokens.verify_and_touch(token, ip.as_deref()).is_some())
    }

    /// 未配置密码时，是否仍需拒绝未鉴权请求。
    fn locked_without_password(&self, settings: &WebAccessSettings) -> bool {
        self.require_auth && !settings.auth_required()
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.revocations.subscribe()
    }

    pub fn session_is_valid(&self, token: &str, idle_timeout: Option<Duration>) -> bool {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(token).is_some_and(|session| {
            let age = session.last_seen.elapsed();
            age <= SESSION_TTL && idle_timeout.is_none_or(|limit| age <= limit)
        })
    }

    #[cfg(test)]
    pub fn create_session(&self) -> String {
        self.create_session_with(None, None)
    }

    /// 登录成功时建会话，记下来源 IP 与 User-Agent 供「网页登录会话」列表展示。
    pub fn create_session_with(&self, ip: Option<String>, user_agent: Option<String>) -> String {
        let token = generate_token();
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(token.clone(), WebSession::new(ip, user_agent));
        token
    }

    /// 仍有效的会话（TTL 与闲置锁定都未到期），按最近活动倒序。
    pub fn list_sessions(
        &self,
        current: Option<&str>,
        idle_timeout: Option<Duration>,
    ) -> Vec<WebSessionInfo> {
        let sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let mut list: Vec<WebSessionInfo> = sessions
            .iter()
            .filter(|(_, session)| {
                let age = session.last_seen.elapsed();
                age <= SESSION_TTL && idle_timeout.is_none_or(|limit| age <= limit)
            })
            .map(|(token, session)| WebSessionInfo {
                id: session_id(token),
                created_at: session.created_at.to_rfc3339(),
                last_activity_at: session.last_activity_at.to_rfc3339(),
                ip: session.ip.clone(),
                user_agent: session.user_agent.clone(),
                current: current == Some(token.as_str()),
            })
            .collect();
        list.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
        list
    }

    /// 按 id（cookie 的 SHA-256）吊销一个会话；返回是否找到。
    pub fn revoke_session_by_id(&self, id: &str) -> bool {
        let removed = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
            let before = sessions.len();
            sessions.retain(|token, _| session_id(token) != id);
            before != sessions.len()
        };
        if removed {
            self.notify_revocation();
        }
        removed
    }

    /// 吊销除 `keep` 以外的全部会话，返回吊销数量。
    pub fn revoke_sessions_except(&self, keep: Option<&str>) -> usize {
        let removed = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
            let before = sessions.len();
            sessions.retain(|token, _| Some(token.as_str()) == keep);
            before - sessions.len()
        };
        if removed > 0 {
            self.notify_revocation();
        }
        removed
    }

    fn notify_revocation(&self) {
        self.revocations
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    pub fn validate_session(&self, token: &str, idle_timeout: Option<Duration>) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let now = Instant::now();
        sessions.retain(|_, session| now.duration_since(session.last_seen) <= SESSION_TTL);

        let Some(session) = sessions.get_mut(token) else {
            return false;
        };

        if idle_timeout.is_some_and(|timeout| now.duration_since(session.last_seen) > timeout) {
            sessions.remove(token);
            return false;
        }

        session.last_seen = now;
        session.last_activity_at = chrono::Utc::now();
        true
    }

    pub fn revoke_session(&self, token: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(token);
        self.notify_revocation();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub auth_required: bool,
    pub authenticated: bool,
    pub username: String,
    pub password_configured: bool,
    pub allow_lan: bool,
    pub lock_on_idle_minutes: u16,
    /// 本请求来源在远程只读模式下是否被限制为只读
    pub read_only: bool,
    /// 远程只读模式下是否放行已鉴权远程会话的写入（设置回显）
    pub remote_authenticated_write: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub authenticated: bool,
}

pub async fn status(State(state): State<AppState>, request: Request<Body>) -> Json<AuthStatus> {
    let settings = state.settings_service.get_settings().web_access;
    let device_authenticated = bearer_from_headers(request.headers())
        .is_some_and(|token| state.web_auth.verify_device_token(&token));
    let auth_required =
        settings.auth_required() || state.web_auth.locked_without_password(&settings);
    let authenticated = device_authenticated
        || !auth_required
        || session_from_request(&request).is_some_and(|token| {
            state
                .web_auth
                .validate_session(&token, idle_timeout(&settings))
        });
    let password_configured = settings.password_configured();
    // /api/auth/status 在免鉴权组，access_control 不经过它——这里独立分类来源
    let remote_ip = request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let origin = classify_origin(remote_ip, request.headers());
    // status 在免鉴权组，effective_read_only 的"已鉴权"前提在这里需显式核对：
    // 未登录的远程请求即使开了 remote_authenticated_write 也如实报告只读。
    let read_only = !device_authenticated
        && (effective_read_only(origin, &settings)
            || (settings.remote_read_only && origin == RequestOrigin::Remote && !authenticated));

    Json(AuthStatus {
        auth_required,
        authenticated,
        username: settings.username,
        password_configured,
        allow_lan: settings.allow_lan,
        lock_on_idle_minutes: settings.lock_on_idle_minutes,
        read_only,
        remote_authenticated_write: settings.remote_authenticated_write,
    })
}

pub async fn login(
    State(state): State<AppState>,
    connect_info: Option<axum::Extension<axum::extract::ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Response {
    let settings = state.settings_service.get_settings().web_access;
    if !settings.auth_required() {
        return Json(LoginResponse {
            authenticated: true,
        })
        .into_response();
    }

    let username_matches = request.username.trim() == settings.username;
    if !username_matches || !settings.verify_password(&request.password) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid username or password",
        );
    }

    let peer = connect_info.map(|axum::Extension(info)| info.0.ip());
    let ip = client_ip(peer, &headers).map(|ip| ip.to_string());
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(256).collect::<String>());
    let token = state.web_auth.create_session_with(ip, user_agent);
    let mut response = Json(LoginResponse {
        authenticated: true,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
            SESSION_TTL.as_secs()
        ))
        .expect("valid cookie header"),
    );
    response
}

pub async fn logout(State(state): State<AppState>, request: Request<Body>) -> Response {
    if let Some(token) = session_from_request(&request) {
        state.web_auth.revoke_session(&token);
    }

    let mut response = Json(serde_json::json!({ "locked": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("ccp_web_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    response
}

pub async fn access_control(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let settings = state.settings_service.get_settings().web_access;

    let remote_ip = request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());

    // 控制令牌：只认本机直连（回环且无代理转发头）的桌面端，只放行会话管理接口。
    if let Some(candidate) = request
        .headers()
        .get(CONTROL_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        let direct_local = remote_ip.is_some_and(|ip| ip.is_loopback())
            && classify_origin(remote_ip, request.headers()) == RequestOrigin::Local;
        if !direct_local
            || !control_path_allowed(request.uri().path())
            || !control_token_matches(candidate)
        {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "INVALID_CONTROL_TOKEN",
                "Control token is invalid or not allowed here",
            );
        }
        request.extensions_mut().insert(RequestOrigin::Local);
        request.extensions_mut().insert(ControlAuth);
        return next.run(request).await;
    }

    // 设备令牌：已配对的 CC-Panes 设备视同本机主人（不受远程只读限制），
    // 但仍受局域网开关和 IP 白名单约束。带了 Bearer 却无效时直接拒绝，不回落到 cookie。
    if let Some(token) = device_token_from_request(&request) {
        let peer = client_ip(remote_ip, request.headers());
        if !state.web_auth.verify_device_token_from(&token, peer) {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "INVALID_DEVICE_TOKEN",
                "Device token is invalid or has been revoked",
            );
        }
        if remote_ip
            .is_some_and(|ip| !device_peer_allowed(ip, &settings, state.web_auth.require_auth()))
        {
            return json_error(
                StatusCode::FORBIDDEN,
                "REMOTE_FORBIDDEN",
                "Remote access is not allowed by Web access settings",
            );
        }
        request.extensions_mut().insert(RequestOrigin::Local);
        request.extensions_mut().insert(DeviceTokenAuth(token));
        return next.run(request).await;
    }

    if let Some(ip) = remote_ip {
        if !remote_allowed(ip, &settings) {
            return json_error(
                StatusCode::FORBIDDEN,
                "REMOTE_FORBIDDEN",
                "Remote access is not allowed by Web access settings",
            );
        }
    }
    let origin = classify_origin(remote_ip, request.headers());
    request.extensions_mut().insert(origin);

    if !settings.auth_required() {
        if state.web_auth.locked_without_password(&settings) {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "This server requires a device token",
            );
        }
        return next.run(request).await;
    }

    let authenticated = session_from_request(&request).is_some_and(|token| {
        state
            .web_auth
            .validate_session(&token, idle_timeout(&settings))
    });

    if authenticated {
        next.run(request).await
    } else {
        json_error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Web session is locked or not authenticated",
        )
    }
}

/// 展示用的客户端 IP：回环且带 `x-forwarded-for`（Tailscale Serve 等本机反代）时取转发头的
/// 第一个地址，否则取对端地址。只用于展示，不参与任何鉴权判断。
pub(crate) fn client_ip(peer: Option<IpAddr>, headers: &HeaderMap) -> Option<IpAddr> {
    if peer.is_some_and(|ip| ip.is_loopback()) {
        let forwarded = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .and_then(|value| value.trim().parse::<IpAddr>().ok());
        if forwarded.is_some() {
            return forwarded;
        }
    }
    peer
}

pub(crate) fn idle_timeout(
    settings: &cc_panes_core::models::settings::WebAccessSettings,
) -> Option<Duration> {
    (settings.lock_on_idle_minutes > 0)
        .then(|| Duration::from_secs(u64::from(settings.lock_on_idle_minutes) * 60))
}

pub(crate) fn remote_allowed(
    ip: IpAddr,
    settings: &cc_panes_core::models::settings::WebAccessSettings,
) -> bool {
    if ip.is_loopback() {
        return true;
    }
    if !settings.allow_lan || !settings.auth_required() {
        return false;
    }
    if settings.ip_whitelist.is_empty() {
        return true;
    }
    settings
        .ip_whitelist
        .iter()
        .filter_map(|value| value.parse::<IpAddr>().ok())
        .any(|allowed| allowed == ip)
}

/// 设备令牌允许的对端：回环（含 SSH 隧道）始终放行；非回环需打开 allow_lan
/// （或服务以 `--require-token` 启动——运营者已显式选择"只认凭据"，如 Docker 里
/// 对端总是网桥地址），有白名单时还要命中白名单。与 `remote_allowed` 不同，
/// 这里不要求配置了密码——设备令牌本身就是凭据。
pub(crate) fn device_peer_allowed(
    ip: IpAddr,
    settings: &WebAccessSettings,
    token_only_server: bool,
) -> bool {
    if ip.is_loopback() {
        return true;
    }
    if !settings.allow_lan && !settings.allow_devices && !token_only_server {
        return false;
    }
    settings.ip_whitelist.is_empty()
        || settings
            .ip_whitelist
            .iter()
            .filter_map(|value| value.parse::<IpAddr>().ok())
            .any(|allowed| allowed == ip)
}

/// 已通过校验的设备令牌，供 WebSocket 处理器在连接存续期间反复核验（吊销即断开）。
#[derive(Debug, Clone)]
pub struct DeviceTokenAuth(pub String);

/// 设备令牌来源：`Authorization: Bearer`，或仅对 `/ws/` 路径的 `?token=`
/// （WebSocket 客户端——包括把本服务当 daemon 用的 `TerminalDaemonClient`——
/// 不方便设置请求头）。查询参数只接受 `ccp_dev_` 前缀，不会和 cookie 会话混淆。
pub(crate) fn carries_device_credential(request: &Request<Body>) -> bool {
    device_token_from_request(request).is_some_and(|token| {
        token.starts_with(cc_panes_core::services::device_token_service::DEVICE_TOKEN_PREFIX)
    })
}

fn device_token_from_request(request: &Request<Body>) -> Option<String> {
    if let Some(token) = bearer_from_headers(request.headers()) {
        return Some(token);
    }
    if !request.uri().path().starts_with("/ws/") {
        return None;
    }
    request.uri().query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key != "token" {
            return None;
        }
        let value = urlencoding::decode(value).ok()?.into_owned();
        value
            .starts_with(cc_panes_core::services::device_token_service::DEVICE_TOKEN_PREFIX)
            .then_some(value)
    })
}

pub(crate) fn bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

pub(crate) fn session_from_request(request: &Request<Body>) -> Option<String> {
    session_from_headers(request.headers())
}

pub(crate) fn session_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE && !value.is_empty()).then(|| value.to_string())
    })
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "code": code,
            "message": message,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use cc_panes_core::models::settings::WebAccessSettings;

    use super::*;

    #[test]
    fn remote_access_requires_lan_and_auth() {
        let mut settings = WebAccessSettings {
            allow_lan: true,
            auth_enabled: true,
            ..WebAccessSettings::default()
        };
        assert!(!remote_allowed("192.168.1.10".parse().unwrap(), &settings));

        settings.password_salt = Some("00".into());
        settings.password_hash = Some("hash".into());
        assert!(remote_allowed("192.168.1.10".parse().unwrap(), &settings));
    }

    #[test]
    fn classify_origin_loopback_without_proxy_headers_is_local() {
        let headers = HeaderMap::new();
        assert_eq!(
            classify_origin(Some("127.0.0.1".parse().unwrap()), &headers),
            RequestOrigin::Local
        );
    }

    #[test]
    fn classify_origin_non_loopback_is_remote() {
        let headers = HeaderMap::new();
        assert_eq!(
            classify_origin(Some("192.168.1.10".parse().unwrap()), &headers),
            RequestOrigin::Remote
        );
        // 拿不到源地址按 Remote 保守处理
        assert_eq!(classify_origin(None, &headers), RequestOrigin::Remote);
    }

    #[test]
    fn classify_origin_loopback_with_proxy_headers_is_remote() {
        for header_name in ["x-forwarded-for", "tailscale-user-login"] {
            let mut headers = HeaderMap::new();
            headers.insert(header_name, HeaderValue::from_static("100.64.0.5"));
            assert_eq!(
                classify_origin(Some("127.0.0.1".parse().unwrap()), &headers),
                RequestOrigin::Remote,
                "header {header_name} should mark request as remote"
            );
        }
    }

    #[test]
    fn read_only_denies_only_remote_writes() {
        // 未开只读：全放行
        assert!(!read_only_denies(
            RequestOrigin::Remote,
            false,
            &Method::POST,
            "/api/sessions/x/write"
        ));
        // 本机来源：全放行
        assert!(!read_only_denies(
            RequestOrigin::Local,
            true,
            &Method::DELETE,
            "/api/sessions/x"
        ));
        // 远程 + 只读：GET 放行、写拒绝
        assert!(!read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::GET,
            "/api/sessions"
        ));
        assert!(read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::POST,
            "/api/sessions/x/write"
        ));
        assert!(read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::DELETE,
            "/api/fs/entry"
        ));
        // 查询型 POST 白名单放行
        assert!(!read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::POST,
            "/api/todos/query"
        ));
        assert!(!read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::POST,
            "/api/memories/search"
        ));
        assert!(!read_only_denies(
            RequestOrigin::Remote,
            true,
            &Method::POST,
            "/api/terminal/path-link/resolve"
        ));
    }

    #[test]
    fn effective_read_only_quadrants() {
        let base = WebAccessSettings::default();
        let with_password = WebAccessSettings {
            auth_enabled: true,
            password_salt: Some("00".into()),
            password_hash: Some("hash".into()),
            ..WebAccessSettings::default()
        };

        // 只读关闭：任何来源都不只读
        let settings = WebAccessSettings {
            remote_read_only: false,
            remote_authenticated_write: true,
            ..with_password.clone()
        };
        assert!(!effective_read_only(RequestOrigin::Remote, &settings));

        // 只读开启、无例外开关：远程只读，本机全权
        let settings = WebAccessSettings {
            remote_read_only: true,
            ..with_password.clone()
        };
        assert!(effective_read_only(RequestOrigin::Remote, &settings));
        assert!(!effective_read_only(RequestOrigin::Local, &settings));

        // 只读 + 例外开关 + 已配密码：已鉴权远程可写
        let settings = WebAccessSettings {
            remote_read_only: true,
            remote_authenticated_write: true,
            ..with_password
        };
        assert!(!effective_read_only(RequestOrigin::Remote, &settings));

        // 只读 + 例外开关但未配密码：开关不生效（fail-safe）
        let settings = WebAccessSettings {
            remote_read_only: true,
            remote_authenticated_write: true,
            ..base
        };
        assert!(effective_read_only(RequestOrigin::Remote, &settings));
    }

    #[test]
    fn whitelist_limits_remote_ips() {
        let settings = WebAccessSettings {
            allow_lan: true,
            auth_enabled: true,
            password_salt: Some("00".into()),
            password_hash: Some("hash".into()),
            ip_whitelist: vec!["192.168.1.20".into()],
            ..WebAccessSettings::default()
        };

        assert!(!remote_allowed("192.168.1.10".parse().unwrap(), &settings));
        assert!(remote_allowed("192.168.1.20".parse().unwrap(), &settings));
    }
}
