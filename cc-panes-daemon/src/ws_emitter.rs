use std::collections::HashMap;
use std::sync::Arc;

use cc_panes_core::events::EventEmitter;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::debug;

#[derive(Clone, Default)]
pub struct WsEmitter {
    subscribers: Arc<RwLock<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
    control_subscribers: Arc<RwLock<Vec<mpsc::UnboundedSender<String>>>>,
}

impl WsEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self, session_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers
            .write()
            .entry(session_id.to_string())
            .or_default()
            .push(tx);
        debug!(session_id, "daemon ws subscriber registered");
        rx
    }

    pub fn subscribe_control(&self) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.control_subscribers.write().push(tx);
        debug!("daemon control subscriber registered");
        rx
    }

    /// 是否仍有活跃（未断开）的 WS 订阅者——会话孤儿判定的信号之一。
    pub fn has_active_subscriber(&self, session_id: &str) -> bool {
        let subscribers = self.subscribers.read();
        subscribers
            .get(session_id)
            .is_some_and(|senders| senders.iter().any(|sender| !sender.is_closed()))
    }

    pub fn cleanup_session(&self, session_id: &str) {
        let mut subscribers = self.subscribers.write();
        if let Some(senders) = subscribers.get_mut(session_id) {
            senders.retain(|sender| !sender.is_closed());
            if senders.is_empty() {
                subscribers.remove(session_id);
            }
        }
    }

    fn publish(&self, session_id: &str, msg: String) -> bool {
        let mut subscribers = self.subscribers.write();
        let delivered = subscribers.get_mut(session_id).is_some_and(|senders| {
            senders.retain(|sender| sender.send(msg.clone()).is_ok());
            !senders.is_empty()
        });
        if !delivered {
            subscribers.remove(session_id);
        }
        delivered
    }

    fn publish_control(&self, msg: String) {
        self.control_subscribers
            .write()
            .retain(|sender| sender.send(msg.clone()).is_ok());
    }
}

impl EventEmitter for WsEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        let Some(session_id) = payload.get("sessionId").and_then(|value| value.as_str()) else {
            return Ok(());
        };

        match event {
            "terminal-output" => {
                let data = payload
                    .get("data")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                self.publish(
                    session_id,
                    serde_json::json!({
                        "type": "output",
                        "data": data,
                    })
                    .to_string(),
                );
            }
            "terminal-exit" => {
                let exit_code = payload
                    .get("exitCode")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(-1);
                self.publish(
                    session_id,
                    serde_json::json!({
                        "type": "exit",
                        "exitCode": exit_code,
                    })
                    .to_string(),
                );
            }
            "session-killed" => {
                // kill 事件必须到达前端：user/mcp 关标签，orphan-reclaim/daemon-reaper
                // 保留标签显示退出。丢弃会导致 daemon 模式下 kill 对前端不可见。
                let reason = payload
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let delivered = self.publish(
                    session_id,
                    serde_json::json!({
                        "type": "killed",
                        "reason": reason,
                    })
                    .to_string(),
                );
                if !delivered {
                    self.publish_control(
                        serde_json::json!({
                            "type": "sessionKilled",
                            "sessionId": session_id,
                            "reason": reason,
                        })
                        .to_string(),
                    );
                }
            }
            _ => {}
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use cc_panes_core::constants::events as EV;

    use super::*;

    #[test]
    fn publishes_terminal_output_and_exit_to_session_subscribers() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        emitter
            .emit(
                EV::TERMINAL_OUTPUT,
                serde_json::json!({
                    "sessionId": "session-1",
                    "data": "ready",
                }),
            )
            .expect("output emit");
        emitter
            .emit(
                EV::TERMINAL_EXIT,
                serde_json::json!({
                    "sessionId": "session-1",
                    "exitCode": 7,
                }),
            )
            .expect("exit emit");

        let output = rx.try_recv().expect("output message");
        let exit = rx.try_recv().expect("exit message");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output).expect("output json"),
            serde_json::json!({"type":"output","data":"ready"})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&exit).expect("exit json"),
            serde_json::json!({"type":"exit","exitCode":7})
        );
    }

    #[test]
    fn publishes_session_killed_with_reason_to_subscribers() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        emitter
            .emit(
                EV::SESSION_KILLED,
                serde_json::json!({
                    "sessionId": "session-1",
                    "reason": "orphan-reclaim",
                }),
            )
            .expect("killed emit");

        let killed = rx.try_recv().expect("killed message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&killed).expect("killed json"),
            serde_json::json!({"type":"killed","reason":"orphan-reclaim"})
        );
    }

    #[test]
    fn session_killed_without_reason_defaults_to_unknown() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        emitter
            .emit(
                EV::SESSION_KILLED,
                serde_json::json!({ "sessionId": "session-1" }),
            )
            .expect("killed emit");

        let killed = rx.try_recv().expect("killed message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&killed).expect("killed json"),
            serde_json::json!({"type":"killed","reason":"unknown"})
        );
    }

    #[test]
    fn publishes_session_killed_to_control_when_session_has_no_subscribers() {
        let emitter = WsEmitter::new();
        let mut control_rx = emitter.subscribe_control();

        emitter
            .emit(
                EV::SESSION_KILLED,
                serde_json::json!({
                    "sessionId": "session-without-bridge",
                    "reason": "mcp",
                }),
            )
            .expect("killed emit");

        let killed = control_rx.try_recv().expect("control killed message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&killed).expect("control killed json"),
            serde_json::json!({
                "type": "sessionKilled",
                "sessionId": "session-without-bridge",
                "reason": "mcp",
            })
        );
    }

    #[test]
    fn session_subscriber_prevents_duplicate_control_killed() {
        let emitter = WsEmitter::new();
        let mut session_rx = emitter.subscribe("session-1");
        let mut control_rx = emitter.subscribe_control();

        emitter
            .emit(
                EV::SESSION_KILLED,
                serde_json::json!({
                    "sessionId": "session-1",
                    "reason": "mcp",
                }),
            )
            .expect("killed emit");

        assert!(session_rx.try_recv().is_ok());
        assert!(control_rx.try_recv().is_err());
    }
}
