//! SessionStateMachine — hook 驱动的会话状态机
//!
//! ## 角色
//! 主进程的"会话事件总线"。所有 hook 子命令通过 POST /api/hook-event 上报 cc-pane
//! 抽象事件（CcPaneEvent），此模块依据状态转移表更新 SessionStatus，并触发通知。
//!
//! ## 与现有 terminal_service 的关系
//! - terminal_service::SessionStatus 仍是 status 主存储（每个 session 一个 Mutex<SessionStatus>）
//! - 本模块**不直接持有** session 状态，而是通过回调更新 terminal_service 中的 status Mutex
//! - terminal_service 的 PTY ANSI 推断（infer_status）作为兜底：仅在 hook 30s 静默时生效
//!   （由 last_hook_event_at 时间戳控制；具体在阶段 2.8 落地）
//!
//! ## 通知触发（§4.4）
//! 状态跃迁时调用 NotificationService::on_status_transition（阶段 2.6 落地）。
//! 阶段 2.2 先把"跃迁事件"埋好接口，通知逻辑在 2.6 接入。
//!
//! ## 阶段 2.7（长工具 60s timer）
//! 进入 ToolRunning(name) 时启动 tokio oneshot timer；离开时取消。
//! 本文件只预留 spawn_long_tool_timer 接口，timer 真实落地在 2.7。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cc_cli_adapters::CcPaneEvent;
use tracing::{debug, info, warn};

use crate::services::terminal_service::SessionStatus;

/// hook 事件的到达通道。
///
/// 同一个 hook 触发会经两条通道上报：HTTP POST /api/hook-event（带完整 payload）
/// 和 PTY in-band OSC 777 标记（cc-panes-cli-hook 的 terminalSequence 输出，
/// 由 osc_state_detect 解析）。本地运行时两条都通，WSL/SSH 运行时 HTTP 可能
/// 到不了后端，OSC 随终端字节流必达。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventChannel {
    Http,
    Osc,
}

/// 跨通道去重窗口：同名事件在此窗口内从**另一条**通道再次到达时视为
/// 同一次 hook 的重复投递，丢弃。窗口需远大于双通道到达的偏差（毫秒级），
/// 又远小于相邻两次真实 hook 事件的最短间隔。
const CROSS_CHANNEL_DEDUP_WINDOW_SECS: u64 = 2;

/// 去重记忆条数。单槽会被重排击穿：A(Http)→B(Http)→A(Osc) 序列里
/// A 的 OSC 副本因记忆已被 B 覆盖而重复应用（如 turn_seq 多计）。
const DEDUP_MEMORY: usize = 4;

