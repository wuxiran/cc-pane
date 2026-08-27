use std::collections::HashMap;
use std::sync::Arc;

use cc_panes_core::events::EventEmitter;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::debug;

/// 会话镜像通道容量：256 条 × ≤16KB 合批 ≈ 单个慢客户端最多积压 ~4MB。
/// 此前是无界通道——远程浏览器/移动端网络慢时服务端内存无界增长。
const SESSION_CHANNEL_CAPACITY: usize = 256;

/// Media state changes are small and can be recovered by the Canvas polling
/// endpoint, so a bounded best-effort queue is sufficient here.  Keeping this
/// separate from terminal output prevents a slow media client from affecting a
/// PTY stream (and vice versa).
const MEDIA_CHANNEL_CAPACITY: usize = 128;

/// desync 契约（与 cc-panes-daemon/src/ws_emitter.rs 一致）：
/// 输出队列溢出后**绝不掐 VT 流中段**，整段跳过并在排空后插入本标记；
/// 客户端收到后应重拉 `GET /api/sessions/{id}/snapshot` 重放。
/// 旧客户端不认识该类型会静默忽略。
const DESYNC_MESSAGE: &str = r#"{"type":"desync"}"#;

struct SessionSubscriber {
    tx: mpsc::Sender<String>,
    desynced: bool,
}

struct MediaSubscriber {
    tx: mpsc::Sender<String>,
    workspace_id: Option<String>,
}

/// A WebSocket-backed EventEmitter that routes terminal output events
/// to the correct session's WebSocket subscribers.
pub struct WsEmitter {
    /// session_id → list of subscribers
    subscribers: Arc<RwLock<HashMap<String, Vec<SessionSubscriber>>>>,
    /// Media-job subscribers are independent from terminal session streams.
    media_subscribers: Arc<RwLock<Vec<MediaSubscriber>>>,
}

