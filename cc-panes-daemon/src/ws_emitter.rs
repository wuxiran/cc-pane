use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use cc_panes_core::constants::events as EV;
use cc_panes_core::events::EventEmitter;
use cc_panes_core::services::should_retain_incoming;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::debug;

use crate::session_output_store::SessionOutputStore;

/// 身份事件留存上限。一条会话最多一条，超出按插入顺序淘汰最旧的。
const MAX_RETAINED_IDENTITY_EVENTS: usize = 1024;

/// 会话镜像通道容量：256 条 × ≤16KB 合批 ≈ 单个慢客户端最多积压 ~4MB。
/// 此前是无界通道——WS 发送端卡住时 daemon 内存无界增长（docs/71 §3 风险点 2）。
const SESSION_CHANNEL_CAPACITY: usize = 256;
/// control 通道容量。身份事件另有 `identity_events` 留存 + 桌面补拉兜底，
/// 溢出丢弃只损失一次实时性，不损失数据。
const CONTROL_CHANNEL_CAPACITY: usize = 1024;

/// desync 契约：输出队列溢出后**绝不掐 VT 流中段**（前端会花屏），而是整段跳过
/// 并在队列排空后插入本标记；客户端收到后应丢弃现有画面、用
/// `GET /api/sessions/{id}/snapshot` 重放。旧客户端不认识该类型会静默忽略，
/// 行为退化为溢出前的现状（可能花屏），但 daemon 侧内存已有界。
const DESYNC_MESSAGE: &str = r#"{"type":"desync"}"#;

/// 单个会话镜像订阅者：有界发送端 + desync 状态。
/// `desynced` 只在持有 subscribers 写锁时读写，无需原子类型。
struct SessionSubscriber {
    tx: mpsc::Sender<String>,
    desynced: bool,
}

/// 按 session 去重 + 保序的身份事件留存。
#[derive(Default)]
struct IdentityEventStore {
    by_session: HashMap<String, Value>,
    order: VecDeque<String>,
}

#[derive(Clone, Default)]
pub struct WsEmitter {
    subscribers: Arc<RwLock<HashMap<String, Vec<SessionSubscriber>>>>,
    control_subscribers: Arc<RwLock<Vec<mpsc::Sender<String>>>>,
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

    pub fn subscribe(&self, session_id: &str) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(SESSION_CHANNEL_CAPACITY);
        self.subscribers
            .write()
            .entry(session_id.to_string())
            .or_default()
            .push(SessionSubscriber {
                tx,
                desynced: false,
            });
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

    /// 留存一条身份事件。
    ///
    /// **不能无条件 last-write**：绑定层按来源优先级取舍
    /// （manual 高于 issued/osc-title，后者又高于 rollout-scan/backfill），
    /// 而 codex 的 rollout 兜底扫描与 OSC 标题捕获本就会竞态。若 fallback 最后
    /// 写入留存，断连重连的桌面重放到的就是那个被降级的值。
    fn retain_identity_event(&self, session_id: &str, payload: &Value) {
        let incoming_source = payload.get("source").and_then(Value::as_str).unwrap_or("");
        let incoming_resume_id = payload
            .get("resumeSessionId")
            .and_then(Value::as_str)
            .unwrap_or("");

        let mut store = self.identity_events.write();
        if let Some(existing) = store.by_session.get(session_id) {
            let existing_source = existing.get("source").and_then(Value::as_str);
            let existing_resume_id = existing.get("resumeSessionId").and_then(Value::as_str);
            if !should_retain_incoming(
                existing_source,
                existing_resume_id,
                incoming_source,
                incoming_resume_id,
            ) {
                return;
            }
        }

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

    pub fn subscribe_control(&self) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(CONTROL_CHANNEL_CAPACITY);
        self.control_subscribers.write().push(tx);
        debug!("daemon control subscriber registered");
        rx
    }

    /// 是否仍有活跃（未断开）的 WS 订阅者——会话孤儿判定的信号之一。
    pub fn has_active_subscriber(&self, session_id: &str) -> bool {
        let subscribers = self.subscribers.read();
        subscribers
            .get(session_id)
            .is_some_and(|senders| senders.iter().any(|sub| !sub.tx.is_closed()))
    }

