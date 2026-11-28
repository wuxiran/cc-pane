//! Staged workflows (docs/114): MCP tools, structured-result helpers and the driver.
//!
//! The driver is a single consumer task per orchestrator run. It is woken by
//! workflow creation/approval, by child TaskBindings reaching a terminal status,
//! and by a slow safety tick. All dispatch goes through `run_durable_dispatch`.
use super::*;
use cc_panes_core::models::workflow::{
    CreateWorkflowRequest, StageSelector, Workflow, WorkflowStageSpec, WorkflowStatus,
};
use cc_panes_core::services::{json_schema_lite, workflow_engine, DispatchJob, WorkflowService};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const RESULT_MAX_BYTES: usize = 32 * 1024;
const SAFETY_TICK: std::time::Duration = std::time::Duration::from_secs(60);
pub(crate) const WORKFLOW_CHANGED_EVENT: &str = "workflow-changed";
const WORKFLOW_OWNED_KEY: &str = "workflowOwned";

fn stages_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "items": { "type": "object" } })
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpCreateWorkflowParams {
    /// [{key, requiresApproval?, tasks:[{key, prompt, cliTool?, projectPath?, pool?, resultSchema?}]}]。
    /// prompt 可引用 {{prev}} / {{stages.<key>[.<task>]}}
    #[schemars(schema_with = "stages_schema")]
    stages: Value,
    /// 并发上限，如 {"codex":2}；pool 缺省取 cliTool
    pools: Option<BTreeMap<String, u32>>,
    /// 父 TaskBinding；省略则新建（需 projectPath）
    parent_binding_id: Option<String>,
    /// 新建父任务的项目，也是子任务默认项目
    project_path: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpApproveStageParams {
    workflow_id: String,
    stage_key: Option<String>,
    stage_index: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpWorkflowIdParams {
    workflow_id: String,
}

fn workflow_service(state: &AppState) -> Result<Arc<WorkflowService>, String> {
    state
        .app_handle
        .try_state::<Arc<WorkflowService>>()
        .map(|service| service.inner().clone())
        .ok_or_else(|| "workflow service unavailable".to_string())
}

#[tool_router(router = workflow_tool_router, vis = "pub(super)")]
impl McpToolHandler {
    /// 建多阶段工作流：阶段串行，阶段内并行合流，可设审批点与并发池。返回 workflowId（= 父 bindingId）。
    #[tool]
    async fn create_workflow(
        &self,
        Parameters(params): Parameters<McpCreateWorkflowParams>,
        extensions: Extensions,
    ) -> String {
        match self.create_workflow_impl(params, &extensions) {
            Ok(workflow) => workflow_status_json(&workflow).to_string(),
            Err(error) => format!("错误: {error}"),
        }
    }

    /// 批准等待审批的阶段（stageKey 或 stageIndex），重复批准无副作用。
    #[tool]
    async fn approve_stage(&self, Parameters(params): Parameters<McpApproveStageParams>) -> String {
        let selector = match (params.stage_key, params.stage_index) {
            (Some(key), _) => StageSelector::Key(key),
            (None, Some(index)) => StageSelector::Index(index),
            (None, None) => return "错误: 需要 stageKey 或 stageIndex".to_string(),
        };
        let result = workflow_service(&self.state).and_then(|service| {
            service
                .approve_stage(&params.workflow_id, selector, "mcp")
                .map_err(|error| error.to_string())
        });
        match result {
            Ok(workflow) => workflow_status_json(&workflow).to_string(),
            Err(error) => format!("错误: {error}"),
        }
    }

    /// 工作流状态：各阶段 / 子任务的状态、bindingId 与结构化结果。
    #[tool]
    async fn get_workflow_status(
        &self,
        Parameters(params): Parameters<McpWorkflowIdParams>,
    ) -> String {
        let result = workflow_service(&self.state).and_then(|service| {
            service
                .get(&params.workflow_id)
                .map_err(|error| error.to_string())
        });
        match result {
            Ok(Some(workflow)) => workflow_status_json(&workflow).to_string(),
            Ok(None) => format!("错误: 工作流 '{}' 不存在", params.workflow_id),
            Err(error) => format!("错误: {error}"),
        }
    }
}

impl McpToolHandler {
    fn create_workflow_impl(
        &self,
        params: McpCreateWorkflowParams,
        extensions: &Extensions,
    ) -> Result<Workflow, String> {
        let service = workflow_service(&self.state)?;
        let stages: Vec<WorkflowStageSpec> = serde_json::from_value(params.stages)
            .map_err(|error| format!("stages 格式错误: {error}"))?;
        let pools = params.pools.unwrap_or_default();
        // Validate before creating a parent binding so a bad request leaves nothing behind.
        workflow_engine::validate_create(&CreateWorkflowRequest {
            workflow_id: "pending".into(),
            stages: stages.clone(),
            pools: pools.clone(),
        })?;
        let parent = match params.parent_binding_id {
            Some(id) => self
                .state
                .task_binding_service
                .get(&id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("父任务绑定 '{id}' 不存在"))?,
            None => self.create_workflow_parent(params.project_path, params.title, extensions)?,
        };
        let request = CreateWorkflowRequest {
            workflow_id: parent.id.clone(),
            stages: with_default_project(stages, &parent.project_path),
            pools,
        };
        service.create(request).map_err(|error| error.to_string())
    }

    fn create_workflow_parent(
        &self,
        project_path: Option<String>,
        title: Option<String>,
        extensions: &Extensions,
    ) -> Result<TaskBinding, String> {
        let project_path = project_path
            .filter(|path| !path.trim().is_empty())
            .ok_or("省略 parentBindingId 时必须提供 projectPath")?;
        if !is_project_registered(&self.state, &project_path) {
            return Err(format!("项目路径 '{project_path}' 未注册"));
        }
        // The caller's session receives worker reports; absent for UI / REST callers.
        let session_id =
            resolve_caller_session_id_for(&self.state, extensions, "create_workflow").ok();
        let binding = self
            .state
            .task_binding_service
            .create(CreateTaskBindingRequest {
                title: title
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or_else(|| "Workflow".to_string()),
                role: Some(TaskBindingRole::Task),
                parent_id: None,
                plan_path: None,
                normalized_plan_path: None,
                prompt: None,
                session_id,
                resume_id: None,
                pane_id: None,
                tab_id: None,
                todo_id: None,
                workspace_name: self.workspace_of_project(&project_path),
                project_path,
                cli_tool: None,
                worker_kind: None,
                metadata: Some(json!({ WORKFLOW_OWNED_KEY: true })),
            })
            .map_err(|error| error.to_string())?;
        self.state
            .task_binding_service
            .update(
                &binding.id,
                UpdateTaskBindingRequest {
                    status: Some(TaskBindingStatus::Running),
                    ..Default::default()
                },
            )
            .map_err(|error| error.to_string())
    }
}

fn with_default_project(
    mut stages: Vec<WorkflowStageSpec>,
    project_path: &str,
) -> Vec<WorkflowStageSpec> {
    for task in stages.iter_mut().flat_map(|stage| stage.tasks.iter_mut()) {
        if task
            .project_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
        {
            task.project_path = Some(project_path.to_string());
        }
    }
    stages
}

/// Compact status for agents: no prompts / specs, only progress and results.
pub(super) fn workflow_status_json(workflow: &Workflow) -> Value {
    let stages: Vec<Value> = workflow
        .stages
        .iter()
        .map(|stage| {
            let tasks: Vec<Value> = stage
                .tasks
                .iter()
                .map(|task| {
                    let mut item =
                        json!({"key": task.key, "status": task.status, "pool": task.pool});
                    if let Some(id) = &task.binding_id {
                        item["bindingId"] = json!(id);
                    }
                    if let Some(result) = &task.result {
                        item["result"] = result.clone();
                    }
                    if let Some(error) = &task.error {
                        item["error"] = json!(error);
                    }
                    item
                })
                .collect();
            let mut item = json!({
                "index": stage.index, "key": stage.key, "status": stage.status,
                "requiresApproval": stage.requires_approval, "tasks": tasks,
            });
            if let Some(at) = &stage.approved_at {
                item["approvedAt"] = json!(at);
            }
            if let Some(error) = &stage.error {
                item["error"] = json!(error);
            }
            item
        })
        .collect();
    json!({"workflowId": workflow.id, "status": workflow.status, "stages": stages})
}

// ============ structured results ============

/// Reject a malformed `resultSchema` before anything is created.
pub(super) fn check_result_schema(launch: &McpLaunchTaskParams) -> Result<(), String> {
    match launch.result_schema.as_ref() {
        Some(schema) => json_schema_lite::check_schema(schema),
        None => Ok(()),
    }
}

/// Tell the worker how to hand back its result. No-op without a schema.
pub(super) fn append_result_instruction(launch: &mut McpLaunchTaskParams, binding_id: &str) {
    let (Some(schema), Some(prompt)) = (launch.result_schema.as_ref(), launch.prompt.as_mut())
    else {
        return;
    };
    prompt.push_str(&workflow_engine::result_instruction(binding_id, schema));
}

fn validate_result(binding: &TaskBinding, result: &Value) -> Result<(), String> {
    if result.to_string().len() > RESULT_MAX_BYTES {
        return Err(format!("result 超过 {RESULT_MAX_BYTES} 字节"));
    }
    let schema = binding
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("resultSchema"));
    match schema {
        Some(schema) => json_schema_lite::validate(schema, result)
            .map_err(|errors| format!("result 不符合 resultSchema: {}", errors.join("; "))),
        None => Ok(()),
    }
}

/// Metadata for an update that carries `result`: validated, merged under `result`.
/// Without a result the caller's metadata passes through untouched.
pub(super) fn merge_validated_result(
    bindings: &crate::services::TaskBindingService,
    id: &str,
    metadata: Option<Value>,
    result: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(result) = result else {
        return Ok(metadata);
    };
    let binding = bindings
        .get(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("TaskBinding '{id}' 不存在"))?;
    validate_result(&binding, &result)?;
    let mut merged = metadata
        .or(binding.metadata)
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    merged["result"] = result;
    Ok(Some(merged))
}

/// Validate and persist a result without touching status (report_to_leader).
pub(super) fn store_validated_result(
    bindings: &crate::services::TaskBindingService,
    id: &str,
    result: Value,
) -> Result<(), String> {
    let metadata = merge_validated_result(bindings, id, None, Some(result))?;
    bindings
        .update(
            id,
            UpdateTaskBindingRequest {
                metadata,
                ..Default::default()
            },
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// The single line submitted to the leader; carries the structured result when present.
pub(super) fn worker_report_line(worker: &TaskBinding, summary: &str) -> String {
    let mut line = format!(
        "[worker-report] id={} status={} summary={}",
        worker.id, worker.status, summary
    );
    if let Some(result) = worker.metadata.as_ref().and_then(|m| m.get("result")) {
        line.push_str(" result=");
        line.push_str(&sanitize_pty_line(&result.to_string(), 500));
    }
    line
}

// ============ driver ============

/// Launch parameters for one workflow job (same durable path as dispatch_task).
fn launch_params_for(job: &DispatchJob) -> Result<McpLaunchTaskParams, String> {
    let spec = &job.spec;
    let project_path = spec
        .project_path
        .clone()
        .ok_or("workflow task has no projectPath")?;
    let mut launch: McpLaunchTaskParams = serde_json::from_value(json!({
        "projectPath": project_path,
        "prompt": job.prompt,
        "title": spec.title.clone().unwrap_or_else(|| format!("{} · {}", job.stage_key, job.task_key)),
        "cliTool": spec.cli_tool, "modelId": spec.model_id, "profileId": spec.profile_id,
        "workspaceName": spec.workspace_name, "permissionMode": spec.permission_mode,
        "parentBindingId": job.workflow_id,
        "placement": "tab",
        "resultSchema": spec.result_schema,
    }))
    .map_err(|error| error.to_string())?;
    launch.binding_metadata = Some(job.receipt_metadata());
    Ok(launch)
}

fn binding_id_from_response(response: &str) -> Option<String> {
    serde_json::from_str::<Value>(response)
        .ok()?
        .get("bindingId")?
        .as_str()
        .map(str::to_string)
}

/// Install wakers and start the driver. Returns None when the service is not managed.
pub(super) fn spawn_workflow_driver(
    state: AppState,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    let Ok(service) = workflow_service(&state) else {
        warn!("[workflow] service not managed; staged workflows disabled");
        return None;
    };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let waker = tx.clone();
    service.set_waker(Arc::new(move |id: &str| {
        let _ = waker.send(id.to_string());
    }));
    state
        .task_binding_service
        .set_terminal_observer(Arc::new(move |binding: &TaskBinding| {
            if let Some(parent) = &binding.parent_id {
                let _ = tx.send(parent.clone());
            }
        }));
    Some(tokio::spawn(run_driver(state, service, rx, cancel)))
}

async fn run_driver(
    state: AppState,
    service: Arc<WorkflowService>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    // Recovery strictly precedes any dispatch in this process (docs/114 §6).
    match service.recover_claims(&state.task_binding_service) {
        Ok(ids) if !ids.is_empty() => info!(count = ids.len(), "[workflow] recovered claims"),
        Ok(_) => {}
        Err(error) => warn!(%error, "[workflow] claim recovery failed"),
    }
    let mut pending = BTreeSet::new();
    enqueue_active(&service, &mut pending);
    let mut tick = tokio::time::interval(SAFETY_TICK);
    tick.tick().await;
    loop {
        while let Some(id) = pending.pop_first() {
            if *cancel.borrow() {
                return;
            }
            advance_one(&state, &service, &id).await;
            while let Ok(id) = rx.try_recv() {
                pending.insert(id);
            }
        }
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return;
                }
            }
            _ = tick.tick() => enqueue_active(&service, &mut pending),
            id = rx.recv() => match id {
                Some(id) => { pending.insert(id); }
                None => return,
            },
        }
    }
}

