use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio::time::{self, Duration};
use tokio_tungstenite::connect_async;
use tracing::{debug, error, warn};

use crate::state::{AppState, TerminalOutputMode};

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
    let send_task = match state.output_mode {
        TerminalOutputMode::Emitter => tokio::spawn(async move {
            while let Some(msg) = output_rx.recv().await {
                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            debug!(session_id = sid_clone, "WS send task ended");
        }),
        TerminalOutputMode::Polling => {
            let backend = state.terminal_backend.clone();
            tokio::spawn(async move {
                if let Some(url) = backend.event_stream_url(&sid_clone) {
                    match connect_async(&url).await {
                        Ok((mut daemon_ws, _)) => {
                            while let Some(message) = daemon_ws.next().await {
                                match message {
                                    Ok(message) if message.is_text() => match message.to_text() {
                                        Ok(text) => {
                                            if ws_tx
                                                .send(Message::Text(text.to_string().into()))
                                                .await
                                                .is_err()
                                            {
                                                break;
                                            }
                                        }
                                        Err(error) => {
                                            warn!(
                                                session_id = sid_clone,
                                                error = %error,
                                                "WS daemon stream text decode failed"
                                            );
                                            break;
                                        }
                                    },
                                    Ok(message) if message.is_close() => break,
                                    Ok(_) => {}
                                    Err(error) => {
                                        warn!(session_id = sid_clone, error = %error, "WS daemon stream failed");
                                        break;
                                    }
                                }
                            }
                            debug!(session_id = sid_clone, "WS daemon stream send task ended");
                            return;
                        }
                        Err(error) => {
                            warn!(session_id = sid_clone, error = %error, "WS daemon stream connect failed; falling back to polling");
                        }
                    }
                }

                let mut last_snapshot = String::new();
                let mut interval = time::interval(Duration::from_millis(100));
                loop {
                    interval.tick().await;
                    match backend.get_session_replay_snapshot(&sid_clone) {
                        Ok(Some(snapshot)) => {
                            if let Some(data) =
                                replay_snapshot_delta(&last_snapshot, &snapshot.data)
                            {
                                last_snapshot = snapshot.data;
                                let msg = serde_json::json!({
                                    "type": "output",
                                    "data": data,
                                })
                                .to_string();
                                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            warn!(session_id = sid_clone, error = %error, "WS polling output failed");
                            break;
                        }
                    }
                }
                debug!(session_id = sid_clone, "WS polling send task ended");
            })
        }
    };

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
                    let _ = state.terminal_backend.write(&session_id, &text);
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
            state
                .terminal_backend
                .write(session_id, data)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        }
        "resize" => {
            let cols = msg.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = msg.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            state
                .terminal_backend
                .resize(session_id, cols, rows)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        }
        other => {
            error!(msg_type = other, "Unknown WS message type");
        }
    }
    Ok(())
}

fn replay_snapshot_delta(previous: &str, current: &str) -> Option<String> {
    if current.is_empty() {
        return None;
    }
    if previous.is_empty() {
        return Some(current.to_string());
    }
    if current == previous {
        return None;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return Some(delta.to_string());
    }
    Some(current.to_string())
}

#[cfg(test)]
mod tests {
    use super::replay_snapshot_delta;

    #[test]
    fn replay_snapshot_delta_returns_only_new_suffix() {
        assert_eq!(
            replay_snapshot_delta("\u{1b}[2Jready", "\u{1b}[2Jready\nnext"),
            Some("\nnext".to_string())
        );
        assert_eq!(replay_snapshot_delta("same", "same"), None);
        assert_eq!(
            replay_snapshot_delta("old prefix", "new buffer"),
            Some("new buffer".to_string())
        );
    }
}
