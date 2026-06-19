use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

const MANIFEST_FILE: &str = "daemon-manifest.json";

#[derive(Clone)]
pub struct DaemonConfig {
    inner: Arc<DaemonState>,
}

impl DaemonConfig {
    pub fn new(token: String, addr: SocketAddr) -> Self {
        let started_at = current_epoch_millis();
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        Self {
            inner: Arc::new(DaemonState {
                token,
                addr,
                started_at,
                shutdown_tx,
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
        DaemonStatus {
            status: "ok".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            addr: self.inner.addr.to_string(),
            started_at: self.inner.started_at,
            session_count: 0,
        }
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.inner.shutdown_tx.subscribe()
    }

    fn request_shutdown(&self) {
        let _ = self.inner.shutdown_tx.send(true);
    }
}

struct DaemonState {
    token: String,
    addr: SocketAddr,
    started_at: u64,
    shutdown_tx: watch::Sender<bool>,
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

pub fn router(config: DaemonConfig) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/daemon/status", get(status))
        .route("/api/daemon/shutdown", post(shutdown))
        .with_state(config)
}

pub fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn write_manifest(runtime_dir: &Path, config: &DaemonConfig) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(runtime_dir)?;
    let path = runtime_dir.join(MANIFEST_FILE);
    let manifest = DaemonManifest {
        addr: config.addr().to_string(),
        token: config.token().to_string(),
        pid: std::process::id(),
        started_at: config.inner.started_at,
    };
    let data = serde_json::to_vec_pretty(&manifest)?;
    std::fs::write(&path, data)?;
    Ok(path)
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
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::*;

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
        let config = DaemonConfig::new(
            "test-token".to_string(),
            "127.0.0.1:18081".parse().expect("socket addr"),
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
        let config = DaemonConfig::new(
            "secret".to_string(),
            "127.0.0.1:18082".parse().expect("socket addr"),
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
    async fn shutdown_requires_token_and_signals_graceful_shutdown() {
        let config = DaemonConfig::new(
            "secret".to_string(),
            "127.0.0.1:18083".parse().expect("socket addr"),
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
}