/// 单个 session 的状态机内部状态
#[derive(Debug, Clone)]
pub struct SessionStateEntry {
    pub status: SessionStatus,
    /// 当前 ToolRunning 时的工具名（仅 ToolRunning 状态有意义）
    pub current_tool_name: Option<String>,
    /// 当前 ToolRunning 的简短摘要，用于前端活动徽章展示。
    pub current_tool_summary: Option<String>,
    /// 最后一次收到 hook 事件的时间（用于 2.8 ANSI 推断降级判定）
    pub last_hook_event_at: Instant,
    /// 最近数次已应用事件（事件名 + 时间 + 通道），用于跨通道去重
    last_applied_events: Vec<(&'static str, Instant, EventChannel)>,
    /// 最近一次状态机更新的 epoch 毫秒时间戳。
    pub updated_at: u64,
    /// 当前 ToolRunning 工具的 tool_use_id（用于长工具 timer 与通知 dedupe）
    pub current_tool_use_id: Option<String>,
    /// 当前轮序号（每个 TurnEnd 自增；用于通知 dedupe_key）
    pub turn_seq: u64,
    /// task_binding_id（hook 上报时附带）
    pub task_binding_id: Option<String>,
}

impl SessionStateEntry {
    fn new() -> Self {
        Self {
            status: SessionStatus::Initializing,
            current_tool_name: None,
            current_tool_summary: None,
            last_hook_event_at: Instant::now(),
            last_applied_events: Vec::new(),
            updated_at: current_epoch_millis(),
            current_tool_use_id: None,
            turn_seq: 0,
            task_binding_id: None,
        }
    }
}

/// 一次状态跃迁记录（送给 NotificationService 等订阅方）
#[derive(Debug, Clone)]
pub struct StateTransition {
    pub pty_session_id: String,
    pub from: SessionStatus,
    pub to: SessionStatus,
    pub turn_seq: u64,
    pub tool_use_id: Option<String>,
    /// 进入 ToolRunning 时的工具名（其他状态为 None）
    pub tool_name: Option<String>,
    pub task_binding_id: Option<String>,
    /// 触发本次跃迁的 cc-pane 事件（仅供调试/通知文案）
    pub trigger_event: String,
    /// 原始 hook payload 中的可选错误类型（仅 Error 跃迁时填充）
    pub error_type: Option<String>,
}

/// 订阅状态跃迁的回调（阶段 2.6 NotificationService 实现）
pub type TransitionListener = Arc<dyn Fn(&StateTransition) + Send + Sync>;

/// SessionStateMachine —— 整个进程一个实例。
///
/// 内部用 Mutex<HashMap> 保存所有 session 的状态机条目。读写都加锁，但都是 O(1)。
pub struct SessionStateMachine {
    entries: Mutex<HashMap<String, SessionStateEntry>>,
    listeners: Mutex<Vec<TransitionListener>>,
}

impl SessionStateMachine {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// 订阅状态跃迁。阶段 2.6 NotificationService 会注册一个回调进来。
    pub fn subscribe(&self, listener: TransitionListener) {
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.push(listener);
        }
    }

    /// 处理一个 hook 事件（HTTP 通道，保持原签名兼容）。
    ///
    /// 返回 (from, to)，用于 HTTP handler 把跃迁回执给 hook（hook 可选择忽略）。
    pub fn on_event(
        &self,
        pty_session_id: &str,
        event: &CcPaneEvent,
        task_binding_id: Option<String>,
        payload: &serde_json::Value,
    ) -> (SessionStatus, SessionStatus) {
        self.on_event_with_channel(
            pty_session_id,
            event,
            task_binding_id,
            payload,
            EventChannel::Http,
        )
    }

