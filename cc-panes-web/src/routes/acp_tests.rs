//! `/api/acp/*` + `/ws/acp/*` 代理：鉴权（Cookie / 设备令牌）/ 只读 / 503 / 透传。
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{
        connect_info::ConnectInfo,
        ws::{Message as AxumMessage, WebSocketUpgrade},
        Path as UrlPath, RawQuery,
    },
    http::{header, HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use cc_panes_core::services::DeviceTokenService;
use futures_util::StreamExt;
use tower::util::ServiceExt;

use super::{login_cookie, remote_settings, test_dir, test_state};
use crate::routes::acp::AcpHost;
use crate::web_auth::WebAuthStore;

const TOKEN: &str = "bridge-token";

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<String>>>);

impl Seen {
    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some("Bearer bridge-token")
}

fn origin(headers: &HeaderMap) -> String {
    let raw = headers
        .get("x-ccpanes-origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");
    urlencoding::decode(raw).unwrap().into_owned()
}

/// 假 orchestrator：校验 Bearer，记录收到的请求（含来源头）。
async fn spawn_upstream() -> (String, Seen) {
    let seen = Seen::default();
    let chats_seen = seen.clone();
    let prompt_seen = seen.clone();
    let ws_seen = seen.clone();
    let app = Router::new()
        .route(
            "/acp/chats",
            get(move |headers: HeaderMap| {
                let seen = chats_seen.clone();
                async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    seen.0.lock().unwrap().push("GET /acp/chats".into());
                    Json(serde_json::json!([{"chatId":"mobile-1","origin":"mobile"}]))
                        .into_response()
                }
            }),
        )
        .route(
            "/acp/chats/{id}/prompt",
            post(
                move |headers: HeaderMap, UrlPath(id): UrlPath<String>, body: String| {
                    let seen = prompt_seen.clone();
                    async move {
                        if !authorized(&headers) {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        seen.0
                            .lock()
                            .unwrap()
                            .push(format!("POST {id} [{}] {body}", origin(&headers)));
                        Json(serde_json::json!({"promptId":"p1"})).into_response()
                    }
                },
            ),
        )
        .route(
            "/acp/ws/{id}",
            get(
                move |headers: HeaderMap,
                      UrlPath(id): UrlPath<String>,
                      RawQuery(query): RawQuery,
                      ws: WebSocketUpgrade| {
                    let seen = ws_seen.clone();
                    async move {
                        if !authorized(&headers) {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        if id == "missing" {
                            return (
                                StatusCode::NOT_FOUND,
                                Json(serde_json::json!({"code":"ACP_SESSION_NOT_FOUND","message":"x"})),
                            )
                                .into_response();
                        }
                        seen.0
                            .lock()
                            .unwrap()
                            .push(format!("WS {id} {}", query.unwrap_or_default()));
                        ws.on_upgrade(|mut socket| async move {
                            for frame in [
                                r#"{"type":"event","seq":4,"kind":"brand_new_kind","payload":{"z":1}}"#,
                                r#"{"type":"synchronized","lastSeq":4}"#,
                            ] {
                                let _ = socket.send(AxumMessage::Text(frame.into())).await;
                            }
                            while let Some(Ok(_)) = socket.next().await {}
                        })
                    }
                },
            ),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), seen)
}

fn local(mut request: Request<Body>) -> Request<Body> {
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::from([127, 0, 0, 1]),
        4545,
    )));
    request
}

fn state_with_host(name: &str, host: AcpHost) -> crate::state::AppState {
    let mut state = test_state(name);
    state.acp_host = Arc::new(host);
    state
}

