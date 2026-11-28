//! `POST /api/providers/export`（docs/112 §6）：只认设备令牌，响应 no-store。
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, Method, Request, StatusCode},
};
use cc_panes_core::services::DeviceTokenService;
use tower::util::ServiceExt;

use crate::web_auth::WebAuthStore;

fn state(name: &str, token_only: bool) -> (crate::state::AppState, Arc<DeviceTokenService>) {
    let mut state = super::test_state(name);
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir(name)));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), token_only));
    (state, tokens)
}

fn export_request(bearer: Option<&str>, method: Method) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri("/api/providers/export")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let mut request = builder
        .body(Body::from(r#"{"code":"123456"}"#))
        .expect("request");
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::from([127, 0, 0, 1]),
        40000,
    )));
    request
}

async fn code_of(response: axum::response::Response) -> String {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let json: serde_json::Value = serde_json::from_slice(&body).expect("json");
    json["code"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn loopback_without_device_token_is_forbidden() {
    // 回环免登录时其余接口都放行，导出密钥仍然必须带设备令牌。
    let (state, _) = state("export-loopback", false);
    let app = super::super::build_router(state);
    let response = app
        .oneshot(export_request(None, Method::POST))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    assert_eq!(code_of(response).await, "DEVICE_TOKEN_REQUIRED");
}

#[tokio::test]
async fn device_token_is_forwarded_to_desktop_host() {
    // 测试环境没有桌面 app：鉴权通过后落到转发 → 503，证明令牌这一关放行了。
    let (state, tokens) = state("export-token", true);
    let (_, token) = tokens.create("Wu's iPhone").expect("token");
    let app = super::super::build_router(state);
    let response = app
        .oneshot(export_request(Some(&token), Method::POST))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
}

#[tokio::test]
async fn invalid_device_token_is_unauthorized() {
    let (state, _) = state("export-bad", true);
    let app = super::super::build_router(state);
    let response = app
        .oneshot(export_request(Some("ccp_dev_bogus"), Method::POST))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn export_route_has_no_get() {
    let (state, tokens) = state("export-get", true);
    let (_, token) = tokens.create("phone").expect("token");
    let app = super::super::build_router(state);
    let response = app
        .oneshot(export_request(Some(&token), Method::GET))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}
