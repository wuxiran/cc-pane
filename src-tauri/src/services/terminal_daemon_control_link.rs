use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{Emitter, Manager};
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
    connected: Arc<AtomicBool>,
}

impl TerminalDaemonControlLink {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (client_tx, client_rx) = watch::channel(None);
        let connected = Arc::new(AtomicBool::new(false));
        tauri::async_runtime::spawn(run_control_link(client_rx, app_handle, connected.clone()));
        Self {
            client_tx,
            connected,
        }
    }

    pub fn replace_client(&self, client: TerminalDaemonClient) {
        self.client_tx.send_replace(Some(client));
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// 上报当前共享 MCP running URL 全量表；连接断开时由 watch 保留最新值，
    /// 下一次 control 连接建立后补发。
    pub fn report_shared_mcp_urls(urls: HashMap<String, String>) {
        report_shared_mcp_urls(urls);
    }
}

struct ControlConnectionGuard {
    connected: Arc<AtomicBool>,
}

impl ControlConnectionGuard {
    fn new(connected: Arc<AtomicBool>) -> Self {
        connected.store(true, Ordering::SeqCst);
        Self { connected }
    }
}

impl Drop for ControlConnectionGuard {
    fn drop(&mut self) {
        self.connected.store(false, Ordering::SeqCst);
    }
}

/// 待上报的 hidden 会话全集（隐藏零投递闸门的上行，docs/78 §4）。
///
/// 用 watch 而非 mpsc：上报是**全量覆盖**语义（daemon 侧按连接替换整个集合），
/// 中间状态没有价值，断线重连后只需补发最新值。None = 尚无上报。
type HiddenChannel = (
    tokio::sync::watch::Sender<Option<Vec<String>>>,
    tokio::sync::watch::Receiver<Option<Vec<String>>>,
);

fn hidden_sessions_channel() -> &'static HiddenChannel {
    static CHANNEL: std::sync::OnceLock<HiddenChannel> = std::sync::OnceLock::new();
    CHANNEL.get_or_init(|| tokio::sync::watch::channel(None))
}

/// 前端经 Tauri command 调用：声明当前不可见的会话全集。
///
/// **不保证送达**（daemon 可能是旧版或断线）——调用方不得据此放松前端积压
/// 兜底；这只是让 daemon 有机会在源头断流。
pub fn report_hidden_sessions(sessions: Vec<String>) {
    let _ = hidden_sessions_channel().0.send(Some(sessions));
}

fn hidden_sessions_message(sessions: &[String]) -> String {
    serde_json::json!({ "type": "hiddenSessions", "sessions": sessions }).to_string()
}

type SharedMcpUrlsChannel = (
    tokio::sync::watch::Sender<Option<HashMap<String, String>>>,
    tokio::sync::watch::Receiver<Option<HashMap<String, String>>>,
);

fn shared_mcp_urls_channel() -> &'static SharedMcpUrlsChannel {
    static CHANNEL: std::sync::OnceLock<SharedMcpUrlsChannel> = std::sync::OnceLock::new();
    CHANNEL.get_or_init(|| tokio::sync::watch::channel(None))
}

/// 上报当前共享 MCP running URL 全量表；连接断开时由 watch 保留最新值，
/// 下一次 control 连接建立后补发。
pub fn report_shared_mcp_urls(urls: HashMap<String, String>) {
    let _ = shared_mcp_urls_channel().0.send(Some(urls));
}

fn shared_mcp_urls_message(urls: &HashMap<String, String>) -> String {
    serde_json::json!({
        "type": "sharedMcpUrls",
        "servers": urls.iter().map(|(name, url)| serde_json::json!({
            "name": name,
            "url": url,
        })).collect::<Vec<_>>(),
    })
    .to_string()
}

/// 输出投递回执的待发队列（B-5）。
///
/// 用 watch + 排空而非 mpsc：回执是**累计值**，中间态没有价值——同一会话连报
/// 3 次只需发最后一次，跳过的那些什么也不丢。链路一断就自然合并，稳态下 map
/// 被排空为空，不会像无界队列那样堆积（在一个专治无界队列的改动里留一个无界
/// 队列实在说不过去）。
///
/// 不做断线重发：daemon 侧的 `acked_seq` 活在 daemon 进程里，重连后账还在；
/// daemon 真重启了则会话本身也没了，重发反而会给新会话灌旧账。
type OutputAckChannel = (
    tokio::sync::watch::Sender<HashMap<String, u64>>,
    tokio::sync::watch::Receiver<HashMap<String, u64>>,
);

