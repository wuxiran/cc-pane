use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use cc_panes_core::models::{
    CliTool, CreateSessionRequest as CoreCreateSessionRequest, LaunchProviderSelection,
    SshConnectionInfo, TerminalReplaySnapshot, WslLaunchInfo,
};
use cc_panes_core::services::terminal_service::SessionOutput;
use cc_panes_core::services::{SessionStatusInfo, TerminalBackend};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

const MANIFEST_FILE: &str = "daemon-manifest.json";

#[derive(Clone)]
pub struct DaemonConfig {
    inner: Arc<DaemonState>,
}

impl DaemonConfig {
    pub fn new(
        token: String,
        addr: SocketAddr,
        terminal_backend: Arc<dyn TerminalBackend>,
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
                default_cwd,
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
        }
    }

    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.inner.shutdown_tx.subscribe()
    }

    fn request_shutdown(&self) {
        let _ = self.inner.shutdown_tx.send(true);
    }

    fn terminal_backend(&self) -> &dyn TerminalBackend {
        self.inner.terminal_backend.as_ref()
    }

    fn default_cwd(&self) -> &str {
        &self.inner.default_cwd
    }
}

struct DaemonState {
    token: String,
    addr: SocketAddr,
    started_at: u64,
    shutdown_tx: watch::Sender<bool>,
    terminal_backend: Arc<dyn TerminalBackend>,
    default_cwd: String,
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
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
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
    pub ssh: Option<SshConnectionInfo>,
    #[serde(default)]
    pub wsl: Option<WslLaunchInfo>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
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

pub fn router(config: DaemonConfig) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/daemon/status", get(status))
        .route("/api/daemon/shutdown", post(shutdown))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}/status", get(get_session_status))
        .route("/api/sessions/{id}/output", get(get_session_output))
        .route("/api/sessions/{id}/snapshot", get(get_session_snapshot))
        .route("/api/sessions/{id}/write", post(write_session))
        .route("/api/sessions/{id}/submit", post(submit_session))
        .route("/api/sessions/{id}/resize", post(resize_session))
        .route("/api/sessions/{id}", delete(kill_session))
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

async fn create_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    if req.core.ssh.is_some() || req.core.wsl.is_some() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "UNSUPPORTED_REMOTE_LAUNCH",
            "daemon MVP only supports local terminal sessions",
        ));
    }

    let project_path = req
        .core
        .project_path
        .or(req.cwd)
        .unwrap_or_else(|| config.default_cwd().to_string());
    let core_request = CoreCreateSessionRequest {
        launch_id: req.core.launch_id,
        project_path,
        cols: req.core.cols.unwrap_or(120),
        rows: req.core.rows.unwrap_or(30),
        workspace_name: req.core.workspace_name,
        provider_id: req.core.provider_id,
        provider_selection: req.core.provider_selection,
        launch_profile_id: req.core.launch_profile_id,
        workspace_path: req.core.workspace_path,
        workspace_snapshot_id: req.core.workspace_snapshot_id,
        launch_claude: req.core.launch_claude,
        cli_tool: req.core.cli_tool,
        resume_id: req.core.resume_id,
        skip_mcp: req.core.skip_mcp,
        append_system_prompt: req.core.append_system_prompt,
        initial_prompt: req.core.initial_prompt,
        ssh: None,
        wsl: None,
    };
    let session_id = config
        .terminal_backend()
        .create_session(core_request)
        .map_err(internal_error)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    ))
}

async fn list_sessions(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionStatusInfo>>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
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
    let statuses = config
        .terminal_backend()
        .get_all_status()
        .map_err(internal_error)?;
    statuses
        .into_iter()
        .find(|status| status.session_id == id)
        .map(Json)
        .ok_or_else(|| not_found("Session not found"))
}

async fn resize_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<ResizeRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config
        .terminal_backend()
        .resize(&id, req.cols, req.rows)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn write_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<WriteRequest>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
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
    let snapshot = config
        .terminal_backend()
        .get_session_replay_snapshot(&id)
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Session not found"))?;
    Ok(Json(snapshot))
}

async fn kill_session(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    config
        .terminal_backend()
        .kill(&id)
        .map_err(not_found_from_error)?;
    Ok(StatusCode::NO_CONTENT)
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

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<serde_json::Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        error.to_string(),
    )
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
    use std::sync::{Arc, Mutex};

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use cc_panes_core::models::TerminalBufferMode;
    use cc_panes_core::services::terminal_service::SessionStatus;
    use cc_panes_core::utils::AppResult;
    use tower::ServiceExt;

    use super::*;

    #[derive(Default)]
    struct MockTerminalBackend {
        created: Mutex<Vec<CoreCreateSessionRequest>>,
        writes: Mutex<Vec<(String, String)>>,
        submits: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
    }

    impl TerminalBackend for MockTerminalBackend {
        fn create_session(&self, request: CoreCreateSessionRequest) -> AppResult<String> {
            self.created.lock().unwrap().push(request);
            Ok("session-1".to_string())
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

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            if self.created.lock().unwrap().is_empty() {
                return Ok(Vec::new());
            }

            Ok(vec![SessionStatusInfo {
                session_id: "session-1".to_string(),
                status: SessionStatus::Idle,
                last_output_at: 100,
                pid: Some(42),
                current_tool_name: None,
                current_tool_use_id: None,
                current_tool_summary: None,
                updated_at: 120,
            }])
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
    }

    fn test_config(token: &str, addr: &str, backend: Arc<MockTerminalBackend>) -> DaemonConfig {
        DaemonConfig::new(
            token.to_string(),
            addr.parse().expect("socket addr"),
            backend,
            "/default/project".to_string(),
        )
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
    async fn terminal_routes_require_token_and_delegate_to_backend() {
        let backend = Arc::new(MockTerminalBackend::default());
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
                        r#"{"projectPath":"/repo","cols":100,"rows":40,"prompt":"inspect"}"#,
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
    async fn daemon_mvp_rejects_remote_launch_options() {
        let app = router(test_config(
            "secret",
            "127.0.0.1:18085",
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
                        r#"{"projectPath":"/repo","wsl":{"remotePath":"/repo"}}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
