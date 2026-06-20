use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{
        provider::Provider, provider::ProviderType, TerminalBufferMode, WorkspaceMigrationRequest,
        WorkspaceMigrationTargetKind,
    },
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
    let path = std::env::temp_dir().join(format!("cc-panes-web-resources-{name}-{millis}"));
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

#[tokio::test]
async fn workspace_routes_match_core_service_operations() {
    let (state, root) = test_state("workspace");
    let project_path = root.join("project-a");
    std::fs::create_dir_all(&project_path).expect("project dir");

    let (status, Json(workspace)) = create_workspace(
        State(state.clone()),
        Json(CreateWorkspaceRequest {
            name: "team-a".to_string(),
            path: Some(root.to_string_lossy().to_string()),
        }),
    )
    .await
    .expect("create workspace");
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(workspace.name, "team-a");

    let (project_status, Json(project)) = add_workspace_project(
        State(state.clone()),
        Path("team-a".to_string()),
        Json(AddWorkspaceProjectRequest {
            path: project_path.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("add workspace project");
    assert_eq!(project_status, StatusCode::CREATED);

    update_workspace_alias(
        State(state.clone()),
        Path("team-a".to_string()),
        Json(WorkspaceAliasRequest {
            alias: Some("Team A".to_string()),
        }),
    )
    .await
    .expect("update workspace alias");
    update_workspace_project_alias(
        State(state.clone()),
        Path(("team-a".to_string(), project.id.clone())),
        Json(ProjectAliasRequest {
            alias: Some("Project A".to_string()),
        }),
    )
    .await
    .expect("update project alias");

    let Json(workspace) = get_workspace(State(state.clone()), Path("team-a".to_string()))
        .await
        .expect("get workspace");
    assert_eq!(workspace.alias.as_deref(), Some("Team A"));
    assert_eq!(workspace.projects[0].alias.as_deref(), Some("Project A"));

    let mut saved_workspace = workspace.clone();
    saved_workspace.pinned = true;
    saved_workspace.hidden = true;
    saved_workspace.launch_profile_id = Some("profile-a".to_string());
    update_workspace(
        State(state.clone()),
        Path("team-a".to_string()),
        Json(UpdateWorkspaceRequest {
            workspace: saved_workspace,
        }),
    )
    .await
    .expect("update full workspace");
    let Json(updated_workspace) = get_workspace(State(state.clone()), Path("team-a".to_string()))
        .await
        .expect("get updated workspace");
    assert!(updated_workspace.pinned);
    assert!(updated_workspace.hidden);
    assert_eq!(
        updated_workspace.launch_profile_id.as_deref(),
        Some("profile-a")
    );

    remove_workspace_project(
        State(state.clone()),
        Path(("team-a".to_string(), project.id)),
    )
    .await
    .expect("remove workspace project");
    delete_workspace(State(state), Path("team-a".to_string()))
        .await
        .expect("delete workspace");
}

#[tokio::test]
async fn workspace_migration_routes_match_core_service_operations() {
    let (state, root) = test_state("workspace-migration");
    let source_root = root.join("source-workspace");
    let project_path = source_root.join("project-a");
    let target_root = root.join("target-workspaces");
    std::fs::create_dir_all(&project_path).expect("project dir");
    std::fs::write(project_path.join("note.txt"), "workspace migration").expect("project file");

    let _workspace = create_workspace(
        State(state.clone()),
        Json(CreateWorkspaceRequest {
            name: "migrate-ws".to_string(),
            path: Some(source_root.to_string_lossy().to_string()),
        }),
    )
    .await
    .expect("create workspace");
    let (_status, Json(project)) = add_workspace_project(
        State(state.clone()),
        Path("migrate-ws".to_string()),
        Json(AddWorkspaceProjectRequest {
            path: project_path.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("add project");

    let request = WorkspaceMigrationRequest {
        workspace_name: "migrate-ws".to_string(),
        target_kind: WorkspaceMigrationTargetKind::Local,
        target_root: target_root.to_string_lossy().to_string(),
        target_distro: None,
    };
    let Json(plan) = preview_workspace_migration(State(state.clone()), Json(request.clone()))
        .await
        .expect("preview workspace migration");
    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].project_id, project.id);

    let Json(result) = execute_workspace_migration(State(state.clone()), Json(request))
        .await
        .expect("execute workspace migration");
    assert_eq!(
        result.status,
        cc_panes_core::models::WorkspaceMigrationStatus::Succeeded
    );
    assert_eq!(
        result.workspace.path.as_deref(),
        Some(target_root.to_string_lossy().as_ref())
    );
    assert!(target_root.join("project-a").join("note.txt").exists());

    let Json(rolled_back) = rollback_workspace_migration(
        State(state),
        Path(("migrate-ws".to_string(), result.snapshot_id)),
    )
    .await
    .expect("rollback workspace migration");
    assert_eq!(
        rolled_back.workspace.path.as_deref(),
        Some(source_root.to_string_lossy().as_ref())
    );
}

#[tokio::test]
async fn project_migration_routes_match_core_service_operations() {
    let (state, root) = test_state("project-migration");
    let workspace_root = root.join("workspace");
    let project_path = workspace_root.join("project-b");
    let target_root = root.join("project-target");
    std::fs::create_dir_all(&project_path).expect("project dir");
    std::fs::write(project_path.join("note.txt"), "project migration").expect("project file");

    let _workspace = create_workspace(
        State(state.clone()),
        Json(CreateWorkspaceRequest {
            name: "project-ws".to_string(),
            path: Some(workspace_root.to_string_lossy().to_string()),
        }),
    )
    .await
    .expect("create workspace");
    let (_status, Json(project)) = add_workspace_project(
        State(state.clone()),
        Path("project-ws".to_string()),
        Json(AddWorkspaceProjectRequest {
            path: project_path.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("add project");

    let request = cc_panes_core::models::ProjectMigrationRequest {
        workspace_name: "project-ws".to_string(),
        project_id: project.id.clone(),
        target_kind: WorkspaceMigrationTargetKind::Local,
        target_root: target_root.to_string_lossy().to_string(),
        target_distro: None,
    };
    let Json(plan) = preview_project_migration(State(state.clone()), Json(request.clone()))
        .await
        .expect("preview project migration");
    assert_eq!(plan.project_id, project.id);

    let Json(result) = execute_project_migration(State(state.clone()), Json(request))
        .await
        .expect("execute project migration");
    assert_eq!(
        result.status,
        cc_panes_core::models::WorkspaceMigrationStatus::Succeeded
    );
    assert!(target_root.join("note.txt").exists());
    assert_eq!(
        result.workspace.projects[0].path,
        target_root.to_string_lossy()
    );

    let Json(rolled_back) = rollback_project_migration(
        State(state),
        Path(("project-ws".to_string(), result.snapshot_id)),
    )
    .await
    .expect("rollback project migration");
    assert_eq!(
        rolled_back.workspace.projects[0].path,
        project_path.to_string_lossy()
    );
}

#[tokio::test]
async fn scan_workspace_directory_route_discovers_git_repositories() {
    let (_state, root) = test_state("workspace-scan");
    let repo = root.join("repo-a");
    std::fs::create_dir_all(&repo).expect("repo dir");
    std::process::Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&repo)
        .output()
        .expect("git init");

    let Json(scanned) = scan_workspace_directory(Query(ScanWorkspaceQuery {
        root_path: root.to_string_lossy().to_string(),
    }))
    .await
    .expect("scan workspace directory");
    assert_eq!(scanned.len(), 1);
    assert_eq!(scanned[0].main_path, repo.to_string_lossy());
    assert_eq!(scanned[0].main_branch, "main");
}

#[tokio::test]
async fn project_routes_match_core_service_operations() {
    let (state, root) = test_state("project");
    let project_path = root.join("project-b");
    std::fs::create_dir_all(&project_path).expect("project dir");

    let (status, Json(project)) = add_project(
        State(state.clone()),
        Json(AddProjectRequest {
            path: project_path.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("add project");
    assert_eq!(status, StatusCode::CREATED);

    update_project_name(
        State(state.clone()),
        Path(project.id.clone()),
        Json(ProjectNameRequest {
            name: "Renamed".to_string(),
        }),
    )
    .await
    .expect("rename project");
    update_project_alias(
        State(state.clone()),
        Path(project.id.clone()),
        Json(ProjectAliasRequest {
            alias: Some("Alias".to_string()),
        }),
    )
    .await
    .expect("alias project");

    let Json(found) = get_project(State(state.clone()), Path(project.id.clone()))
        .await
        .expect("get project");
    let found = found.expect("project exists");
    assert_eq!(found.name, "Renamed");
    assert_eq!(found.alias.as_deref(), Some("Alias"));

    remove_project(State(state), Path(project.id))
        .await
        .expect("remove project");
}

#[tokio::test]
async fn provider_routes_match_core_service_operations() {
    let (state, _root) = test_state("provider");
    let provider = Provider {
        id: "anthropic".to_string(),
        name: "Anthropic".to_string(),
        provider_type: ProviderType::Anthropic,
        api_key: Some("key".to_string()),
        base_url: None,
        region: None,
        project_id: None,
        aws_profile: None,
        config_dir: None,
        is_default: true,
    };

    add_provider(State(state.clone()), Json(provider.clone()))
        .await
        .expect("add provider");
    let Json(default_provider): Json<Option<Provider>> =
        get_default_provider(State(state.clone())).await;
    assert_eq!(default_provider.expect("default").id, "anthropic");

    let mut updated = provider;
    updated.name = "Updated".to_string();
    update_provider(
        State(state.clone()),
        Path("anthropic".to_string()),
        Json(updated),
    )
    .await
    .expect("update provider");
    let Json(found): Json<Option<Provider>> =
        get_provider(State(state.clone()), Path("anthropic".to_string())).await;
    assert_eq!(found.expect("provider").name, "Updated");

    remove_provider(State(state), Path("anthropic".to_string()))
        .await
        .expect("remove provider");
}

#[tokio::test]
async fn filesystem_routes_match_core_service_operations() {
    let (state, root) = test_state("filesystem");
    let base = root.join("files");
    std::fs::create_dir_all(&base).expect("base dir");
    let dir = base.join("nested");
    let file = dir.join("note.txt");

    fs_create_directory(
        State(state.clone()),
        Json(FsCreateRequest {
            path: dir.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("create dir");
    fs_create_file(
        State(state.clone()),
        Json(FsCreateRequest {
            path: file.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("create file");
    fs_write_file(
        State(state.clone()),
        Json(FsWriteRequest {
            path: file.to_string_lossy().to_string(),
            content: "hello".to_string(),
        }),
    )
    .await
    .expect("write file");

    let Json(content) = fs_read_file(
        State(state.clone()),
        Query(FsPathQuery {
            path: file.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("read file");
    assert_eq!(content.content, "hello");

    let Json(listing) = fs_list_directory(
        State(state.clone()),
        Query(FsListQuery {
            path: dir.to_string_lossy().to_string(),
            show_hidden: false,
        }),
    )
    .await
    .expect("list dir");
    assert_eq!(listing.entries.len(), 1);

    let Json(info) = fs_get_entry_info(
        State(state.clone()),
        Query(FsPathQuery {
            path: file.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("entry info");
    assert!(info.is_file);

    fs_delete_entry(
        State(state),
        Json(FsCreateRequest {
            path: file.to_string_lossy().to_string(),
        }),
    )
    .await
    .expect("delete file");
}
