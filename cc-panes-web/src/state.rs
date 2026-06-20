use std::sync::Arc;

use cc_panes_core::services::{
    ExternalSkillRegistry, FileSystemService, HistoryService, LaunchHistoryService,
    LaunchProfileService, McpConfigService, MemoryService, PlanService, ProcessMonitorService,
    ProjectService, ProviderService, RunnerService, SessionRestoreService, SettingsService,
    SharedMcpService, SkillService, SpecService, SshMachineService, TaskBindingService,
    TerminalBackend, TodoService, UsageStatsService, UserSkillService, WorkspaceService,
    WorktreeService,
};

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
    pub launch_profile_service: Arc<LaunchProfileService>,
    pub memory_service: Arc<MemoryService>,
    pub ssh_machine_service: Arc<SshMachineService>,
    pub session_restore_service: Arc<SessionRestoreService>,
    pub history_service: Arc<HistoryService>,
    pub worktree_service: Arc<WorktreeService>,
    pub runner_service: Arc<RunnerService>,
    pub process_monitor_service: Arc<ProcessMonitorService>,
    pub mcp_config_service: Arc<McpConfigService>,
    pub shared_mcp_service: Arc<SharedMcpService>,
    pub skill_service: Arc<SkillService>,
    pub plan_service: Arc<PlanService>,
    pub external_skill_registry: Arc<ExternalSkillRegistry>,
    pub user_skill_service: Arc<UserSkillService>,
    pub usage_stats_service: Arc<UsageStatsService>,
    pub ws_emitter: Arc<WsEmitter>,
    pub default_cwd: String,
    pub output_mode: TerminalOutputMode,
}
