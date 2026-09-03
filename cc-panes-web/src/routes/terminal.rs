use std::collections::HashMap;

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
    services::{
        resolve_terminal_path_link as resolve_core_terminal_path_link,
        session_provenance_persist::persist_created_session_or_cleanup,
        terminal_service::SessionOutput, CreateSessionOutcome, CreatedLaunchHistory,
        ResolvedTerminalPathLink, SessionStatusInfo, TerminalAdoptionSnapshot, TerminalBackend,
    },
    utils::{error::AppError, normalize_session_request_for_current_host, AppResult},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::state::AppState;

const WEB_CREATE_DEADLINE: Duration = Duration::from_secs(45);

fn cleanup_late_session(
    backend: &dyn TerminalBackend,
    outcome: CreateSessionOutcome,
) -> AppResult<()> {
    if outcome.reused_existing {
        backend.release_session(&outcome.session_id)
    } else {
        backend.kill_with_reason(
            &outcome.session_id,
            cc_panes_core::services::terminal_service::KillReason::LaunchTimeout,
        )
    }
}

fn terminal_operation_error(error: impl ToString) -> (StatusCode, String) {
    let message = error.to_string();
    let status = if message.contains("SESSION_CLAIMED") {
        StatusCode::CONFLICT
    } else if message.contains("not found") || message.contains("Not found") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, message)
}

