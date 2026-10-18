//! Failed dispatches must re-enter durable dispatch, not bypass it with a bare PTY.
use super::*;
use cc_panes_core::models::TaskDispatchMode;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Default)]
pub(super) struct RetryGate(Mutex<HashSet<String>>);

pub(super) struct RetryClaim<'a> {
    gate: &'a RetryGate,
    id: String,
}

impl RetryGate {
    fn enter(&self, id: &str) -> Result<RetryClaim<'_>, String> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !active.insert(id.to_owned()) {
            return Err("This task is already being retried".into());
        }
        Ok(RetryClaim {
            gate: self,
            id: id.to_owned(),
        })
    }
}
impl Drop for RetryClaim<'_> {
    fn drop(&mut self) {
        self.gate
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

pub(super) const RETRY_PATH: &str = "/api/retry-dispatched-task";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RetryRequest {
    binding_id: String,
}

impl OrchestratorService {
    pub async fn retry_dispatched_task(&self, binding_id: &str) -> Result<TaskBinding, String> {
        let running = self
            .cancel_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|cancel| !*cancel.borrow());
        let port = ready_port(&self.status(), running)?;
        // Enter through HTTP so the request runs on the dispatcher runtime and
        // participates in its existing graceful-shutdown request drain. Never
        // drop a dispatch future while a blocking PTY create can still complete.
        let response = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?
            .post(format!("http://127.0.0.1:{port}{RETRY_PATH}"))
            .bearer_auth(&self.token)
            .json(&RetryRequest {
                binding_id: binding_id.to_owned(),
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Task retry failed")
                .to_string());
        }
        serde_json::from_value(body).map_err(|e| e.to_string())
    }
}

fn ready_port(status: &OrchestratorStatus, running: bool) -> Result<u16, String> {
    if !running || status.lifecycle != OrchestratorLifecycle::Ready {
        return Err("Task dispatcher is not ready".into());
    }
    status
        .port
        .ok_or_else(|| "Task dispatcher has no listening port".into())
}

pub(super) async fn handle_retry(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(request): Json<RetryRequest>,
) -> (StatusCode, Json<Value>) {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Invalid or missing Bearer token"})),
        );
    }
    let _claim = match state.retry_gate.enter(&request.binding_id) {
        Ok(claim) => claim,
        Err(error) => return (StatusCode::CONFLICT, Json(json!({"error":error}))),
    };
    match McpToolHandler::new(state.clone())
        .retry_binding(&request.binding_id)
        .await
    {
        Ok(binding) => (StatusCode::OK, Json(json!(binding))),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))),
    }
}

fn validate_retry_workspace(
    launch: &McpLaunchTaskParams,
    workspaces: &WorkspaceService,
) -> Result<(), String> {
    let Some(name) = launch.workspace_name.as_deref() else {
        return Ok(());
    };
    let workspace = workspaces.get_workspace(name)?;
    if !workspace
        .projects
        .iter()
        .any(|project| normalize_path(&project.path) == normalize_path(&launch.project_path))
    {
        return Err(format!(
            "Original workspace '{name}' no longer contains this project"
        ));
    }
    Ok(())
}

