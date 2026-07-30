use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use cc_panes_core::constants::events as EV;
use cc_panes_core::events::EventEmitter;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::debug;

use crate::session_output_store::SessionOutputStore;

/// 身份事件留存上限。一条会话最多一条，超出按插入顺序淘汰最旧的。
const MAX_RETAINED_IDENTITY_EVENTS: usize = 1024;

/// 按 session 去重 + 保序的身份事件留存。
#[derive(Default)]
struct IdentityEventStore {
    by_session: HashMap<String, Value>,
    order: VecDeque<String>,
}

#[derive(Clone, Default)]
pub struct WsEmitter {
    subscribers: Arc<RwLock<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>,
    control_subscribers: Arc<RwLock<Vec<mpsc::UnboundedSender<String>>>>,
    output_store: Arc<RwLock<Option<Arc<SessionOutputStore>>>>,
    /// 已捕获的 resume id 身份事件，按 session 保留供桌面侧补拉。
    ///
    /// control 是**无重放的广播**：没有订阅者时消息直接丢。而 claude 发号紧跟
    /// PTY spawn，桌面侧 control link 却是异步建连、后端监听器更晚注册——app
    /// 刚启动那一两秒内建的会话（恢复流程恰好在这时批量建会话）身份事件必丢，
    /// 且丢了没有第二次机会。留存 + 桌面侧连上后补拉一次，把这个窗口堵死。
    identity_events: Arc<RwLock<IdentityEventStore>>,
}