fn launch_project_name(project_path: &str) -> String {
    let trimmed = project_path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

type TerminalPathLinkHttpError = (StatusCode, Json<AppError>);

fn terminal_path_link_error(error: AppError) -> TerminalPathLinkHttpError {
    let status = match error.code() {
        Some("TERMINAL_PATH_INVALID" | "TERMINAL_PATH_OUTSIDE_ROOT") => StatusCode::BAD_REQUEST,
        Some("TERMINAL_PATH_CONTEXT_UNAVAILABLE" | "TERMINAL_PATH_UNAVAILABLE") => {
            StatusCode::NOT_FOUND
        }
        Some("TERMINAL_PATH_REMOTE_UNSUPPORTED" | "TERMINAL_PATH_TYPE_UNSUPPORTED") => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(error))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTerminalPathLinkRequest {
    pub session_id: String,
    pub raw_path: String,
}

pub async fn resolve_terminal_path_link(
    State(state): State<AppState>,
    Json(request): Json<ResolveTerminalPathLinkRequest>,
) -> Result<Json<ResolvedTerminalPathLink>, TerminalPathLinkHttpError> {
    let backend = state.terminal_backend.clone();
    tokio::task::spawn_blocking(move || {
        let context = backend.terminal_link_context(&request.session_id)?;
        resolve_terminal_path_link_for_context(context, &request.raw_path)
    })
    .await
    .map_err(|error| terminal_path_link_error(AppError::from(error.to_string())))?
    .map(Json)
    .map_err(terminal_path_link_error)
}

fn resolve_terminal_path_link_for_context(
    context: Option<cc_panes_core::services::TerminalLinkContext>,
    raw_path: &str,
) -> AppResult<ResolvedTerminalPathLink> {
    let context = context.ok_or_else(|| {
        AppError::coded(
            "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
            "The terminal path context is unavailable",
        )
    })?;
    resolve_core_terminal_path_link(&context, raw_path)
}

#[cfg(test)]
mod terminal_path_link_tests {
    use super::*;

    #[test]
    fn terminal_path_link_route_maps_typed_errors_without_paths() {
        let (status, body) = terminal_path_link_error(AppError::coded(
            "TERMINAL_PATH_OUTSIDE_ROOT",
            "The terminal path is outside the session project",
        ));
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body.0.code(), Some("TERMINAL_PATH_OUTSIDE_ROOT"));
        assert!(!body.0.message().contains("C:\\"));
    }

    #[test]
    fn terminal_path_link_route_fails_closed_without_context() {
        let error = resolve_terminal_path_link_for_context(None, "src/main.rs")
            .expect_err("missing context");
        assert_eq!(error.code(), Some("TERMINAL_PATH_CONTEXT_UNAVAILABLE"));
    }
}

fn summarize_terminal_input(data: &str) -> serde_json::Value {
    let chars: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| ch.escape_default().to_string())
        .collect();
    let code_points: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| format!("{:x}", ch as u32))
        .collect();
    let bytes: Vec<String> = data
        .as_bytes()
        .iter()
        .take(32)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    serde_json::json!({
        "chars": chars,
        "charCount": data.chars().count(),
        "utf8Bytes": data.len(),
        "codePoints": code_points,
        "bytes": bytes,
        "truncated": data.chars().count() > 24 || data.len() > 32,
    })
}

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
    pub model_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
    pub origin_layout_id: Option<String>,
    pub origin_tab_id: Option<String>,
    pub origin_terminal_pane_id: Option<String>,
    pub expected_saved_session_id: Option<String>,
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
    pub yolo_mode: Option<bool>,
    #[serde(default)]
    pub adapter_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub ssh: Option<SshConnectionInfo>,
    #[serde(default)]
    pub wsl: Option<cc_panes_core::models::WslLaunchInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub resolved_model_id: Option<String>,
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
    /// `"system"` = 前端代答的终端查询回复（CPR / DA / OSC 颜色）。缺省视为用户输入。
    /// 两者待遇相反：回显开着时按键**应该**回显，代答回复必须抑制。
    #[serde(default)]
    pub source: Option<String>,
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

    let core_request = normalize_session_request_for_current_host(CoreCreateSessionRequest {
        launch_id: req.core.launch_id,
        project_path,
        cols: req.core.cols.unwrap_or(120),
        rows: req.core.rows.unwrap_or(30),
        workspace_name: req.core.workspace_name,
        provider_id: req.core.provider_id,
        model_id: req.core.model_id,
        provider_selection: req.core.provider_selection,
        launch_profile_id: req.core.launch_profile_id,
        workspace_path: req.core.workspace_path,
        workspace_snapshot_id: req.core.workspace_snapshot_id,
        origin_layout_id: req.core.origin_layout_id,
        origin_tab_id: req.core.origin_tab_id,
        origin_terminal_pane_id: req.core.origin_terminal_pane_id,
        expected_saved_session_id: req.core.expected_saved_session_id,
        launch_claude: req.core.launch_claude,
        cli_tool: req.core.cli_tool,
        resume_id: req.core.resume_id,
        skip_mcp: req.core.skip_mcp,
        append_system_prompt: req.core.append_system_prompt,
        initial_prompt: req.core.initial_prompt,
        yolo_mode: req.core.yolo_mode,
        adapter_options: req.core.adapter_options,
        extra_env: req.core.extra_env,
        ssh: req.core.ssh,
        wsl: req.core.wsl,
    });

    let observation_request = core_request.clone();
    let launch_id = core_request.launch_id.clone();
    let backend = state.terminal_backend.clone();
    let late_backend = backend.clone();
    let mut create_task =
        tokio::task::spawn_blocking(move || backend.create_session_with_outcome(core_request));
    let outcome = match tokio::time::timeout(WEB_CREATE_DEADLINE, &mut create_task).await {
        Ok(result) => result
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .map_err(terminal_operation_error)?,
        Err(_) => {
            if let Some(launch_id) = launch_id.clone() {
                let cancel_backend = state.terminal_backend.clone();
                tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        cancel_backend.cancel_launch(&launch_id)
                    })
                    .await;
                });
            }
            tokio::spawn(async move {
                if let Ok(Ok(outcome)) = create_task.await {
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = cleanup_late_session(late_backend.as_ref(), outcome);
                    })
                    .await;
                }
            });
            return Err((
                StatusCode::GATEWAY_TIMEOUT,
                format!(
                    "[LAUNCH_TIMEOUT] Terminal launch exceeded {}ms",
                    WEB_CREATE_DEADLINE.as_millis()
                ),
            ));
        }
    };
    let session_id = outcome.session_id;
    let reused_existing = outcome.reused_existing;
    let resolved_model_id = outcome.resolved_model_id;

    // 出生凭证必须在 session id 返回给调用方之前落进 SQLite，否则这条会话在 app
    // 重启后会被 identity-mismatch 永久拦下。fail-closed：写不进去就清掉刚建的会话。
    persist_created_session_or_cleanup(
        state.terminal_backend.as_ref(),
        state.session_restore_service.as_ref(),
        &observation_request,
        &session_id,
        reused_existing,
    )
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    if let Some(launch_id) = launch_id.as_deref() {
        let cli_tool = observation_request.effective_cli_tool();
        let mut bound = false;
        for attempt in 0..10 {
            match state.launch_history_service.bind_pty_session(
                launch_id,
                &session_id,
                cli_tool.as_id(),
                resolved_model_id.as_deref(),
                observation_request.provider_id.as_deref(),
            ) {
                Ok(Some(_)) => {
                    bound = true;
                    break;
                }
                Ok(None) if attempt < 9 => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        launch_id,
                        session_id,
                        cli_tool = cli_tool.as_id(),
                        error = %error,
                        "failed to bind Web PTY to launch history"
                    );
                    break;
                }
            }
        }
        if !bound {
            let runtime_kind = if observation_request.ssh.is_some() {
                "ssh"
            } else if observation_request.wsl.is_some() {
                "wsl"
            } else {
                "local"
            };
            let project_name = launch_project_name(&observation_request.project_path);
            let launch_cwd = if observation_request.ssh.is_some() {
                Some(observation_request.project_path.as_str())
            } else {
                observation_request
                    .workspace_path
                    .as_deref()
                    .or(Some(observation_request.project_path.as_str()))
            };
            if let Err(error) =
                state
                    .launch_history_service
                    .bind_or_add_created_session(CreatedLaunchHistory {
                        launch_id,
                        project_name: &project_name,
                        project_path: &observation_request.project_path,
                        pty_session_id: &session_id,
                        cli_tool: cli_tool.as_id(),
                        runtime_kind,
                        wsl_distro: observation_request
                            .wsl
                            .as_ref()
                            .and_then(|wsl| wsl.distro.as_deref()),
                        workspace_name: observation_request.workspace_name.as_deref(),
                        workspace_path: observation_request.workspace_path.as_deref(),
                        launch_cwd,
                        provider_id: observation_request.provider_id.as_deref(),
                        model_id: resolved_model_id.as_deref(),
                        provider_selection: Some(observation_request.provider_selection.as_str()),
                        launch_profile_id: observation_request.launch_profile_id.as_deref(),
                        workspace_snapshot_id: observation_request.workspace_snapshot_id.as_deref(),
                    })
            {
                tracing::warn!(
                    launch_id,
                    session_id,
                    cli_tool = cli_tool.as_id(),
                    error = %error,
                    "failed to create fallback Web launch history row"
                );
            }
        }
    }

    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            session_id,
            resolved_model_id,
        }),
    ))
}