    /// 处理一个 hook 事件，标注到达通道。
    ///
    /// 跨通道去重：同名事件在 2s 窗口内从另一条通道重复到达时丢弃
    /// （返回 (current, current)，不产生跃迁）。同通道的快速重复
    /// （如连续两次 tool-before）是真实事件，照常应用。
    pub fn on_event_with_channel(
        &self,
        pty_session_id: &str,
        event: &CcPaneEvent,
        task_binding_id: Option<String>,
        payload: &serde_json::Value,
        channel: EventChannel,
    ) -> (SessionStatus, SessionStatus) {
        let mut entries = match self.entries.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let entry = entries
            .entry(pty_session_id.to_string())
            .or_insert_with(SessionStateEntry::new);
        let from = entry.status;

        let event_name = cc_pane_event_name(event);
        let is_cross_channel_dup = entry.last_applied_events.iter().any(|(name, at, ch)| {
            *name == event_name
                && *ch != channel
                && at.elapsed().as_secs() < CROSS_CHANNEL_DEDUP_WINDOW_SECS
        });
        if is_cross_channel_dup {
            debug!(
                pty_session_id = pty_session_id,
                event = event_name,
                channel = ?channel,
                "cross-channel duplicate hook event dropped"
            );
            return (from, from);
        }
        if entry.last_applied_events.len() >= DEDUP_MEMORY {
            entry.last_applied_events.remove(0);
        }
        entry
            .last_applied_events
            .push((event_name, Instant::now(), channel));

        if let Some(id) = task_binding_id.clone() {
            entry.task_binding_id = Some(id);
        }
        entry.last_hook_event_at = Instant::now();
        entry.updated_at = current_epoch_millis();

        // 状态转移表（§4.2）
        let (next, tool_use_id_change, tool_name_change) = match event {
            CcPaneEvent::SessionInit | CcPaneEvent::SessionResume => {
                (SessionStatus::Initializing, None, None)
            }
            CcPaneEvent::PromptBefore => (SessionStatus::Thinking, None, None),
            CcPaneEvent::ToolBefore(_) => {
                let tool_name = extract_tool_name(payload).unwrap_or_else(|| "tool".into());
                let tool_use_id = extract_tool_use_id(payload);
                let tool_summary = extract_tool_summary(payload);
                entry.current_tool_use_id = tool_use_id.clone();
                entry.current_tool_name = Some(tool_name.clone());
                entry.current_tool_summary = tool_summary;
                (SessionStatus::ToolRunning, tool_use_id, Some(tool_name))
            }
            CcPaneEvent::ToolAfter(_) => {
                // 工具结束 → 回到 Thinking（如果之前是 ToolRunning），否则保持不变
                let was_tool_use_id = entry.current_tool_use_id.take();
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                if matches!(from, SessionStatus::ToolRunning) {
                    (SessionStatus::Thinking, was_tool_use_id, None)
                } else {
                    (from, was_tool_use_id, None)
                }
            }
            CcPaneEvent::TurnEnd => {
                entry.turn_seq += 1;
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                (SessionStatus::Idle, None, None)
            }
            CcPaneEvent::BeforeCompact => {
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                (SessionStatus::Compacting, None, None)
            }
            CcPaneEvent::WaitingInput => {
                let tool_use_id = extract_tool_use_id(payload);
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                (SessionStatus::WaitingInput, tool_use_id, None)
            }
            CcPaneEvent::Error => {
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                (SessionStatus::Error, None, None)
            }
            CcPaneEvent::SessionEnd => {
                entry.current_tool_name = None;
                entry.current_tool_summary = None;
                (SessionStatus::Exited, None, None)
            }
        };

        entry.status = next;
        let turn_seq = entry.turn_seq;
        let task_binding_id_snapshot = entry.task_binding_id.clone();
        let trigger_event = cc_pane_event_name(event).to_string();
        let error_type = if matches!(event, CcPaneEvent::Error) {
            extract_error_type(payload)
        } else {
            None
        };
        drop(entries);

        let transition = StateTransition {
            pty_session_id: pty_session_id.to_string(),
            from,
            to: next,
            turn_seq,
            tool_use_id: tool_use_id_change,
            tool_name: tool_name_change,
            task_binding_id: task_binding_id_snapshot,
            trigger_event,
            error_type,
        };

        // status 变化时广播；ToolBefore 即使仍是 ToolRunning 也广播，
        // 这样连续工具调用会重新启动长工具 timer。
        let should_notify =
            transition.from != transition.to || matches!(event, CcPaneEvent::ToolBefore(_));
        if should_notify {
            debug!(
                pty_session_id = pty_session_id,
                from = ?transition.from,
                to = ?transition.to,
                event = %transition.trigger_event,
                "session state transition"
            );
            self.notify_listeners(&transition);
        } else {
            debug!(
                pty_session_id = pty_session_id,
                event = %transition.trigger_event,
                "hook event arrived but status unchanged"
            );
        }

        (from, next)
    }

    /// 由 terminal_service 在 PTY 退出时调用，强制进入 Exited（即使 SessionEnd hook 未来过）。
    pub fn force_exited(&self, pty_session_id: &str) {
        let mut entries = match self.entries.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let Some(entry) = entries.get_mut(pty_session_id) else {
            return;
        };
        let from = entry.status;
        if matches!(from, SessionStatus::Exited) {
            return;
        }
        entry.status = SessionStatus::Exited;
        entry.current_tool_name = None;
        entry.current_tool_summary = None;
        entry.current_tool_use_id = None;
        entry.updated_at = current_epoch_millis();
        let task_binding_id = entry.task_binding_id.clone();
        let turn_seq = entry.turn_seq;
        drop(entries);
        let transition = StateTransition {
            pty_session_id: pty_session_id.to_string(),
            from,
            to: SessionStatus::Exited,
            turn_seq,
            tool_use_id: None,
            tool_name: None,
            task_binding_id,
            trigger_event: "pty-exit".into(),
            error_type: None,
        };
        info!(
            pty_session_id = pty_session_id,
            "PTY exit forced state machine into Exited"
        );
        self.notify_listeners(&transition);
    }