fn output_ack_channel() -> &'static OutputAckChannel {
    static CHANNEL: std::sync::OnceLock<OutputAckChannel> = std::sync::OnceLock::new();
    CHANNEL.get_or_init(|| tokio::sync::watch::channel(HashMap::new()))
}

/// 前端经 Tauri command 调用：报告某会话已消化到的累计 endSeq。
///
/// **不保证送达**（daemon 可能是旧版或断线）。送不到的后果是 daemon 侧
/// `ever_acked` 保持 false，闸门据此降级放行——退回今天的行为，不会更差。
pub fn report_output_ack(session_id: String, processed_end_seq: u64) {
    merge_output_ack(&output_ack_channel().0, session_id, processed_end_seq);
}

/// 合并一笔回执到给定通道。与 [`report_output_ack`] 同一段逻辑，
/// 拆出 sender 参数只为让测试能用本地通道，不去抢进程内的静态单例。
fn merge_output_ack(
    sender: &tokio::sync::watch::Sender<HashMap<String, u64>>,
    session_id: String,
    processed_end_seq: u64,
) {
    sender.send_modify(|pending| {
        let slot = pending.entry(session_id).or_insert(0);
        // max-merge：乱序到达的小值不能把游标拽回去。
        if processed_end_seq > *slot {
            *slot = processed_end_seq;
        }
    });
}

/// 取走待发回执并清空。
///
/// **必须用 `send_if_modified` 而不是 `send_modify`**：后者是**无条件**通知
/// （tokio 内部把闭包包成恒返回 `true` 的 `send_if_modified`），空 map 写回也会
/// 把接收方的 `changed()` 重新置 ready。而调用方在 drain **之前**就
/// `mark_unchanged()` 了，于是 drain 自己产生的这次通知没人消费——下一轮
/// `changed()` 立刻 ready、再 drain 空 map、再通知，形成**永久自唤醒环**：
/// 该 future 从此不再回到 Pending，把一整个 tokio worker 烧到 100% 单核。
///
/// 实测（0.12.8 调查，docs/92）：一次前端 ACK 就足以让循环 3 秒跑 1900 万次。
/// 活体采样表现为 `ZwRemoveIoCompletionEx` / `ZwWaitForAlertByThreadId` 反复
/// park/unpark，而 I/O 计数只有约 92 次/秒——**没有真实 I/O，纯调度器空转**，
/// 且不写任何日志，所以静默烧了很久没人发现。
fn drain_output_acks() -> HashMap<String, u64> {
    drain_output_acks_from(&output_ack_channel().0)
}

/// 排空给定通道。与 [`drain_output_acks`] 同一段逻辑，拆出 sender 参数只为让
/// 回归测试能用本地通道验证「空队列不通知」，不去抢进程内的静态单例。
fn drain_output_acks_from(
    sender: &tokio::sync::watch::Sender<HashMap<String, u64>>,
) -> HashMap<String, u64> {
    let mut taken = HashMap::new();
    sender.send_if_modified(|pending| {
        if pending.is_empty() {
            // 空队列不产生 changed 通知——这一行就是自唤醒环的闸门。
            return false;
        }
        taken = std::mem::take(pending);
        true
    });
    taken
}

