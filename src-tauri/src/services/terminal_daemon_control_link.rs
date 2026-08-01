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

async fn run_control_link(
    mut client_rx: watch::Receiver<Option<TerminalDaemonClient>>,
    app_handle: tauri::AppHandle,
    connected: Arc<AtomicBool>,
) {
    // 跨重连保留：已补拉过的身份事件不再重复应用，notifier 的去重与待投队列
    // 也不能随断线清零。
    let mut applied_identity: HashSet<(String, String)> = HashSet::new();
    let mut notifier_state = NotifierState::default();
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
                    replay_identity_events(&app_handle, &client, &mut applied_identity);
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
                            Ok(Some(ControlAction::Emit(event))) => {
                                if crate::webview_reliability::webview_emits_allowed() {
                                    if let Err(error) = app_handle.emit(event.name, event.payload) {
                                        warn!(error = %error, "terminal daemon control event emit failed");
                                    }
                                }
                            }
                            Ok(Some(ControlAction::BindResume(payload))) => {
                                apply_resume_binding(&app_handle, payload);
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
fn apply_resume_binding(app_handle: &tauri::AppHandle, payload: serde_json::Value) {
    let Some(payload) = parse_resume_payload(payload) else {
        return;
    };
    let service = app_handle
        .state::<std::sync::Arc<cc_panes_core::services::LaunchHistoryService>>()
        .inner()
        .clone();
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(crate::services::bind_resume_id(handle, service, payload));
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
    let fresh: Vec<serde_json::Value> = events
        .into_iter()
        .filter(|payload| {
            let key = identity_key(payload);
            key.is_none_or(|key| applied.insert(key))
        })
        .collect();
    if fresh.is_empty() {
        return;
    }

    debug!(count = fresh.len(), "replaying daemon identity events");
    // 顺序处理而非逐条 spawn：补拉是补漏，不该和正常启动抢 DB。
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        for payload in fresh {
            let Some(typed) = parse_resume_payload(payload) else {
                continue;
            };
            let service = handle
                .state::<std::sync::Arc<cc_panes_core::services::LaunchHistoryService>>()
                .inner()
                .clone();
            crate::services::bind_resume_id(handle.clone(), service, typed).await;
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
}