/// DELETE /api/launches/:launch_id — cancel an in-flight launch.
pub async fn cancel_launch(
    State(state): State<AppState>,
    Path(launch_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let backend = state.terminal_backend.clone();
    tokio::task::spawn_blocking(move || backend.cancel_launch(&launch_id))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(terminal_operation_error)?;
    Ok(StatusCode::NO_CONTENT)
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

pub async fn get_adoption_snapshot(
    State(state): State<AppState>,
) -> Result<Json<TerminalAdoptionSnapshot>, (StatusCode, String)> {
    state
        .terminal_backend
        .adoption_snapshot()
        .map(Json)
        .map_err(terminal_operation_error)
}

pub async fn adopt_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, (StatusCode, String)> {
    let granted = state
        .terminal_backend
        .adopt_session(&id)
        .map_err(terminal_operation_error)?;
    if !granted || !state.terminal_backend.claims_supported() {
        return Ok(Json(granted));
    }
    let snapshot = match state.terminal_backend.adoption_snapshot() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = state.terminal_backend.release_session(&id);
            return Err(terminal_operation_error(error));
        }
    };
    let Some(owner) = snapshot.owner_instance_id else {
        let _ = state.terminal_backend.release_session(&id);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "daemon claim snapshot omitted owner instance id".to_string(),
        ));
    };
    if let Err(error) = state
        .session_restore_service
        .transfer_observation_owner(&id, &owner)
    {
        let _ = state.terminal_backend.release_session(&id);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, error));
    }
    Ok(Json(true))
}

pub async fn release_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .terminal_backend
        .release_session(&id)
        .map_err(terminal_operation_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/sessions/:id/status — get a terminal session status
pub async fn get_session_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SessionStatusInfo>, (StatusCode, String)> {
    let status = state
        .terminal_backend
        .get_session_status(&id)
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to get session status");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to get session status".to_string(),
            )
        })?;

    status
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
        .map_err(terminal_operation_error)?;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/sessions/:id/write — write raw terminal input
