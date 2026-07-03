use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{
        LaunchProfileDraft, LaunchProfileMcpPolicy, LaunchProfileSkillPolicy,
        LaunchProviderSelection, TerminalBufferMode,
    },
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, HistoryService, LaunchHistoryService, LayoutSnapshotService,
        McpConfigService, PlanService, ProcessMonitorService, ProjectService, ProviderService,
        RunnerService, SessionRestoreService, SettingsService, SharedMcpService, SpecService,
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
        "cc-panes-web-launch-profiles-{name}-{millis}-{}",
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
        layout_snapshot_service: Arc::new(LayoutSnapshotService::new(db.clone())),
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
        project_cli_hooks_service: Arc::new(cc_panes_core::services::ProjectCliHooksService::new(
            Arc::new(cc_cli_adapters::CliToolRegistry::new()),
        )),
        journal_service: Arc::new(cc_panes_core::services::JournalService::new(
            app_paths.workspaces_dir(),
        )),
        cli_registry: Arc::new(cc_cli_adapters::CliToolRegistry::new()),
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
        web_auth: Arc::new(crate::web_auth::WebAuthStore::default()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    };
    (state, root)
}

fn draft(name: &str, is_default: bool) -> LaunchProfileDraft {
    LaunchProfileDraft {
        name: Some(name.to_string()),
        alias: Some(format!("{name} alias")),
        description: Some("Launch profile test".to_string()),
        provider_id: None,
        adapter_options: Default::default(),
        target_tools: vec!["codex".to_string()],
        target_runtime: Some("local".to_string()),
        yolo_mode: false,
        mcp_policy: LaunchProfileMcpPolicy::default(),
        skill_policy: LaunchProfileSkillPolicy::default(),
        is_default,
    }
}

#[tokio::test]
async fn launch_profile_routes_manage_crud_and_defaults() {
    let (state, _root) = test_state("crud");

    let (status, Json(created)) =
        create_launch_profile(State(state.clone()), Json(draft("Codex Local", true)))
            .await
            .expect("create launch profile");
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created.name, "Codex Local");
    assert!(created.is_default);

    let Json(listed) = list_launch_profiles(State(state.clone()))
        .await
        .expect("list launch profiles");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    let Json(found) = get_launch_profile(State(state.clone()), Path(created.id.clone()))
        .await
        .expect("get launch profile");
    assert_eq!(
        found.expect("profile").alias.as_deref(),
        Some("Codex Local alias")
    );

    let Json(updated) = update_launch_profile(
        State(state.clone()),
        Path(created.id.clone()),
        Json(LaunchProfileDraft {
            name: Some("Codex Strict".to_string()),
            ..draft("Codex Local", false)
        }),
    )
    .await
    .expect("update launch profile");
    assert_eq!(updated.name, "Codex Strict");
    assert!(!updated.is_default);

    let status = set_default_launch_profile(State(state.clone()), Path(created.id.clone()))
        .await
        .expect("set default launch profile");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let Json(defaulted) = get_launch_profile(State(state.clone()), Path(created.id.clone()))
        .await
        .expect("get defaulted launch profile");
    assert!(defaulted.expect("profile").is_default);

    let status = delete_launch_profile(State(state.clone()), Path(created.id.clone()))
        .await
        .expect("delete launch profile");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let Json(listed) = list_launch_profiles(State(state))
        .await
        .expect("list after delete");
    assert!(listed.is_empty());
}

#[tokio::test]
async fn launch_profile_preview_resolves_created_profile() {
    let (state, _root) = test_state("preview");

    let (_status, Json(created)) =
        create_launch_profile(State(state.clone()), Json(draft("Codex Local", true)))
            .await
            .expect("create launch profile");

    let Json(resolution) = preview_launch_profile_resolution(
        State(state),
        Json(LaunchProfilePreviewRequest {
            profile_id: Some(created.id),
            use_system_default: false,
            workspace_name: None,
            project_id: None,
            provider_id: None,
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: Some("codex".to_string()),
            runtime_kind: Some("local".to_string()),
        }),
    )
    .await
    .expect("preview launch profile");

    assert_eq!(resolution.profile_name.as_deref(), Some("Codex Local"));
    assert!(!resolution.degraded);
    assert!(resolution
        .mcp_servers
        .iter()
        .any(|server| server.id == "ccpanes"));
    assert!(resolution
        .skills
        .iter()
        .any(|skill| skill.id == "builtin:ccpanes-launch-task"));
}
