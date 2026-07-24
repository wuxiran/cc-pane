use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::Emitter;
use tokio_tungstenite::connect_async;
use tracing::{debug, warn};

use cc_panes_core::constants::events as EV;

use crate::services::TerminalDaemonClient;

const RECONNECT_MIN: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(60);

/// 维持到 daemon 的桌面控制 WS 连接（`/ws/control?kind=desktop`）。
///
/// daemon 用活跃控制连接数统计 `desktopClientCount`，前端孤儿会话对账在
/// 计数 >1 时 fail-closed 跳过——多个桌面实例共享 daemon 时，任何单实例的
/// "被引用会话全集"都是残缺视图，据此杀会话会误杀其他实例的面板。
///
/// 同一连接也接收 daemon 的低频控制事件：当某会话没有独立 WS bridge 时，
/// daemon 会从这里兜底下发 sessionKilled，桌面再转成同名 Tauri app 事件。
///
/// 断开后指数退避重连，任务与 app 同生命周期。
pub fn spawn_terminal_daemon_control_link(
    client: TerminalDaemonClient,
    app_handle: tauri::AppHandle,
) {
    tauri::async_runtime::spawn(async move {
        let url = client.websocket_control_url("desktop");
        let mut backoff = RECONNECT_MIN;
        loop {
            match connect_async(&url).await {
                Ok((mut ws, _)) => {
                    debug!("terminal daemon control link connected");
                    backoff = RECONNECT_MIN;
                    while let Some(message) = ws.next().await {
                        let message = match message {
                            Ok(message) => message,
                            Err(_) => break,
                        };
                        if !message.is_text() {
                            continue;
                        }
                        match parse_control_event(message.to_text().unwrap_or_default()) {
                            Ok(Some(event)) => {
                                if let Err(error) = app_handle.emit(event.name, event.payload) {
                                    warn!(error = %error, "terminal daemon control event emit failed");
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                warn!(error = %error, "terminal daemon control message parse failed");
                            }
                        }
                    }
                    warn!("terminal daemon control link disconnected; reconnecting");
                }
                Err(error) => {
                    debug!(error = %error, "terminal daemon control link connect failed");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RECONNECT_MAX);
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum DaemonControlMessage {
    SessionKilled {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, PartialEq)]
struct ControlEvent {
    name: &'static str,
    payload: serde_json::Value,
}

fn parse_control_event(text: &str) -> serde_json::Result<Option<ControlEvent>> {
    let message = serde_json::from_str::<DaemonControlMessage>(text)?;
    Ok(match message {
        DaemonControlMessage::SessionKilled { session_id, reason } => Some(ControlEvent {
            name: EV::SESSION_KILLED,
            payload: serde_json::json!({
                "sessionId": session_id,
                "reason": reason.as_deref().unwrap_or("unknown"),
            }),
        }),
        DaemonControlMessage::Unknown => None,
    })
}

#[cfg(test)]
mod tests {
    use cc_panes_core::constants::events as EV;

    use super::*;

    #[test]
    fn session_killed_control_message_maps_to_frontend_event() {
        let event = parse_control_event(
            r#"{"type":"sessionKilled","sessionId":"session-1","reason":"mcp"}"#,
        )
        .expect("valid control message")
        .expect("known control message");

        assert_eq!(event.name, EV::SESSION_KILLED);
        assert_eq!(
            event.payload,
            serde_json::json!({
                "sessionId": "session-1",
                "reason": "mcp",
            })
        );
    }

    #[test]
    fn unknown_control_message_is_ignored_for_forward_compatibility() {
        assert!(parse_control_event(r#"{"type":"futureEvent"}"#)
            .expect("unknown message must still parse")
            .is_none());
    }
}
