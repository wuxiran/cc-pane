use crate::state::{AppState, TerminalOutputMode};
use crate::web_auth::RequestOrigin;
use crate::websocket_access::Access;
use axum::{extract::ConnectInfo, http::HeaderMap};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use cc_panes_core::services::terminal_output_cursor::{CursorDelta, OutputCursor};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::time::{self, Duration};
use tokio_tungstenite::connect_async;
use tracing::{debug, warn};

pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(session_id): Path<String>,
    origin: Option<Extension<RequestOrigin>>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let origin = origin.map_or(RequestOrigin::Remote, |Extension(origin)| origin);
    let access = Access::new(
        &state,
        &headers,
        peer.map(|Extension(ConnectInfo(addr))| addr.ip()),
        origin,
    );
    ws.on_upgrade(move |socket| handle_ws(socket, session_id, state, access))
}

async fn handle_ws(socket: WebSocket, session_id: String, state: AppState, access: Access) {
    let (mut tx, mut rx) = socket.split();
    let mut output = state.ws_emitter.subscribe(&session_id);
    // Both directions belong to this connection. Dropping the losing future closes its
    // socket half/subscription immediately; no detached send task survives a disconnect.
    let send = async {
        match state.output_mode {
            TerminalOutputMode::Emitter => {
                while let Some(message) = output.recv().await {
                    if access.permissions(&state).is_none() {
                        break;
                    }
                    if tx.send(Message::Text(message.into())).await.is_err() {
                        break;
                    }
                }
            }
            TerminalOutputMode::Polling => {
                if let Some(url) = state.terminal_backend.event_stream_url(&session_id) {
                    match connect_async(&url).await {
                        Ok((mut stream, _)) => {
                            while let Some(Ok(message)) = stream.next().await {
                                if access.permissions(&state).is_none() {
                                    break;
                                }
                                if message.is_close() {
                                    break;
                                }
                                if let Ok(text) = message.to_text() {
                                    if tx
                                        .send(Message::Text(text.to_owned().into()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                            let _ = tx.close().await;
                            return;
                        }
                        Err(error) => {
                            warn!(session_id, %error, "daemon stream unavailable; using snapshot cursor")
                        }
                    }
                }
                let mut cursor = OutputCursor::default();
                let mut interval = time::interval(Duration::from_millis(100));
                loop {
                    interval.tick().await;
                    let backend = state.terminal_backend.clone();
                    let id = session_id.clone();
                    let snapshot = tokio::task::spawn_blocking(move || {
                        backend.get_session_recovery_snapshot(&id)
                    })
                    .await;
                    let snapshot = match snapshot {
                        Ok(Ok(Some(snapshot))) => snapshot,
                        Ok(Ok(None)) => break,
                        error => {
                            warn!(session_id, ?error, "terminal snapshot polling failed");
                            break;
                        }
                    };
                    let message = match cursor.recovery(
                        snapshot.checkpoint_epoch,
                        snapshot.end_seq,
                        &snapshot.delta,
                    ) {
                        CursorDelta::Unchanged => continue,
                        CursorDelta::Resync => serde_json::json!({"type":"desync"}),
                        CursorDelta::Data(data) => {
                            serde_json::json!({"type":"output", "data":data, "endSeq":snapshot.end_seq})
                        }
                    };
                    if access.permissions(&state).is_none() {
                        break;
                    }
                    if tx
                        .send(Message::Text(message.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = tx.close().await;
    };
    let receive = async {
        while let Some(Ok(message)) = rx.next().await {
            let Some(read_only) = access.permissions(&state) else {
                break;
            };
            let command = match message {
                Message::Text(text) => parse_command(&text, read_only),
                Message::Binary(data) if !read_only => String::from_utf8(data.to_vec())
                    .map(ClientCommand::Input)
                    .map_err(anyhow::Error::from),
                Message::Close(_) => break,
                _ => continue,
            };
            let command = match command {
                Ok(command) => command,
                Err(error) => {
                    warn!(session_id, %error, "terminal client command rejected");
                    continue;
                }
            };
            if matches!(command, ClientCommand::Input(_)) && !access.touch_input(&state) {
                break;
            }
            let backend = state.terminal_backend.clone();
            let id = session_id.clone();
            let result = tokio::task::spawn_blocking(move || match command {
                ClientCommand::Input(data) => backend.write(&id, &data),
                ClientCommand::Resize(cols, rows) => backend.resize(&id, cols, rows),
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                warn!(session_id, ?result, "terminal client operation failed");
                break;
            }
        }
    };
    tokio::select! { _ = access.revoked(&state) => {}, _ = send => {}, _ = receive => {} }
    drop(output);
    state.ws_emitter.cleanup_session(&session_id);
    debug!(session_id, "WebSocket disconnected");
}

#[derive(Debug, PartialEq)]
enum ClientCommand {
    Input(String),
    Resize(u16, u16),
}
fn parse_command(text: &str, read_only: bool) -> anyhow::Result<ClientCommand> {
    let message: serde_json::Value = serde_json::from_str(text)?;
    let kind = message.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if read_only {
        anyhow::bail!("remote read-only mode: command rejected");
    }
    match kind {
        "input" => Ok(ClientCommand::Input(
            message
                .get("data")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("input data must be text"))?
                .to_owned(),
        )),
        "resize" => {
            let dimension = |name: &str, min| {
                message
                    .get(name)
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u16::try_from(v).ok())
                    .filter(|v| *v >= min)
                    .ok_or_else(|| anyhow::anyhow!("invalid {name}"))
            };
            Ok(ClientCommand::Resize(
                dimension("cols", 2)?,
                dimension("rows", 1)?,
            ))
        }
        _ => anyhow::bail!("unknown terminal command"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readonly_rejects_both_input_and_shared_pty_resize() {
        assert!(parse_command(r#"{"type":"input","data":"x"}"#, true).is_err());
        assert!(parse_command(r#"{"type":"resize","cols":80,"rows":24}"#, true).is_err());
    }
    #[test]
    fn validates_dimensions_without_integer_wraparound_or_arbitrary_small_pane_limits() {
        assert_eq!(
            parse_command(r#"{"type":"resize","cols":18,"rows":4}"#, false).unwrap(),
            ClientCommand::Resize(18, 4)
        );
        for cols in [0, 1, 65536, u64::MAX] {
            assert!(parse_command(
                &serde_json::json!({"type":"resize","cols":cols,"rows":1}).to_string(),
                false
            )
            .is_err());
        }
    }
}
