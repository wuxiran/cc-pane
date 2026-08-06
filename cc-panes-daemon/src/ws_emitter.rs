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

/// 单个会话镜像订阅者：有界发送端 + desync 状态 + 隐藏闸门。
/// 这些标志只在持有 subscribers 写锁时读写，无需原子类型。
struct SessionSubscriber {
    tx: mpsc::Sender<String>,
    desynced: bool,
    /// 订阅方的连接标识。**hidden 必须按连接记账而不是按会话**：daemon 是
    /// 多客户端共享的（桌面 + web + 手机），桌面把标签切后台不得掐断手机端
    /// 正在看的同一个会话。
    connection_id: Option<String>,
    /// 该连接已声明本会话不可见——跳过投递（delta 照常在 ReplayBuffer 累积），
    /// unhide 时发 desync 让它走快照重建。
    hidden: bool,
    /// hidden 期间是否真的丢过数据。只由 unhide 消费（重复标记 hidden 不清除），
    /// 否则「隐藏→再隐藏」会把待补的 desync 抹掉。
    dropped_while_hidden: bool,
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

    /// 无身份订阅（hidden 闸门对其不生效）。生产路径已全部改走
    /// `subscribe_with_connection`；保留本入口供测试与匿名旧客户端语义。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn subscribe(&self, session_id: &str) -> mpsc::Receiver<String> {
        self.subscribe_with_connection(session_id, None)
    }

    /// 带连接标识的订阅。hidden 闸门按连接生效，所以需要可寻址身份——
    /// `handle_ws` 传入 per-session WS 握手里的 instanceId，它与 control 连接
    /// 的 instanceId 同源，`set_hidden_sessions` 靠这个同源性定位到本连接的
    /// 全部会话订阅。
    pub fn subscribe_with_connection(
        &self,
        session_id: &str,
        connection_id: Option<String>,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(SESSION_CHANNEL_CAPACITY);
        self.subscribers
            .write()
            .entry(session_id.to_string())
            .or_default()
            .push(SessionSubscriber {
                tx,
                desynced: false,
                connection_id,
                hidden: false,
                dropped_while_hidden: false,
            });
        debug!(session_id, "daemon ws subscriber registered");
        rx
    }

    /// 某个连接声明「这些会话我看不见了」。
    ///
    /// 只影响该连接自己的投递：别的客户端（手机 / web）照常收流。
    pub fn set_hidden_sessions(&self, connection_id: &str, hidden_sessions: &[String]) {
        let hidden: std::collections::HashSet<&str> =
            hidden_sessions.iter().map(|s| s.as_str()).collect();
        let mut subscribers = self.subscribers.write();
        for (session_id, list) in subscribers.iter_mut() {
            let should_hide = hidden.contains(session_id.as_str());
            for sub in list.iter_mut() {
                if sub.connection_id.as_deref() != Some(connection_id) {
                    continue;
                }
                if should_hide {
                    sub.hidden = true;
                } else if sub.hidden {
                    // unhide：期间真丢过数据才需要让它重建画面。
                    //
                    // Codex 审查 P1：不能直接 try_send——队列满时 desync 丢失
                    // 而标记已清，客户端永远不知道自己缺了数据。改置 desynced
                    // 标志复用 deliver 的排空机制：下一条消息投递前会先补插
                    // desync，插不进就继续整段跳过，直到排空。
                    sub.hidden = false;
                    if sub.dropped_while_hidden {
                        sub.dropped_while_hidden = false;
                        match sub.tx.try_send(DESYNC_MESSAGE.to_string()) {
                            Ok(()) => {}
                            Err(_) => sub.desynced = true,
                        }
                    }
                }
            }
        }
    }

    /// 连接断开：清掉它的全部 hidden 标记。
    ///
    /// 不清的话，重连后的新订阅会被上一条连接留下的标记压住——表现为
    /// 「重连后永久收不到输出」，且没有任何报错。
    pub fn clear_connection_hidden(&self, connection_id: &str) {
        let mut subscribers = self.subscribers.write();
        for list in subscribers.values_mut() {
            for sub in list.iter_mut() {
                if sub.connection_id.as_deref() == Some(connection_id) {
                    sub.hidden = false;
                    sub.dropped_while_hidden = false;
                }
            }
        }
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
        // 隐藏零投递闸门（批3）：该连接看不见这个会话时，源头就不推。
        //
        // **只掐可丢的输出**（drop_on_full=true 即 terminal-output）。exit /
        // killed 这类必达事件即使在隐藏期也要送达——它们决定标签的生死，
        // 丢了会让前端永远显示一个已经死掉的「运行中」会话。
        if sub.hidden && drop_on_full {
            sub.dropped_while_hidden = true;
            return false;
        }
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
    use cc_panes_core::services::boundary_events::{BoundaryChannel, EventOrigin, BOUNDARY_EVENTS};

    /// **契约守卫**：表里每个事件都必须真的被投递出去。
    ///
    /// 这条测试存在的理由是 docs/45 那类事故：resume id 事件掉进 `emit` 的
    /// `_ => {}`，跨进程静默丢失，表现为「功能还在、就是没数据」，且不可自愈。
    /// 逐事件正例测试挡不住这个——新加的事件没人给它写正例。
    ///
    /// 做法：对表中每个事件真跑一次 emit，断言至少有一条消息落到某个通道。
    /// 落进 `_ => {}` 的事件不会产生任何投递，这里就会挂。
    #[test]
    fn every_boundary_event_has_a_non_default_branch() {
        for event in BOUNDARY_EVENTS {
            // 只有经 emit 进来的事件才可能落进 `_ => {}`。emitter 自生成的
            // desync 与独立入口的 notifier 各有自己的测试。
            if event.origin != EventOrigin::Emit {
                continue;
            }

            let emitter = WsEmitter::new();
            let mut session_rx = emitter.subscribe("guard-session");
            let mut control_rx = emitter.subscribe_control();

            emitter.emit(
                event.name,
                serde_json::json!({
                    "sessionId": "guard-session",
                    "data": "x",
                    "exitCode": 0,
                    "resumeId": "r-1",
                    "message": "m",
                }),
            );

            let delivered_session = session_rx.try_recv().is_ok();
            let delivered_control = control_rx.try_recv().is_ok();

            assert!(
                delivered_session || delivered_control,
                "事件 `{}` 没有任何投递——它多半落进了 emit 的 `_ => {{}}`。
                 契约表登记了它必须跨界（通道 {:?}），请在 emit 里补分支；
                 若它确实不该跨界，请从 boundary_events.rs 的表里删掉。",
                event.name,
                event.channel,
            );

            // 通道也要对得上：control 类事件跑到 session WS 上，多客户端场景
            // 下会因订阅者不存在而丢失。
            match event.channel {
                BoundaryChannel::Control => assert!(
                    delivered_control,
                    "事件 `{}` 契约上走 control，实际没投到 control",
                    event.name
                ),
                BoundaryChannel::SessionWs => assert!(
                    delivered_session,
                    "事件 `{}` 契约上走 per-session WS，实际没投到",
                    event.name
                ),
                // 兜底类：优先 session，投不进才 control。有订阅者时应落 session。
                BoundaryChannel::SessionWsWithControlFallback => assert!(
                    delivered_session,
                    "事件 `{}` 有订阅者时应落 per-session WS",
                    event.name
                ),
            }
        }
    }

    // ===== 隐藏零投递闸门（批3 B3-06）=====

    #[test]
    fn hidden_connection_stops_receiving_output_but_others_keep_streaming() {
        let emitter = WsEmitter::new();
        let mut desktop = emitter.subscribe_with_connection("s1", Some("ctl-desktop".into()));
        let mut mobile = emitter.subscribe_with_connection("s1", Some("ctl-mobile".into()));

        // 桌面把这个标签切到后台
        emitter.set_hidden_sessions("ctl-desktop", &["s1".to_string()]);
        emitter.emit(
            EV::TERMINAL_OUTPUT,
            serde_json::json!({ "sessionId": "s1", "data": "hello" }),
        );

        assert!(
            desktop.try_recv().is_err(),
            "隐藏的连接不该收到输出（源头断流）"
        );
        assert!(
            mobile.try_recv().is_ok(),
            "**别的客户端必须照常收流**——daemon 是多客户端共享的，             桌面切后台不能掐断手机端正在看的同一个会话"
        );
    }

    #[test]
    fn unhide_sends_desync_when_data_was_actually_dropped() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe_with_connection("s1", Some("ctl-1".into()));

        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.emit(
            EV::TERMINAL_OUTPUT,
            serde_json::json!({ "sessionId": "s1", "data": "missed" }),
        );
        emitter.set_hidden_sessions("ctl-1", &[]);

        let msg = rx.try_recv().expect("unhide 后应收到 desync");
        assert!(msg.contains("desync"), "期望 desync，实得 {msg}");
    }

    #[test]
    fn unhide_without_dropped_data_does_not_send_desync() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe_with_connection("s1", Some("ctl-1".into()));

        // 隐藏期间没有任何输出 → 画面没缺口 → 不该让客户端白重建一次
        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.set_hidden_sessions("ctl-1", &[]);

        assert!(rx.try_recv().is_err(), "没丢数据就不该发 desync");
    }

    #[test]
    fn re_hiding_does_not_clear_pending_drop_marker() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe_with_connection("s1", Some("ctl-1".into()));

        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.emit(
            EV::TERMINAL_OUTPUT,
            serde_json::json!({ "sessionId": "s1", "data": "missed" }),
        );
        // 隐藏 → 再次声明隐藏（前端重复上报）：待补的 desync 不能被抹掉
        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.set_hidden_sessions("ctl-1", &[]);

        let msg = rx.try_recv().expect("重复标记隐藏后，unhide 仍应补 desync");
        assert!(msg.contains("desync"));
    }

    #[test]
    fn exit_still_delivered_while_hidden() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe_with_connection("s1", Some("ctl-1".into()));

        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.emit(
            EV::TERMINAL_EXIT,
            serde_json::json!({ "sessionId": "s1", "exitCode": 0 }),
        );

        // 闸门只掐可丢的输出。exit 决定标签生死，丢了会让前端永远显示
        // 一个已经死掉的「运行中」会话。
        let msg = rx.try_recv().expect("exit 在隐藏期也必须送达");
        assert!(msg.contains("exit"), "期望 exit，实得 {msg}");
    }

    #[test]
    fn clearing_connection_releases_hidden_marks() {
        let emitter = WsEmitter::new();
        let mut rx = emitter.subscribe_with_connection("s1", Some("ctl-1".into()));

        emitter.set_hidden_sessions("ctl-1", &["s1".to_string()]);
        emitter.clear_connection_hidden("ctl-1");

        emitter.emit(
            EV::TERMINAL_OUTPUT,
            serde_json::json!({ "sessionId": "s1", "data": "after-reconnect" }),
        );

        // 不清的话重连后的新订阅会被旧标记压住 → 永久收不到输出且零报错
        assert!(rx.try_recv().is_ok(), "连接清理后应恢复投递");
    }

    #[test]
    fn hidden_marks_are_per_connection_not_per_session() {
        let emitter = WsEmitter::new();
        let mut a = emitter.subscribe_with_connection("s1", Some("ctl-a".into()));
        let mut b = emitter.subscribe_with_connection("s2", Some("ctl-a".into()));
        let mut c = emitter.subscribe_with_connection("s1", Some("ctl-b".into()));

        // 同一连接只隐藏 s1
        emitter.set_hidden_sessions("ctl-a", &["s1".to_string()]);
        for sid in ["s1", "s2"] {
            emitter.emit(
                EV::TERMINAL_OUTPUT,
                serde_json::json!({ "sessionId": sid, "data": "x" }),
            );
        }

        assert!(a.try_recv().is_err(), "ctl-a 的 s1 应断流");
        assert!(b.try_recv().is_ok(), "ctl-a 的 s2 不受影响");
        assert!(c.try_recv().is_ok(), "ctl-b 的 s1 不受影响");
    }

    /// notifier 走独立入口，同样不能静默丢。
    #[test]
    fn notifier_events_reach_control_channel() {
        let emitter = WsEmitter::new();
        let mut control_rx = emitter.subscribe_control();

        emitter.publish_notifier_event("waitingInput", "session-1", None);

        assert!(
            control_rx.try_recv().is_ok(),
            "notifier 事件没到 control 通道"
        );
    }

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
