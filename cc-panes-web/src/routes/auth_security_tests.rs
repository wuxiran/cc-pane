use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[test]
fn shared_shutdown_releases_claims_without_killing_sessions() {
    let backend = NoopTerminalBackend::default();
    crate::shutdown::cleanup(&backend, false);
    assert_eq!(backend.kills.load(Ordering::SeqCst), 0);
    assert_eq!(backend.releases.load(Ordering::SeqCst), 1);
    crate::shutdown::cleanup(&backend, true);
    assert_eq!(backend.kills.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn arbitrary_origins_cannot_write_or_log_in_to_loopback() {
    let state = test_state("origin-security");
    let backend = Arc::new(NoopTerminalBackend::default());
    let mut state = state;
    state.terminal_backend = backend.clone();
    let app = super::super::build_router(state);
    for path in [
        "/api/sessions/session/write",
        "/api/auth/login",
        "/ws/session",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header(header::HOST, "localhost:8080")
                    .header(header::ORIGIN, "https://untrusted.example")
                    .header(header::CONTENT_TYPE, "application/json")
                    .extension(ConnectInfo(
                        "127.0.0.1:54321".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(Body::from(r#"{"data":"unexpected input"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn established_socket_closes_after_logout_without_accepting_more_input() {
    assert_socket_revoked(false).await;
}

#[tokio::test]
async fn established_socket_closes_after_password_change() {
    assert_socket_revoked(true).await;
}

async fn assert_socket_revoked(change_password: bool) {
    let mut state = test_state(if change_password {
        "ws-password"
    } else {
        "ws-logout"
    });
    enable_auth(&state);
    let backend = Arc::new(NoopTerminalBackend::default());
    state.terminal_backend = backend.clone();
    let token = state.web_auth.create_session();
    let app = super::super::build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let mut request = format!("ws://{addr}/ws/session")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::COOKIE,
        format!("ccp_web_session={token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    if change_password {
        let mut settings = state.settings_service.get_settings();
        settings.web_access.set_password("new password").unwrap();
        state.settings_service.update_settings(settings).unwrap();
    } else {
        state.web_auth.revoke_session(&token);
    }
    let _ = socket
        .send(Message::Text(
            r#"{"type":"input","data":"must not execute"}"#.into(),
        ))
        .await;
    let ended = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next()).await;
    server.abort();
    assert!(
        ended.is_ok(),
        "revoked stream must close even without new output"
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
}