    /// 查询当前状态（无锁失败时返回 None）。
    pub fn snapshot(&self, pty_session_id: &str) -> Option<SessionStateEntry> {
        self.entries.lock().ok()?.get(pty_session_id).cloned()
    }

    /// 返回面向 UI/编排判定的有效状态。陈旧 busy 只在查询结果中回落为 Idle，
    /// 状态机条目和 TerminalSession.status 均保持原值，后续新事件仍可正常接续。
    pub fn status_for_query(
        &self,
        pty_session_id: &str,
        stored_status: SessionStatus,
    ) -> SessionStatus {
        self.status_for_query_at(pty_session_id, stored_status, Instant::now())
    }

    #[doc(hidden)]
    pub fn status_for_query_at(
        &self,
        pty_session_id: &str,
        stored_status: SessionStatus,
        now: Instant,
    ) -> SessionStatus {
        if !stored_status.is_busy() {
            return stored_status;
        }
        let entries = match self.entries.lock() {
            Ok(entries) => entries,
            Err(error) => error.into_inner(),
        };
        let Some(entry) = entries.get(pty_session_id) else {
            return stored_status;
        };
        if !entry.status.is_busy() {
            return stored_status;
        }
        let stale_for = now.saturating_duration_since(entry.last_hook_event_at);
        if stale_for.as_secs() > crate::constants::session_state::STALE_BUSY_TIMEOUT_SECS {
            SessionStatus::Idle
        } else {
            stored_status
        }
    }

    /// 查询自上次 hook 事件以来已过去多少秒（供 2.8 ANSI 推断降级判定）。
    /// 没有任何 hook 事件记录时返回 None（ANSI 推断可以照常运行）。
    pub fn seconds_since_last_hook(&self, pty_session_id: &str) -> Option<u64> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(pty_session_id)?;
        Some(entry.last_hook_event_at.elapsed().as_secs())
    }

    fn notify_listeners(&self, transition: &StateTransition) {
        let listeners = match self.listeners.lock() {
            Ok(g) => g.clone(),
            Err(_) => {
                warn!("SessionStateMachine listeners lock poisoned");
                return;
            }
        };
        for listener in listeners.iter() {
            // 单个 listener panic 不应影响其他 listener；用 catch_unwind 兜底
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener(transition);
            }));
        }
    }
}

impl Default for SessionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

// ============ payload helpers ============
//
// hook stdin JSON 字段不固定，状态机只挑感兴趣的几个；缺失时返回 None。

fn extract_tool_name(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_tool_use_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_tool_summary(payload: &serde_json::Value) -> Option<String> {
    for key in ["tool_summary", "input_summary", "summary"] {
        if let Some(summary) = payload.get(key).and_then(|v| v.as_str()) {
            return trim_tool_summary(summary);
        }
    }

    let input = payload.get("tool_input").or_else(|| payload.get("input"))?;
    if let Some(object) = input.as_object() {
        for key in [
            "file_path",
            "path",
            "command",
            "pattern",
            "url",
            "query",
            "prompt",
            "description",
        ] {
            if let Some(value) = object.get(key).and_then(summary_value_to_string) {
                return trim_tool_summary(&value);
            }
        }
        if let Some((_, value)) = object.iter().next() {
            return summary_value_to_string(value).and_then(|value| trim_tool_summary(&value));
        }
    }

    summary_value_to_string(input).and_then(|value| trim_tool_summary(&value))
}

fn summary_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).ok()
        }
    }
}

fn trim_tool_summary(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(40).collect())
}

