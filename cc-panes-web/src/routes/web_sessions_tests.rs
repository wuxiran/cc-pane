//! 网页登录会话列表 / 吊销 / 撤销其他全部，以及桌面端控制令牌的边界。
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, Request, StatusCode},
};
use cc_panes_core::services::DeviceTokenService;
use tower::util::ServiceExt;

use crate::web_auth::{self, WebAuthStore, CONTROL_TOKEN_HEADER};

const CONTROL_TOKEN: &str = "test-control-token-0123456789abcdef0123456789abcdef";

fn request(method: &str, uri: &str) -> axum::http::request::Builder {
    Request::builder().method(method).uri(uri)
}

fn with_peer(mut request: Request<Body>, peer: [u8; 4]) -> Request<Body> {
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(IpAddr::from(peer), 40000)));
    request
}

async fn json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

fn cookie_pair(set_cookie: &str) -> String {
    set_cookie.split(';').next().expect("cookie").to_string()
}

async fn list(app: &axum::Router, cookie: &str) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(
            request("GET", "/api/auth/sessions")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    json(response).await
}

#[tokio::test]
async fn sessions_are_listed_with_current_marked_and_can_be_revoked() {
    let state = super::test_state("web-sessions-list");
    super::enable_auth(&state);
    let app = super::super::build_router(state);
    let mine = cookie_pair(&super::login_cookie(app.clone()).await);
    let other = cookie_pair(&super::login_cookie(app.clone()).await);

    let body = list(&app, &mine).await;
    let sessions = body["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions.iter().filter(|s| s["current"] == true).count(), 1);
    // id 是 cookie 的摘要，不是 cookie 本身
    let mine_value = mine.split_once('=').unwrap().1;
    assert!(sessions
        .iter()
        .all(|s| s["id"].as_str() != Some(mine_value)));

    let other_id = sessions
        .iter()
        .find(|s| s["current"] == false)
        .and_then(|s| s["id"].as_str())
        .expect("other id")
        .to_string();
    let response = app
        .clone()
        .oneshot(
            request("DELETE", &format!("/api/auth/sessions/{other_id}"))
                .header(header::COOKIE, &mine)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);

    // 被吊销的 cookie 立即失效
    let response = app
        .clone()
        .oneshot(
            request("GET", "/api/settings")
                .header(header::COOKIE, &other)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        list(&app, &mine).await["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn revoke_others_keeps_the_calling_session() {
    let mut state = super::test_state("web-sessions-revoke-others");
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir(
        "web-sessions-revoke-others-tokens",
    )));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), false));
    super::enable_auth(&state);
    tokens.create("laptop").expect("token");
    tokens.create("desk").expect("token");
    let app = super::super::build_router(state);
    let mine = cookie_pair(&super::login_cookie(app.clone()).await);
    let _a = super::login_cookie(app.clone()).await;
    let _b = super::login_cookie(app.clone()).await;

    let response = app
        .clone()
        .oneshot(
            request("POST", "/api/auth/revoke-others")
                .header(header::COOKIE, &mine)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    assert_eq!(body["webSessions"], 2);
    assert_eq!(body["deviceTokens"], 2);
    let sessions = list(&app, &mine).await;
    let sessions = sessions["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["current"], true);
    assert!(tokens.list().is_empty());
}

#[tokio::test]
async fn revoke_others_from_a_device_keeps_that_device_token() {
    let mut state = super::test_state("web-sessions-device-caller");
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&super::test_dir(
        "web-sessions-device-caller-tokens",
    )));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), false));
    let (keep, keep_token) = tokens.create("me").expect("token");
    tokens.create("other").expect("token");
    let app = super::super::build_router(state);
    let response = app
        .oneshot(with_peer(
            request("POST", "/api/auth/revoke-others")
                .header(header::AUTHORIZATION, format!("Bearer {keep_token}"))
                .body(Body::empty())
                .expect("request"),
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["deviceTokens"], 1);
    let left = tokens.list();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, keep.id);
}

#[tokio::test]
async fn control_token_is_loopback_only_and_limited_to_session_routes() {
    web_auth::install_control_token_for_test(CONTROL_TOKEN);
    let state = super::test_state("web-sessions-control");
    super::enable_auth(&state);
    let app = super::super::build_router(state);
    let _cookie = super::login_cookie(app.clone()).await;

    let call = |uri: &str, token: &str, peer: [u8; 4]| {
        with_peer(
            request("GET", uri)
                .header(CONTROL_TOKEN_HEADER, token)
                .body(Body::empty())
                .expect("request"),
            peer,
        )
    };

    // 本机直连 + 正确令牌：可以列会话（桌面端不对应任何会话，没有 current）
    let response = app
        .clone()
        .oneshot(call("/api/auth/sessions", CONTROL_TOKEN, [127, 0, 0, 1]))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    assert_eq!(body["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(body["sessions"][0]["current"], false);

    for (uri, token, peer) in [
        ("/api/auth/sessions", "wrong", [127, 0, 0, 1]),
        ("/api/settings", CONTROL_TOKEN, [127, 0, 0, 1]),
        ("/api/auth/sessions", CONTROL_TOKEN, [192, 168, 1, 10]),
    ] {
        let response = app
            .clone()
            .oneshot(call(uri, token, peer))
            .await
            .expect("response");
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{uri} {peer:?}"
        );
    }

    // 经本机反代转发（带 x-forwarded-for）的请求不算本机直连
    let response = app
        .oneshot(with_peer(
            request("GET", "/api/auth/sessions")
                .header(CONTROL_TOKEN_HEADER, CONTROL_TOKEN)
                .header("x-forwarded-for", "100.64.0.5")
                .body(Body::empty())
                .expect("request"),
            [127, 0, 0, 1],
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
