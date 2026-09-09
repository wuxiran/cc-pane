use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cc_panes_core::constants::events as EV;
use cc_panes_core::models::{TerminalExit, TerminalOutput, TerminalReplaySnapshot};
use cc_panes_core::services::terminal_service::{SessionStatus, SessionStatusInfo};
use cc_panes_core::services::{HistoryWatchManager, TerminalBackend};
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{Emitter, Manager};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tracing::{debug, warn};

use super::terminal_daemon_bridge_reliability::{
    connect_with_retry, reconnect_when_available, skip_missed_interval, BridgeMode, BridgeStats,
    BridgeTelemetry, ConnectRetryPolicy, PollWork, PollingSchedule, POLL_INTERVAL,
    WEBSOCKET_STATUS_INTERVAL,
};
use super::terminal_daemon_output_cursor::{CursorDelta, OutputCursor};

type DaemonWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 会话消失后，退出前额外等待 daemon 补发 `killed`；正常运行期不引入延迟。
const DRAIN_WINDOW: Duration = Duration::from_millis(150);

#[derive(Clone)]
pub struct TerminalDaemonEventBridge {
    app_handle: tauri::AppHandle,
    sessions: Arc<Mutex<HashMap<String, SessionBridgeState>>>,
    history_watch_manager: Arc<HistoryWatchManager>,
    retry_policy: ConnectRetryPolicy,
    telemetry: BridgeTelemetry,
}

#[derive(Debug, Default)]
struct SessionBridgeState {
    last_snapshot: String,
    last_status: Option<SessionStatusInfo>,
    started: bool,
    terminal_exit_emitted: bool,
    mode: BridgeMode,
    output_cursor: OutputCursor,
    legacy_snapshots: bool,
}

impl SessionBridgeState {
    fn enter_websocket(&mut self) {
        self.mode.enter_websocket();
    }

    fn enter_polling(&mut self) {
        self.mode.enter_polling();
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum DaemonStreamMessage {
    Output {
        data: String,
        /// 本批数据最后一个 raw chunk 的 seq（M3b-2）。旧 daemon 不发 → None。
        #[serde(default, rename = "endSeq")]
        end_seq: Option<u64>,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
    Killed {
        reason: Option<String>,
    },
    /// daemon 侧输出队列曾溢出（慢客户端），中段输出已被整段跳过：
    /// 前端必须丢弃现有画面、用 replay snapshot 重放，否则 VT 流缺口必然花屏。
    Desync,
    /// 未知消息类型兜底：新 daemon 增加消息类型时旧 app 不能因 serde 失败
    /// 整条流退化为轮询。
    #[serde(other)]
    Unknown,
}

impl TerminalDaemonEventBridge {
    pub fn new(
        app_handle: tauri::AppHandle,
        history_watch_manager: Arc<HistoryWatchManager>,
    ) -> Self {
        let retry_policy = ConnectRetryPolicy::default();
        Self {
            app_handle,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            history_watch_manager,
            retry_policy,
            telemetry: BridgeTelemetry::new(retry_policy.max_concurrent),
        }
    }

    pub fn stats(&self) -> BridgeStats {
        let sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        self.telemetry
            .bridge_stats(sessions.values().map(|state| state.mode))
    }

    pub fn start_session(&self, session_id: impl Into<String>, backend: Arc<dyn TerminalBackend>) {
        self.start_session_with_snapshot(session_id, backend, None);
    }

    pub fn start_session_after_replay(
        &self,
        session_id: impl Into<String>,
        backend: Arc<dyn TerminalBackend>,
        snapshot: &TerminalReplaySnapshot,
    ) {
        self.start_session_with_snapshot(session_id, backend, Some(snapshot.data.clone()));
    }

    fn start_session_with_snapshot(
        &self,
        session_id: impl Into<String>,
        backend: Arc<dyn TerminalBackend>,
        initial_snapshot: Option<String>,
    ) {
        let session_id = session_id.into();
        let should_start = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
            let state = sessions.entry(session_id.clone()).or_default();
            if let Some(snapshot) = initial_snapshot {
                state.last_snapshot = snapshot;
            }
            if state.started {
                false
            } else {
                state.started = true;
                true
            }
        };

        if !should_start {
            return;
        }

        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            bridge.run_session(session_id, backend).await;
        });
    }