fn enqueue_active(service: &WorkflowService, pending: &mut BTreeSet<String>) {
    match service.list(true, 200) {
        Ok(workflows) => pending.extend(workflows.into_iter().map(|workflow| workflow.id)),
        Err(error) => warn!(%error, "[workflow] listing active workflows failed"),
    }
}

async fn advance_one(state: &AppState, service: &WorkflowService, id: &str) {
    let outcome = match service.advance(id, &state.task_binding_service) {
        Ok(Some(outcome)) => outcome,
        Ok(None) => return,
        Err(error) => {
            warn!(workflow_id = %id, %error, "[workflow] advance failed");
            return;
        }
    };
    if let Some(index) = outcome.entered_approval {
        notify_approval(state, &outcome.workflow, index);
    }
    if outcome.workflow.status.is_terminal() {
        finish_owned_parent(state, &outcome.workflow);
    }
    let changed = outcome.changed || !outcome.jobs.is_empty();
    for job in &outcome.jobs {
        dispatch_job(state, service, job).await;
    }
    if changed {
        emit_changed(state, id);
    }
}

async fn dispatch_job(state: &AppState, service: &WorkflowService, job: &DispatchJob) {
    info!(workflow_id = %job.workflow_id, stage = job.stage_index, task = %job.task_key, "[workflow] dispatch");
    let settled = match launch_params_for(job) {
        Err(error) => service.dispatch_failed(job, &error),
        Ok(launch) => {
            let response = McpToolHandler::new(state.clone())
                .run_durable_dispatch(launch, Extensions::default())
                .await;
            match binding_id_from_response(&response) {
                Some(binding_id) => service.dispatch_succeeded(job, &binding_id),
                None => service.dispatch_failed(job, &bounded_dispatch_error(&response)),
            }
        }
    };
    if let Err(error) = settled {
        warn!(workflow_id = %job.workflow_id, task = %job.task_key, %error, "[workflow] settle failed");
    }
}

