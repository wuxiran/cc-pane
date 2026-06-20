use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_memory::models::{
    MemoryCategory, MemoryQuery, MemoryScope, StoreMemoryRequest, UpdateMemoryRequest,
};
use cc_panes_core::{
    models::TerminalBufferMode,
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, HistoryService, LaunchHistoryService, McpConfigService, PlanService,
        ProcessMonitorService, ProjectService, ProviderService, RunnerService,
        SessionRestoreService, SettingsService, SharedMcpService, SpecService,
        SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend, TodoService,
        UsageStatsService, WorkspaceService, WorktreeService,
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
    let path = std::env::temp_dir().join(format!(
        "cc-panes-web-memory-{name}-{millis}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str) -> (AppState, std::path::PathBuf) {
    let root = test_dir(name);
    let app_paths = Arc::new(AppPaths::new(Some(
        root.join("data").to_string_lossy().to_string(),
    )));
    let db = Arc::new(Database::new_fallback().expect("db"));
    let project_repo = Arc::new(ProjectRepository::new(db.clone()));
    let todo_repo = Arc::new(TodoRepository::new(db.clone()));
    let spec_repo = Arc::new(SpecRepository::new(db.clone()));
    let task_binding_repo = Arc::new(TaskBindingRepository::new(db.clone()));
    let history_repo = Arc::new(HistoryRepository::new(db.clone()));
    let runner_repo = Arc::new(RunnerRepository::new(db.clone()));
    let usage_stats_repo = Arc::new(UsageStatsRepository::new(db.clone()));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let process_monitor_service = Arc::new(ProcessMonitorService::new());
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let external_skill_registry = Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
        Arc::new(cc_cli_adapters::CliToolRegistry::new()),
    ));
    let launch_profile_service = Arc::new(
        cc_panes_core::services::LaunchProfileService::new_with_external_skill_registry(
            app_paths.launch_profiles_path(),
            external_skill_registry.clone(),
        ),
    );
    let usage_stats_service = Arc::new(UsageStatsService::new(
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
        terminal_backend: Arc::new(NoopTerminalBackend),
        workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
        project_service: Arc::new(ProjectService::new(project_repo)),
        provider_service: Arc::new(ProviderService::new(app_paths.providers_path())),
        settings_service: Arc::new(SettingsService::new()),
        filesystem_service: Arc::new(FileSystemService::new()),
        todo_service: todo_service.clone(),
        spec_service: Arc::new(SpecService::new(spec_repo, todo_service)),
        task_binding_service: Arc::new(TaskBindingService::new(task_binding_repo)),
        launch_history_service,
        launch_profile_service,
        memory_service,
        ssh_machine_service,
        session_restore_service: Arc::new(SessionRestoreService::new(db, app_paths.clone())),
        history_service: Arc::new(HistoryService::new()),
        worktree_service: Arc::new(WorktreeService::new()),
        runner_service: Arc::new(RunnerService::new(
            runner_repo,
            process_monitor_service.clone(),
        )),
        process_monitor_service,
        mcp_config_service: Arc::new(McpConfigService::new()),
        shared_mcp_service: Arc::new(SharedMcpService::new(&app_paths)),
        skill_service: Arc::new(cc_panes_core::services::SkillService::new()),
        plan_service: Arc::new(PlanService::new()),
        external_skill_registry,
        user_skill_service: Arc::new(cc_panes_core::services::UserSkillService::new(
            app_paths.user_skills_dir(),
        )),
        usage_stats_service,
        ws_emitter: Arc::new(WsEmitter::new()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    };
    (state, root)
}

fn store_request(project_path: String) -> StoreMemoryRequest {
    StoreMemoryRequest {
        title: "Memory API".to_string(),
        content: "Remember the web memory route".to_string(),
        scope: Some(MemoryScope::Project),
        category: Some(MemoryCategory::Decision),
        importance: Some(5),
        workspace_name: Some("workspace-a".to_string()),
        project_path: Some(project_path),
        session_id: Some("session-a".to_string()),
        tags: Some(vec!["web".to_string(), "memory".to_string()]),
        source: Some("test".to_string()),
    }
}

#[tokio::test]
async fn memory_routes_match_tauri_memory_commands() {
    let (state, root) = test_state("crud");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let project_path = project.to_string_lossy().to_string();

    let (status, Json(memory)) = store_memory(
        State(state.clone()),
        Json(store_request(project_path.clone())),
    )
    .await
    .expect("store memory");
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(memory.title, "Memory API");

    let Json(listed) = list_memories(
        State(state.clone()),
        Query(ListMemoriesQuery {
            scope: Some(MemoryScope::Project),
            workspace_name: None,
            project_path: Some(project_path.clone()),
            limit: Some(10),
            offset: Some(0),
        }),
    )
    .await
    .expect("list memories");
    assert_eq!(listed.total, 1);

    let Json(found) = get_memory(State(state.clone()), Path(memory.id.clone()))
        .await
        .expect("get memory");
    assert_eq!(
        found.expect("memory").content,
        "Remember the web memory route"
    );

    let Json(search_result) = search_memory(
        State(state.clone()),
        Json(MemoryQuery {
            search: Some("web memory".to_string()),
            project_path: Some(project_path.clone()),
            limit: Some(10),
            ..Default::default()
        }),
    )
    .await
    .expect("search memory");
    assert_eq!(search_result.total, 1);

    let Json(updated) = update_memory(
        State(state.clone()),
        Path(memory.id.clone()),
        Json(UpdateMemoryRequest {
            title: Some("Updated Memory API".to_string()),
            importance: Some(4),
            ..Default::default()
        }),
    )
    .await
    .expect("update memory");
    assert!(updated);

    let Json(stats) = get_memory_stats(
        State(state.clone()),
        Query(MemoryStatsQuery {
            workspace_name: None,
            project_path: Some(project_path.clone()),
        }),
    )
    .await
    .expect("memory stats");
    assert_eq!(stats.total, 1);
    assert_eq!(stats.by_scope.get("project"), Some(&1));

    let Json(formatted) = format_memory_for_injection(
        State(state.clone()),
        Json(FormatMemoryRequest {
            memory_ids: vec![memory.id.clone()],
        }),
    )
    .await
    .expect("format memory");
    assert!(formatted.contains("Updated Memory API"));

    let Json(context) = prepare_session_context(
        State(state.clone()),
        Json(PrepareSessionContextRequest {
            project_path: project_path.clone(),
            memory_ids: vec![memory.id.clone()],
        }),
    )
    .await
    .expect("prepare session context");
    assert!(context.contains("Updated Memory API"));
    assert!(project.join("CLAUDE.local.md").exists());

    let Json(deleted) = delete_memory(State(state.clone()), Path(memory.id))
        .await
        .expect("delete memory");
    assert!(deleted);
}