    fn stop_session(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        sessions.remove(session_id);
    }

    fn set_session_mode(&self, session_id: &str, mode: BridgeMode) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let Some(state) = sessions.get_mut(session_id) else {
            return;
        };
        let changed = state.mode != mode;
        match mode {
            BridgeMode::Connecting => {}
            BridgeMode::Websocket => state.enter_websocket(),
            BridgeMode::Polling => state.enter_polling(),
        }
        drop(sessions);
        if changed {
            use super::performance_recorder::EventKind;
            match mode {
                BridgeMode::Websocket => {
                    self.record_diagnostic(session_id, EventKind::Websocket, None)
                }
                BridgeMode::Polling => self.record_diagnostic(session_id, EventKind::Polling, None),
                BridgeMode::Connecting => {}
            }
        }
    }

    fn record_diagnostic(
        &self,
        session_id: &str,
        kind: super::performance_recorder::EventKind,
        end_seq: Option<u64>,
    ) {
        use super::performance_recorder::{DiagnosticEvent, PerformanceRecorder};
        if let Some(recorder) = self.app_handle.try_state::<Arc<PerformanceRecorder>>() {
            recorder.record_event(DiagnosticEvent {
                kind,
                session_id: Some(session_id.to_string()),
                end_seq,
            });
        }
    }

    fn emit_to_webview(&self, event: &str, payload: serde_json::Value) -> anyhow::Result<()> {
        if crate::webview_reliability::webview_emits_allowed() {
            self.app_handle.emit(event, payload)?;
        }
        Ok(())
    }

    async fn initial_websocket(
        &self,
        session_id: &str,
        backend: &dyn TerminalBackend,
    ) -> Option<DaemonWebSocket> {
        let url = backend.event_stream_url(session_id)?;
        let result = connect_with_retry(self.retry_policy, self.telemetry.clone(), || {
            let url = url.clone();
            async move { Ok(connect_async(&url).await?.0) }
        })
        .await;
        match result {
            Ok(websocket) => Some(websocket),
            Err(error) => {
                warn!(%session_id, %error, "terminal websocket unavailable; polling with scheduled reconnect");
                None
            }
        }
    }

    async fn run_session(&self, session_id: String, backend: Arc<dyn TerminalBackend>) {
        let mut websocket = self.initial_websocket(&session_id, backend.as_ref()).await;
        loop {
            if let Some(stream) = websocket.take() {
                self.set_session_mode(&session_id, BridgeMode::Websocket);
                match self
                    .stream_session(session_id.clone(), stream, backend.clone())
                    .await
                {
                    Ok(()) => break,
                    Err(error) => {
                        warn!(%session_id, %error, "terminal websocket interrupted; reconnect scheduled")
                    }
                }
            }
            self.set_session_mode(&session_id, BridgeMode::Polling);
            self.telemetry.record_fallback();
            websocket = self.poll_session(&session_id, backend.clone()).await;
            if websocket.is_none() {
                break;
            }
            tracing::info!(%session_id, "terminal daemon websocket stream recovered");
        }
        self.stop_session(&session_id);
    }

    async fn stream_session<S>(
        &self,
        session_id: String,
        mut ws: S,
        backend: Arc<dyn TerminalBackend>,
    ) -> anyhow::Result<()>
    where
        S: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin,
    {
        let mut status_interval = skip_missed_interval(WEBSOCKET_STATUS_INTERVAL);

        loop {
            tokio::select! {
                message = ws.next() => {
                    let Some(message) = message else {
                        anyhow::bail!("terminal websocket ended before a terminal exit event");
                    };
                    let message = message?;
                    if message.is_close() {
                        anyhow::bail!("terminal websocket closed before a terminal exit event");
                    }
                    if !message.is_text() {
                        continue;
                    }
                    if self.handle_stream_message(&session_id, message.to_text()?)? {
                        return Ok(());
                    }
                }
                _ = status_interval.tick() => {
                    // 状态轮询判定“会话没了”只说明 sessions map 里查不到，不代表 daemon
                    // 没有排队待发的 killed 消息——kill 路径里 remove 与事件广播之间存在空窗，
                    // 直接 return 会 drop socket 并把 reason 一起丢掉（标签因此关不掉）。
                    // 所以先排干 WS 中已就绪的消息，让 killed/exit 有机会被处理，再决定是否
                    // 由 poll_status 发静默 -1。
                    if self.drain_ready_messages(&session_id, &mut ws, Duration::ZERO).await? {
                        return Ok(());
                    }
                    if self.poll_status(&session_id, backend.clone()).await? == PollStatus::Done {
                        // poll_status 的 HTTP 往返期间 ws.next() 不被 poll，killed 可能刚好
                        // 在这段时间入队：退出前再给一个短窗口把它读出来。
                        self.drain_ready_messages(&session_id, &mut ws, DRAIN_WINDOW)
                            .await?;
                        return Ok(());
                    }
                }
            }
        }
    }

    /// 退出前排干 WS 里已就绪的消息，`window` 内还允许等待新到达的消息。
    ///
    /// 返回 `true` 表示读到了终止性消息（`killed` / `exit`）并已 emit 对应事件，
    /// 调用方应直接退出、不要再走静默 `-1` 路径。返回 `false` 表示窗口内没有可用消息
    /// （或流已结束/收到 close 帧），由调用方按原逻辑处理。
    async fn drain_ready_messages<S>(
        &self,
        session_id: &str,
        ws: &mut S,
        window: Duration,
    ) -> anyhow::Result<bool>
    where
        S: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin,
    {
        drain_ready_messages_with(ws, window, |text| {
            self.handle_stream_message(session_id, text)
        })
        .await
    }

    fn handle_stream_message(&self, session_id: &str, text: &str) -> anyhow::Result<bool> {
        let message: DaemonStreamMessage = serde_json::from_str(text)?;
        match message {
            DaemonStreamMessage::Output { data, end_seq } => {
                let delta = {
                    let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
                    let Some(state) = sessions.get_mut(session_id) else {
                        return Ok(false);
                    };
                    match end_seq {
                        Some(seq) => state.output_cursor.stream(seq, &data),
                        None => {
                            state.output_cursor.reset();
                            CursorDelta::Data(data)
                        }
                    }
                };
                self.emit_cursor_delta(session_id, delta, end_seq)?;
                Ok(false)
            }
            DaemonStreamMessage::Exit { exit_code } => {
                self.emit_terminal_status_once(synthesized_exited_status_with_code(
                    session_id,
                    Some(exit_code),
                ))?;
                self.emit_terminal_exit_once(session_id, exit_code)?;
                Ok(true)
            }
            DaemonStreamMessage::Killed { reason } => {
                // 转发 kill 事件给前端（daemon 模式下此前会被丢弃），
                // 并照 Exit 路径 synthesize 退出状态：保留标签时终端能显示进程退出。
                self.emit_to_webview(
                    EV::SESSION_KILLED,
                    session_killed_event_payload(session_id, reason.as_deref()),
                )?;
                self.emit_terminal_status_once(synthesized_exited_status(session_id))?;
                self.emit_terminal_exit_once(session_id, -1)?;
                Ok(true)
            }
            DaemonStreamMessage::Desync => {
                // The daemon already declared the gap (including hidden-view drops).
                // Discard the old continuity anchor so the first resumed frame does
                // not immediately request a second full replay for that same gap.
                if let Some(state) = self
                    .sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(session_id)
                {
                    state.output_cursor.reset();
                }
                self.record_diagnostic(
                    session_id,
                    super::performance_recorder::EventKind::Resync,
                    None,
                );
                self.emit_to_webview(
                    EV::TERMINAL_DESYNC,
                    serde_json::json!({ "sessionId": session_id }),
                )?;
                Ok(false)
            }
            DaemonStreamMessage::Unknown => Ok(false),
        }
    }

    async fn poll_session(
        &self,
        session_id: &str,
        backend: Arc<dyn TerminalBackend>,
    ) -> Option<DaemonWebSocket> {
        let mut interval = skip_missed_interval(POLL_INTERVAL);
        let mut schedule = PollingSchedule::default();
        let reconnect = async {
            let Some(url) = backend.event_stream_url(session_id) else {
                return std::future::pending::<DaemonWebSocket>().await;
            };
            reconnect_when_available(self.retry_policy, self.telemetry.clone(), || {
                let url = url.clone();
                async move { Ok(connect_async(&url).await?.0) }
            })
            .await
        };
        tokio::pin!(reconnect);
        loop {
            tokio::select! {
                websocket = &mut reconnect => {
                    // Subscribe first, then bridge the disconnected interval. Queued WS
                    // frames overlapping this snapshot are filtered by OutputCursor.
                    if let Err(error) = self.poll_snapshot(session_id, backend.clone()).await {
                        warn!(%session_id, %error, "terminal reconnect catch-up failed; requesting screen recovery");
                        if let Err(emit_error) = self.emit_cursor_delta(session_id, CursorDelta::Resync, None) {
                            warn!(%session_id, %emit_error, "terminal reconnect recovery notification failed");
                        }
                    }
                    return Some(websocket);
                }
                _ = interval.tick() => {}
            }
            let work = schedule.next_work();

            if let Err(error) = self.poll_snapshot(session_id, backend.clone()).await {
                debug!(%session_id, %error, "terminal snapshot unavailable; reconnect remains active");
            }

            if work == PollWork::SnapshotOnly {
                continue;
            }

            match self.poll_status(session_id, backend.clone()).await {
                Ok(PollStatus::Continue) => {}
                Ok(PollStatus::Done) => {
                    return None;
                }
                Err(error) => {
                    debug!(%session_id, %error, "terminal status unavailable; reconnect remains active");
                }
            }
        }
    }

    async fn poll_snapshot(
        &self,
        session_id: &str,
        backend: Arc<dyn TerminalBackend>,
    ) -> anyhow::Result<()> {
        let legacy = self
            .sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(session_id)
            .is_some_and(|state| state.legacy_snapshots);
        if legacy {
            return self.poll_legacy_snapshot(session_id, backend).await;
        }
        let sid = session_id.to_string();
        let source = backend.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            source.get_session_recovery_snapshot(&sid)
        })
        .await?;
        let snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(error)
                if error.to_string().contains("CHECKPOINT_UNSUPPORTED")
                    || error
                        .to_string()
                        .contains("checkpoint not supported by this backend") =>
            {
                if let Some(state) = self
                    .sessions
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .get_mut(session_id)
                {
                    state.legacy_snapshots = true;
                    state.output_cursor.reset();
                }
                return self.poll_legacy_snapshot(session_id, backend).await;
            }
            Err(error) => return Err(anyhow::anyhow!(error.to_string())),
        };
        let Some(snapshot) = snapshot else {
            return Ok(());
        };
        let delta = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
            let Some(state) = sessions.get_mut(session_id) else {
                return Ok(());
            };
            state.output_cursor.recovery(
                snapshot.checkpoint_epoch,
                snapshot.end_seq,
                &snapshot.delta,
            )
        };
        self.emit_cursor_delta(session_id, delta, Some(snapshot.end_seq))
    }

    fn emit_cursor_delta(
        &self,
        session_id: &str,
        delta: CursorDelta,
        end_seq: Option<u64>,
    ) -> anyhow::Result<()> {
        if matches!(delta, CursorDelta::Resync) {
            self.record_diagnostic(
                session_id,
                super::performance_recorder::EventKind::Resync,
                end_seq,
            );
        }
        match delta {
            CursorDelta::Unchanged => Ok(()),
            CursorDelta::Data(data) => self.emit_to_webview(
                EV::TERMINAL_OUTPUT,
                serde_json::to_value(TerminalOutput {
                    session_id: session_id.to_string(),
                    data,
                    end_seq,
                })?,
            ),
            CursorDelta::Resync => self.emit_to_webview(
                EV::TERMINAL_DESYNC,
                serde_json::json!({ "sessionId": session_id }),
            ),
        }
    }

    async fn poll_legacy_snapshot(
        &self,
        session_id: &str,
        backend: Arc<dyn TerminalBackend>,
    ) -> anyhow::Result<()> {
        let sid = session_id.to_string();
        let snapshot =
            tauri::async_runtime::spawn_blocking(move || backend.get_session_replay_snapshot(&sid))
                .await
                .map_err(|error| anyhow::anyhow!(error.to_string()))?
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;

        let Some(snapshot) = snapshot else {
            return Ok(());
        };

        match self.apply_snapshot_delta(session_id, &snapshot) {
            SnapshotDelta::Delta(delta) => {
                self.emit_to_webview(
                    EV::TERMINAL_OUTPUT,
                    serde_json::to_value(TerminalOutput {
                        session_id: session_id.to_string(),
                        data: delta,
                        // 轮询降级路径按快照差分产出，坐标系与 raw seq 无关，不产 seq。
                        end_seq: None,
                    })?,
                )?;
            }
            SnapshotDelta::Mismatch => {
                self.emit_to_webview(
                    EV::TERMINAL_DESYNC,
                    serde_json::json!({ "sessionId": session_id }),
                )?;
            }
            SnapshotDelta::Unchanged => {}
        }

        Ok(())
    }

    async fn poll_status(
        &self,
        session_id: &str,
        backend: Arc<dyn TerminalBackend>,
    ) -> anyhow::Result<PollStatus> {
        let sid = session_id.to_string();
        let status = tauri::async_runtime::spawn_blocking(move || backend.get_session_status(&sid))
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let poll_status = poll_status_from_session_presence(status.as_ref());

        let Some(mut status) = status else {
            self.emit_terminal_status_once(synthesized_exited_status(session_id))?;
            self.emit_terminal_exit_once(session_id, -1)?;
            return Ok(poll_status);
        };

        if let Some(orchestrator) = self
            .app_handle
            .try_state::<Arc<crate::services::OrchestratorService>>()
        {
            orchestrator.adjust_terminal_statuses_for_query(std::slice::from_mut(&mut status));
        }

        if self.should_emit_status(session_id, &status) {
            self.emit_to_webview(EV::TERMINAL_STATUS, serde_json::to_value(&status)?)?;
        }

        Ok(poll_status)
    }

    fn apply_snapshot_delta(
        &self,
        session_id: &str,
        snapshot: &TerminalReplaySnapshot,
    ) -> SnapshotDelta {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let state = sessions.entry(session_id.to_string()).or_default();
        let outcome = replay_snapshot_delta(&state.last_snapshot, &snapshot.data);
        // Mismatch 也要重置基线：desync 恢复后前端画面 == 当前快照，
        // 下一轮轮询从此处继续前缀比对。
        if !matches!(outcome, SnapshotDelta::Unchanged) {
            state.last_snapshot = snapshot.data.clone();
        }
        outcome
    }

    fn should_emit_status(&self, session_id: &str, status: &SessionStatusInfo) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let state = sessions.entry(session_id.to_string()).or_default();
        if state
            .last_status
            .as_ref()
            .is_some_and(|previous| same_status_payload(previous, status))
        {
            return false;
        }
        state.last_status = Some(status.clone());
        true
    }

    fn emit_terminal_exit_once(&self, session_id: &str, exit_code: i32) -> anyhow::Result<()> {
        let should_emit = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
            let state = sessions.entry(session_id.to_string()).or_default();
            if state.terminal_exit_emitted {
                false
            } else {
                state.terminal_exit_emitted = true;
                true
            }
        };

        if should_emit {
            self.history_watch_manager.on_session_ended(session_id);
            self.emit_to_webview(
                EV::TERMINAL_EXIT,
                serde_json::to_value(TerminalExit {
                    session_id: session_id.to_string(),
                    exit_code,
                })?,
            )?;
        }

        Ok(())
    }

    fn emit_terminal_status_once(&self, status: SessionStatusInfo) -> anyhow::Result<()> {
        if self.should_emit_status(&status.session_id, &status) {
            self.emit_to_webview(EV::TERMINAL_STATUS, serde_json::to_value(&status)?)?;
        }

        Ok(())
    }
}

