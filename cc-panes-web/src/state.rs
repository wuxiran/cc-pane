use std::sync::Arc;

use cc_panes_core::services::TerminalService;

use crate::ws_emitter::WsEmitter;

/// Shared application state for axum handlers.
#[derive(Clone)]
pub struct AppState {
    pub terminal_service: Arc<TerminalService>,
    pub ws_emitter: Arc<WsEmitter>,
    pub default_cwd: String,
    pub default_shell: Option<String>,
}
