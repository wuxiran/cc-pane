use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{HistoryConfig, HistoryLabel, TerminalBufferMode},
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, HistoryService, LaunchHistoryService, McpConfigService, PlanService,
        ProcessMonitorService, ProjectService, ProviderService, RunnerService,
        SessionRestoreService, SettingsService, SharedMcpService, SpecService,
        SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend, TodoService,
        WorkspaceService, WorktreeService,
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
        "cc-panes-web-local-history-{name}-{millis}-{}",
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
    let usage_stats_repo = Arc::new(cc_panes_core::repository::UsageStatsRepository::new(
        db.clone(),
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
        external_skill_registry: Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
            Arc::new(cc_cli_adapters::CliToolRegistry::new()),
        )),
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

fn manual_label(id: &str) -> HistoryLabel {
    HistoryLabel {
        id: id.to_string(),
        name: "Manual Label".to_string(),
        label_type: "manual".to_string(),
        source: "user".to_string(),
        timestamp: "2026-06-20T00:00:00Z".to_string(),
        file_snapshots: Vec::new(),
        branch: String::new(),
    }
}

#[tokio::test]
async fn local_history_routes_manage_config_and_lifecycle() {
    let (state, root) = test_state("config");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let project_path = project.to_string_lossy().to_string();

    let status = init_project_history(
        State(state.clone()),
        Json(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("init history");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let Json(config) = get_history_config(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("get config");
    assert!(config.enabled);

    let updated = HistoryConfig {
        enabled: false,
        ignore_patterns: vec!["tmp/**".to_string()],
        max_versions_per_file: 7,
        max_age_days: 3,
        max_file_size: 1024,
        max_total_size: 4096,
        min_save_interval_secs: 2,
    };
    update_history_config(
        State(state.clone()),
        Json(HistoryConfigRequest {
            project_path: project_path.clone(),
            config: updated,
        }),
    )
    .await
    .expect("update config");

    let Json(config) = get_history_config(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("get updated config");
    assert!(!config.enabled);
    assert_eq!(config.max_versions_per_file, 7);

    let Json(compressed) = compress_history(
        State(state.clone()),
        Json(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("compress");
    assert_eq!(compressed, 0);

    stop_project_history(
        State(state.clone()),
        Json(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("stop history");
    cleanup_project_history(State(state), Json(ProjectHistoryRequest { project_path }))
        .await
        .expect("cleanup history");
}

#[tokio::test]
async fn local_history_routes_manage_labels_without_snapshots() {
    let (state, root) = test_state("labels");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let project_path = project.to_string_lossy().to_string();

    put_label(
        State(state.clone()),
        Json(PutLabelRequest {
            project_path: project_path.clone(),
            label: manual_label("manual-1"),
        }),
    )
    .await
    .expect("put label");

    let Json(labels) = list_labels(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list labels");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].id, "manual-1");

    let Json(restored) = restore_to_label(
        State(state.clone()),
        Json(LabelRequest {
            project_path: project_path.clone(),
            label_id: "manual-1".to_string(),
        }),
    )
    .await
    .expect("restore empty label");
    assert!(restored.is_empty());

    let Json(auto_id) = create_auto_label(
        State(state.clone()),
        Json(CreateAutoLabelRequest {
            project_path: project_path.clone(),
            name: "Auto Label".to_string(),
            source: "build".to_string(),
        }),
    )
    .await
    .expect("auto label");
    assert!(!auto_id.is_empty());

    let Json(labels) = list_labels(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list labels after auto");
    assert_eq!(labels.len(), 2);

    delete_label(
        State(state.clone()),
        Query(DeleteLabelQuery {
            project_path: project_path.clone(),
            label_id: "manual-1".to_string(),
        }),
    )
    .await
    .expect("delete label");

    let Json(labels) = list_labels(State(state), Query(ProjectHistoryRequest { project_path }))
        .await
        .expect("list after delete");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].id, auto_id);
}

#[tokio::test]
async fn local_history_routes_return_empty_queries_for_new_project() {
    let (state, root) = test_state("queries");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let project_path = project.to_string_lossy().to_string();

    let Json(versions) = list_file_versions(
        State(state.clone()),
        Query(FileVersionQuery {
            project_path: project_path.clone(),
            file_path: "src/main.rs".to_string(),
        }),
    )
    .await
    .expect("list versions");
    assert!(versions.is_empty());

    let Json(dir_changes) = list_directory_changes(
        State(state.clone()),
        Query(DirectoryChangesQuery {
            project_path: project_path.clone(),
            dir_path: "src".to_string(),
            since: None,
        }),
    )
    .await
    .expect("directory changes");
    assert!(dir_changes.is_empty());

    let Json(recent) = get_recent_changes(
        State(state.clone()),
        Query(LimitQuery {
            project_path: project_path.clone(),
            limit: Some(5),
        }),
    )
    .await
    .expect("recent changes");
    assert!(recent.is_empty());

    let Json(deleted) = list_deleted_files(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("deleted files");
    assert!(deleted.is_empty());

    let Json(branch) = get_current_branch(
        State(state.clone()),
        Query(ProjectHistoryRequest {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("current branch");
    assert!(branch.is_empty());

    let Json(branches) = get_file_branches(
        State(state.clone()),
        Query(FileVersionQuery {
            project_path: project_path.clone(),
            file_path: "src/main.rs".to_string(),
        }),
    )
    .await
    .expect("file branches");
    assert!(branches.is_empty());

    let Json(branch_versions) = list_file_versions_by_branch(
        State(state.clone()),
        Query(BranchVersionsQuery {
            project_path: project_path.clone(),
            file_path: "src/main.rs".to_string(),
            branch: "main".to_string(),
        }),
    )
    .await
    .expect("versions by branch");
    assert!(branch_versions.is_empty());

    let Json(worktree_changes) = list_worktree_recent_changes(
        State(state),
        Query(LimitQuery {
            project_path,
            limit: Some(5),
        }),
    )
    .await
    .expect("worktree changes");
    assert!(worktree_changes.is_empty());
}
