//! ComfyUI's execution event stream.
//!
//! The stream is intentionally a thin transport wrapper. It parses each
//! message through [`super::comfy::ComfyEvent`], preserves unknown event types,
//! and never treats a websocket message as the authoritative output state.
//! Callers should continue polling `/history/{prompt_id}` after disconnects or
//! terminal-looking events.

use super::comfy::ComfyEvent;
use crate::utils::error::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use url::Url;

const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Convert a configured ComfyUI HTTP(S) base URL into a websocket endpoint.
/// Existing path prefixes are retained, so reverse proxies mounted below a
/// sub-path continue to work.
pub fn comfy_websocket_url(base_url: &str, client_id: &str) -> AppResult<Url> {
    if client_id.trim().is_empty()
        || client_id.len() > 128
        || client_id.chars().any(char::is_control)
    {
        return Err(AppError::coded(
            "COMFY_CLIENT_ID_INVALID",
            "ComfyUI websocket client id is invalid",
        ));
    }
    let mut base = Url::parse(base_url)
        .map_err(|_| AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI base URL is invalid"))?;
    match base.scheme() {
        "http" => {
            let _ = base.set_scheme("ws");
        }
        "https" => {
            let _ = base.set_scheme("wss");
        }
        "ws" | "wss" => {}
        _ => {
            return Err(AppError::coded(
                "COMFY_PROFILE_INVALID",
                "ComfyUI URL must use HTTP(S)",
            ));
        }
    }
    if base.query().is_some() || base.fragment().is_some() {
        return Err(AppError::coded(
            "COMFY_PROFILE_INVALID",
            "ComfyUI base URL must not contain query or fragment",
        ));
    }
    let mut endpoint = base.join("ws").map_err(|_| {
        AppError::coded("COMFY_PROFILE_INVALID", "ComfyUI websocket path is invalid")
    })?;
    endpoint
        .query_pairs_mut()
        .append_pair("clientId", client_id);
    Ok(endpoint)
}

/// A connected, bounded ComfyUI websocket reader.
pub struct ComfyEventStream {
    socket: Socket,
}

impl std::fmt::Debug for ComfyEventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComfyEventStream").finish_non_exhaustive()
    }
}

impl ComfyEventStream {
    pub async fn connect(base_url: &str, client_id: &str) -> AppResult<Self> {
        Self::connect_with_timeout(base_url, client_id, DEFAULT_CONNECT_TIMEOUT).await
    }

    pub async fn connect_with_timeout(
        base_url: &str,
        client_id: &str,
        timeout: Duration,
    ) -> AppResult<Self> {
        if timeout.is_zero() {
            return Err(AppError::coded(
                "COMFY_WS_TIMEOUT_INVALID",
                "ComfyUI websocket timeout must be positive",
            ));
        }
        let endpoint = comfy_websocket_url(base_url, client_id)?;
        let result = tokio::time::timeout(timeout, connect_async(endpoint.as_str())).await;
        let (socket, _) = result
            .map_err(|_| {
                AppError::coded(
                    "COMFY_WS_CONNECT_TIMEOUT",
                    "timed out connecting to ComfyUI websocket",
                )
            })?
            .map_err(|error| {
                AppError::coded(
                    "COMFY_WS_CONNECT_FAILED",
                    format!("failed to connect to ComfyUI websocket: {error}"),
                )
            })?;
        Ok(Self { socket })
    }

    /// Read the next parsed event. `Ok(None)` means the peer closed the
    /// connection; callers should reconnect and resume `/history` polling.
    pub async fn next_event(&mut self) -> AppResult<Option<ComfyEvent>> {
        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|error| {
                AppError::coded(
                    "COMFY_WS_READ_FAILED",
                    format!("ComfyUI websocket read failed: {error}"),
                )
            })?;
            match message {
                Message::Text(text) => return parse_message(text.as_bytes()),
                // ComfyUI sends preview images and other render-only payloads
                // as binary frames. They are not durable job state, and
                // attempting to parse them as JSON would tear down the event
                // stream on the first preview frame. Final outputs still come
                // from /history, so these frames can be ignored safely.
                Message::Binary(_) => {}
                Message::Ping(payload) => {
                    self.socket
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|error| {
                            AppError::coded(
                                "COMFY_WS_WRITE_FAILED",
                                format!("failed to answer ComfyUI websocket ping: {error}"),
                            )
                        })?;
                }
                Message::Pong(_) => {}
                Message::Close(_) => return Ok(None),
                _ => {}
            }
        }
        Ok(None)
    }

    pub async fn close(mut self) -> AppResult<()> {
        self.socket.close(None).await.map_err(|error| {
            AppError::coded(
                "COMFY_WS_CLOSE_FAILED",
                format!("failed to close ComfyUI websocket: {error}"),
            )
        })
    }
}

fn parse_message(bytes: &[u8]) -> AppResult<Option<ComfyEvent>> {
    if bytes.len() > MAX_EVENT_BYTES {
        return Err(AppError::coded(
            "COMFY_EVENT_TOO_LARGE",
            "ComfyUI websocket event exceeds the size limit",
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| {
        AppError::coded(
            "COMFY_EVENT_INVALID",
            "ComfyUI websocket event is not valid JSON",
        )
    })?;
    ComfyEvent::parse(&value).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_preserves_prefix_and_uses_client_id_query() {
        let url = comfy_websocket_url("https://example.test/comfy/", "client-1").unwrap();
        assert_eq!(
            url.as_str(),
            "wss://example.test/comfy/ws?clientId=client-1"
        );
    }

    #[test]
    fn websocket_url_rejects_query_and_bad_client_id() {
        assert!(comfy_websocket_url("http://127.0.0.1:8188/?token=x", "ok").is_err());
        assert!(comfy_websocket_url("http://127.0.0.1:8188", "bad\nvalue").is_err());
    }

    #[test]
    fn parses_unknown_events_without_dropping_payload() {
        let event = parse_message(br#"{"type":"future_event","data":{"value":1}}"#)
            .unwrap()
            .unwrap();
        assert!(
            matches!(event, ComfyEvent::Unknown { event_type, .. } if event_type == "future_event")
        );
    }
}