    pub fn cleanup_session(&self, session_id: &str) {
        let mut subscribers = self.subscribers.write();
        if let Some(senders) = subscribers.get_mut(session_id) {
            senders.retain(|sub| !sub.tx.is_closed());
            if senders.is_empty() {
                subscribers.remove(session_id);
            }
        }
    }

    /// 向单个订阅者投递一条会话消息，执行 desync 契约。
    ///
    /// 返回是否成功入队。`drop_on_full` 为真（普通输出）时队列满 → 丢弃本条并
    /// 置 desynced；为假（exit/killed 这类终止性消息）时队列满不置 desynced，
    /// 由调用方走 control 兜底。
    fn deliver(sub: &mut SessionSubscriber, msg: &str, drop_on_full: bool) -> bool {
        if sub.desynced {
            // 排空到有空位时先插入 desync 标记，客户端据此走 snapshot 重放；
            // 标记进不去说明队列还满着，继续整段跳过。
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

    /// 返回是否至少成功投递给一个订阅者。
    /// `drop_on_full`：普通输出为真（满 → 丢本条 + 置 desynced）；
    /// exit/killed 为假（满不置 desynced，调用方走 control 兜底保可见）。
    fn publish_with(&self, session_id: &str, msg: String, drop_on_full: bool) -> bool {
        let mut subscribers = self.subscribers.write();
        let Some(senders) = subscribers.get_mut(session_id) else {
            return false;
        };
        senders.retain(|sub| !sub.tx.is_closed());
        let mut any = false;
        for sub in senders.iter_mut() {
            if Self::deliver(sub, &msg, drop_on_full) {
                any = true;
            }
        }
        if senders.is_empty() {
            subscribers.remove(session_id);
        }
        any
    }

    fn publish(&self, session_id: &str, msg: String) -> bool {
        self.publish_with(session_id, msg, true)
    }

    /// 终止性事件（exit/killed）后摘除该会话的全部订阅发送端。
    ///
    /// tokio mpsc 的接收端会先排空已入队的积压再得到通道关闭 → 转发循环退出 →
    /// WS 关闭 → 桥的 close 兜底合成退出。这保证**即使终止消息因队列满被丢**，
    /// 客户端也必然感知会话终止（真实退出码另经 control 送达）。
    fn drop_session_subscribers(&self, session_id: &str) {
        self.subscribers.write().remove(session_id);
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
        self.control_subscribers.write().retain(|sender| {
            match sender.try_send(msg.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // control 事件各有留存/补拉/去重兜底，溢出丢弃只损失实时性。
                    debug!("daemon control channel full, dropping message");
                    true
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
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
                let delivered = self.publish_with(
                    session_id,
                    serde_json::json!({
                        "type": "exit",
                        "exitCode": exit_code,
                    })
                    .to_string(),
                    // 终止性消息：队列满也不置 desynced，走 control 兜底。
                    false,
                );
                if !delivered {
                    // 镜像流投不进（慢客户端满载/无订阅者）时经 control 的 notifier
                    // 通道送达真实退出码；镜像 WS 关闭本身还会触发桥的合成退出兜底。
                    self.publish_notifier_event(
                        "sessionExited",
                        session_id,
                        Some(exit_code as i32),
                    );
                }
                // 会话不会再产出新内容：宽限一小段等 reader 排空后落盘，
                // 之后重启才有历史可重放。
                self.persist_session_output(session_id);
                self.drop_session_subscribers(session_id);
            }
            "session-killed" => {
                // kill 事件必须到达前端：user/mcp 关标签，orphan-reclaim/daemon-reaper
                // 保留标签显示退出。丢弃会导致 daemon 模式下 kill 对前端不可见。
                let reason = payload
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let delivered = self.publish_with(
                    session_id,
                    serde_json::json!({
                        "type": "killed",
                        "reason": reason,
                    })
                    .to_string(),
                    // 终止性消息：队列满也不置 desynced，走下方 control 兜底。
                    false,
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
                self.drop_session_subscribers(session_id);
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

    fn emit_output(emitter: &WsEmitter, session_id: &str, data: &str) {
        emitter
            .emit(
                EV::TERMINAL_OUTPUT,
                serde_json::json!({ "sessionId": session_id, "data": data }),
            )
            .expect("output emit");
    }

    /// 队列溢出必须不阻塞、不无界堆积；排空后第一条新消息前插入 desync 标记，
    /// 客户端据此走 snapshot 重放——绝不掐 VT 流中段。
    #[test]
    fn output_overflow_drops_then_resyncs_with_marker_after_drain() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        for index in 0..(SESSION_CHANNEL_CAPACITY + 20) {
            emit_output(&emitter, "session-1", &format!("chunk-{index}"));
        }

        let mut received = 0;
        while rx.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(
            received, SESSION_CHANNEL_CAPACITY,
            "溢出部分必须被丢弃而非积压"
        );

        emit_output(&emitter, "session-1", "after-drain");
        let first = rx.try_recv().expect("desync marker");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first).expect("marker json"),
            serde_json::json!({"type":"desync"})
        );
        let second = rx.try_recv().expect("resumed output");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&second).expect("output json"),
            serde_json::json!({"type":"output","data":"after-drain"})
        );
    }

    /// desynced 期间的普通输出整段跳过（不产生部分 VT 流）。
    #[test]
    fn outputs_are_skipped_entirely_while_desynced() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        for index in 0..(SESSION_CHANNEL_CAPACITY + 5) {
            emit_output(&emitter, "session-1", &format!("chunk-{index}"));
        }
        // 只腾出一格：desync 标记占掉它，随后的输出仍进不去、继续跳过。
        rx.try_recv().expect("drain one");
        emit_output(&emitter, "session-1", "still-full");

        let mut messages = Vec::new();
        while let Ok(message) = rx.try_recv() {
            messages.push(message);
        }
        let desync_count = messages
            .iter()
            .filter(|message| message.contains("\"desync\""))
            .count();
        assert_eq!(desync_count, 1);
        assert!(
            !messages
                .iter()
                .any(|message| message.contains("still-full")),
            "desync 标记之后没有排空前，输出必须整段跳过"
        );
    }

    /// exit 是终止性消息：镜像队列满时必须经 control 的 notifier 通道送达真实退出码。
    #[test]
    fn exit_falls_back_to_control_when_session_queue_is_full() {
        let emitter = WsEmitter::new();
        let mut control = emitter.subscribe_control();
        let _rx = emitter.subscribe("session-1");

        for index in 0..SESSION_CHANNEL_CAPACITY {
            emit_output(&emitter, "session-1", &format!("chunk-{index}"));
        }
        emitter
            .emit(
                EV::TERMINAL_EXIT,
                serde_json::json!({ "sessionId": "session-1", "exitCode": 5 }),
            )
            .expect("exit emit");

        let message = control.try_recv().expect("control fallback message");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&message).expect("control json"),
            serde_json::json!({
                "type": "notifier",
                "event": "sessionExited",
                "sessionId": "session-1",
                "exitCode": 5,
            })
        );
    }

    /// 终止后订阅发送端必须被摘除：接收端排空积压后要看到通道关闭（而非永远悬挂），
    /// WS 转发循环据此退出、桥的 close 兜底合成退出——exit 即使被满队列丢掉也不失联。
    #[test]
    fn exit_drops_session_subscribers_so_channel_closes_after_drain() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe("session-1");

        for index in 0..SESSION_CHANNEL_CAPACITY {
            emit_output(&emitter, "session-1", &format!("chunk-{index}"));
        }
        emitter
            .emit(
                EV::TERMINAL_EXIT,
                serde_json::json!({ "sessionId": "session-1", "exitCode": 5 }),
            )
            .expect("exit emit");

        let mut drained = 0;
        while rx.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(drained, SESSION_CHANNEL_CAPACITY, "积压必须先排空再关闭");
        assert!(
            matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)),
            "排空后必须是 Disconnected 而非 Empty"
        );
        assert!(!emitter.has_active_subscriber("session-1"));
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