impl WsEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 会话退出时把回滚缓冲落盘的去处。构造顺序决定它只能后置注入：
    /// store 需要 `TerminalService`，而 `TerminalService` 需要本 emitter。
    pub fn set_output_store(&self, store: Arc<SessionOutputStore>) {
        *self.output_store.write() = Some(store);
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

    /// 已留存的身份事件全集，供 `GET /api/sessions/identity` 返回。
    pub fn identity_snapshot(&self) -> Vec<Value> {
        let store = self.identity_events.read();
        store
            .order
            .iter()
            .filter_map(|session_id| store.by_session.get(session_id).cloned())
            .collect()
    }

    fn retain_identity_event(&self, session_id: &str, payload: &Value) {
        let mut store = self.identity_events.write();
        if store
            .by_session
            .insert(session_id.to_string(), payload.clone())
            .is_none()
        {
            store.order.push_back(session_id.to_string());
        }
        while store.order.len() > MAX_RETAINED_IDENTITY_EVENTS {
            if let Some(evicted) = store.order.pop_front() {
                store.by_session.remove(&evicted);
            }
        }
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

    /// 会话副作用通知（waiting-input 推断 / 自然退出 / 清理）转发到桌面。
    ///
    /// daemon 原先挂 `NoopNotifier`，于是 PTY 推断的 waiting-input、退出系统通知、
    /// last_prompt 回填与 CCChan 提醒在 daemon 模式下**全部不执行**——hook 能覆盖
    /// 一部分 CLI，无 hook 的纯 PTY 推断路径则完全没有。这类事件低频，走 control。
    pub(crate) fn publish_notifier_event(
        &self,
        event: &str,
        session_id: &str,
        exit_code: Option<i32>,
    ) {
        self.publish_control(
            serde_json::json!({
                "type": "notifier",
                "event": event,
                "sessionId": session_id,
                "exitCode": exit_code,
            })
            .to_string(),
        );
    }

    fn persist_session_output(&self, session_id: &str) {
        let store = self.output_store.read().clone();
        if let Some(store) = store {
            store.schedule_session_persist(session_id);
        }
    }

    fn publish_control(&self, msg: String) {
        self.control_subscribers
            .write()
            .retain(|sender| sender.send(msg.clone()).is_ok());
    }
}

impl EventEmitter for WsEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        // 启动告警必须在 sessionId 守卫之前处理：profileMismatch 是"会话还没建成
        // 就已回落"的诊断，载荷里没有 sessionId，走守卫会被整条吞掉——用户选的
        // launch profile（含 YOLO）静默不生效，且没有任何提示。
        if event == EV::TERMINAL_LAUNCH_WARNING {
            self.publish_control(
                serde_json::json!({
                    "type": "launchWarning",
                    "payload": &payload,
                })
                .to_string(),
            );
            return Ok(());
        }

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
                // 会话不会再产出新内容：宽限一小段等 reader 排空后落盘，
                // 之后重启才有历史可重放。
                self.persist_session_output(session_id);
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
            EV::TERMINAL_RESUME_ID_DETECTED => {
                self.retain_identity_event(session_id, &payload);
                // daemon 模式下 PTY 活在本进程，claude 发号与 codex OSC 捕获都在这里
                // emit。桌面侧的 bind_resume_id 监听的是同名 Tauri 事件，收不到就
                // 意味着 launch_history.resume_session_id 永远为 null、恢复时无从
                // resume。会话订阅通道只服务单会话镜像，这类低频身份事件走 control。
                self.publish_control(
                    serde_json::json!({
                        "type": "resumeIdDetected",
                        "payload": &payload,
                    })
                    .to_string(),
                );
            }
            _ => {}
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
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

    /// resume id 必须走 control：它不属于任何一条会话镜像流，且要在会话还没有
    /// 任何 WS 订阅者时（刚 create 完、前端尚未 attach）就能送达桌面。
    #[test]
    fn publishes_resume_id_detected_to_control_channel() {
        let emitter = WsEmitter::new();
        let mut control = emitter.subscribe_control();
        let mut session = emitter.subscribe("session-1");

        let payload = serde_json::json!({
            "sessionId": "session-1",
            "resumeSessionId": "resume-1",
            "source": "issued",
            "cliTool": "claude",
        });
        emitter
            .emit(EV::TERMINAL_RESUME_ID_DETECTED, payload.clone())
            .expect("resume emit");

        let message = control.try_recv().expect("control message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&message).expect("control json"),
            serde_json::json!({ "type": "resumeIdDetected", "payload": payload })
        );
        assert!(
            session.try_recv().is_err(),
            "resume id must not be pushed into the per-session mirror stream"
        );
    }

    /// profileMismatch 载荷里没有 sessionId——守卫放在告警处理之前就会整条吞掉。
    #[test]
    fn publishes_launch_warning_without_session_id_to_control_channel() {
        let emitter = WsEmitter::new();
        let mut control = emitter.subscribe_control();

        let payload = serde_json::json!({
            "kind": "profileMismatch",
            "launchId": "proj-1",
            "cliTool": "codex",
            "cliMismatch": true,
        });
        emitter
            .emit(EV::TERMINAL_LAUNCH_WARNING, payload.clone())
            .expect("warning emit");

        let message = control.try_recv().expect("control message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&message).expect("control json"),
            serde_json::json!({ "type": "launchWarning", "payload": payload })
        );
    }

    /// control 无订阅者时消息直接丢——身份事件必须另有留存，否则 app 启动窗口期
    /// 建的会话（恢复流程恰在此时批量建会话）永远拿不到 resume id。
    #[test]
    fn identity_events_are_retained_even_without_subscribers() {
        let emitter = WsEmitter::new();
        let payload = serde_json::json!({
            "sessionId": "session-1",
            "resumeSessionId": "resume-1",
            "source": "issued",
        });
        emitter
            .emit(EV::TERMINAL_RESUME_ID_DETECTED, payload.clone())
            .expect("resume emit");

        assert_eq!(emitter.identity_snapshot(), vec![payload]);
    }

    #[test]
    fn identity_events_keep_one_entry_per_session() {
        let emitter = WsEmitter::new();
        for resume in ["resume-1", "resume-2"] {
            emitter
                .emit(
                    EV::TERMINAL_RESUME_ID_DETECTED,
                    serde_json::json!({
                        "sessionId": "session-1",
                        "resumeSessionId": resume,
                        "source": "issued",
                    }),
                )
                .expect("resume emit");
        }

        let snapshot = emitter.identity_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0]["resumeSessionId"], "resume-2");
    }

    #[test]
    fn identity_events_are_bounded() {
        let emitter = WsEmitter::new();
        for index in 0..(MAX_RETAINED_IDENTITY_EVENTS + 10) {
            emitter
                .emit(
                    EV::TERMINAL_RESUME_ID_DETECTED,
                    serde_json::json!({
                        "sessionId": format!("session-{index}"),
                        "resumeSessionId": "resume",
                        "source": "issued",
                    }),
                )
                .expect("resume emit");
        }

        let snapshot = emitter.identity_snapshot();
        assert_eq!(snapshot.len(), MAX_RETAINED_IDENTITY_EVENTS);
        // 淘汰最旧的：最早那批不该还在。
        assert_eq!(snapshot[0]["sessionId"], "session-10");
    }

    #[test]
    fn notifier_events_go_to_control_channel() {
        let emitter = WsEmitter::new();
        let mut control = emitter.subscribe_control();

        emitter.publish_notifier_event("sessionExited", "session-1", Some(2));

        let message = control.try_recv().expect("control message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&message).expect("control json"),
            serde_json::json!({
                "type": "notifier",
                "event": "sessionExited",
                "sessionId": "session-1",
                "exitCode": 2,
            })
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
