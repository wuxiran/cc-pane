use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{
        spec::SpecStatus,
        task_binding::{TaskBindingStatus, UpdateTaskBindingRequest},
        todo::{TodoPriority, TodoStatus},
        TerminalBufferMode,
    },
    repository::{
        Database, HistoryRepository, ProjectRepository, SpecRepository, TaskBindingRepository,
        TodoRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, LaunchHistoryService, ProjectService, ProviderService,
        SessionRestoreService, SettingsService, SpecService, TaskBindingService, TerminalBackend,
        TodoService, WorkspaceService,
    },
    utils::{AppPaths, AppResult},
};

use super::*;
use crate::{state::TerminalOutputMode, ws_emitter::WsEmitter};

struct NoopTerminalBackend;

impl TerminalBackend for NoopTerminalBackend {
    fn create_session(
        &self,
        _request: cc_panes_core::models::CreateSessionRequest,
    ) -> AppResult<String> {
        Ok("session".to_string())
    }

    fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
    }

    fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
        Ok(())
    }

    fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
        Ok(())
    }

    fn kill(&self, _session_id: &str) -> AppResult<()> {
        Ok(())
    }

    fn get_all_status(&self) -> AppResult<Vec<cc_panes_core::services::SessionStatusInfo>> {
        Ok(vec![cc_panes_core::services::SessionStatusInfo {
            session_id: "session".to_string(),
            status: SessionStatus::Idle,
            last_output_at: 0,
            pid: None,
            exit_code: None,
            current_tool_name: None,
            current_tool_use_id: None,
            current_tool_summary: None,
            updated_at: 0,
        }])
    }

    fn get_session_status(
        &self,
        session_id: &str,
    ) -> AppResult<Option<cc_panes_core::services::SessionStatusInfo>> {
        Ok(self
            .get_all_status()?
            .into_iter()
            .find(|status| status.session_id == session_id))
    }

    fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
        Ok(SessionOutput {
            session_id: session_id.to_string(),
            lines: Vec::new(),
        })
    }

    fn get_session_replay_snapshot(
        &self,
        _session_id: &str,
    ) -> AppResult<Option<cc_panes_core::models::TerminalReplaySnapshot>> {
        Ok(Some(cc_panes_core::models::TerminalReplaySnapshot {
            data: String::new(),
            buffer_mode: TerminalBufferMode::Normal,
        }))
    }
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let path = std::env::temp_dir().join(format!("cc-panes-web-workflow-{name}-{millis}"));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str) -> (AppState, std::path::PathBuf) {
    let root = test_dir(name);
    let app_paths = AppPaths::new(Some(root.join("data").to_string_lossy().to_string()));
    let db = Arc::new(Database::new_fallback().expect("db"));
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db.clone()));
    let spec_repo = Arc::new(SpecRepository::new(db.clone()));
    let task_binding_repo = Arc::new(TaskBindingRepository::new(db.clone()));
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let state = AppState {
        terminal_backend: Arc::new(NoopTerminalBackend),
        workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
        project_service: Arc::new(ProjectService::new(project_repo)),
        provider_service: Arc::new(ProviderService::new(app_paths.providers_path())),
        settings_service: Arc::new(SettingsService::new()),
        filesystem_service: Arc::new(FileSystemService::new()),
        todo_service: todo_service.clone(),
        spec_service: Arc::new(SpecService::new(spec_repo, todo_service)),
        task_binding_service: Arc::new(TaskBindingService::new(task_binding_repo)),
        launch_history_service: Arc::new(LaunchHistoryService::new(history_repo)),
        session_restore_service: Arc::new(SessionRestoreService::new(db, Arc::new(app_paths))),
        ws_emitter: Arc::new(WsEmitter::new()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    };
    (state, root)
}

#[tokio::test]
async fn todo_routes_match_core_service_operations() {
    let (state, _root) = test_state("todo");
    let (status, Json(todo)) = create_todo(
        State(state.clone()),
        Json(CreateTodoRequest {
            title: "Ship web todo API".to_string(),
            priority: Some(TodoPriority::High),
            ..Default::default()
        }),
    )
    .await
    .expect("create todo");
    assert_eq!(status, StatusCode::CREATED);

    let (sub_status, Json(subtask)) = add_todo_subtask(
        State(state.clone()),
        Path(todo.id.clone()),
        Json(AddSubtaskRequest {
            title: "Write tests".to_string(),
        }),
    )
    .await
    .expect("add subtask");
    assert_eq!(sub_status, StatusCode::CREATED);

    let Json(updated) = update_todo(
        State(state.clone()),
        Path(todo.id.clone()),
        Json(UpdateTodoRequest {
            status: Some(TodoStatus::InProgress),
            ..Default::default()
        }),
    )
    .await
    .expect("update todo");
    assert_eq!(updated.status, TodoStatus::InProgress);

    let Json(toggled) = toggle_todo_subtask(State(state.clone()), Path(subtask.id.clone()))
        .await
        .expect("toggle subtask");
    assert!(toggled);

    let Json(result) = query_todos(State(state.clone()), Json(TodoQuery::default()))
        .await
        .expect("query todos");
    assert_eq!(result.total, 1);

    let Json(stats) = get_todo_stats(
        State(state.clone()),
        Query(TodoStatsQuery {
            scope: None,
            scope_ref: None,
        }),
    )
    .await
    .expect("todo stats");
    assert_eq!(stats.total, 1);

    delete_todo(State(state), Path(todo.id))
        .await
        .expect("delete todo");
}