/// 远程只读开启、需要登录，并挂上设备令牌服务。
fn read_only_state(name: &str, host: AcpHost) -> (crate::state::AppState, Arc<DeviceTokenService>) {
    let mut state = state_with_host(name, host);
    let tokens = Arc::new(DeviceTokenService::in_data_dir(&test_dir(name)));
    state.web_auth = Arc::new(WebAuthStore::with_device_tokens(tokens.clone(), false));
    let mut settings = remote_settings();
    settings.web_access.ip_whitelist.clear();
    settings.web_access.remote_read_only = true;
    state.settings_service.update_settings(settings).unwrap();
    (state, tokens)
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn proxies_reads_and_writes_with_bearer_token() {
    let (base, seen) = spawn_upstream().await;
    let app = super::super::build_router(state_with_host("acp-proxy", AcpHost::fixed(base, TOKEN)));

    let response = app
        .clone()
        .oneshot(local(
            Request::get("/api/acp/chats").body(Body::empty()).unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await[0]["chatId"], "mobile-1");

    let response = app
        .oneshot(local(
            Request::post("/api/acp/chats/mobile-1/prompt")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"blocks":[{"type":"text","text":"hi"}]}"#))
                .unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["promptId"], "p1");
    let seen = seen.all();
    assert_eq!(seen[0], "GET /acp/chats");
    assert!(
        seen[1].starts_with("POST mobile-1 [mobile] {\"blocks\""),
        "{}",
        seen[1]
    );
}

#[tokio::test]
async fn host_unavailable_returns_503() {
    let app = super::super::build_router(state_with_host("acp-none", AcpHost::unavailable()));
    let response = app
        .oneshot(local(
            Request::get("/api/acp/engines")
                .body(Body::empty())
                .unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body_json(response).await["code"], "ACP_HOST_UNAVAILABLE");

    // 端口没人听（app 已退出、manifest 残留）同样 503。
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let app = super::super::build_router(state_with_host("acp-dead", AcpHost::fixed(dead, TOKEN)));
    let response = app
        .oneshot(local(
            Request::get("/api/acp/chats").body(Body::empty()).unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body_json(response).await["code"], "ACP_HOST_UNAVAILABLE");
}

#[tokio::test]
async fn stale_token_is_reported_as_host_unavailable() {
    let (base, _) = spawn_upstream().await;
    let app = super::super::build_router(state_with_host(
        "acp-stale",
        AcpHost::fixed(base, "old-token"),
    ));
    let response = app
        .oneshot(local(
            Request::get("/api/acp/chats").body(Body::empty()).unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body_json(response).await["code"], "ACP_HOST_UNAVAILABLE");
}

#[tokio::test]
async fn unknown_or_traversal_paths_are_not_proxied() {
    let (base, seen) = spawn_upstream().await;
    let app = super::super::build_router(state_with_host("acp-paths", AcpHost::fixed(base, TOKEN)));
    for uri in [
        "/api/acp/chats/x/y/z",
        "/api/acp/mcp",
        "/api/acp/chats/x/shutdown",
    ] {
        let response = app
            .clone()
            .oneshot(local(Request::get(uri).body(Body::empty()).unwrap()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }
    assert!(seen.all().is_empty());
}

#[tokio::test]
async fn cookie_session_requires_login_and_respects_remote_read_only() {
    let (base, seen) = spawn_upstream().await;
    let (state, _) = read_only_state("acp-readonly", AcpHost::fixed(base, TOKEN));
    let app = super::super::build_router(state);
    let remote = |method: &str, uri: &str, cookie: Option<&str>, body: &'static str| {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "100.64.0.5");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        local(builder.body(Body::from(body)).unwrap())
    };

    // 未登录：401，不转发。
    let response = app
        .clone()
        .oneshot(remote("GET", "/api/acp/chats", None, ""))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let cookie = login_cookie(app.clone()).await;
    for (method, uri) in [
        ("POST", "/api/acp/chats"),
        ("POST", "/api/acp/chats/mobile-1/prompt"),
        ("POST", "/api/acp/chats/mobile-1/permission"),
        ("POST", "/api/acp/chats/mobile-1/config"),
        ("DELETE", "/api/acp/chats/mobile-1"),
    ] {
        let response = app
            .clone()
            .oneshot(remote(method, uri, Some(&cookie), "{}"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {uri}");
        assert_eq!(body_json(response).await["code"], "READ_ONLY");
    }
    let response = app
        .oneshot(remote("GET", "/api/acp/chats", Some(&cookie), ""))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(seen.all(), ["GET /acp/chats"]);
}

#[tokio::test]
async fn device_token_is_owner_and_names_the_origin() {
    let (base, seen) = spawn_upstream().await;
    let (state, tokens) = read_only_state("acp-device", AcpHost::fixed(base, TOKEN));
    let (_, token) = tokens.create("吴的 iPhone").unwrap();
    let app = super::super::build_router(state);
    let request = |bearer: &str| {
        local(
            Request::post("/api/acp/chats/mobile-1/prompt")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .header("x-forwarded-for", "100.64.0.5")
                .body(Body::from(r#"{"blocks":[],"promptId":"p1"}"#))
                .unwrap(),
        )
    };
    // 设备令牌视同本机主人：远程只读不拦写。
    let response = app.clone().oneshot(request(&token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        seen.all(),
        [r#"POST mobile-1 [device:吴的 iPhone] {"blocks":[],"promptId":"p1"}"#]
    );
    // 无效令牌：401，不回落到 cookie，也不转发。
    let response = app.oneshot(request("ccp_dev_bogus")).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(seen.all().len(), 1);
}

async fn spawn_web(state: crate::state::AppState) -> SocketAddr {
    let app = super::super::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    addr
}

fn http_status(error: tokio_tungstenite::tungstenite::Error) -> StatusCode {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => response.status(),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn websocket_relays_frames_verbatim_with_after_seq() {
    let (base, seen) = spawn_upstream().await;
    let addr = spawn_web(state_with_host("acp-ws", AcpHost::fixed(base, TOKEN))).await;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/ws/acp/mobile-1?afterSeq=3"))
            .await
            .unwrap();
    let first = socket.next().await.unwrap().unwrap();
    assert_eq!(
        first.to_text().unwrap(),
        r#"{"type":"event","seq":4,"kind":"brand_new_kind","payload":{"z":1}}"#
    );
    let second = socket.next().await.unwrap().unwrap();
    assert!(second.to_text().unwrap().contains("synchronized"));
    assert_eq!(seen.all(), ["WS mobile-1 afterSeq=3"]);
    let _ = socket.close(None).await;
}

#[tokio::test]
async fn websocket_accepts_device_token_query_under_read_only() {
    let (base, seen) = spawn_upstream().await;
    let (state, tokens) = read_only_state("acp-ws-device", AcpHost::fixed(base, TOKEN));
    let (_, token) = tokens.create("ipad").unwrap();
    let addr = spawn_web(state).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/ws/acp/mobile-1?afterSeq=0&token={token}"
    ))
    .await
    .unwrap();
    assert!(socket.next().await.unwrap().unwrap().is_text());
    // 令牌只在 web 这一跳用，不带给上游。
    assert_eq!(seen.all(), ["WS mobile-1 afterSeq=0"]);
    let _ = socket.close(None).await;

    let error = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/ws/acp/mobile-1?token=ccp_dev_bogus"
    ))
    .await
    .unwrap_err();
    assert_eq!(http_status(error), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn websocket_handshake_errors_keep_http_status() {
    let (base, _) = spawn_upstream().await;
    let addr = spawn_web(state_with_host(
        "acp-ws-404",
        AcpHost::fixed(base.clone(), TOKEN),
    ))
    .await;
    let error = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/acp/missing"))
        .await
        .unwrap_err();
    assert_eq!(http_status(error), StatusCode::NOT_FOUND);

    let addr = spawn_web(state_with_host("acp-ws-503", AcpHost::unavailable())).await;
    let error = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/acp/c1"))
        .await
        .unwrap_err();
    assert_eq!(http_status(error), StatusCode::SERVICE_UNAVAILABLE);

    // 上游拒绝凭据（manifest 陈旧）对客户端也是 503。
    let addr = spawn_web(state_with_host("acp-ws-stale", AcpHost::fixed(base, "old"))).await;
    let error = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/acp/c1"))
        .await
        .unwrap_err();
    assert_eq!(http_status(error), StatusCode::SERVICE_UNAVAILABLE);
}