impl WsEmitter {
    pub fn new() -> Self {
        Self {
            subscribers: Arc::new(RwLock::new(HashMap::new())),
            media_subscribers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Subscribe to a session's output stream.
    /// Returns a receiver that yields terminal output data.
    pub fn subscribe(&self, session_id: &str) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(SESSION_CHANNEL_CAPACITY);
        let mut subs = self.subscribers.write();
        subs.entry(session_id.to_string())
            .or_default()
            .push(SessionSubscriber {
                tx,
                desynced: false,
            });
        debug!(session_id, "ws_emitter: new subscriber");
        rx
    }

    /// Remove all closed senders for a session. Called on WS disconnect.
    pub fn cleanup_session(&self, session_id: &str) {
        let mut subs = self.subscribers.write();
        if let Some(senders) = subs.get_mut(session_id) {
            senders.retain(|sub| !sub.tx.is_closed());
            if senders.is_empty() {
                subs.remove(session_id);
            }
        }
    }

    /// desync 契约投递：满 → （普通输出）丢本条并置 desynced；
    /// 排空后先插 desync 标记再恢复转发。
    fn deliver(sub: &mut SessionSubscriber, msg: &str, drop_on_full: bool) -> bool {
        if sub.desynced {
            match sub.tx.try_send(DESYNC_MESSAGE.to_string()) {
                Ok(()) => sub.desynced = false,
                Err(_) => return false,
            }
        }
        match sub.tx.try_send(msg.to_string()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                if drop_on_full {
                    sub.desynced = true;
                }
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// 终止性事件后摘除该会话的全部订阅发送端（接收端排空后通道关闭 → WS 关闭）。
    fn drop_session_subscribers(&self, session_id: &str) {
        self.subscribers.write().remove(session_id);
    }

    fn publish(&self, session_id: &str, msg: String, drop_on_full: bool) {
        let mut subs = self.subscribers.write();
        if let Some(senders) = subs.get_mut(session_id) {
            senders.retain(|sub| !sub.tx.is_closed());
            for sub in senders.iter_mut() {
                Self::deliver(sub, &msg, drop_on_full);
            }
            if senders.is_empty() {
                subs.remove(session_id);
            }
        }
    }

    /// Subscribe to Canvas media-job events.  `workspace_id` scopes events for
    /// a Web Canvas; `None` is useful for local diagnostics and receives all
    /// events.  The receiver is closed automatically once the WebSocket exits.
    pub fn subscribe_media(&self, workspace_id: Option<&str>) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(MEDIA_CHANNEL_CAPACITY);
        self.media_subscribers.write().push(MediaSubscriber {
            tx,
            workspace_id: workspace_id.map(str::to_string),
        });
        debug!(workspace_id, "ws_emitter: new media subscriber");
        rx
    }

    /// Remove media subscribers whose WebSocket receiver has already closed.
    /// Called on disconnect; `publish_media_job_changed` also performs this
    /// pruning defensively for abrupt network failures.
    pub fn cleanup_media(&self) {
        self.media_subscribers
            .write()
            .retain(|subscriber| !subscriber.tx.is_closed());
    }

    /// Publish one durable media-run snapshot to Web Canvas subscribers.
    /// Delivery is best effort because the REST endpoints remain the source of
    /// truth and the frontend periodically refreshes after disconnects/drops.
    pub fn publish_media_job_changed(&self, payload: Value) {
        let workspace_id = payload
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let message = match serde_json::to_string(&payload) {
            Ok(message) => message,
            Err(error) => {
                debug!(error = %error, "ws_emitter: failed to serialize media event");
                return;
            }
        };
        let mut subscribers = self.media_subscribers.write();
        subscribers.retain(|subscriber| !subscriber.tx.is_closed());
        for subscriber in subscribers.iter_mut() {
            let matches_workspace = subscriber
                .workspace_id
                .as_deref()
                .is_none_or(|scope| workspace_id.as_deref() == Some(scope));
            if !matches_workspace {
                continue;
            }
            // A dropped notification is safe: the Canvas polling fallback will
            // fetch the authoritative run state on its next interval.
            let _ = subscriber.tx.try_send(message.clone());
        }
    }
}

impl EventEmitter for WsEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        if event == "media-job-changed" {
            self.publish_media_job_changed(payload);
            return Ok(());
        }
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
                self.publish(session_id, msg, true);
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
                // 终止性消息：满不置 desynced。
                self.publish(session_id, msg, false);
                // 摘除订阅发送端：接收端排空积压后得到通道关闭 → WS 关闭。
                // 保证即使 exit 因队列满被丢，远端也必然感知会话终止。
                self.drop_session_subscribers(session_id);
            }
            "session-killed" => {
                let reason = payload
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                let msg = serde_json::json!({
                    "type": "killed",
                    "reason": reason,
                })
                .to_string();
                self.publish(session_id, msg, false);
                self.drop_session_subscribers(session_id);
            }
            "terminal-desync" => {
                // reader 线程经 emit 发的 desync（合批通道满整段丢弃；Stage 4
                // 看门狗在 web 模式不会触发——无 ACK 通道则闸门永不 park，但
                // 分支照样要有：契约表 origin=Emit，缺分支就是静默丢补救信号）。
                // 复用 desynced 闩锁：插不进就闩住，deliver 排空后补插。
                let mut subs = self.subscribers.write();
                if let Some(senders) = subs.get_mut(session_id) {
                    for sub in senders.iter_mut() {
                        match sub.tx.try_send(DESYNC_MESSAGE.to_string()) {
                            Ok(()) => sub.desynced = false,
                            Err(_) => sub.desynced = true,
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::WsEmitter;
    use cc_panes_core::events::EventEmitter;
    use serde_json::json;

    #[tokio::test]
    async fn media_events_are_scoped_and_serialized() {
        let emitter = WsEmitter::new();
        let mut workspace = emitter.subscribe_media(Some("workspace-a"));
        let mut all = emitter.subscribe_media(None);

        emitter.publish_media_job_changed(json!({
            "type": "media-job-changed",
            "workspaceId": "workspace-a",
            "runId": "run-1",
            "status": "succeeded",
        }));
        assert_eq!(workspace.recv().await.unwrap(), all.recv().await.unwrap());

        emitter.publish_media_job_changed(json!({
            "type": "media-job-changed",
            "workspaceId": "workspace-b",
            "runId": "run-2",
            "status": "processing",
        }));
        assert!(workspace.try_recv().is_err());
        assert!(all.try_recv().is_ok());
    }

    #[tokio::test]
    async fn closed_media_receivers_are_pruned() {
        let emitter = WsEmitter::new();
        let receiver = emitter.subscribe_media(None);
        drop(receiver);
        emitter.publish_media_job_changed(json!({
            "type": "media-job-changed",
            "runId": "run-1",
        }));
        assert!(emitter.media_subscribers.read().is_empty());
    }

    #[test]
    fn event_emitter_accepts_media_job_events_without_a_session_id() {
        let emitter = WsEmitter::new();
        let mut events = emitter.subscribe_media(None);
        EventEmitter::emit(
            &emitter,
            "media-job-changed",
            json!({"type": "media-job-changed", "runId": "run-1"}),
        )
        .expect("media event should be accepted");
        assert!(events.try_recv().is_ok());
    }
}
