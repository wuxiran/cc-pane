use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::watch;
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
/// 断开后指数退避重连；daemon client 被替换时立即放弃旧 URL/token。
/// manager 只启动一个常驻任务，避免每次自愈都叠加一个 desktop 控制连接。
pub struct TerminalDaemonControlLink {
    client_tx: watch::Sender<Option<TerminalDaemonClient>>,
}

impl TerminalDaemonControlLink {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (client_tx, client_rx) = watch::channel(None);
        tauri::async_runtime::spawn(run_control_link(client_rx, app_handle));
        Self { client_tx }
    }

    pub fn replace_client(&self, client: TerminalDaemonClient) {
        self.client_tx.send_replace(Some(client));
    }
}

async fn run_control_link(
    mut client_rx: watch::Receiver<Option<TerminalDaemonClient>>,
    app_handle: tauri::AppHandle,
) {
    'client: loop {
        let Some(client) = client_rx.borrow().clone() else {
            if client_rx.changed().await.is_err() {
                return;
            }
            continue;
        };
        let url = client.websocket_control_url("desktop");
        let mut backoff = RECONNECT_MIN;

        loop {
            let connection = tokio::select! {
                changed = client_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    continue 'client;
                }
                connection = connect_async(&url) => connection,
            };

            match connection {
                Ok((mut ws, _)) => {
                    debug!(daemon_addr = %client.addr(), "terminal daemon control link connected");
                    backoff = RECONNECT_MIN;
                    loop {
                        let message = tokio::select! {
                            changed = client_rx.changed() => {
                                if changed.is_err() {
                                    return;
                                }
                                continue 'client;
                            }
                            message = ws.next() => message,
                        };
                        let message = match message {
                            Some(Ok(message)) => message,
                            Some(Err(_)) | None => break,
                        };
                        if !message.is_text() {
                            continue;
                        }
                        match parse_control_event(message.to_text().unwrap_or_default()) {
                            Ok(Some(event)) => {
                                if crate::webview_reliability::webview_emits_allowed() {
                                    if let Err(error) = app_handle.emit(event.name, event.payload) {
                                        warn!(error = %error, "terminal daemon control event emit failed");
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(error) => {
                                warn!(error = %error, "terminal daemon control message parse failed");
                            }
                        }
                    }
                    warn!(daemon_addr = %client.addr(), "terminal daemon control link disconnected; reconnecting");
                }
                Err(error) => {
                    debug!(daemon_addr = %client.addr(), error = %error, "terminal daemon control link connect failed");
                }
            }

            tokio::select! {
                changed = client_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    continue 'client;
                }
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(RECONNECT_MAX);
        }
    }
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
