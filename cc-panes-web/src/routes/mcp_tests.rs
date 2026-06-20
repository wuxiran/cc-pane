use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::{shared_mcp::SharedMcpServerConfig, TerminalBufferMode},
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
        "cc-panes-web-mcp-{name}-{millis}-{}",
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

#[tokio::test]
async fn project_mcp_routes_match_tauri_mcp_commands() {
    let (state, root) = test_state("project");
    let project = root.join("project");
    let claude_dir = project.join(".claude");
    std::fs::create_dir_all(&claude_dir).expect("claude dir");
    std::fs::write(
        claude_dir.join("settings.local.json"),
        r#"{"mcpServers":{},"customField":"preserved"}"#,
    )
    .expect("settings");
    let project_path = project.to_string_lossy().to_string();

    upsert_mcp_server(
        State(state.clone()),
        Json(UpsertMcpServerRequest {
            project_path: project_path.clone(),
            name: "context7".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@upstash/context7-mcp".to_string()],
            env: std::collections::HashMap::from([("API_KEY".to_string(), "test".to_string())]),
        }),
    )
    .await
    .expect("upsert mcp");

    let Json(servers) = list_mcp_servers(
        State(state.clone()),
        Query(ProjectMcpQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("list mcp");
    assert_eq!(servers.len(), 1);
    assert_eq!(servers["context7"].command, "npx");

    let Json(server) = get_mcp_server(
        State(state.clone()),
        Path("context7".to_string()),
        Query(ProjectMcpQuery {
            project_path: project_path.clone(),
        }),
    )
    .await
    .expect("get mcp");
    assert_eq!(server.expect("server").args.len(), 2);

    let raw = std::fs::read_to_string(claude_dir.join("settings.local.json")).expect("read");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(parsed["customField"], "preserved");

    let Json(removed) = remove_mcp_server(
        State(state.clone()),
        Query(RemoveMcpServerQuery {
            project_path: project_path.clone(),
            name: "context7".to_string(),
        }),
    )
    .await
    .expect("remove mcp");
    assert!(removed);

    let Json(servers) = list_mcp_servers(State(state), Query(ProjectMcpQuery { project_path }))
        .await
        .expect("list after remove");
    assert!(servers.is_empty());
}

#[tokio::test]
async fn shared_mcp_routes_manage_config_without_starting_processes() {
    let (state, _root) = test_state("shared");

    let status = upsert_shared_mcp_server(
        State(state.clone()),
        Json(SharedServerRequest {
            name: "fetch".to_string(),
            config: SharedMcpServerConfig {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "mcp-proxy".to_string()],
                env: Default::default(),
                shared: true,
                port: 3131,
                bridge_mode: Default::default(),
            },
        }),
    )
    .await
    .expect("upsert shared");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let Json(config) = get_shared_mcp_config(State(state.clone())).await;
    assert!(config.servers.contains_key("fetch"));

    let Json(statuses) = get_shared_mcp_status(State(state.clone())).await;
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].name, "fetch");
    assert!(statuses[0].pid.is_none());

    update_shared_mcp_global_config(
        State(state.clone()),
        Json(SharedGlobalConfigRequest {
            port_range_start: 3200,
            port_range_end: 3299,
            health_check_interval_secs: 10,
            max_restarts: 5,
        }),
    )
    .await
    .expect("update global");
    let Json(config) = get_shared_mcp_config(State(state.clone())).await;
    assert_eq!(config.port_range_start, 3200);
    assert_eq!(config.max_restarts, 5);

    remove_shared_mcp_server(State(state.clone()), Path("fetch".to_string()))
        .await
        .expect("remove shared");
    let Json(config) = get_shared_mcp_config(State(state)).await;
    assert!(config.servers.is_empty());
}