#[tokio::test]
async fn spec_routes_match_core_service_operations() {
    let (state, root) = test_state("spec");
    let project_path = root.join("project");
    std::fs::create_dir_all(&project_path).expect("project dir");
    let project_path = project_path.to_string_lossy().to_string();

    let (status, Json(spec)) = create_spec(
        State(state.clone()),
        Json(CreateSpecRequest {
            project_path: project_path.clone(),
            title: "Web Spec API".to_string(),
            tasks: Some(vec!["Task A".to_string()]),
        }),
    )
    .await
    .expect("create spec");
    assert_eq!(status, StatusCode::CREATED);

    let Json(specs) = list_specs(
        State(state.clone()),
        Query(ListSpecsQuery {
            project_path: project_path.clone(),
            status: None,
        }),
    )
    .await
    .expect("list specs");
    assert_eq!(specs.len(), 1);

    let Json(content) = get_spec_content(
        State(state.clone()),
        Path(spec.id.clone()),
        Query(SpecContentQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("get content");
    assert!(content.contains("Web Spec API"));

    save_spec_content(
        State(state.clone()),
        Path(spec.id.clone()),
        Json(SaveSpecContentRequest {
            project_path: project_path.clone(),
            content: content.replace("Proposal", "Proposal Updated"),
        }),
    )
    .await
    .expect("save content");

    let Json(updated) = update_spec(
        State(state.clone()),
        Path(spec.id.clone()),
        Json(UpdateSpecRequest {
            status: Some(SpecStatus::Active),
            ..Default::default()
        }),
    )
    .await
    .expect("update spec");
    assert_eq!(updated.status, SpecStatus::Active);

    sync_spec_tasks(
        State(state.clone()),
        Path(spec.id.clone()),
        Json(SyncSpecTasksRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("sync tasks");

    delete_spec(
        State(state),
        Path(spec.id),
        Query(SpecContentQuery { project_path }),
    )
    .await
    .expect("delete spec");
}

#[tokio::test]
async fn task_binding_routes_match_core_service_operations() {
    let (state, root) = test_state("task-binding");
    let project_path = root.to_string_lossy().to_string();

    let (status, Json(binding)) = create_task_binding(
        State(state.clone()),
        Json(CreateTaskBindingRequest {
            title: "Worker task".to_string(),
            role: None,
            parent_id: None,
            plan_path: None,
            normalized_plan_path: None,
            prompt: None,
            project_path: project_path.clone(),
            session_id: Some("session-1".to_string()),
            resume_id: None,
            pane_id: None,
            tab_id: None,
            todo_id: None,
            workspace_name: None,
            cli_tool: None,
            metadata: None,
        }),
    )
    .await
    .expect("create binding");
    assert_eq!(status, StatusCode::CREATED);

    let Json(found) = find_task_binding_by_session(
        State(state.clone()),
        Query(FindTaskBindingBySessionQuery {
            session_id: "session-1".to_string(),
        }),
    )
    .await
    .expect("find by session");
    assert_eq!(found.expect("binding").id, binding.id);

    let Json(updated) = update_task_binding(
        State(state.clone()),
        Path(binding.id.clone()),
        Json(UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Running),
            progress: Some(40),
            ..Default::default()
        }),
    )
    .await
    .expect("update binding");
    assert_eq!(updated.progress, 40);

    let Json(result) = query_task_bindings(State(state.clone()), Json(TaskBindingQuery::default()))
        .await
        .expect("query bindings");
    assert_eq!(result.total, 1);

    let Json(deleted) = delete_task_binding(State(state), Path(binding.id))
        .await
        .expect("delete binding");
    assert!(deleted);
}

#[tokio::test]
async fn plan_collaboration_routes_match_core_service_operations() {
    let (state, root) = test_state("plan-collaboration");
    let project_path = root.to_string_lossy().to_string();
    let plan_path = root.join("plan.md").to_string_lossy().to_string();

    let Json(leader) = register_plan_leader(
        State(state.clone()),
        Json(RegisterPlanLeaderRequest {
            plan_path: plan_path.clone(),
            project_path: project_path.clone(),
            title: Some("Plan".to_string()),
            prompt: None,
            session_id: Some("leader-session".to_string()),
            resume_id: None,
            pane_id: None,
            tab_id: None,
            workspace_name: None,
            cli_tool: Some("claude".to_string()),
            metadata: None,
        }),
    )
    .await
    .expect("register leader");

    let Json(worker) = register_plan_worker(
        State(state.clone()),
        Json(RegisterPlanWorkerRequest {
            leader_id: Some(leader.id.clone()),
            plan_path: None,
            session_id: "worker-session".to_string(),
            project_path,
            title: Some("Worker".to_string()),
            prompt: None,
            resume_id: None,
            pane_id: None,
            tab_id: None,
            workspace_name: None,
            cli_tool: Some("codex".to_string()),
            metadata: None,
        }),
    )
    .await
    .expect("register worker");

    let Json(collaboration) = get_plan_collaboration(
        State(state.clone()),
        Query(PlanCollaborationQuery {
            leader_id: Some(leader.id),
            plan_path: None,
            normalized_plan_path: None,
            verbose: Some(true),
        }),
    )
    .await
    .expect("get collaboration");
    assert_eq!(collaboration.total, 1);
    assert_eq!(collaboration.workers[0].id, worker.id);

    let Json(reconciled) = reconcile_plan_collaboration(
        State(state),
        Query(PlanCollaborationQuery {
            leader_id: Some(collaboration.leader.id),
            plan_path: None,
            normalized_plan_path: None,
            verbose: Some(false),
        }),
    )
    .await
    .expect("reconcile collaboration");
    assert_eq!(reconciled.total, 1);
}