fn session_killed_event_payload(session_id: &str, reason: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "reason": reason.unwrap_or("unknown"),
    })
}

/// `drain_ready_messages` 的纯流处理部分：把消息取舍与事件 emit 解耦，便于脱离
/// `tauri::AppHandle` 单测“poll 先于 killed 到达时消息不会被丢弃”。
///
/// `handle` 返回 `true` 表示该消息是终止性的（`killed` / `exit`），排干立即结束。
async fn drain_ready_messages_with<S, F>(
    ws: &mut S,
    window: Duration,
    mut handle: F,
) -> anyhow::Result<bool>
where
    S: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin,
    F: FnMut(&str) -> anyhow::Result<bool>,
{
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let Ok(message) = tokio::time::timeout_at(deadline, ws.next()).await else {
            return Ok(false);
        };
        let Some(message) = message else {
            return Ok(false);
        };
        let message = message?;
        if message.is_close() {
            return Ok(false);
        }
        if !message.is_text() {
            continue;
        }
        if handle(message.to_text()?)? {
            return Ok(true);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PollStatus {
    Continue,
    Done,
}

fn poll_status_from_session_presence(status: Option<&SessionStatusInfo>) -> PollStatus {
    // Hook 状态只描述 CLI 生命周期，不是 PTY 进程退出证据。daemon 仍能返回
    // 会话时继续桥接；真实退出由 WS exit/killed 或 sessions map 移除确认。
    if status.is_some() {
        PollStatus::Continue
    } else {
        PollStatus::Done
    }
}

/// 快照增量三态（M3b-0）：失配不再冒充增量。
#[derive(Debug, PartialEq)]
enum SnapshotDelta {
    Unchanged,
    Delta(String),
    /// 当前快照不再以上次快照为前缀（8MB front-drop / 未来的 photo rebase）：
    /// 中段不连续。把整屏当增量 append 会产生重复画面——唯一诚实做法是发
    /// desync 走统一快照恢复（前端 reset + 全量重放）。
    Mismatch,
}

fn replay_snapshot_delta(previous: &str, current: &str) -> SnapshotDelta {
    if current.is_empty() {
        return SnapshotDelta::Unchanged;
    }
    if previous.is_empty() {
        return SnapshotDelta::Delta(current.to_string());
    }
    if current == previous {
        return SnapshotDelta::Unchanged;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return SnapshotDelta::Delta(delta.to_string());
    }
    SnapshotDelta::Mismatch
}

fn same_status_payload(left: &SessionStatusInfo, right: &SessionStatusInfo) -> bool {
    left.session_id == right.session_id
        && left.status == right.status
        && left.last_output_at == right.last_output_at
        && left.pid == right.pid
        && left.exit_code == right.exit_code
        && left.current_tool_name == right.current_tool_name
        && left.current_tool_use_id == right.current_tool_use_id
        && left.current_tool_summary == right.current_tool_summary
        && left.updated_at == right.updated_at
}

fn synthesized_exited_status(session_id: &str) -> SessionStatusInfo {
    synthesized_exited_status_with_code(session_id, None)
}

fn synthesized_exited_status_with_code(
    session_id: &str,
    exit_code: Option<i32>,
) -> SessionStatusInfo {
    let now = current_epoch_millis();
    SessionStatusInfo {
        session_id: session_id.to_string(),
        status: SessionStatus::Exited,
        last_output_at: now,
        pid: None,
        exit_code,
        current_tool_name: None,
        current_tool_use_id: None,
        current_tool_summary: None,
        updated_at: now,
    }
}

fn current_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
#[path = "terminal_daemon_event_bridge_tests.rs"]
mod tests;