fn output_ack_message(acks: &HashMap<String, u64>) -> String {
    serde_json::json!({
        "type": "outputAck",
        "sessions": acks
            .iter()
            .map(|(session_id, processed_end_seq)| serde_json::json!({
                "sessionId": session_id,
                "processedEndSeq": processed_end_seq,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// outbox ack（docs/86 3.1）：告知 daemon 这些身份事件已被本桌面端消费，
/// 可从留存中移除。旧 daemon 收到未知消息静默忽略（设计内降级：留存照旧、
/// 重放靠 `applied` 去重，行为等同 ack 之前）。
fn identity_ack_message(keys: &[(String, String)]) -> String {
    serde_json::json!({
        "type": "identityAck",
        "events": keys
            .iter()
            .map(|(session_id, resume_id)| serde_json::json!({
                "sessionId": session_id,
                "resumeId": resume_id,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

async fn run_control_link(
    mut client_rx: watch::Receiver<Option<TerminalDaemonClient>>,
    app_handle: tauri::AppHandle,
    connected: Arc<AtomicBool>,
) {
    // 跨重连保留：已补拉过的身份事件不再重复应用，notifier 的去重与待投队列
    // 也不能随断线清零。
    let mut applied_identity: HashSet<(String, String)> = HashSet::new();
    let mut notifier_state = NotifierState::default();
    // 身份事件 ack 队列：绑定任务完成后投键进来，由本 select 循环发给 daemon。
    // 发送失败不丢语义——daemon 仍留存，下次重连补拉时按「已应用」路径重新 ack。
    let (ack_tx, mut ack_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
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
                    let _connection_guard = ControlConnectionGuard::new(connected.clone());
                    debug!(daemon_addr = %client.addr(), "terminal daemon control link connected");
                    backoff = RECONNECT_MIN;
                    replay_identity_events(&app_handle, &client, &mut applied_identity, &ack_tx);
                    // 重连补发：daemon 侧 hidden 标记随旧连接清零（防旧标记压住
                    // 新订阅），所以新连接必须把当前全集重新声明一次。
                    let mut hidden_rx = hidden_sessions_channel().1.clone();
                    let mut shared_mcp_urls_rx = shared_mcp_urls_channel().1.clone();
                    let mut output_ack_rx = output_ack_channel().1.clone();
                    output_ack_rx.mark_unchanged();
                    // 先克隆出值再 await：watch::Ref 跨 await 会让 future 失去 Send
                    let latest_hidden = hidden_rx.borrow_and_update().clone();
                    if let Some(sessions) = latest_hidden {
                        use futures_util::SinkExt;
                        // best-effort 链路的仅有观测点：不留痕的话「daemon 没生效」
                        // 与「app 根本没发」无法区分。失败不 break——ws.next()
                        // 很快会看到同一个断连并走重连。
                        match ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                hidden_sessions_message(&sessions).into(),
                            ))
                            .await
                        {
                            Ok(()) => debug!(
                                count = sessions.len(),
                                "hidden sessions resent on control connect"
                            ),
                            Err(error) => debug!(
                                %error,
                                "hidden sessions resend failed; reconnect will retry"
                            ),
                        }
                    }
                    let latest_shared_mcp_urls = shared_mcp_urls_rx.borrow_and_update().clone();
                    if let Some(urls) = latest_shared_mcp_urls {
                        use futures_util::SinkExt;
                        match ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                shared_mcp_urls_message(&urls).into(),
                            ))
                            .await
                        {
                            Ok(()) => debug!(
                                count = urls.len(),
                                "shared MCP URLs resent on control connect"
                            ),
                            Err(error) => debug!(
                                %error,
                                "shared MCP URLs resend failed; reconnect will retry"
                            ),
                        }
                    }
                    loop {
                        let message = tokio::select! {
                            changed = client_rx.changed() => {
                                if changed.is_err() {
                                    return;
                                }
                                continue 'client;
                            }
                            changed = hidden_rx.changed() => {
                                if changed.is_ok() {
                                    let latest = hidden_rx.borrow_and_update().clone();
                                    if let Some(sessions) = latest {
                                        use futures_util::SinkExt;
                                        if ws
                                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                                hidden_sessions_message(&sessions).into(),
                                            ))
                                            .await
                                            .is_err()
                                        {
                                            debug!("hidden sessions push failed; reconnecting");
                                            break;
                                        }
                                        debug!(count = sessions.len(), "hidden sessions pushed");
                                    }
                                }
                                continue;
                            }
                            changed = shared_mcp_urls_rx.changed() => {
                                if changed.is_ok() {
                                    let latest = shared_mcp_urls_rx.borrow_and_update().clone();
                                    if let Some(urls) = latest {
                                        use futures_util::SinkExt;
                                        if ws
                                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                                shared_mcp_urls_message(&urls).into(),
                                            ))
                                            .await
                                            .is_err()
                                        {
                                            debug!("shared MCP URLs push failed; reconnecting");
                                            break;
                                        }
                                        debug!(count = urls.len(), "shared MCP URLs pushed");
                                    }
                                }
                                continue;
                            }
                            changed = output_ack_rx.changed() => {
                                if changed.is_ok() {
                                    output_ack_rx.mark_unchanged();
                                    let pending = drain_output_acks();
                                    // 排空本身会再置一次 changed；下一轮 map 为空直接跳过。
                                    if !pending.is_empty() {
                                        use futures_util::SinkExt;
                                        if ws
                                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                                output_ack_message(&pending).into(),
                                            ))
                                            .await
                                            .is_err()
                                        {
                                            // 丢了不补发：回执是累计值，前端下一次
                                            // 上报就把账补齐（自愈）。
                                            debug!("output ack push failed; reconnecting");
                                            break;
                                        }
                                        debug!(count = pending.len(), "output acks pushed");
                                    }
                                }
                                continue;
                            }
                            ack = ack_rx.recv() => {
                                if let Some(first) = ack {
                                    let mut keys = vec![first];
                                    while let Ok(more) = ack_rx.try_recv() {
                                        keys.push(more);
                                    }
                                    use futures_util::SinkExt;
                                    if ws
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            identity_ack_message(&keys).into(),
                                        ))
                                        .await
                                        .is_err()
                                    {
                                        // 丢了不补发：daemon 留存未删，重连补拉走
                                        // 「已应用」路径会重新 ack（自愈）。
                                        debug!("identity ack send failed; reconnecting");
                                        break;
                                    }
                                    debug!(count = keys.len(), "identity events acked");
                                }
                                continue;
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
                            Ok(Some(ControlAction::Emit(event))) => {
                                if crate::webview_reliability::webview_emits_allowed() {
                                    if let Err(error) = app_handle.emit(event.name, event.payload) {
                                        warn!(error = %error, "terminal daemon control event emit failed");
                                    }
                                }
                            }
                            Ok(Some(ControlAction::BindResume(payload))) => {
                                // 记入 applied：重连补拉时不再重复绑定同一条。
                                if let Some(key) = identity_key(&payload) {
                                    applied_identity.insert(key);
                                }
                                apply_resume_binding(&app_handle, payload, &ack_tx);
                            }
                            Ok(Some(ControlAction::Notify {
                                event,
                                session_id,
                                exit_code,
                            })) => {
                                apply_notifier_event(
                                    &app_handle,
                                    &mut notifier_state,
                                    &event,
                                    &session_id,
                                    exit_code,
                                );
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
    /// daemon 侧捕获到的 resume id（claude 发号 / codex OSC 标题）。
    /// 载荷原样透传，字段名必须与 `ResumeIdDetectedPayload` 保持一致。
    ResumeIdDetected { payload: serde_json::Value },
    /// 启动降级告警（launch profile 回落 / codex resume 目标缺失）。
    /// 降级必须对用户可见，丢掉就等于"设置静默不生效"。
    LaunchWarning { payload: serde_json::Value },
    /// daemon 侧补拍请求（M3b-2）：某会话照片锚点之后的 delta 超阈值，
    /// 催前端重拍上传。best-effort：丢了 daemon 30s 周期扫描会重发。
    CheckpointRequest {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// daemon 侧 PTY 推断出的会话副作用，交给桌面已有的 notifier 执行。
    Notifier {
        event: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default, rename = "exitCode")]
        exit_code: Option<i32>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, PartialEq)]
struct ControlEvent {
    name: &'static str,
    payload: serde_json::Value,
}

/// 控制消息的处置方式。
///
/// 关键区分：`Emit` 是**给 WebView 看的**，受 `webview_emits_allowed()` 门禁约束
/// （那道门禁防的是失效 WebView 上的 emit 洪水，不能绕）；而 resume id 是**要落库
/// 的身份数据**，被门禁吞掉意味着 DB 永久不绑定、该会话此后不可恢复——所以它走
/// `BindResume`，直接进后端持久化，完全不经过 WebView。
#[derive(Debug, PartialEq)]
enum ControlAction {
    Emit(ControlEvent),
    BindResume(serde_json::Value),
    Notify {
        event: String,
        session_id: String,
        exit_code: Option<i32>,
    },
}

fn parse_control_event(text: &str) -> serde_json::Result<Option<ControlAction>> {
    let message = serde_json::from_str::<DaemonControlMessage>(text)?;
    Ok(match message {
        DaemonControlMessage::SessionKilled { session_id, reason } => {
            Some(ControlAction::Emit(ControlEvent {
                name: EV::SESSION_KILLED,
                payload: serde_json::json!({
                    "sessionId": session_id,
                    "reason": reason.as_deref().unwrap_or("unknown"),
                }),
            }))
        }
        DaemonControlMessage::ResumeIdDetected { payload } => {
            Some(ControlAction::BindResume(payload))
        }
        DaemonControlMessage::LaunchWarning { payload } => {
            Some(ControlAction::Emit(ControlEvent {
                name: EV::TERMINAL_LAUNCH_WARNING,
                payload,
            }))
        }
        DaemonControlMessage::CheckpointRequest { session_id } => {
            Some(ControlAction::Emit(ControlEvent {
                name: EV::TERMINAL_CHECKPOINT_REQUEST,
                payload: serde_json::json!({ "sessionId": session_id }),
            }))
        }
        DaemonControlMessage::Notifier {
            event,
            session_id,
            exit_code,
        } => Some(ControlAction::Notify {
            event,
            session_id,
            exit_code,
        }),
        DaemonControlMessage::Unknown => None,
    })
}

/// 把 resume id 直接落库，不经 WebView 门禁。
fn apply_resume_binding(
    app_handle: &tauri::AppHandle,
    payload: serde_json::Value,
    ack_tx: &tokio::sync::mpsc::UnboundedSender<(String, String)>,
) {
    let key = identity_key(&payload);
    let Some(payload) = parse_resume_payload(payload) else {
        return;
    };
    let service = app_handle
        .state::<std::sync::Arc<cc_panes_core::services::LaunchHistoryService>>()
        .inner()
        .clone();
    let handle = app_handle.clone();
    let ack_tx = ack_tx.clone();
    tauri::async_runtime::spawn(async move {
        crate::services::bind_resume_id(handle, service, payload).await;
        // 绑定流程走完（含 upsert/二次窗兜底）即 ack——留存的目的只是投递保证，
        // 落库失败的事件重放也不会有不同结果（applied 去重会拦住重复绑定）。
        if let Some(key) = key {
            let _ = ack_tx.send(key);
        }
    });
}

/// 会话副作用交给桌面自己的 notifier（与本地 PTY 模式同一实现）。
/// 同一会话的 waiting-input 去重窗口。hook 通道与 PTY 推断都会驱动同一个
/// notifier，短时间内的重复只该提醒一次。
const WAITING_INPUT_DEDUPE: Duration = Duration::from_secs(20);

#[derive(Default)]
struct NotifierState {
    /// 已投递过 sessionExited 的会话——自然退出只该通知一次。
    exited: HashSet<String>,
    last_waiting: HashMap<String, Instant>,
    /// notifier 尚未注册时收到的事件。**不能直接丢**：自然退出不可重来，
    /// 丢了就永远没有退出通知、last_prompt 回填与 CCChan 提醒。
    pending: Vec<(String, String, Option<i32>)>,
}

impl NotifierState {
    /// 是否应当投递该事件（去重判定）。
    fn should_deliver(&mut self, event: &str, session_id: &str) -> bool {
        match event {
            "sessionExited" => self.exited.insert(session_id.to_string()),
            "waitingInput" => {
                let now = Instant::now();
                match self.last_waiting.get(session_id) {
                    Some(last) if now.duration_since(*last) < WAITING_INPUT_DEDUPE => false,
                    _ => {
                        self.last_waiting.insert(session_id.to_string(), now);
                        true
                    }
                }
            }
            "cleanup" => {
                self.exited.remove(session_id);
                self.last_waiting.remove(session_id);
                true
            }
            _ => true,
        }
    }
}

fn apply_notifier_event(
    app_handle: &tauri::AppHandle,
    state: &mut NotifierState,
    event: &str,
    session_id: &str,
    exit_code: Option<i32>,
) {
    let notifier = app_handle
        .try_state::<std::sync::Arc<dyn cc_panes_core::events::SessionNotifier>>()
        .map(|handle| handle.inner().clone());
    let Some(notifier) = notifier else {
        // control link 比 notifier 的 app.manage() 先启动，这个窗口内到达的事件
        // 先排队，等注册后补投——身份事件有补拉兜底，notifier 没有。
        debug!(
            event,
            session_id, "session notifier not registered yet; queueing"
        );
        state
            .pending
            .push((event.to_string(), session_id.to_string(), exit_code));
        return;
    };

    let queued = std::mem::take(&mut state.pending);
    for (event, session_id, exit_code) in queued {
        dispatch_notifier(&notifier, state, &event, &session_id, exit_code);
    }
    dispatch_notifier(&notifier, state, event, session_id, exit_code);
}

fn dispatch_notifier(
    notifier: &std::sync::Arc<dyn cc_panes_core::events::SessionNotifier>,
    state: &mut NotifierState,
    event: &str,
    session_id: &str,
    exit_code: Option<i32>,
) {
    if !state.should_deliver(event, session_id) {
        debug!(event, session_id, "duplicate notifier event suppressed");
        return;
    }
    match event {
        "waitingInput" => notifier.notify_waiting_input(session_id),
        "sessionExited" => notifier.notify_session_exited(session_id, exit_code.unwrap_or(-1)),
        "cleanup" => notifier.cleanup_session(session_id),
        other => debug!(event = other, "unknown daemon notifier event ignored"),
    }
}

/// 连上（含每次重连）后补拉一次 daemon 留存的身份事件。
///
/// control 是无重放的广播：本 link 建连之前 daemon emit 的 resume id 已经丢了，
/// 而 claude 发号紧跟 PTY spawn——app 启动那一两秒正是恢复流程批量建会话的时刻。
/// 补拉把这个窗口堵死；`bind_resume_id` 本身按来源优先级幂等，重复应用无副作用。
fn replay_identity_events(
    app_handle: &tauri::AppHandle,
    client: &TerminalDaemonClient,
    applied: &mut HashSet<(String, String)>,
    ack_tx: &tokio::sync::mpsc::UnboundedSender<(String, String)>,
) {
    let events = match client.list_identity_events() {
        Ok(events) => events,
        Err(error) => {
            warn!(error = %error, "failed to replay daemon identity events");
            return;
        }
    };

    // 只重放本进程还没应用过的：daemon 的留存是累积的（会话退出后条目仍在），
    // 每次重连全量重放会变成一轮 DB 写 + 事件风暴。
    let mut previously_applied: Vec<(String, String)> = Vec::new();
    let fresh: Vec<serde_json::Value> = events
        .into_iter()
        .filter(|payload| {
            let Some(key) = identity_key(payload) else {
                return true;
            };
            if applied.insert(key.clone()) {
                true
            } else {
                previously_applied.push(key);
                false
            }
        })
        .collect();
    // 已应用过但 daemon 仍留存的条目：上一轮 ack 丢了（断线/旧 daemon），
    // 直接补 ack——这条自愈路径保证 ack 丢失不会让留存永久膨胀。
    for key in previously_applied {
        let _ = ack_tx.send(key);
    }
    if fresh.is_empty() {
        return;
    }

    debug!(count = fresh.len(), "replaying daemon identity events");
    // 顺序处理而非逐条 spawn：补拉是补漏，不该和正常启动抢 DB。
    let handle = app_handle.clone();
    let ack_tx = ack_tx.clone();
    tauri::async_runtime::spawn(async move {
        for payload in fresh {
            let key = identity_key(&payload);
            let Some(typed) = parse_resume_payload(payload) else {
                continue;
            };
            let service = handle
                .state::<std::sync::Arc<cc_panes_core::services::LaunchHistoryService>>()
                .inner()
                .clone();
            crate::services::bind_resume_id(handle.clone(), service, typed).await;
            if let Some(key) = key {
                let _ = ack_tx.send(key);
            }
        }
    });
}

fn identity_key(payload: &serde_json::Value) -> Option<(String, String)> {
    let session_id = payload.get("sessionId")?.as_str()?.to_string();
    let resume_id = payload.get("resumeSessionId")?.as_str()?.to_string();
    Some((session_id, resume_id))
}

fn parse_resume_payload(
    payload: serde_json::Value,
) -> Option<crate::services::ResumeIdDetectedPayload> {
    match serde_json::from_value(payload) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            warn!(error = %error, "daemon resume id payload did not match expected shape");
            None
        }
    }
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

        let ControlAction::Emit(event) = event else {
            panic!("sessionKilled must stay a UI emit");
        };
        assert_eq!(event.name, EV::SESSION_KILLED);
        assert_eq!(
            event.payload,
            serde_json::json!({
                "sessionId": "session-1",
                "reason": "mcp",
            })
        );
    }

    /// daemon 模式下 PTY 在 daemon 进程里，resume id 只能经控制通道回到桌面。
    /// 载荷必须原样透传：字段名对不上 `ResumeIdDetectedPayload` 就会反序列化失败，
    /// launch_history 永远拿不到 resume id（表现为恢复出来的会话没有历史对话）。
    #[test]
    fn resume_id_detected_control_message_passes_payload_through() {
        let event = parse_control_event(
            r#"{"type":"resumeIdDetected","payload":{"sessionId":"pty-1","resumeSessionId":"resume-1","source":"issued","cliTool":"claude"}}"#,
        )
        .expect("valid control message")
        .expect("known control message");

        // resume id 必须走后端持久绑定，**不能**是受 WebView 门禁约束的 UI emit：
        // WebView 自愈期门禁为 false，走 emit 就会被吞掉、DB 永久不绑定。
        let ControlAction::BindResume(payload) = event else {
            panic!("resume id must bypass the WebView gate via BindResume");
        };
        assert_eq!(
            payload,
            serde_json::json!({
                "sessionId": "pty-1",
                "resumeSessionId": "resume-1",
                "source": "issued",
                "cliTool": "claude",
            })
        );
        // 载荷必须能反序列化成绑定层的类型——字段名对不上就会整条静默失败。
        let typed: crate::services::ResumeIdDetectedPayload =
            serde_json::from_value(payload).expect("payload must match ResumeIdDetectedPayload");
        assert_eq!(typed.session_id, "pty-1");
        assert_eq!(typed.resume_session_id, "resume-1");
        assert_eq!(typed.source, "issued");
    }

    #[test]
    fn notifier_control_message_carries_session_and_exit_code() {
        let action = parse_control_event(
            r#"{"type":"notifier","event":"sessionExited","sessionId":"pty-9","exitCode":3}"#,
        )
        .expect("valid control message")
        .expect("known control message");

        assert_eq!(
            action,
            ControlAction::Notify {
                event: "sessionExited".to_string(),
                session_id: "pty-9".to_string(),
                exit_code: Some(3),
            }
        );
    }

    /// waitingInput / cleanup 不带 exitCode，缺字段必须解析成 None 而不是失败。
    #[test]
    fn notifier_control_message_without_exit_code_parses() {
        let action = parse_control_event(
            r#"{"type":"notifier","event":"waitingInput","sessionId":"pty-9"}"#,
        )
        .expect("valid control message")
        .expect("known control message");

        assert_eq!(
            action,
            ControlAction::Notify {
                event: "waitingInput".to_string(),
                session_id: "pty-9".to_string(),
                exit_code: None,
            }
        );
    }

    /// 补拍请求转成 WebView 事件（前端触发 serialize + 上传）。
    #[test]
    fn checkpoint_request_control_message_maps_to_frontend_event() {
        let event = parse_control_event(r#"{"type":"checkpointRequest","sessionId":"pty-3"}"#)
            .expect("valid control message")
            .expect("known control message");

        let ControlAction::Emit(event) = event else {
            panic!("checkpoint request stays a UI emit");
        };
        assert_eq!(event.name, EV::TERMINAL_CHECKPOINT_REQUEST);
        assert_eq!(event.payload, serde_json::json!({ "sessionId": "pty-3" }));
    }

    #[test]
    fn launch_warning_control_message_passes_payload_through() {
        let event = parse_control_event(
            r#"{"type":"launchWarning","payload":{"kind":"profileMismatch","launchId":"proj-1"}}"#,
        )
        .expect("valid control message")
        .expect("known control message");

        let ControlAction::Emit(event) = event else {
            panic!("launch warning stays a UI emit");
        };
        assert_eq!(event.name, EV::TERMINAL_LAUNCH_WARNING);
        assert_eq!(
            event.payload,
            serde_json::json!({ "kind": "profileMismatch", "launchId": "proj-1" })
        );
    }

    /// 自然退出只能通知一次：hook 通道与 PTY 推断都会驱动同一个 notifier。
    #[test]
    fn session_exited_is_delivered_once_per_session() {
        let mut state = NotifierState::default();
        assert!(state.should_deliver("sessionExited", "s-1"));
        assert!(!state.should_deliver("sessionExited", "s-1"));
        // 另一条会话不受影响
        assert!(state.should_deliver("sessionExited", "s-2"));
    }

    #[test]
    fn waiting_input_is_deduped_within_window() {
        let mut state = NotifierState::default();
        assert!(state.should_deliver("waitingInput", "s-1"));
        assert!(!state.should_deliver("waitingInput", "s-1"));
    }

    /// cleanup 清账：会话 id 复用（或重连后重建）时不能被旧记录永久压住。
    #[test]
    fn cleanup_resets_dedupe_state() {
        let mut state = NotifierState::default();
        assert!(state.should_deliver("sessionExited", "s-1"));
        assert!(state.should_deliver("cleanup", "s-1"));
        assert!(state.should_deliver("sessionExited", "s-1"));
    }

    /// 身份事件按 (session, resumeId) 去重：daemon 的留存是累积的，
    /// 每次重连全量重放会变成一轮 DB 写风暴。
    #[test]
    fn identity_key_dedupes_repeated_replays() {
        let payload = serde_json::json!({
            "sessionId": "pty-1",
            "resumeSessionId": "resume-1",
            "source": "issued",
        });
        let mut applied = HashSet::new();
        let key = identity_key(&payload).expect("key");
        assert!(applied.insert(key.clone()));
        assert!(!applied.insert(key));
    }

    #[test]
    fn identity_key_missing_fields_returns_none() {
        assert!(identity_key(&serde_json::json!({ "sessionId": "pty-1" })).is_none());
    }

    #[test]
    fn unknown_control_message_is_ignored_for_forward_compatibility() {
        assert!(parse_control_event(r#"{"type":"futureEvent"}"#)
            .expect("unknown message must still parse")
            .is_none());
    }

    /// 自唤醒环回归守卫（docs/92）。
    ///
    /// drain 用 `send_modify`（无条件通知）时，空 map 写回会把 `changed()` 重新置
    /// ready，而调用方在 drain 前就 `mark_unchanged()` 了——没人消费这次通知，
    /// 下一轮立刻 ready、再 drain 空 map、再通知，该 future 从此不回 Pending，
    /// 烧满一整个 tokio worker（实测 3 秒 1900 万次，且不写任何日志）。
    ///
    /// 这条测的是「排空一个已空的队列**不得**产生 changed 通知」——把
    /// `send_if_modified` 换回 `send_modify` 立刻失败。
    ///
    /// **不碰进程内的静态通道**：`output_ack_channel()` 是 `OnceLock` 单例，
    /// 同一二进制里的测试并发跑会互相抢它（先写的值被别的测试 drain 掉，
    /// 表现为莫名其妙的 `None`）。这里在本地建等价通道复刻同一形态，
    /// 顺带让断言与真实实现共用 [`drain_output_acks_from`]。
    #[tokio::test]
    async fn draining_an_empty_queue_does_not_rewake_receivers() {
        let (tx, mut rx) = tokio::sync::watch::channel(HashMap::<String, u64>::new());
        rx.mark_unchanged();

        tx.send_modify(|pending| {
            pending.insert("spin-guard-session".to_string(), 42);
        });
        assert!(rx.changed().await.is_ok(), "真实上报必须唤醒接收方");
        rx.mark_unchanged();

        let taken = drain_output_acks_from(&tx);
        assert_eq!(taken.get("spin-guard-session"), Some(&42));

        // 第一次 drain 非空，会留下一次通知——消费掉它。
        let _ = tokio::time::timeout(std::time::Duration::from_millis(50), rx.changed()).await;
        rx.mark_unchanged();

        // 关键断言：队列已空，再 drain 不得再次唤醒。
        let drained_again = drain_output_acks_from(&tx);
        assert!(drained_again.is_empty());
        let rewoken =
            tokio::time::timeout(std::time::Duration::from_millis(80), rx.changed()).await;
        assert!(
            rewoken.is_err(),
            "排空已空队列不得产生 changed 通知，否则形成永久自唤醒环（docs/92）"
        );
    }

    /// max-merge 语义不能因为改了通知条件而丢：乱序到达的小值不得把游标拽回去。
    #[test]
    fn output_ack_keeps_max_merge_semantics() {
        let (tx, _rx) = tokio::sync::watch::channel(HashMap::<String, u64>::new());
        for seq in [100u64, 40, 250] {
            merge_output_ack(&tx, "merge-session".to_string(), seq);
        }
        let taken = drain_output_acks_from(&tx);
        assert_eq!(taken.get("merge-session"), Some(&250));
    }
}
