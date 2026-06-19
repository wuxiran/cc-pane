use std::sync::Arc;

use cc_panes_core::services::{
    FileSystemService, LaunchHistoryService, ProjectService, ProviderService,
    SessionRestoreService, SettingsService, SpecService, TaskBindingService, TerminalBackend,
    TodoService, WorkspaceService,
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
    pub session_restore_service: Arc<SessionRestoreService>,
    pub ws_emitter: Arc<WsEmitter>,
    pub default_cwd: String,
    pub output_mode: TerminalOutputMode,
}
