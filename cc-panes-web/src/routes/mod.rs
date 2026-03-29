pub mod static_files;
pub mod terminal;

use axum::{
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::CorsLayer;

use crate::state::AppState;
use crate::ws_handler::ws_upgrade;

/// Build the axum router with all routes.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/sessions", post(terminal::create_session))
        .route("/api/sessions", get(terminal::list_sessions))
        .route("/api/sessions/{id}/resize", post(terminal::resize_session))
        .route("/api/sessions/{id}", delete(terminal::kill_session));

    let ws = Router::new().route("/ws/{session_id}", get(ws_upgrade));

    Router::new()
        .merge(api)
        .merge(ws)
        .fallback(static_files::static_handler)
        .layer(CorsLayer::permissive())
        .with_state(state)
}
