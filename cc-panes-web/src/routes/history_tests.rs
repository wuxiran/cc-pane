use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{SavedSession, TerminalBufferMode},
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
    let path = std::env::temp_dir().join(format!("cc-panes-web-history-{name}-{millis}"));
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

fn saved_session(root: &std::path::Path) -> SavedSession {
    SavedSession {
        workspace_snapshot_id: Some("snapshot-a".to_string()),
        session_id: "pty-session-a".to_string(),
        tab_id: "tab-a".to_string(),
        pane_id: "pane-a".to_string(),
        project_path: root.join("project").to_string_lossy().to_string(),
        workspace_name: Some("workspace-a".to_string()),
        workspace_path: Some(root.to_string_lossy().to_string()),
        provider_id: Some("provider-a".to_string()),
        provider_selection: Some("explicit".to_string()),
        launch_profile_id: Some("profile-a".to_string()),
        cli_tool: "codex".to_string(),
        runtime_kind: Some("local".to_string()),
        resume_id: Some("resume-a".to_string()),
        ssh_config: None,
        custom_title: Some("Session A".to_string()),
        created_at: "2026-06-20T00:00:00Z".to_string(),
        saved_at: "2026-06-20T00:01:00Z".to_string(),
        has_output: false,
    }
}

#[tokio::test]
async fn launch_history_routes_match_core_service_operations() {
    let (state, root) = test_state("launch-history");
    let project_path = root.join("project").to_string_lossy().to_string();

    let (status, Json(id)) = add_launch_history(
        State(state.clone()),
        Json(AddLaunchHistoryRequest {
            project_id: "launch-a".to_string(),
            project_name: "Project A".to_string(),
            project_path: project_path.clone(),
            cli_tool: Some("codex".to_string()),
            runtime_kind: Some("wsl".to_string()),
            wsl_distro: Some("Ubuntu".to_string()),
            workspace_name: Some("Workspace".to_string()),
            workspace_path: Some(root.to_string_lossy().to_string()),
            launch_cwd: Some(project_path.clone()),
            provider_id: Some("provider-a".to_string()),
            provider_selection: Some("explicit".to_string()),
            launch_profile_id: Some("profile-a".to_string()),
            workspace_snapshot_id: Some("snapshot-a".to_string()),
        }),
    )
    .await
    .expect("add launch history");
    assert_eq!(status, StatusCode::CREATED);

    update_launch_session_id(
        State(state.clone()),
        Path(id),
        Json(UpdateSessionIdRequest {
            resume_session_id: "resume-a".to_string(),
        }),
    )
    .await
    .expect("update session id");
    update_launch_resume_source(
        State(state.clone()),
        Path(id),
        Json(UpdateResumeSourceRequest {
            source: "manual".to_string(),
        }),
    )
    .await
    .expect("update resume source");
    update_launch_last_prompt(
        State(state.clone()),
        Path(id),
        Json(UpdateLastPromptRequest {
            last_prompt: "continue".to_string(),
        }),
    )
    .await
    .expect("update prompt");

    let Json(records) = list_launch_history(
        State(state.clone()),
        Query(ListLaunchHistoryQuery {
            limit: Some(10),
            project_path: None,
        }),
    )
    .await
    .expect("list launch history");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].resume_session_id.as_deref(), Some("resume-a"));
    assert_eq!(records[0].resume_source.as_deref(), Some("manual"));

    let Json(project_records) = list_launch_history(
        State(state.clone()),
        Query(ListLaunchHistoryQuery {
            limit: Some(10),
            project_path: Some(project_path.clone()),
        }),
    )
    .await
    .expect("list launch history by project");
    assert_eq!(project_records.len(), 1);

    let Json(touched) = touch_launch_by_session(
        State(state.clone()),
        Json(TouchBySessionRequest {
            resume_session_id: "resume-a".to_string(),
        }),
    )
    .await
    .expect("touch by session");
    assert_eq!(touched, Some(id));

    let Json(found_resume) = find_launch_history_by_resume_session(
        State(state.clone()),
        Query(FindByResumeQuery {
            resume_session_id: "resume-a".to_string(),
        }),
    )
    .await
    .expect("find by resume");
    assert_eq!(found_resume.expect("record").id, id);

    delete_launch_history(State(state.clone()), Path(id))
        .await
        .expect("delete launch history");
    let Json(records) = list_launch_history(
        State(state),
        Query(ListLaunchHistoryQuery {
            limit: Some(10),
            project_path: None,
        }),
    )
    .await
    .expect("list after delete");
    assert!(records.is_empty());
}

