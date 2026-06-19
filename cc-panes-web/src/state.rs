use std::sync::Arc;

use cc_panes_core::services::TerminalBackend;

use crate::ws_emitter::WsEmitter;

/// Shared application state for axum handlers.
#[derive(Clone)]
pub struct AppState {
    pub terminal_backend: Arc<dyn TerminalBackend>,
    pub ws_emitter: Arc<WsEmitter>,
    pub default_cwd: String,
}