impl McpToolHandler {
    async fn retry_binding(&self, binding_id: &str) -> Result<TaskBinding, String> {
        let service = &self.state.task_binding_service;
        let original = service
            .get(binding_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Task binding no longer exists".to_string())?;
        let launch = retry_params(&original)?;
        validate_retry_workspace(&launch, &self.state.workspace_service)?;
        if let Some(previous_id) = original
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/ui/retryBindingId"))
            .and_then(Value::as_str)
        {
            if let Some(previous) = service.get(previous_id).map_err(|e| e.to_string())? {
                if previous.status != TaskBindingStatus::Failed {
                    return Ok(previous);
                }
            }
        }
        // This path assigns fresh task/binding/session identities and performs
        // the normal runtime/profile resolution, readiness and MCP environment setup.
        let response = self
            .run_durable_dispatch(launch, Extensions::default())
            .await;
        let receipt: Value = serde_json::from_str(&response).map_err(|_| response.clone())?;
        let next_id = receipt
            .get("bindingId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Task retry failed: {response}"))?;
        let next = service
            .get(next_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Retried task binding is unavailable".to_string())?;
        let next = service
            .update_patch(next_id, json!({"metadata":{"ui":{"retryOf":binding_id}}}))
            .unwrap_or_else(|error| {
                warn!(%error, next_id, "retry launched but child annotation failed");
                next
            });
        // A metadata failure after launch must not encourage an accidental second
        // execution: return the live child and let normal state sync reconcile it.
        if let Err(error) = service.update_patch(
            binding_id,
            json!({"metadata":{"ui":{
                "retriedAt":chrono::Utc::now().timestamp_millis(), "retryBindingId":next_id
            }}}),
        ) {
            warn!(%error, binding_id, "retry launched but parent annotation failed");
        }
        Ok(next)
    }
}

fn retry_params(binding: &TaskBinding) -> Result<McpLaunchTaskParams, String> {
    if binding.status != TaskBindingStatus::Failed {
        return Err("Only failed tasks can be retried".into());
    }
    let envelope = dispatch_envelope_from_binding(binding)?;
    let (prompt, resume_id) = match envelope.mode {
        TaskDispatchMode::Prompt => (binding.prompt.clone(), None),
        TaskDispatchMode::Resume => (None, envelope.resume_id.clone()),
    };
    if prompt
        .as_deref()
        .or(resume_id.as_deref())
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err("The original task has no prompt or resume identity".into());
    }
    if envelope.binding_id.as_deref() != Some(binding.id.as_str()) {
        return Err("The original dispatch envelope does not match this task".into());
    }
    serde_json::from_value(json!({
        "projectPath":envelope.project_path, "workspaceName":envelope.workspace_name,
        "cliTool":envelope.resolved_cli_tool, "profileId":envelope.profile_id,
        "runtimeKind":envelope.runtime_kind, "cwd":envelope.cwd,
        "modelId":envelope.model_id, "permissionMode":envelope.permission_mode,
        "providerId":envelope.provider_id, "providerSelection":envelope.provider_selection,
        "parentBindingId":envelope.parent_binding_id,
        // Parent binding is stable; resolve its current session instead of replaying a stale PTY id.
        "parentSessionId":if envelope.parent_binding_id.is_none() { envelope.parent_session_id } else { None },
        "title":binding.title, "prompt":prompt, "resumeId":resume_id,
        "placement":"beside"
    })).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed_binding() -> TaskBinding {
        serde_json::from_value(json!({
            "id":"failed", "title":"implement", "role":"worker", "projectPath":"/repo", "cliTool":"codex",
            "status":"failed", "progress":0, "sortOrder":0, "createdAt":"now", "updatedAt":"now",
            "prompt":"original task", "metadata":{"dispatchEnvelope":{
                "version":1,"taskId":"old-task","bindingId":"failed","mode":"prompt","resolvedCliTool":"codex",
                "projectPath":"/repo","workspaceName":"workspace","profileId":"profile","runtimeKind":"wsl",
                "cwd":"/repo/subdir","permissionMode":"default","modelId":"chosen-model",
                "providerId":"provider","providerSelection":"explicit",
                "parentBindingId":"leader","parentSessionId":"old-parent-pty",
                "mcp":{"supported":true,"canControlOrchestration":true,"canReportResult":true}
            }}
        })).unwrap()
    }

    #[test]
    fn retry_retains_configuration_and_gets_fresh_dispatch_ids() {
        let binding = failed_binding();
        let retry = retry_params(&binding).unwrap();
        assert_eq!(retry.runtime_kind.as_deref(), Some("wsl"));
        assert_eq!(retry.profile_id.as_deref(), Some("profile"));
        assert_eq!(retry.cwd.as_deref(), Some("/repo/subdir"));
        assert_eq!(retry.model_id.as_deref(), Some("chosen-model"));
        assert_eq!(retry.permission_mode.as_deref(), Some("default"));
        assert_eq!(retry.provider_id.as_deref(), Some("provider"));
        assert_eq!(retry.provider_selection.as_deref(), Some("explicit"));
        assert_eq!(retry.parent_binding_id.as_deref(), Some("leader"));
        assert!(retry.parent_session_id.is_none());
        assert!(retry.dispatch_binding_id.is_none());
        assert!(retry.dispatch_task_id.is_none());
        assert_eq!(retry.prompt.as_deref(), Some("original task"));
        let plan = TaskDispatchService::default()
            .plan(TaskDispatchRequest {
                cli_tool: retry.cli_tool,
                project_path: retry.project_path,
                prompt: retry.prompt,
                ..Default::default()
            })
            .unwrap();
        assert_ne!(plan.envelope.task_id, "old-task");
        assert!(plan.envelope.binding_id.is_none());
    }

