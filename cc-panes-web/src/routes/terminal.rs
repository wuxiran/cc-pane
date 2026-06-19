use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{
        CliTool, CreateSessionRequest as CoreCreateSessionRequest, LaunchProviderSelection,
        SshConnectionInfo, TerminalReplaySnapshot,
    },
    services::{terminal_service::SessionOutput, SessionStatusInfo},
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    /// Full core launch request fields. `project_path` is kept implicit for
    /// compatibility with the original web terminal endpoint via `cwd`.
    #[serde(flatten)]
    pub core: PartialCreateSessionRequest,
    /// Working directory (optional, falls back to server default)
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
    pub wsl: Option<cc_panes_core::models::WslLaunchInfo>,
}

#[derive(Serialize)]
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

/// POST /api/sessions — create a new terminal session
pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), (StatusCode, String)> {
    if req.core.ssh.is_some() && req.core.wsl.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "SSH and WSL launch options cannot be combined".to_string(),
        ));
    }

    let project_path = req
        .core
        .project_path
        .or(req.cwd)
        .unwrap_or_else(|| state.default_cwd.clone());

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
        ssh: req.core.ssh,
        wsl: req.core.wsl,
    };

    let session_id = state
        .terminal_backend
        .create_session(core_request)
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to create session");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create session".to_string(),
            )
        })?;

    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    ))
}

/// GET /api/sessions — list all active sessions
pub async fn list_sessions(
    State(state): State<AppState>,
) -> Result<Json<Vec<SessionStatusInfo>>, (StatusCode, String)> {
    let statuses = state.terminal_backend.get_all_status().map_err(|e| {
        tracing::error!(error = %e, "Failed to get sessions");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to list sessions".to_string(),
        )
    })?;

    Ok(Json(statuses))
}

/// GET /api/sessions/:id/status — get a terminal session status
pub async fn get_session_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SessionStatusInfo>, (StatusCode, String)> {
    let statuses = state.terminal_backend.get_all_status().map_err(|e| {
        tracing::error!(error = %e, "Failed to get session status");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to get session status".to_string(),
        )
    })?;

    statuses
        .into_iter()
        .find(|status| status.session_id == id)
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))
}