fn extract_error_type(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("error_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn current_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 事件名 → CcPaneEvent（`cc_pane_event_name` 的逆映射）。
/// OSC 通道只携带事件名，工具事件的 matcher 在运行期分发无意义，统一 any()。
pub fn parse_cc_pane_event_name(name: &str) -> Option<CcPaneEvent> {
    use cc_cli_adapters::ToolMatcher;
    Some(match name {
        "session-init" => CcPaneEvent::SessionInit,
        "session-resume" => CcPaneEvent::SessionResume,
        "session-end" => CcPaneEvent::SessionEnd,
        "prompt-before" => CcPaneEvent::PromptBefore,
        "tool-before" => CcPaneEvent::ToolBefore(ToolMatcher::any()),
        "tool-after" => CcPaneEvent::ToolAfter(ToolMatcher::any()),
        "turn-end" => CcPaneEvent::TurnEnd,
        "before-compact" => CcPaneEvent::BeforeCompact,
        "waiting-input" => CcPaneEvent::WaitingInput,
        "error" => CcPaneEvent::Error,
        _ => return None,
    })
}

fn cc_pane_event_name(event: &CcPaneEvent) -> &'static str {
    match event {
        CcPaneEvent::SessionInit => "session-init",
        CcPaneEvent::SessionResume => "session-resume",
        CcPaneEvent::SessionEnd => "session-end",
        CcPaneEvent::PromptBefore => "prompt-before",
        CcPaneEvent::ToolBefore(_) => "tool-before",
        CcPaneEvent::ToolAfter(_) => "tool-after",
        CcPaneEvent::TurnEnd => "turn-end",
        CcPaneEvent::BeforeCompact => "before-compact",
        CcPaneEvent::WaitingInput => "waiting-input",
        CcPaneEvent::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_cli_adapters::ToolMatcher;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn empty_payload() -> serde_json::Value {
        json!({})
    }

    #[test]
    fn session_init_then_prompt_then_turn_end_walks_through_states() {
        let sm = SessionStateMachine::new();
        let sid = "pty-1";
        let (_, s1) = sm.on_event(sid, &CcPaneEvent::SessionInit, None, &empty_payload());
        assert_eq!(s1, SessionStatus::Initializing);
        let (_, s2) = sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        assert_eq!(s2, SessionStatus::Thinking);
        let (_, s3) = sm.on_event(sid, &CcPaneEvent::TurnEnd, None, &empty_payload());
        assert_eq!(s3, SessionStatus::Idle);
        let snap = sm.snapshot(sid).unwrap();
        assert_eq!(snap.turn_seq, 1);
    }

    #[test]
    fn stale_busy_status_falls_back_to_idle_only_for_queries() {
        let sm = SessionStateMachine::new();
        let sid = "pty-stale-busy";
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        let snapshot = sm.snapshot(sid).expect("state entry");
        let query_time = snapshot.last_hook_event_at
            + std::time::Duration::from_secs(
                crate::constants::session_state::STALE_BUSY_TIMEOUT_SECS + 1,
            );

        assert_eq!(
            sm.status_for_query_at(sid, SessionStatus::Thinking, query_time),
            SessionStatus::Idle
        );
        assert_eq!(
            sm.snapshot(sid).expect("raw state remains").status,
            SessionStatus::Thinking
        );
    }

    #[test]
    fn fresh_busy_status_does_not_fall_back_while_events_are_flowing() {
        let sm = SessionStateMachine::new();
        let sid = "pty-fresh-busy";
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        let snapshot = sm.snapshot(sid).expect("state entry");
        let query_time = snapshot.last_hook_event_at
            + std::time::Duration::from_secs(
                crate::constants::session_state::STALE_BUSY_TIMEOUT_SECS - 1,
            );

        assert_eq!(
            sm.status_for_query_at(sid, SessionStatus::Thinking, query_time),
            SessionStatus::Thinking
        );
    }

    #[test]
    fn tool_before_then_after_returns_to_thinking() {
        let sm = SessionStateMachine::new();
        let sid = "pty-2";
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        let payload = json!({"tool_name": "Edit", "tool_use_id": "tu-1"});
        let (_, s) = sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &payload,
        );
        assert_eq!(s, SessionStatus::ToolRunning);
        // 工具名存储在 snapshot 里
        let snap = sm.snapshot(sid).unwrap();
        assert_eq!(snap.current_tool_name.as_deref(), Some("Edit"));
        assert_eq!(snap.current_tool_summary, None);
        let (_, s) = sm.on_event(
            sid,
            &CcPaneEvent::ToolAfter(ToolMatcher::any()),
            None,
            &empty_payload(),
        );
        assert_eq!(s, SessionStatus::Thinking);
        let snap = sm.snapshot(sid).unwrap();
        assert!(snap.current_tool_name.is_none());
        assert!(snap.current_tool_summary.is_none());
    }

    #[test]
    fn waiting_input_and_error_overrides() {
        let sm = SessionStateMachine::new();
        let sid = "pty-3";
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        sm.on_event(
            sid,
            &CcPaneEvent::WaitingInput,
            None,
            &json!({"tool_name": "Bash"}),
        );
        assert_eq!(
            sm.snapshot(sid).unwrap().status,
            SessionStatus::WaitingInput
        );
        sm.on_event(
            sid,
            &CcPaneEvent::Error,
            None,
            &json!({"error_type": "rate_limit"}),
        );
        assert_eq!(sm.snapshot(sid).unwrap().status, SessionStatus::Error);
    }

    #[test]
    fn force_exited_emits_transition() {
        let sm = SessionStateMachine::new();
        let sid = "pty-4";
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        sm.subscribe(Arc::new(move |t: &StateTransition| {
            if t.to == SessionStatus::Exited {
                c.fetch_add(1, Ordering::SeqCst);
            }
        }));
        sm.on_event(sid, &CcPaneEvent::SessionInit, None, &empty_payload());
        sm.force_exited(sid);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        // 重复 force_exited 不再触发
        sm.force_exited(sid);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn listeners_only_fire_on_real_change() {
        let sm = SessionStateMachine::new();
        let sid = "pty-5";
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        sm.subscribe(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }));
        // 首次 SessionInit：from=Initializing, to=Initializing → 不发跃迁
        sm.on_event(sid, &CcPaneEvent::SessionInit, None, &empty_payload());
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        // PromptBefore：Initializing → Thinking，真变化
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        // 再次 PromptBefore：Thinking → Thinking，不发
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn tool_before_notifies_even_when_status_stays_tool_running() {
        let sm = SessionStateMachine::new();
        let sid = "pty-6";
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        sm.subscribe(Arc::new(move |t: &StateTransition| {
            if t.to == SessionStatus::ToolRunning {
                c.fetch_add(1, Ordering::SeqCst);
            }
        }));

        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &json!({"tool_name": "Read", "tool_use_id": "tu-1"}),
        );
        sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &json!({"tool_name": "Edit", "tool_use_id": "tu-2"}),
        );

        assert_eq!(counter.load(Ordering::SeqCst), 2);
        assert_eq!(
            sm.snapshot(sid).unwrap().current_tool_use_id.as_deref(),
            Some("tu-2")
        );
    }

    #[test]
    fn cross_channel_duplicate_is_dropped() {
        let sm = SessionStateMachine::new();
        let sid = "pty-8";
        // HTTP 先到：Initializing → Thinking
        let (_, s) = sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        assert_eq!(s, SessionStatus::Thinking);
        sm.on_event(sid, &CcPaneEvent::TurnEnd, None, &empty_payload());
        assert_eq!(sm.snapshot(sid).unwrap().turn_seq, 1);
        // 同一 turn-end 的 OSC 副本在窗口内到达 → 丢弃，turn_seq 不再自增
        let (from, to) = sm.on_event_with_channel(
            sid,
            &CcPaneEvent::TurnEnd,
            None,
            &empty_payload(),
            EventChannel::Osc,
        );
        assert_eq!((from, to), (SessionStatus::Idle, SessionStatus::Idle));
        assert_eq!(sm.snapshot(sid).unwrap().turn_seq, 1);
    }

    #[test]
    fn osc_first_then_http_duplicate_is_also_dropped() {
        let sm = SessionStateMachine::new();
        let sid = "pty-9";
        let (_, s) = sm.on_event_with_channel(
            sid,
            &CcPaneEvent::WaitingInput,
            None,
            &empty_payload(),
            EventChannel::Osc,
        );
        assert_eq!(s, SessionStatus::WaitingInput);
        sm.on_event_with_channel(
            sid,
            &CcPaneEvent::TurnEnd,
            None,
            &empty_payload(),
            EventChannel::Osc,
        );
        let seq_before = sm.snapshot(sid).unwrap().turn_seq;
        // HTTP 副本晚到 → 丢弃
        sm.on_event(sid, &CcPaneEvent::TurnEnd, None, &empty_payload());
        assert_eq!(sm.snapshot(sid).unwrap().turn_seq, seq_before);
    }

    #[test]
    fn reordered_osc_copy_is_still_deduped() {
        // A(Http) → B(Http) → A(Osc)：A 的 OSC 副本被 PTY 缓冲延迟到 B 之后，
        // 单槽记忆会漏掉它；多槽记忆必须仍然去重。
        let sm = SessionStateMachine::new();
        let sid = "pty-11";
        sm.on_event(sid, &CcPaneEvent::TurnEnd, None, &empty_payload());
        sm.on_event(sid, &CcPaneEvent::PromptBefore, None, &empty_payload());
        assert_eq!(sm.snapshot(sid).unwrap().turn_seq, 1);
        // turn-end 的 OSC 副本迟到
        sm.on_event_with_channel(
            sid,
            &CcPaneEvent::TurnEnd,
            None,
            &empty_payload(),
            EventChannel::Osc,
        );
        assert_eq!(sm.snapshot(sid).unwrap().turn_seq, 1);
        // 状态也不该被打回 Idle
        assert_eq!(sm.snapshot(sid).unwrap().status, SessionStatus::Thinking);
    }

    #[test]
    fn same_channel_rapid_repeat_is_applied() {
        let sm = SessionStateMachine::new();
        let sid = "pty-10";
        // 同通道连续两次 tool-before 是真实事件（连续工具调用），不去重
        sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &json!({"tool_name": "Read", "tool_use_id": "tu-1"}),
        );
        sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &json!({"tool_name": "Edit", "tool_use_id": "tu-2"}),
        );
        assert_eq!(
            sm.snapshot(sid).unwrap().current_tool_use_id.as_deref(),
            Some("tu-2")
        );
    }

    #[test]
    fn parse_cc_pane_event_name_round_trips() {
        for name in [
            "session-init",
            "session-resume",
            "session-end",
            "prompt-before",
            "tool-before",
            "tool-after",
            "turn-end",
            "before-compact",
            "waiting-input",
            "error",
        ] {
            let event = parse_cc_pane_event_name(name).expect(name);
            assert_eq!(cc_pane_event_name(&event), name);
        }
        assert!(parse_cc_pane_event_name("bogus").is_none());
    }

    #[test]
    fn tool_before_captures_summary_from_tool_input() {
        let sm = SessionStateMachine::new();
        let sid = "pty-7";
        sm.on_event(
            sid,
            &CcPaneEvent::ToolBefore(ToolMatcher::any()),
            None,
            &json!({
                "tool_name": "Edit",
                "tool_use_id": "tu-1",
                "tool_input": {
                    "file_path": "/tmp/a-very-long-file-name-that-will-be-trimmed.rs"
                }
            }),
        );

        let snap = sm.snapshot(sid).unwrap();
        assert_eq!(snap.current_tool_name.as_deref(), Some("Edit"));
        assert_eq!(
            snap.current_tool_summary.as_deref(),
            Some("/tmp/a-very-long-file-name-that-will-be-")
        );
    }
}
