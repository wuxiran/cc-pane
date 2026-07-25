use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::services::{
    ExternalSkillRegistry, FileSystemService, HistoryService, JournalService, LaunchHistoryService,
    LaunchProfileService, LayoutSnapshotService, McpConfigService, MemoryService, PlanService,
    ProcessMonitorService, ProjectCliHooksService, ProjectService, ProviderService,
    QuickCommandService, RunnerService, SessionIndexService, SessionRestoreService,
    SettingsService, SharedMcpService, SkillService, SpecService, SshMachineService,
    TaskBindingService, TerminalBackend, TodoService,
    UsageStatsService, UserSkillService, WorkspaceService, WorktreeService,
};

use crate::web_auth::WebAuthStore;
use crate::ws_emitter::WsEmitter;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalOutputMode {
    Emitter,
    Polling,
}

/// Shared application state for axum handlers.
#[derive(Clone)]
pub struct AppState {
    pub terminal_backend: Arc<dyn TerminalBackend>,
    pub workspace_service: Arc<WorkspaceService>,
    pub project_service: Arc<ProjectService>,
    pub provider_service: Arc<ProviderService>,
    pub settings_service: Arc<SettingsService>,
    pub filesystem_service: Arc<FileSystemService>,
    pub todo_service: Arc<TodoService>,
    pub spec_service: Arc<SpecService>,
    pub task_binding_service: Arc<TaskBindingService>,
    pub launch_history_service: Arc<LaunchHistoryService>,
    pub layout_snapshot_service: Arc<LayoutSnapshotService>,
    pub launch_profile_service: Arc<LaunchProfileService>,
    pub quick_command_service: Arc<QuickCommandService>,
    pub memory_service: Arc<MemoryService>,
    pub ssh_machine_service: Arc<SshMachineService>,
    pub session_restore_service: Arc<SessionRestoreService>,
    pub history_service: Arc<HistoryService>,
    pub worktree_service: Arc<WorktreeService>,
    pub runner_service: Arc<RunnerService>,
    pub process_monitor_service: Arc<ProcessMonitorService>,
    pub project_cli_hooks_service: Arc<ProjectCliHooksService>,
    pub journal_service: Arc<JournalService>,
    pub cli_registry: Arc<CliToolRegistry>,
    pub mcp_config_service: Arc<McpConfigService>,
    pub shared_mcp_service: Arc<SharedMcpService>,
    pub skill_service: Arc<SkillService>,
    pub plan_service: Arc<PlanService>,
    pub external_skill_registry: Arc<ExternalSkillRegistry>,
    pub user_skill_service: Arc<UserSkillService>,
    pub usage_stats_service: Arc<UsageStatsService>,
    pub session_index_service: Arc<SessionIndexService>,
    pub ws_emitter: Arc<WsEmitter>,
    pub web_auth: Arc<WebAuthStore>,
    pub default_cwd: String,
    pub output_mode: TerminalOutputMode,
}

#[cfg(test)]
pub fn test_session_index_service(workspaces_dir: std::path::PathBuf) -> Arc<SessionIndexService> {
    let db = Arc::new(
        cc_panes_core::repository::Database::new_fallback().expect("session index test database"),
    );
    Arc::new(SessionIndexService::new(
        Arc::new(cc_panes_core::repository::SessionIndexRepository::new(
            db.clone(),
        )),
        Arc::new(LaunchHistoryService::new(Arc::new(
            cc_panes_core::repository::HistoryRepository::new(db),
        ))),
        Arc::new(WorkspaceService::new(workspaces_dir)),
    ))
}
