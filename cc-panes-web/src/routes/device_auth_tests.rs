//! 设备令牌鉴权（docs/111-multi-device.md）。
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, Request, StatusCode},
};
use cc_panes_core::services::DeviceTokenService;
use tower::util::ServiceExt;

use crate::web_auth::WebAuthStore;

fn headless_state(name: &str) -> (crate::state::AppState, Arc<DeviceTokenService>) {
    let mut state = super::test_state(name);
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir(name)));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), true));
    (state, tokens)
}

fn request(uri: &str, bearer: Option<&str>, peer: [u8; 4]) -> Request<Body> {
    let mut builder = Request::builder().uri(uri);
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::empty()).expect("request");
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(IpAddr::from(peer), 40000)));
    request
}

#[tokio::test]
async fn require_token_rejects_loopback_without_credentials() {
    let (state, _) = headless_state("dev-loopback");
    let app = super::super::build_router(state);
    let response = app
        .oneshot(request("/api/settings", None, [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_device_token_is_accepted_and_revocation_is_immediate() {
    let (state, tokens) = headless_state("dev-valid");
    let (record, token) = tokens.create("laptop").expect("token");
    let app = super::super::build_router(state);

    let response = app
        .clone()
        .oneshot(request("/api/settings", Some(&token), [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);

    tokens.revoke(&record.id).expect("revoke");
    let response = app
        .oneshot(request("/api/settings", Some(&token), [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_bearer_does_not_fall_back_to_open_access() {
    // 不开 require_token 时回环默认放行；但带了错误令牌必须 401，不能悄悄当本人处理。
    let mut state = super::test_state("dev-invalid");
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir(
        "dev-invalid",
    )));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens, false));
    let app = super::super::build_router(state);
    let response = app
        .clone()
        .oneshot(request(
            "/api/settings",
            Some("ccp_dev_bogus"),
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .oneshot(request("/api/settings", None, [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn device_token_from_lan_requires_allow_lan() {
    // 非 token-only 服务（桌面端自带的 web 服务）：局域网设备令牌需打开 allow_lan
    let mut state = super::test_state("dev-lan");
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir("dev-lan")));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), false));
    let (_, token) = tokens.create("desk").expect("token");
    let app = super::super::build_router(state.clone());
    let response = app
        .clone()
        .oneshot(request("/api/settings", Some(&token), [192, 168, 1, 20]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let mut settings = state.settings_service.get_settings();
    settings.web_access.allow_lan = true;
    state
        .settings_service
        .update_settings(settings)
        .expect("allow lan");
    let response = app
        .oneshot(request("/api/settings", Some(&token), [192, 168, 1, 20]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn device_token_bypasses_remote_read_only() {
    let (state, tokens) = headless_state("dev-ro");
    let (_, token) = tokens.create("desk").expect("token");
    let mut settings = state.settings_service.get_settings();
    settings.web_access.allow_lan = true;
    settings.web_access.remote_read_only = true;
    state
        .settings_service
        .update_settings(settings)
        .expect("settings");
    let app = super::super::build_router(state);
    let mut req = Request::builder()
        .uri("/api/auth/status")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("request");
    req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::from([192, 168, 1, 20]),
        1,
    )));
    let response = app.oneshot(req).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let json: serde_json::Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["readOnly"], false);
}

#[tokio::test]
async fn token_only_server_accepts_device_token_from_lan_but_honors_whitelist() {
    let (state, tokens) = headless_state("dev-token-only-lan");
    let (_, token) = tokens.create("desk").expect("token");
    let app = super::super::build_router(state.clone());
    let response = app
        .clone()
        .oneshot(request("/api/settings", Some(&token), [172, 17, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut settings = state.settings_service.get_settings();
    settings.web_access.ip_whitelist = vec!["10.0.0.5".to_string()];
    state
        .settings_service
        .update_settings(settings)
        .expect("whitelist");
    let response = app
        .oneshot(request("/api/settings", Some(&token), [172, 17, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn query_token_is_accepted_only_on_websocket_paths() {
    let (state, tokens) = headless_state("dev-ws-query");
    let (_, token) = tokens.create("desk").expect("token");
    let app = super::super::build_router(state);

    // WS 路径：令牌通过鉴权（没有 Upgrade 头，所以由 WS 提取器拒绝，但不是 401）
    let response = app
        .clone()
        .oneshot(request(
            &format!("/ws/session-1?token={token}"),
            None,
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);

    let response = app
        .clone()
        .oneshot(request(
            "/ws/session-1?token=ccp_dev_bogus",
            None,
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 非 WS 路径不接受查询参数里的令牌
    let response = app
        .oneshot(request(
            &format!("/api/settings?token={token}"),
            None,
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_is_public_even_in_token_only_mode() {
    let (state, _) = headless_state("dev-health");
    let app = super::super::build_router(state);
    let response = app
        .oneshot(request("/api/health", None, [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
