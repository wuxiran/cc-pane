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
];

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
        settings.remote_read_only,
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

#[derive(Default)]
pub struct WebAuthStore {
    sessions: Mutex<HashMap<String, Instant>>,
}

impl WebAuthStore {
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
    let authenticated = !settings.auth_required()
        || session_from_request(&request).is_some_and(|token| {
            state
                .web_auth
                .validate_session(&token, idle_timeout(&settings))
        });
    let auth_required = settings.auth_required();
    let password_configured = settings.password_configured();
    // /api/auth/status 在免鉴权组，access_control 不经过它——这里独立分类来源
    let remote_ip = request
        .extensions()
        .get::<axum::extract::connect_info::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let origin = classify_origin(remote_ip, request.headers());
    let read_only = settings.remote_read_only && origin == RequestOrigin::Remote;

    Json(AuthStatus {
        auth_required,
        authenticated,
        username: settings.username,
        password_configured,
        allow_lan: settings.allow_lan,
        lock_on_idle_minutes: settings.lock_on_idle_minutes,
        read_only,
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

fn idle_timeout(settings: &cc_panes_core::models::settings::WebAccessSettings) -> Option<Duration> {
    (settings.lock_on_idle_minutes > 0)
        .then(|| Duration::from_secs(u64::from(settings.lock_on_idle_minutes) * 60))
}

fn remote_allowed(
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

fn session_from_request(request: &Request<Body>) -> Option<String> {
    let cookie = request.headers().get(header::COOKIE)?.to_str().ok()?;
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