pub async fn write_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<WriteRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    tracing::debug!(
        session_id = %id,
        input = %summarize_terminal_input(&req.data),
        "terminal-input.trace web.write_session"
    );
    let write = if req.source.as_deref() == Some("system") {
        state.terminal_backend.write_reply(&id, &req.data)
    } else {
        state.terminal_backend.write(&id, &req.data)
    };
    write.map_err(terminal_operation_error)?;

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
        .map_err(terminal_operation_error)?;

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
    state
        .terminal_backend
        .kill(&id)
        .map_err(terminal_operation_error)?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use cc_panes_core::{
        models::{SavedSession, TerminalBufferMode, WslLaunchInfo},
        services::{
            terminal_service::SessionStatus, FileSystemService, HistoryService,
            LaunchHistoryService, LayoutSnapshotService, McpConfigService, PlanService,
            ProcessMonitorService, ProjectService, ProviderService, RunnerService,
            SessionRestoreService, SettingsService, SharedMcpService, SpecService,
            SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend,
            TodoService, WorkspaceService, WorktreeService,
        },
        utils::{error::AppError, AppPaths, AppResult},
    };
    use serde_json::json;

    use super::*;
    use crate::ws_emitter::WsEmitter;

    #[derive(Default)]
    struct MockTerminalBackend {
        created: Mutex<Vec<CoreCreateSessionRequest>>,
        created_session_id: Mutex<Option<String>>,
        resolved_model_id: Mutex<Option<String>>,
        create_error: Mutex<Option<AppError>>,
        writes: Mutex<Vec<(String, String)>>,
        submits: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
        kills: Mutex<Vec<String>>,
        output_requests: Mutex<Vec<(String, usize)>>,
        snapshot_requests: Mutex<Vec<String>>,
        claims_supported: bool,
        adoption_snapshot_error: Mutex<Option<AppError>>,
        adoption_owner: Mutex<Option<String>>,
        adopted: Mutex<Vec<String>>,
        releases: Mutex<Vec<String>>,
        provenance: Mutex<Option<cc_panes_core::models::TerminalSessionProvenance>>,
    }

    impl TerminalBackend for MockTerminalBackend {
        fn create_session(&self, request: CoreCreateSessionRequest) -> AppResult<String> {
            self.created.lock().unwrap().push(request);
            if let Some(error) = self.create_error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(self
                .created_session_id
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "created-session".to_string()))
        }

        fn create_session_with_outcome(
            &self,
            request: CoreCreateSessionRequest,
        ) -> AppResult<CreateSessionOutcome> {
            let expected_session_id = request.expected_saved_session_id.clone();
            let requested_model_id = request.model_id.clone();
            let session_id = self.create_session(request)?;
            Ok(CreateSessionOutcome {
                reused_existing: expected_session_id.as_deref() == Some(session_id.as_str()),
                session_id,
                resolved_model_id: self
                    .resolved_model_id
                    .lock()
                    .unwrap()
                    .clone()
                    .or(requested_model_id),
            })
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
                exit_code: None,
                current_tool_name: None,
                current_tool_use_id: None,
                current_tool_summary: None,
                updated_at: 120,
            }])
        }

        fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            Ok(self
                .get_all_status()?
                .into_iter()
                .find(|status| status.session_id == session_id))
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

        fn adopt_session(&self, session_id: &str) -> AppResult<bool> {
            self.adopted.lock().unwrap().push(session_id.to_string());
            Ok(true)
        }

        fn release_session(&self, session_id: &str) -> AppResult<()> {
            self.releases.lock().unwrap().push(session_id.to_string());
            Ok(())
        }

        fn claims_supported(&self) -> bool {
            self.claims_supported
        }

        fn session_provenance(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<cc_panes_core::models::TerminalSessionProvenance>> {
            Ok(self.provenance.lock().unwrap().clone())
        }

        fn adoption_snapshot(&self) -> AppResult<TerminalAdoptionSnapshot> {
            if let Some(error) = self.adoption_snapshot_error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(TerminalAdoptionSnapshot {
                claims_supported: self.claims_supported,
                daemon_generation: Some(100),
                owner_instance_id: self.adoption_owner.lock().unwrap().clone(),
                captured_at_ms: 200,
                complete: true,
                sessions: self.get_all_status()?,
                claims: std::collections::HashMap::new(),
                provenance: std::collections::HashMap::new(),
            })
        }
    }

    fn test_state(backend: Arc<MockTerminalBackend>) -> AppState {
        test_state_and_db(backend).0
    }

    fn test_state_and_db(
        backend: Arc<MockTerminalBackend>,
    ) -> (AppState, Arc<cc_panes_core::repository::Database>) {
        fn test_dir(name: &str) -> String {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_millis();
            let path = std::env::temp_dir().join(format!("cc-panes-web-terminal-{name}-{millis}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            path.to_string_lossy().to_string()
        }

        let app_paths = Arc::new(AppPaths::new(Some(test_dir("terminal-state"))));
        let database = Arc::new(cc_panes_core::repository::Database::new_fallback().expect("db"));
        let project_repo = Arc::new(cc_panes_core::repository::ProjectRepository::new(
            database.clone(),
        ));
        let todo_repo = Arc::new(cc_panes_core::repository::TodoRepository::new(
            database.clone(),
        ));
        let spec_repo = Arc::new(cc_panes_core::repository::SpecRepository::new(
            database.clone(),
        ));
        let task_binding_repo = Arc::new(cc_panes_core::repository::TaskBindingRepository::new(
            database.clone(),
        ));
        let history_repo = Arc::new(cc_panes_core::repository::HistoryRepository::new(
            database.clone(),
        ));
        let runner_repo = Arc::new(cc_panes_core::repository::RunnerRepository::new(
            database.clone(),
        ));
        let usage_stats_repo = Arc::new(cc_panes_core::repository::UsageStatsRepository::new(
            database.clone(),
        ));
        let todo_service = Arc::new(TodoService::new(todo_repo));
        let process_monitor_service = Arc::new(ProcessMonitorService::new());
        let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
        let launch_profile_service = Arc::new(
            cc_panes_core::services::LaunchProfileService::new_with_external_skill_registry(
                app_paths.launch_profiles_path(),
                Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
                    Arc::new(cc_cli_adapters::CliToolRegistry::new()),
                )),
            ),
        );
        let usage_stats_service = Arc::new(cc_panes_core::services::UsageStatsService::new(
            usage_stats_repo,
            launch_history_service.clone(),
        ));
        let memory_service =
            Arc::new(cc_panes_core::services::MemoryService::new_memory().expect("memory"));
        let ssh_machine_service = Arc::new(SshMachineService::new(
            app_paths.data_dir().join("ssh-machines.json"),
            Arc::new(SshCredentialService::new_memory()),
        ));
        let state = AppState {
            terminal_backend: backend,
            workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
            project_service: Arc::new(ProjectService::new(project_repo)),
            provider_service: Arc::new(ProviderService::new(app_paths.providers_path())),
            settings_service: Arc::new(SettingsService::new()),
            filesystem_service: Arc::new(FileSystemService::new()),
            todo_service: todo_service.clone(),
            spec_service: Arc::new(SpecService::new(spec_repo, todo_service)),
            task_binding_service: Arc::new(TaskBindingService::new(task_binding_repo)),
            launch_history_service,
            media_service: Arc::new(cc_panes_core::services::MediaService::new(Arc::new(
                cc_panes_core::repository::MediaRepository::new(database.clone()),
            ))),
            layout_snapshot_service: Arc::new(LayoutSnapshotService::new(database.clone())),
            drama_service: Arc::new(cc_panes_core::services::DramaService::new(database.clone())),
            launch_profile_service,
            quick_command_service: Arc::new(cc_panes_core::services::QuickCommandService::new(
                app_paths.quick_commands_path(),
            )),
            memory_service,
            ssh_machine_service,
            session_restore_service: Arc::new(SessionRestoreService::new(
                database.clone(),
                app_paths.clone(),
            )),
            history_service: Arc::new(HistoryService::new()),
            worktree_service: Arc::new(WorktreeService::new()),
            runner_service: Arc::new(RunnerService::new(
                runner_repo,
                process_monitor_service.clone(),
            )),
            process_monitor_service,
            project_cli_hooks_service: Arc::new(
                cc_panes_core::services::ProjectCliHooksService::new(Arc::new(
                    cc_cli_adapters::CliToolRegistry::new(),
                )),
            ),
            journal_service: Arc::new(cc_panes_core::services::JournalService::new(
                app_paths.workspaces_dir(),
            )),
            cli_registry: Arc::new(cc_cli_adapters::CliToolRegistry::new()),
            mcp_config_service: Arc::new(McpConfigService::new()),
            shared_mcp_service: Arc::new(SharedMcpService::new(&app_paths)),
            skill_service: Arc::new(cc_panes_core::services::SkillService::new()),
            plan_service: Arc::new(PlanService::new(
                app_paths.clone(),
                Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
            )),
            external_skill_registry: Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
                Arc::new(cc_cli_adapters::CliToolRegistry::new()),
            )),
            user_skill_service: Arc::new(cc_panes_core::services::UserSkillService::new(
                app_paths.user_skills_dir(),
            )),
            usage_stats_service,
            session_index_service: crate::state::test_session_index_service(
                app_paths.workspaces_dir(),
            ),
            ws_emitter: Arc::new(WsEmitter::new()),
            web_auth: Arc::new(crate::web_auth::WebAuthStore::default()),
            default_cwd: "/default/project".to_string(),
            output_mode: crate::state::TerminalOutputMode::Emitter,
        };
        (state, database)
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
    async fn create_session_binds_resolved_model_to_launch_history() {
        let backend = Arc::new(MockTerminalBackend::default());
        *backend.resolved_model_id.lock().unwrap() = Some("provider-default".to_string());
        let state = test_state(backend);
        state
            .launch_history_service
            .add(
                "launch-model",
                "Project",
                "/repo",
                "claude",
                "local",
                None,
                None,
                None,
                None,
                Some("provider-a"),
                None,
                None,
                None,
                None,
            )
            .expect("seed launch history");

        let request = CreateSessionRequest {
            core: PartialCreateSessionRequest {
                launch_id: Some("launch-model".to_string()),
                project_path: Some("/repo".to_string()),
                cli_tool: CliTool::Claude,
                provider_id: Some("provider-a".to_string()),
                ..Default::default()
            },
            cwd: None,
        };

        let _response = create_session(State(state.clone()), Json(request))
            .await
            .expect("create session");

        let record = state
            .launch_history_service
            .find_by_launch_id("launch-model")
            .expect("find launch history")
            .expect("launch history row");
        assert_eq!(record.pty_session_id.as_deref(), Some("created-session"));
        assert_eq!(record.model_id.as_deref(), Some("provider-default"));
    }

    fn restore_test_provenance() -> cc_panes_core::models::TerminalSessionProvenance {
        cc_panes_core::models::TerminalSessionProvenance {
            session_id: "session-1".to_string(),
            daemon_generation: 42,
            birth_nonce: "birth-1".to_string(),
            origin_instance_id: Some("instance-old".to_string()),
            origin_layout_id: Some("layout-origin".to_string()),
            origin_tab_id: Some("tab-origin".to_string()),
            origin_terminal_pane_id: Some("leaf-origin".to_string()),
            project_path: "/repo".to_string(),
            runtime_kind: "local".to_string(),
            cli_tool: "codex".to_string(),
            resume_id: Some("resume-1".to_string()),
            created_at_ms: 1,
        }
    }

    fn reused_session_request() -> CreateSessionRequest {
        CreateSessionRequest {
            core: PartialCreateSessionRequest {
                project_path: Some("/repo".to_string()),
                cols: Some(80),
                rows: Some(24),
                cli_tool: CliTool::Codex,
                resume_id: Some("resume-1".to_string()),
                origin_layout_id: Some("layout-current".to_string()),
                origin_tab_id: Some("tab-current".to_string()),
                origin_terminal_pane_id: Some("leaf-current".to_string()),
                expected_saved_session_id: Some("session-1".to_string()),
                ..Default::default()
            },
            cwd: None,
        }
    }

    #[tokio::test]
    async fn reused_session_keeps_existing_layout_observation() {
        let provenance = restore_test_provenance();
        let backend = Arc::new(MockTerminalBackend {
            created_session_id: Mutex::new(Some("session-1".to_string())),
            claims_supported: true,
            provenance: Mutex::new(Some(provenance.clone())),
            ..Default::default()
        });
        let state = test_state(backend.clone());
        let original_request: CoreCreateSessionRequest = serde_json::from_value(json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24,
            "cliTool": "codex",
            "resumeId": "resume-1"
        }))
        .expect("original request");
        let original = SavedSession::from_creation(&original_request, &provenance)
            .expect("original observation");
        state
            .session_restore_service
            .save_initial_observation(&original)
            .expect("save original observation");

        let (_, Json(response)) =
            create_session(State(state.clone()), Json(reused_session_request()))
                .await
                .expect("reuse session");

        assert_eq!(response.session_id, "session-1");
        let saved = state
            .session_restore_service
            .load_sessions()
            .expect("load sessions")
            .into_iter()
            .find(|session| session.session_id == "session-1")
            .expect("saved session");
        assert_eq!(saved.layout_id.as_deref(), Some("layout-origin"));
        assert_eq!(saved.tab_id, "tab-origin");
        assert_eq!(saved.terminal_pane_id.as_deref(), Some("leaf-origin"));
        assert!(backend.kills.lock().unwrap().is_empty());
        assert!(backend.releases.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn reused_session_persistence_failure_releases_without_killing_pty() {
        let backend = Arc::new(MockTerminalBackend {
            created_session_id: Mutex::new(Some("session-1".to_string())),
            claims_supported: true,
            provenance: Mutex::new(Some(restore_test_provenance())),
            ..Default::default()
        });
        let (state, database) = test_state_and_db(backend.clone());
        database
            .connection()
            .expect("database connection")
            .execute_batch("DROP TABLE terminal_session_provenance")
            .expect("drop provenance table");

        let error = match create_session(State(state), Json(reused_session_request())).await {
            Ok(_) => panic!("persistence failure must be returned"),
            Err(error) => error,
        };

        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            backend.releases.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
        assert!(backend.kills.lock().unwrap().is_empty());
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
    async fn create_session_preserves_backend_error_details() {
        let backend = Arc::new(MockTerminalBackend::default());
        *backend.create_error.lock().unwrap() = Some(AppError::coded_with_params(
            "PATH_NOT_FOUND",
            "Launch directory does not exist: /missing/repo",
            std::collections::HashMap::from([("path".to_string(), "/missing/repo".to_string())]),
        ));
        let state = test_state(backend);
        let request = CreateSessionRequest {
            core: PartialCreateSessionRequest {
                project_path: Some("/missing/repo".to_string()),
                ..Default::default()
            },
            cwd: None,
        };

        let error = match create_session(State(state), Json(request)).await {
            Ok(_) => panic!("backend launch error must be returned"),
            Err(error) => error,
        };

        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.1.contains("PATH_NOT_FOUND"));
        assert!(error.1.contains("/missing/repo"));
    }

    #[tokio::test]
    async fn adopt_session_releases_claim_when_snapshot_fails() {
        let backend = Arc::new(MockTerminalBackend {
            claims_supported: true,
            adoption_snapshot_error: Mutex::new(Some(AppError::from("snapshot failed"))),
            ..Default::default()
        });
        let state = test_state(backend.clone());

        let error = adopt_session(State(state), Path("session-1".to_string()))
            .await
            .expect_err("snapshot error must be returned");

        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.1.contains("snapshot failed"));
        assert_eq!(
            backend.releases.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
    }

    #[tokio::test]
    async fn adopt_session_releases_claim_when_observation_transfer_fails() {
        let backend = Arc::new(MockTerminalBackend {
            claims_supported: true,
            adoption_owner: Mutex::new(Some("owner-1".to_string())),
            ..Default::default()
        });
        let (state, database) = test_state_and_db(backend.clone());
        database
            .connection()
            .expect("database connection")
            .execute_batch("DROP TABLE terminal_sessions")
            .expect("drop terminal sessions table");

        let error = adopt_session(State(state), Path("session-1".to_string()))
            .await
            .expect_err("observation transfer error must be returned");

        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error
            .1
            .contains("Failed to transfer terminal observation owner"));
        assert_eq!(
            backend.releases.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
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
                    // 缺省 = 用户输入，走普通 write 而非受回显判定的 write_reply。
                    source: None,
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

    #[test]
    fn late_cleanup_releases_reused_session_and_kills_fresh_session() {
        let reused_backend = MockTerminalBackend::default();
        cleanup_late_session(
            &reused_backend,
            CreateSessionOutcome {
                session_id: "reused".to_string(),
                reused_existing: true,
                resolved_model_id: None,
            },
        )
        .expect("release reused session");
        assert_eq!(
            reused_backend.releases.lock().unwrap().as_slice(),
            &["reused"]
        );
        assert!(reused_backend.kills.lock().unwrap().is_empty());

        let fresh_backend = MockTerminalBackend::default();
        cleanup_late_session(
            &fresh_backend,
            CreateSessionOutcome {
                session_id: "fresh".to_string(),
                reused_existing: false,
                resolved_model_id: None,
            },
        )
        .expect("kill fresh session");
        assert_eq!(fresh_backend.kills.lock().unwrap().as_slice(), &["fresh"]);
        assert!(fresh_backend.releases.lock().unwrap().is_empty());
    }
}
