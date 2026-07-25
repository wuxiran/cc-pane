use std::sync::Arc;

use axum::{
    extract::{Path, State},
    Json,
};
use cc_panes_core::{
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        terminal_service::{SessionOutput, SessionStatus},
        FileSystemService, HistoryService, LaunchHistoryService, LaunchProfileService,
        LayoutSnapshotService, McpConfigService, PlanService, ProcessMonitorService,
        ProjectService, ProviderService, RunnerService, SessionRestoreService, SettingsService,
        SharedMcpService, SpecService, SshCredentialService, SshMachineService, TaskBindingService,
        TerminalBackend, TodoService, UsageStatsService, WorkspaceService, WorktreeService,
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
        "cc-panes-web-process-{name}-{millis}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(name: &str) -> AppState {
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
    AppState {
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
        session_index_service: crate::state::test_session_index_service(app_paths.workspaces_dir()),
        ws_emitter: Arc::new(WsEmitter::new()),
        web_auth: Arc::new(crate::web_auth::WebAuthStore::default()),
        default_cwd: root.to_string_lossy().to_string(),
        output_mode: TerminalOutputMode::Emitter,
    }
}

#[tokio::test]
async fn scan_claude_processes_returns_consistent_result() {
    let state = test_state("scan");

    let Json(result) = scan_claude_processes(State(state))
        .await
        .expect("scan processes");

    assert_eq!(result.total_count, result.processes.len());
    assert!(!result.scanned_at.is_empty());
}

#[tokio::test]
async fn kill_claude_process_refuses_to_kill_own_process() {
    let state = test_state("kill-self");
    let own_pid = std::process::id();

    let Json(killed) = kill_claude_process(State(state), Path(own_pid))
        .await
        .expect("kill own pid");

    assert!(!killed, "self-protection must refuse to kill our own pid");
}

#[tokio::test]
async fn kill_claude_processes_reports_per_pid_results() {
    let state = test_state("kill-batch");
    let own_pid = std::process::id();

    let Json(results) = kill_claude_processes(
        State(state.clone()),
        Json(KillProcessesRequest {
            pids: vec![own_pid],
        }),
    )
    .await
    .expect("batch kill own pid");
    assert_eq!(results, vec![(own_pid, false)]);

    let Json(results) =
        kill_claude_processes(State(state), Json(KillProcessesRequest { pids: vec![] }))
            .await
            .expect("batch kill empty list");
    assert!(results.is_empty());
}