/// POST /api/sessions/:id/resize — resize terminal
pub async fn resize_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ResizeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .terminal_backend
        .resize(&id, req.cols, req.rows)
        .map_err(|e| {
            tracing::error!(session_id = id, error = %e, "Failed to resize");
            (StatusCode::NOT_FOUND, "Session not found".to_string())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/sessions/:id/write — write raw terminal input
pub async fn write_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<WriteRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state.terminal_backend.write(&id, &req.data).map_err(|e| {
        tracing::error!(session_id = id, error = %e, "Failed to write");
        (StatusCode::NOT_FOUND, "Session not found".to_string())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/sessions/:id/submit — submit text followed by Enter
pub async fn submit_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SubmitRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .terminal_backend
        .submit_text_to_session(&id, &req.text)
        .map_err(|e| {
            tracing::error!(session_id = id, error = %e, "Failed to submit");
            (StatusCode::NOT_FOUND, "Session not found".to_string())
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/sessions/:id/output — read recent plain-text terminal output
pub async fn get_session_output(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> Result<Json<SessionOutput>, (StatusCode, String)> {
    let lines = query.lines.unwrap_or(0);
    let output = state
        .terminal_backend
        .get_session_output(&id, lines)
        .map_err(|e| {
            tracing::error!(session_id = id, error = %e, "Failed to read output");
            (StatusCode::NOT_FOUND, "Session not found".to_string())
        })?;

    Ok(Json(output))
}

/// GET /api/sessions/:id/snapshot — read raw VT replay snapshot for attach
pub async fn get_session_snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<TerminalReplaySnapshot>>, (StatusCode, String)> {
    let snapshot = state
        .terminal_backend
        .get_session_replay_snapshot(&id)
        .map_err(|e| {
            tracing::error!(session_id = id, error = %e, "Failed to read replay snapshot");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to read replay snapshot".to_string(),
            )
        })?;

    match snapshot {
        Some(snapshot) => Ok(Json(Some(snapshot))),
        None => Err((StatusCode::NOT_FOUND, "Session not found".to_string())),
    }
}

/// DELETE /api/sessions/:id — kill terminal session
pub async fn kill_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state.terminal_backend.kill(&id).map_err(|e| {
        tracing::error!(session_id = id, error = %e, "Failed to kill session");
        (StatusCode::NOT_FOUND, "Session not found".to_string())
    })?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use cc_panes_core::{
        models::{TerminalBufferMode, WslLaunchInfo},
        services::{terminal_service::SessionStatus, TerminalBackend},
        utils::AppResult,
    };
    use serde_json::json;

    use super::*;
    use crate::ws_emitter::WsEmitter;

    #[derive(Default)]
    struct MockTerminalBackend {
        created: Mutex<Vec<CoreCreateSessionRequest>>,
        writes: Mutex<Vec<(String, String)>>,
        submits: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
        output_requests: Mutex<Vec<(String, usize)>>,
        snapshot_requests: Mutex<Vec<String>>,
    }

    impl TerminalBackend for MockTerminalBackend {
        fn create_session(&self, request: CoreCreateSessionRequest) -> AppResult<String> {
            self.created.lock().unwrap().push(request);
            Ok("created-session".to_string())
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

        fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
            self.output_requests
                .lock()
                .unwrap()
                .push((session_id.to_string(), lines));
            Ok(SessionOutput {
                session_id: session_id.to_string(),
                lines: vec!["ready".to_string()],
            })
        }

        fn get_session_replay_snapshot(
            &self,
            session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            self.snapshot_requests
                .lock()
                .unwrap()
                .push(session_id.to_string());
            Ok(Some(TerminalReplaySnapshot {
                data: "\u{1b}[2J".to_string(),
                buffer_mode: TerminalBufferMode::Normal,
            }))
        }
    }

    fn test_state(backend: Arc<MockTerminalBackend>) -> AppState {
        AppState {
            terminal_backend: backend,
            ws_emitter: Arc::new(WsEmitter::new()),
            default_cwd: "/default/project".to_string(),
        }
    }

    #[tokio::test]
    async fn create_session_maps_web_request_to_core_backend() {
        let backend = Arc::new(MockTerminalBackend::default());
        let state = test_state(backend.clone());

        let request = CreateSessionRequest {
            core: PartialCreateSessionRequest {
                project_path: Some("/repo".to_string()),
                cols: Some(100),
                rows: Some(40),
                cli_tool: CliTool::Codex,
                provider_id: Some("provider-1".to_string()),
                provider_selection: LaunchProviderSelection::Explicit,
                skip_mcp: true,
                initial_prompt: Some("inspect".to_string()),
                ..Default::default()
            },
            cwd: None,
        };

        let (status, Json(response)) = create_session(State(state), Json(request))
            .await
            .expect("create session");

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(response.session_id, "created-session");
        let created = backend.created.lock().unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].project_path, "/repo");
        assert_eq!(created[0].cols, 100);
        assert_eq!(created[0].rows, 40);
        assert_eq!(created[0].cli_tool, CliTool::Codex);
        assert_eq!(created[0].provider_id.as_deref(), Some("provider-1"));
        assert_eq!(
            created[0].provider_selection,
            LaunchProviderSelection::Explicit
        );
        assert!(created[0].skip_mcp);
        assert_eq!(created[0].initial_prompt.as_deref(), Some("inspect"));
    }

    #[tokio::test]
    async fn create_session_accepts_prompt_alias_and_cwd_fallback() {
        let backend = Arc::new(MockTerminalBackend::default());
        let state = test_state(backend.clone());
        let request: CreateSessionRequest = serde_json::from_value(json!({
            "cwd": "/legacy/cwd",
            "prompt": "run this",
            "cols": 88,
            "rows": 22
        }))
        .expect("deserialize request");

        let _response = create_session(State(state), Json(request))
            .await
            .expect("create session");

        let created = backend.created.lock().unwrap();
        assert_eq!(created[0].project_path, "/legacy/cwd");
        assert_eq!(created[0].cols, 88);
        assert_eq!(created[0].rows, 22);
        assert_eq!(created[0].initial_prompt.as_deref(), Some("run this"));
    }

    #[tokio::test]
    async fn terminal_operation_handlers_delegate_to_backend() {
        let backend = Arc::new(MockTerminalBackend::default());
        let state = test_state(backend.clone());

        assert_eq!(
            write_session(
                State(state.clone()),
                Path("session-1".to_string()),
                Json(WriteRequest {
                    data: "abc".to_string(),
                }),
            )
            .await
            .expect("write"),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            submit_session(
                State(state.clone()),
                Path("session-1".to_string()),
                Json(SubmitRequest {
                    text: "hello".to_string(),
                }),
            )
            .await
            .expect("submit"),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            resize_session(
                State(state.clone()),
                Path("session-1".to_string()),
                Json(ResizeRequest {
                    cols: 120,
                    rows: 30
                }),
            )
            .await
            .expect("resize"),
            StatusCode::NO_CONTENT
        );
        let Json(status) = get_session_status(State(state.clone()), Path("session-1".to_string()))
            .await
            .expect("status");
        let Json(output) = get_session_output(
            State(state.clone()),
            Path("session-1".to_string()),
            Query(OutputQuery { lines: Some(10) }),
        )
        .await
        .expect("output");
        let Json(snapshot) =
            get_session_snapshot(State(state.clone()), Path("session-1".to_string()))
                .await
                .expect("snapshot");
        assert_eq!(
            kill_session(State(state), Path("session-1".to_string()))
                .await
                .expect("kill"),
            StatusCode::NO_CONTENT
        );

        assert_eq!(status.status, SessionStatus::Idle);
        assert_eq!(output.lines, vec!["ready".to_string()]);
        assert!(snapshot.is_some());
        assert_eq!(
            backend.writes.lock().unwrap().as_slice(),
            &[("session-1".to_string(), "abc".to_string())]
        );
        assert_eq!(
            backend.submits.lock().unwrap().as_slice(),
            &[("session-1".to_string(), "hello".to_string())]
        );
        assert_eq!(
            backend.resizes.lock().unwrap().as_slice(),
            &[("session-1".to_string(), 120, 30)]
        );
        assert_eq!(
            backend.output_requests.lock().unwrap().as_slice(),
            &[("session-1".to_string(), 10)]
        );
        assert_eq!(
            backend.snapshot_requests.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
        assert_eq!(
            backend.kills.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
    }

    #[tokio::test]
    async fn create_session_rejects_combined_ssh_and_wsl_launch() {
        let backend = Arc::new(MockTerminalBackend::default());
        let state = test_state(backend);
        let request = CreateSessionRequest {
            core: PartialCreateSessionRequest {
                ssh: Some(SshConnectionInfo {
                    host: "example.com".to_string(),
                    port: 22,
                    user: Some("user".to_string()),
                    auth_method: None,
                    remote_path: "/repo".to_string(),
                    identity_file: None,
                    machine_id: None,
                }),
                wsl: Some(WslLaunchInfo {
                    remote_path: "/repo".to_string(),
                    workspace_remote_path: None,
                    distro: None,
                }),
                ..Default::default()
            },
            cwd: None,
        };

        let error = match create_session(State(state), Json(request)).await {
            Ok(_) => panic!("combined launch should fail"),
            Err(error) => error,
        };

        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }
}
