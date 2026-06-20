use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use cc_panes_core::{
    models::{RunnerInstanceStatus, RunnerLaunchSuggestedAction, RunnerProfileDraft},
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

struct RunnerTerminalBackend {
    session_id: String,
    pid: Option<u32>,
}

impl TerminalBackend for RunnerTerminalBackend {
    fn create_session(
        &self,
        _request: cc_panes_core::models::CreateSessionRequest,
    ) -> AppResult<String> {
        Ok(self.session_id.clone())
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
            session_id: self.session_id.clone(),
            status: SessionStatus::Idle,
            last_output_at: 0,
            pid: self.pid,
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
        Ok(None)
    }
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis();
    let path = std::env::temp_dir().join(format!(
        "cc-panes-web-runner-{name}-{millis}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str, pid: Option<u32>) -> (AppState, std::path::PathBuf) {
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
        terminal_backend: Arc::new(RunnerTerminalBackend {
            session_id: "runner-session".to_string(),
            pid,
        }),
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

fn draft(root: &std::path::Path) -> RunnerProfileDraft {
    let project_path = root.join("project").to_string_lossy().to_string();
    RunnerProfileDraft {
        id: None,
        project_path: project_path.clone(),
        workspace_name: Some("runner-workspace".to_string()),
        name: "dev".to_string(),
        command: "npm run dev".to_string(),
        cwd: project_path,
        runtime_kind: "local".to_string(),
        wsl_distro: None,
        ssh_machine_id: None,
        env: Default::default(),
        expected_ports: Vec::new(),
        tool_hint: Some("npm".to_string()),
    }
}

#[tokio::test]
async fn runner_profile_routes_match_core_service_operations() {
    let (state, root) = test_state("profiles", None);
    let mut draft = draft(&root);
    let project_path = draft.project_path.clone();

    let Json(profile) = upsert_profile(State(state.clone()), Json(draft.clone()))
        .await
        .expect("upsert profile");
    assert_eq!(profile.name, "dev");

    let Json(profiles) = list_profiles(
        State(state.clone()),
        Query(ListRunnerProfilesQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list profiles");
    assert_eq!(profiles.len(), 1);

    draft.id = Some(profile.id.clone());
    draft.command = "npm start".to_string();
    let Json(updated) = upsert_profile(State(state.clone()), Json(draft))
        .await
        .expect("update profile");
    assert_eq!(updated.command, "npm start");

    let Json(found) = get_profile(State(state.clone()), Path(profile.id.clone()))
        .await
        .expect("get profile");
    assert_eq!(found.expect("profile").command, "npm start");

    let Json(plan) = plan_launch(State(state.clone()), Path(profile.id.clone()))
        .await
        .expect("plan launch");
    assert_eq!(
        plan.suggested_actions,
        vec![RunnerLaunchSuggestedAction::StartDirect]
    );

    delete_profile(State(state.clone()), Path(profile.id))
        .await
        .expect("delete profile");
    let Json(profiles) = list_profiles(
        State(state),
        Query(ListRunnerProfilesQuery { project_path }),
    )
    .await
    .expect("list after delete");
    assert!(profiles.is_empty());
}

#[tokio::test]
async fn runner_instance_routes_register_and_mark_lifecycle() {
    let self_pid = std::process::id();
    let (state, root) = test_state("instances", Some(self_pid));
    let Json(profile) = upsert_profile(State(state.clone()), Json(draft(&root)))
        .await
        .expect("upsert profile");

    let Json(instance) = register_for_session(
        State(state.clone()),
        Json(RegisterForSessionRequest {
            session_id: "runner-session".to_string(),
            project_path: profile.project_path.clone(),
            workspace_name: profile.workspace_name.clone(),
            profile_id: Some(profile.id.clone()),
            runtime_kind: "local".to_string(),
            command: profile.command.clone(),
            cwd: profile.cwd.clone(),
        }),
    )
    .await
    .expect("register for session");
    assert_eq!(instance.root_pid, self_pid);
    assert_eq!(instance.profile_id.as_deref(), Some(profile.id.as_str()));

    let Json(active) = list_active_instances(
        State(state.clone()),
        Query(ListActiveInstancesQuery {
            project_path: Some(profile.project_path.clone()),
        }),
    )
    .await
    .expect("list active");
    assert_eq!(active.len(), 1);

    let Json(claims) = refresh_port_claims(State(state.clone()), Path(instance.id.clone()))
        .await
        .expect("refresh claims");
    assert!(claims.is_empty() || claims.iter().all(|claim| claim.pid == self_pid));

    mark_instance_exited(
        State(state.clone()),
        Path(instance.id.clone()),
        Json(MarkInstanceExitedRequest {
            exit_code: Some(0),
            orphaned: None,
        }),
    )
    .await
    .expect("mark exited");

    let Json(active) = list_active_instances(
        State(state),
        Query(ListActiveInstancesQuery {
            project_path: Some(profile.project_path),
        }),
    )
    .await
    .expect("list active after exit");
    assert!(active.is_empty());
}

#[tokio::test]
async fn runner_register_implicit_and_port_conflicts_are_exposed() {
    let (state, root) = test_state("implicit", None);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let self_pid = std::process::id();

    let Json(conflicts) = list_port_conflicts(
        State(state.clone()),
        Json(PortConflictsRequest { ports: vec![port] }),
    )
    .await
    .expect("port conflicts");
    assert!(conflicts.iter().any(|conflict| conflict.port == port));

    let project_path = root.join("project").to_string_lossy().to_string();
    let Json(instance) = register_implicit_instance(
        State(state.clone()),
        Json(RegisterImplicitInstanceRequest {
            project_path: project_path.clone(),
            workspace_name: Some("runner-workspace".to_string()),
            session_id: Some("manual-session".to_string()),
            root_pid: self_pid,
            runtime_kind: "local".to_string(),
            command: "manual dev".to_string(),
            cwd: project_path.clone(),
        }),
    )
    .await
    .expect("register implicit");
    assert_eq!(instance.status, RunnerInstanceStatus::Running);
    assert_eq!(instance.project_path, project_path);

    let Json(killed_self) = kill_pid(
        State(state),
        Json(KillPidRequest {
            pid: std::process::id(),
        }),
    )
    .await
    .expect("kill self pid");
    assert!(!killed_self);

    drop(listener);
}
