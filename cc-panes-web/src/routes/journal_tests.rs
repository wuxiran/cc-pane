use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        DramaService, FileSystemService, HistoryService, LaunchHistoryService,
        LaunchProfileService, LayoutSnapshotService, McpConfigService, PlanService,
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
            buffer_mode: cc_panes_core::models::TerminalBufferMode::Normal,
        }))
    }
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let path = std::env::temp_dir().join(format!(
        "cc-panes-web-journal-{name}-{millis}-{}",
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
    let launch_profile_service = Arc::new(LaunchProfileService::new_with_external_skill_registry(
        app_paths.launch_profiles_path(),
        external_skill_registry.clone(),
    ));
    let memory_service =
        Arc::new(cc_panes_core::services::MemoryService::new_memory().expect("memory"));
    let ssh_machine_service = Arc::new(SshMachineService::new(
        app_paths.data_dir().join("ssh-machines.json"),
        Arc::new(SshCredentialService::new_memory()),
    ));
    let usage_stats_service = Arc::new(UsageStatsService::new(
        usage_stats_repo,
        launch_history_service.clone(),
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
        media_service: Arc::new(cc_panes_core::services::MediaService::new(Arc::new(
            cc_panes_core::repository::MediaRepository::new(db.clone()),
        ))),
        layout_snapshot_service: Arc::new(LayoutSnapshotService::new(db.clone())),
        drama_service: Arc::new(DramaService::new(db.clone())),
        launch_profile_service,
        quick_command_service: Arc::new(cc_panes_core::services::QuickCommandService::new(
            app_paths.quick_commands_path(),
        )),
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
        plan_service: Arc::new(PlanService::new(
            app_paths.clone(),
            Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
        )),
        external_skill_registry,
        user_skill_service: Arc::new(cc_panes_core::services::UserSkillService::new(
            app_paths.user_skills_dir(),
        )),
        usage_stats_service,
        session_index_service: crate::state::test_session_index_service(app_paths.workspaces_dir()),
        ws_emitter: Arc::new(WsEmitter::new()),
        web_auth: Arc::new(crate::web_auth::WebAuthStore::default()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    };
    (state, root)
}

/// Seed the journal index the same way ProjectContextService initializes it,
/// since add_session requires an existing index.md with auto markers.
fn seed_journal_index(root: &std::path::Path, workspace_name: &str) {
    let journal_dir = root
        .join("data")
        .join("workspaces")
        .join(workspace_name)
        .join(".ccpanes")
        .join("journal");
    std::fs::create_dir_all(&journal_dir).expect("journal dir");
    let index = r#"# Session Journal Index

## 当前状态

<!-- @@@auto:current-status -->
- **Active File**: `journal-0.md`
- **Total Sessions**: 0
- **Last Active**: -
<!-- @@@/auto:current-status -->

## 会话历史

<!-- @@@auto:session-history -->
| # | Date | Title | Commits |
|---|------|-------|---------|
<!-- @@@/auto:session-history -->
"#;
    std::fs::write(journal_dir.join("index.md"), index).expect("write index");
}

#[tokio::test]
async fn journal_routes_add_and_read_sessions() {
    let (state, root) = test_state("crud");
    seed_journal_index(&root, "ws1");

    let Json(first) = add_journal_session(
        State(state.clone()),
        Json(AddJournalSessionRequest {
            workspace_name: "ws1".to_string(),
            title: "Fix login".to_string(),
            summary: "Fixed the login redirect loop".to_string(),
            commits: vec![],
        }),
    )
    .await
    .expect("add first session");
    assert_eq!(first, 1);

    let Json(second) = add_journal_session(
        State(state.clone()),
        Json(AddJournalSessionRequest {
            workspace_name: "ws1".to_string(),
            title: "Add tests".to_string(),
            summary: "Backfilled route tests".to_string(),
            commits: vec!["abc1234".to_string()],
        }),
    )
    .await
    .expect("add second session");
    assert_eq!(second, 2);

    let Json(index) = get_journal_index(
        State(state.clone()),
        Query(WorkspaceNameQuery {
            workspace_name: "ws1".to_string(),
        }),
    )
    .await
    .expect("get index");
    assert_eq!(index.total_sessions, 2);
    assert_eq!(index.active_file, "journal-0.md");

    let Json(recent) = get_recent_journal(
        State(state),
        Query(WorkspaceNameQuery {
            workspace_name: "ws1".to_string(),
        }),
    )
    .await
    .expect("get recent journal");
    assert!(recent.contains("Session 1: Fix login"));
    assert!(recent.contains("Fixed the login redirect loop"));
    assert!(recent.contains("Session 2: Add tests"));
    assert!(recent.contains("`abc1234`"));
}

#[tokio::test]
async fn add_journal_session_fails_without_initialized_index() {
    let (state, _root) = test_state("no-index");

    let err = add_journal_session(
        State(state),
        Json(AddJournalSessionRequest {
            workspace_name: "uninitialized".to_string(),
            title: "T".to_string(),
            summary: "S".to_string(),
            commits: vec![],
        }),
    )
    .await
    .expect_err("add without index should fail");
    assert_eq!(err.0, StatusCode::BAD_REQUEST);
    assert!(err.1.contains("index.md"));
}

#[tokio::test]
async fn journal_reads_are_empty_for_missing_workspace() {
    let (state, _root) = test_state("missing");

    let Json(index) = get_journal_index(
        State(state.clone()),
        Query(WorkspaceNameQuery {
            workspace_name: "does-not-exist".to_string(),
        }),
    )
    .await
    .expect("get index for missing workspace");
    assert_eq!(index.total_sessions, 0);
    assert_eq!(index.active_file, "journal-0.md");

    let Json(recent) = get_recent_journal(
        State(state),
        Query(WorkspaceNameQuery {
            workspace_name: "does-not-exist".to_string(),
        }),
    )
    .await
    .expect("get recent journal for missing workspace");
    assert!(recent.is_empty());
}
