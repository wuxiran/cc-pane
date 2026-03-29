use std::collections::HashMap;
use std::sync::Arc;

use cc_panes_core::events::EventEmitter;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::debug;

/// A WebSocket-backed EventEmitter that routes terminal output events
/// to the correct session's WebSocket subscribers.
pub struct WsEmitter {
    /// session_id → list of senders
    subscribers: Arc<RwLock<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
}

impl WsEmitter {
    pub fn new() -> Self {
        Self {
            subscribers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Subscribe to a session's output stream.
    /// Returns a receiver that yields terminal output data.
    pub fn subscribe(&self, session_id: &str) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut subs = self.subscribers.write();
        subs.entry(session_id.to_string()).or_default().push(tx);
        debug!(session_id, "ws_emitter: new subscriber");
        rx
    }

    /// Remove all closed senders for a session. Called on WS disconnect.
    pub fn cleanup_session(&self, session_id: &str) {
        let mut subs = self.subscribers.write();
        if let Some(senders) = subs.get_mut(session_id) {
            senders.retain(|tx| !tx.is_closed());
            if senders.is_empty() {
                subs.remove(session_id);
            }
        }
    }
}

impl EventEmitter for WsEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        // We only care about terminal-output and terminal-exit events
        let session_id = payload.get("sessionId").and_then(|v| v.as_str());
        let session_id = match session_id {
            Some(id) => id,
            None => return Ok(()),
        };

        match event {
            "terminal-output" => {
                let data = payload
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                let msg = serde_json::json!({
                    "type": "output",
                    "data": data,
                })
                .to_string();

                let subs = self.subscribers.read();
                if let Some(senders) = subs.get(session_id) {
                    for tx in senders {
                        let _ = tx.send(msg.clone());
                    }
                }
            }
            "terminal-exit" => {
                let exit_code = payload
                    .get("exitCode")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(-1);

                let msg = serde_json::json!({
                    "type": "exit",
                    "exitCode": exit_code,
                })
                .to_string();

                let subs = self.subscribers.read();
                if let Some(senders) = subs.get(session_id) {
                    for tx in senders {
                        let _ = tx.send(msg.clone());
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}
