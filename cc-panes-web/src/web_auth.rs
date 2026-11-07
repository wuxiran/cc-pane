use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
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
    sessions: Mutex<HashMap<String, Instant>>,
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

    /// 校验设备令牌。每次都按文件状态判断，吊销后下一个请求即失效。
    pub fn verify_device_token(&self, token: &str) -> bool {
        self.device_tokens
            .as_ref()
            .is_some_and(|tokens| tokens.verify(token).is_some())
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
        sessions.get(token).is_some_and(|last| {
            let age = last.elapsed();
            age <= SESSION_TTL && idle_timeout.is_none_or(|limit| age <= limit)
        })
    }

    pub fn create_session(&self) -> String {
        let token = generate_token();
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(token.clone(), Instant::now());
        token
    }

    pub fn validate_session(&self, token: &str, idle_timeout: Option<Duration>) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let now = Instant::now();
        sessions.retain(|_, last_seen| now.duration_since(*last_seen) <= SESSION_TTL);

        let Some(last_seen) = sessions.get_mut(token) else {
            return false;
        };

        if idle_timeout.is_some_and(|timeout| now.duration_since(*last_seen) > timeout) {
            sessions.remove(token);
            return false;
        }

        *last_seen = now;
        true
    }

    pub fn revoke_session(&self, token: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(token);
        self.revocations
            .send_modify(|version| *version = version.wrapping_add(1));
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

pub async fn login(State(state): State<AppState>, Json(request): Json<LoginRequest>) -> Response {
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

    let token = state.web_auth.create_session();
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

    // 设备令牌：已配对的 CC-Panes 设备视同本机主人（不受远程只读限制），
    // 但仍受局域网开关和 IP 白名单约束。带了 Bearer 却无效时直接拒绝，不回落到 cookie。
    if let Some(token) = bearer_from_headers(request.headers()) {
        if !state.web_auth.verify_device_token(&token) {
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
    if !settings.allow_lan && !token_only_server {
        return false;
    }
    settings.ip_whitelist.is_empty()
        || settings
            .ip_whitelist
            .iter()
            .filter_map(|value| value.parse::<IpAddr>().ok())
            .any(|allowed| allowed == ip)
}

pub(crate) fn bearer_from_headers(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

fn session_from_request(request: &Request<Body>) -> Option<String> {
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