fn notify_approval(state: &AppState, workflow: &Workflow, index: u32) {
    let stage = workflow.stages.get(index as usize);
    let title = state
        .task_binding_service
        .get(&workflow.id)
        .ok()
        .flatten()
        .map(|binding| binding.title)
        .unwrap_or_else(|| "Workflow".into());
    let request = serde_json::from_value::<crate::services::NotificationRequest>(json!({
        "kind": "workflow_approval",
        "title": "Workflow approval needed",
        "body": format!("{title} · {}", stage.map(|s| s.key.as_str()).unwrap_or("?")),
        "source": "workflow",
        "dedupeKey": format!("workflow_approval:{}:{index}", workflow.id),
    }));
    let result = request
        .map_err(|error| error.to_string())
        .and_then(|request| {
            state
                .notification_service
                .trigger(&state.app_handle, &state.settings_service, request)
        });
    if let Err(error) = result {
        warn!(workflow_id = %workflow.id, %error, "[workflow] approval notification failed");
    }
}

/// A parent created by create_workflow mirrors the workflow's terminal outcome.
fn finish_owned_parent(state: &AppState, workflow: &Workflow) {
    let Ok(Some(parent)) = state.task_binding_service.get(&workflow.id) else {
        return;
    };
    let owned = parent
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(WORKFLOW_OWNED_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !owned
        || matches!(
            parent.status,
            TaskBindingStatus::Completed | TaskBindingStatus::Failed
        )
    {
        return;
    }
    let (status, summary) = match workflow.status {
        WorkflowStatus::Done => (TaskBindingStatus::Completed, "workflow done".to_string()),
        _ => (
            TaskBindingStatus::Failed,
            workflow
                .stages
                .iter()
                .find_map(|stage| stage.error.clone())
                .unwrap_or_else(|| "workflow failed".into()),
        ),
    };
    if let Err(error) = state.task_binding_service.update(
        &workflow.id,
        UpdateTaskBindingRequest {
            status: Some(status),
            completion_summary: Some(summary),
            ..Default::default()
        },
    ) {
        warn!(workflow_id = %workflow.id, %error, "[workflow] parent status sync failed");
    }
}

fn emit_changed(state: &AppState, id: &str) {
    use tauri::Emitter;
    let _ = state
        .app_handle
        .emit(WORKFLOW_CHANGED_EVENT, json!({ "id": id }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::models::workflow::WorkflowTaskSpec;

    fn job(spec: WorkflowTaskSpec) -> DispatchJob {
        DispatchJob {
            workflow_id: "wf".into(),
            stage_index: 1,
            stage_key: "impl".into(),
            task_key: "rust".into(),
            prompt: "rendered".into(),
            spec,
        }
    }

    #[test]
    fn workflow_jobs_dispatch_through_the_durable_path_with_a_receipt() {
        let launch = launch_params_for(&job(WorkflowTaskSpec {
            key: "rust".into(),
            prompt: "template".into(),
            project_path: Some("/repo".into()),
            cli_tool: Some("codex".into()),
            result_schema: Some(json!({"type": "object"})),
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(launch.parent_binding_id.as_deref(), Some("wf"));
        assert_eq!(launch.prompt.as_deref(), Some("rendered"));
        assert_eq!(launch.title.as_deref(), Some("impl · rust"));
        assert_eq!(launch.cli_tool.as_deref(), Some("codex"));
        assert_eq!(launch.result_schema, Some(json!({"type": "object"})));
        assert_eq!(
            launch.binding_metadata.unwrap()["workflowTask"],
            json!({"workflowId": "wf", "stageIndex": 1, "taskKey": "rust"})
        );
        assert!(launch_params_for(&job(WorkflowTaskSpec::default())).is_err());
    }

    #[test]
    fn dispatch_without_schema_is_unchanged() {
        let mut launch: McpLaunchTaskParams =
            serde_json::from_value(json!({"projectPath": "/repo", "prompt": "hi"})).unwrap();
        assert!(check_result_schema(&launch).is_ok());
        append_result_instruction(&mut launch, "b1");
        assert_eq!(launch.prompt.as_deref(), Some("hi"));
        let envelope: TaskDispatchEnvelope = serde_json::from_value(json!({
            "version": 1, "taskId": "t", "mode": "prompt", "resolvedCliTool": "claude",
            "projectPath": "/repo",
            "mcp": {"supported": true, "canControlOrchestration": true, "canReportResult": true}
        }))
        .unwrap();
        assert_eq!(
            dispatch_binding_metadata_with(&envelope, None, None),
            dispatch_binding_metadata(&envelope)
        );
    }

    #[test]
    fn schema_dispatch_appends_instruction_and_records_schema() {
        let mut launch: McpLaunchTaskParams = serde_json::from_value(json!({
            "projectPath": "/repo", "prompt": "hi", "resultSchema": {"type": "object"}
        }))
        .unwrap();
        append_result_instruction(&mut launch, "b1");
        let prompt = launch.prompt.clone().unwrap();
        assert!(prompt.starts_with("hi\n\n---\n"));
        assert!(prompt.contains("id=\"b1\""));
        let bad: McpLaunchTaskParams = serde_json::from_value(json!({
            "projectPath": "/repo", "prompt": "hi", "resultSchema": "string"
        }))
        .unwrap();
        assert!(check_result_schema(&bad).is_err());
    }

    #[test]
    fn report_line_carries_the_structured_result() {
        let mut worker: TaskBinding = serde_json::from_value(json!({
            "id": "w", "title": "t", "role": "worker", "projectPath": "/repo", "cliTool": "codex",
            "status": "completed", "progress": 100, "sortOrder": 0,
            "createdAt": "now", "updatedAt": "now"
        }))
        .unwrap();
        assert_eq!(
            worker_report_line(&worker, "ok"),
            "[worker-report] id=w status=completed summary=ok"
        );
        worker.metadata = Some(json!({"result": {"pr": 7}}));
        assert!(worker_report_line(&worker, "ok").ends_with(r#" result={"pr":7}"#));
    }

    #[test]
    fn response_binding_id_is_extracted_only_from_success_json() {
        assert_eq!(
            binding_id_from_response(r#"{"bindingId":"b"}"#).as_deref(),
            Some("b")
        );
        assert!(binding_id_from_response("错误: 项目未注册").is_none());
    }

    #[test]
    fn default_project_fills_only_missing_paths() {
        let stages: Vec<WorkflowStageSpec> = serde_json::from_value(json!([{"key": "s", "tasks": [
            {"key": "a", "prompt": "a"}, {"key": "b", "prompt": "b", "projectPath": "/other"}
        ]}]))
        .unwrap();
        let filled = with_default_project(stages, "/repo");
        assert_eq!(filled[0].tasks[0].project_path.as_deref(), Some("/repo"));
        assert_eq!(filled[0].tasks[1].project_path.as_deref(), Some("/other"));
    }

    #[test]
    fn status_json_omits_prompts() {
        let request: CreateWorkflowRequest = serde_json::from_value(json!({
            "workflowId": "wf",
            "stages": [{"key": "s", "requiresApproval": true, "tasks": [{"key": "a", "prompt": "secret prompt"}]}]
        }))
        .unwrap();
        let workflow = workflow_engine::initial_workflow(&request, "t0");
        let text = workflow_status_json(&workflow).to_string();
        assert!(!text.contains("secret prompt"));
        assert!(text.contains(r#""requiresApproval":true"#));
    }
}
