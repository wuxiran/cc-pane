use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, error, warn};

use crate::state::AppState;

/// Upgrade HTTP to WebSocket for a terminal session.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    debug!(session_id, "WebSocket upgrade requested");
    ws.on_upgrade(move |socket| handle_ws(socket, session_id, state))
}

async fn handle_ws(socket: WebSocket, session_id: String, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Subscribe to terminal output for this session
    let mut output_rx = state.ws_emitter.subscribe(&session_id);

    debug!(session_id, "WebSocket connected");

    // Task: forward terminal output → WebSocket client
    let sid_clone = session_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = output_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        debug!(session_id = sid_clone, "WS send task ended");
    });

    // Main loop: receive from WebSocket client → terminal
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => {
                if let Err(e) = handle_client_message(&text, &session_id, &state) {
                    warn!(session_id, error = %e, "Failed to handle WS message");
                }
            }
            Message::Binary(data) => {
                // Treat binary as raw terminal input
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    let _ = state.terminal_service.write(&session_id, &text);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup
    send_task.abort();
    state.ws_emitter.cleanup_session(&session_id);
    debug!(session_id, "WebSocket disconnected");
}

/// Parse and handle a JSON message from the WebSocket client.
fn handle_client_message(text: &str, session_id: &str, state: &AppState) -> anyhow::Result<()> {
    let msg: serde_json::Value = serde_json::from_str(text)?;
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "input" => {
            let data = msg.get("data").and_then(|v| v.as_str()).unwrap_or("");
            state.terminal_service.write(session_id, data)?;
        }
        "resize" => {
            let cols = msg.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = msg.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            state.terminal_service.resize(session_id, cols, rows)?;
        }
        other => {
            error!(msg_type = other, "Unknown WS message type");
        }
    }
    Ok(())
}
