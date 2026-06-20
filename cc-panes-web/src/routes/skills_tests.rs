use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::TerminalBufferMode,
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
        "cc-panes-web-skills-{name}-{millis}-{}",
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

fn installed_skill(id: &str) -> cc_panes_core::services::InstalledUserSkill {
    cc_panes_core::services::InstalledUserSkill {
        id: id.to_string(),
        name: id.to_string(),
        description: Some("A user skill".to_string()),
        category: Some("test".to_string()),
        tags: vec!["smoke".to_string()],
        version: "1.0.0".to_string(),
        license: Some("MIT".to_string()),
        homepage_url: None,
        source_url: None,
        content_sha256: "abc".to_string(),
        installed_at: "2026-06-20T00:00:00Z".to_string(),
        file_path: None,
    }
}

#[tokio::test]
async fn project_skill_routes_match_tauri_skill_commands() {
    let (state, root) = test_state("project");
    let project = root.join("project");
    let target = root.join("target");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::create_dir_all(&target).expect("target dir");
    let project_path = project.to_string_lossy().to_string();
    let target_path = target.to_string_lossy().to_string();

    let Json(saved) = save_skill(
        State(state.clone()),
        Json(SaveSkillRequest {
            project_path: project_path.clone(),
            name: "make-component".to_string(),
            content: "# Make Component\n\nBuild a component".to_string(),
        }),
    )
    .await
    .expect("save skill");
    assert_eq!(saved.name, "make-component");
    assert!(saved
        .file_path
        .ends_with(".claude/commands/make-component.md"));

    let Json(skills) = list_skills(
        State(state.clone()),
        Query(ProjectSkillsQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list skills");
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "make-component");

    let Json(skill) = get_skill(
        State(state.clone()),
        Path("make-component".to_string()),
        Query(ProjectSkillsQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("get skill");
    assert_eq!(
        skill.expect("skill").content,
        "# Make Component\n\nBuild a component"
    );

    let Json(copied) = copy_skill(
        State(state.clone()),
        Json(CopySkillRequest {
            source_project: project_path.clone(),
            target_project: target_path.clone(),
            name: "make-component".to_string(),
        }),
    )
    .await
    .expect("copy skill");
    assert_eq!(copied.name, "make-component");
    assert!(copied.file_path.contains("target/.claude/commands"));

    let Json(deleted) = delete_skill(
        State(state.clone()),
        Query(SkillQuery {
            project_path: project_path.clone(),
            name: "make-component".to_string(),
        }),
    )
    .await
    .expect("delete skill");
    assert!(deleted);

    let Json(skill) = get_skill(
        State(state),
        Path("make-component".to_string()),
        Query(ProjectSkillsQuery { project_path }),
    )
    .await
    .expect("get deleted skill");
    assert!(skill.is_none());
}

#[tokio::test]
async fn project_skill_routes_reject_invalid_names() {
    let (state, root) = test_state("invalid");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let result = save_skill(
        State(state),
        Json(SaveSkillRequest {
            project_path: project.to_string_lossy().to_string(),
            name: "../escape".to_string(),
            content: "bad".to_string(),
        }),
    )
    .await;

    let Err((status, message)) = result else {
        panic!("invalid name should fail");
    };
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message.contains("path separators"));
}

#[tokio::test]
async fn external_and_user_skill_routes_are_exposed() {
    let (state, _root) = test_state("user");
    let skill = installed_skill("frontend-design");
    state
        .user_skill_service
        .write_skill(&skill, "# Frontend Design\n\nUse visual hierarchy.")
        .expect("write user skill");

    let Json(user_skills) = list_user_skills(State(state.clone()))
        .await
        .expect("list user skills");
    assert_eq!(user_skills.len(), 1);
    assert_eq!(user_skills[0].id, "frontend-design");
    assert!(user_skills[0]
        .file_path
        .as_deref()
        .unwrap_or("")
        .ends_with("SKILL.md"));

    let Json(external) = list_external_skills(
        State(state.clone()),
        Query(ExternalSkillsQuery {
            source: Some("claude".to_string()),
        }),
    )
    .await
    .expect("list external skills");
    assert!(external.is_empty());

    let invalid = list_external_skills(
        State(state.clone()),
        Query(ExternalSkillsQuery {
            source: Some("unknown".to_string()),
        }),
    )
    .await;
    assert!(matches!(invalid, Err((StatusCode::BAD_REQUEST, _))));

    let Json(removed) =
        remove_user_skill(State(state.clone()), Path("frontend-design".to_string()))
            .await
            .expect("remove user skill");
    assert!(removed);

    let Json(user_skills) = list_user_skills(State(state))
        .await
        .expect("list after remove");
    assert!(user_skills.is_empty());
}