    #[test]
    fn retry_resume_does_not_turn_into_a_new_prompt_task() {
        let mut binding = failed_binding();
        let envelope = &mut binding.metadata.as_mut().unwrap()["dispatchEnvelope"];
        envelope["mode"] = json!("resume");
        envelope["resumeId"] = json!("conversation");
        let retry = retry_params(&binding).unwrap();
        assert_eq!(retry.resume_id.as_deref(), Some("conversation"));
        assert!(retry.prompt.is_none());
        binding.status = TaskBindingStatus::Running;
        assert!(retry_params(&binding).is_err());
    }

    #[test]
    fn retry_requires_ready_service_and_stops_accepting_requests_on_shutdown() {
        let mut status = OrchestratorStatus::default();
        assert!(ready_port(&status, true).is_err());
        status.lifecycle = OrchestratorLifecycle::Ready;
        status.port = Some(12345);
        assert_eq!(ready_port(&status, true).unwrap(), 12345);
        assert!(ready_port(&status, false).is_err());
    }

    #[tokio::test]
    async fn retry_is_drained_by_http_shutdown_instead_of_detaching_a_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(Some(dir.path().to_string_lossy().into_owned()));
        let service = Arc::new(OrchestratorService::new(&paths));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        {
            let mut status = service.status.lock().unwrap();
            status.lifecycle = OrchestratorLifecycle::Ready;
            status.port = Some(port);
        }
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        *service.cancel_tx.lock().unwrap() = Some(cancel);
        let entered = Arc::new(tokio::sync::Notify::new());
        let complete = Arc::new(tokio::sync::Notify::new());
        let expected_token = service.token.clone();
        let entered_request = entered.clone();
        let complete_request = complete.clone();
        let app = Router::new().route(
            RETRY_PATH,
            post(
                move |headers: HeaderMap, Json(request): Json<RetryRequest>| {
                    let entered = entered_request.clone();
                    let complete = complete_request.clone();
                    let token = expected_token.clone();
                    async move {
                        assert!(verify_token(&headers, &token));
                        assert_eq!(request.binding_id, "failed");
                        entered.notify_one();
                        complete.notified().await;
                        Json(failed_binding())
                    }
                },
            ),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = cancelled.changed().await;
                })
                .await
                .unwrap();
        });
        let caller = service.clone();
        let request = tokio::spawn(async move { caller.retry_dispatched_task("failed").await });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        service.shutdown();
        assert!(service.retry_dispatched_task("failed").await.is_err());
        assert!(!request.is_finished());
        assert!(!server.is_finished());
        complete.notify_one();
        assert_eq!(request.await.unwrap().unwrap().id, "failed");
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn deleted_or_reassigned_workspace_never_falls_back_to_another_environment() {
        let dir = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new(dir.path().join("workspaces"));
        service.create_workspace("other", None).unwrap();
        service.add_project("other", "/repo").unwrap();
        let launch = retry_params(&failed_binding()).unwrap();
        assert!(validate_retry_workspace(&launch, &service).is_err());
        service.create_workspace("workspace", None).unwrap();
        service
            .add_project("workspace", "/different-project")
            .unwrap();
        assert!(validate_retry_workspace(&launch, &service).is_err());
        service.add_project("workspace", "/repo").unwrap();
        assert!(validate_retry_workspace(&launch, &service).is_ok());
    }

    #[test]
    fn duplicate_retry_is_blocked_until_previous_attempt_finishes() {
        let gate = RetryGate::default();
        let claim = gate.enter("task").unwrap();
        assert!(gate.enter("task").is_err());
        assert!(gate.enter("different-task").is_ok());
        drop(claim);
        assert!(gate.enter("task").is_ok());
    }
}