#[tokio::test]
async fn launch_history_session_started_routes_update_and_upsert() {
    let (state, root) = test_state("session-started");
    let project_path = root.join("project").to_string_lossy().to_string();

    let _ = add_launch_history(
        State(state.clone()),
        Json(AddLaunchHistoryRequest {
            project_id: "launch-b".to_string(),
            project_name: "Project B".to_string(),
            project_path: project_path.clone(),
            cli_tool: None,
            runtime_kind: None,
            wsl_distro: None,
            workspace_name: None,
            workspace_path: None,
            launch_cwd: None,
            provider_id: None,
            provider_selection: None,
            launch_profile_id: None,
            workspace_snapshot_id: None,
        }),
    )
    .await
    .expect("add launch");

    let Json(updated_id) = update_launch_session_started(
        State(state.clone()),
        Json(UpdateSessionStartedRequest {
            launch_id: "launch-b".to_string(),
            pty_session_id: "pty-b".to_string(),
            resume_session_id: "resume-b".to_string(),
            cli_tool: "claude".to_string(),
            runtime_kind: "local".to_string(),
            wsl_distro: None,
            launch_cwd: Some(project_path.clone()),
        }),
    )
    .await
    .expect("update started");
    assert!(updated_id.is_some());

    let Json(found_pty) = find_launch_history_by_pty_session(
        State(state.clone()),
        Query(FindByPtyQuery {
            pty_session_id: "pty-b".to_string(),
        }),
    )
    .await
    .expect("find by pty");
    assert_eq!(
        found_pty
            .as_ref()
            .and_then(|record| record.resume_session_id.as_deref()),
        Some("resume-b")
    );

    let Json(prompt_record_id) = update_launch_last_prompt_by_pty(
        State(state.clone()),
        Json(UpdateLastPromptByPtyRequest {
            pty_session_id: "pty-b".to_string(),
            last_prompt: "prompt via pty".to_string(),
        }),
    )
    .await
    .expect("update prompt by pty");
    assert_eq!(prompt_record_id, updated_id);

    let Json(resume_record_id) = update_launch_resume_by_pty(
        State(state.clone()),
        Json(UpdateResumeByPtyRequest {
            pty_session_id: "pty-b".to_string(),
            resume_session_id: "resume-b2".to_string(),
            source: "osc-title".to_string(),
        }),
    )
    .await
    .expect("update resume by pty");
    assert_eq!(resume_record_id, updated_id);

    let Json(upserted_id) = upsert_launch_session_started(
        State(state.clone()),
        Json(UpsertSessionStartedRequest {
            started: UpdateSessionStartedRequest {
                launch_id: "launch-c".to_string(),
                pty_session_id: "pty-c".to_string(),
                resume_session_id: "resume-c".to_string(),
                cli_tool: "codex".to_string(),
                runtime_kind: "local".to_string(),
                wsl_distro: None,
                launch_cwd: Some(project_path.clone()),
            },
            project_path: project_path.clone(),
            project_name: "Project C".to_string(),
            workspace_path: Some(root.to_string_lossy().to_string()),
        }),
    )
    .await
    .expect("upsert started");
    assert!(upserted_id > 0);

    let Json(found_launch) = find_launch_history_by_launch_id(
        State(state),
        Query(FindByLaunchQuery {
            launch_id: "launch-c".to_string(),
        }),
    )
    .await
    .expect("find by launch");
    assert_eq!(
        found_launch.expect("record").pty_session_id.as_deref(),
        Some("pty-c")
    );
}

#[tokio::test]
async fn session_restore_routes_match_core_service_operations() {
    let (state, root) = test_state("session-restore");
    let session = saved_session(&root);

    save_session_output(
        State(state.clone()),
        Path(session.session_id.clone()),
        Json(SaveSessionOutputRequest {
            lines: vec!["line 1".to_string(), "line 2".to_string()],
        }),
    )
    .await
    .expect("save output");

    save_terminal_sessions(State(state.clone()), Json(vec![session.clone()]))
        .await
        .expect("save sessions");

    let Json(loaded) = load_terminal_sessions(State(state.clone()))
        .await
        .expect("load sessions");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].session_id, session.session_id);
    assert!(loaded[0].has_output);

    let Json(output) = load_session_output(State(state.clone()), Path(session.session_id.clone()))
        .await
        .expect("load output");
    assert_eq!(output.expect("output").len(), 2);

    let Json(snapshots) =
        list_workspace_snapshots(State(state.clone()), Path("workspace-a".to_string()))
            .await
            .expect("list snapshots");
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].id, "snapshot-a");

    let Json(snapshot) = get_workspace_snapshot(
        State(state.clone()),
        Path(("workspace-a".to_string(), "snapshot-a".to_string())),
    )
    .await
    .expect("get snapshot");
    assert_eq!(snapshot.expect("snapshot").entries.len(), 1);

    let Json(deleted_snapshot) = delete_workspace_snapshot(
        State(state.clone()),
        Path(("workspace-a".to_string(), "snapshot-a".to_string())),
    )
    .await
    .expect("delete snapshot");
    assert!(deleted_snapshot);

    clear_session_output(State(state.clone()), Path(session.session_id.clone()))
        .await
        .expect("clear output");
    let Json(output) = load_session_output(State(state.clone()), Path(session.session_id))
        .await
        .expect("load cleared output");
    assert!(output.is_none());

    clear_terminal_sessions(State(state.clone()))
        .await
        .expect("clear sessions");
    let Json(loaded) = load_terminal_sessions(State(state))
        .await
        .expect("load cleared sessions");
    assert!(loaded.is_empty());
}

#[tokio::test]
async fn session_state_route_reads_legacy_project_file() {
    let root = test_dir("session-state");
    let ccpanes_dir = root.join(".ccpanes");
    std::fs::create_dir_all(&ccpanes_dir).expect("create .ccpanes");
    std::fs::write(
        ccpanes_dir.join("session-state.json"),
        r#"{"claudeSessionId":"legacy-resume","cliTool":"claude","runtimeKind":"local","lastPrompt":"continue"}"#,
    )
    .expect("write session state");

    let Json(state) = read_session_state(Query(SessionStateQuery {
        project_path: root.to_string_lossy().to_string(),
    }))
    .await
    .expect("read session state");
    let state = state.expect("session state");
    assert_eq!(state.resume_session_id.as_deref(), Some("legacy-resume"));
    assert_eq!(state.cli_tool.as_deref(), Some("claude"));
}
