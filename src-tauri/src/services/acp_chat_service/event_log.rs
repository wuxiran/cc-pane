//! 每 chat 内存事件环 + 实时广播（docs/112 §3.2）。
//!
//! `AcpChatService` 的每次 emit（ACP 会话、原生 Codex 会话、Bot 的进程内旁路）
//! 都经 `EventTap::send` 先写到这里，再交给 Tauri emit 与旁路订阅者。写环与
//! 广播在同一把锁里完成；订阅方也在同一把锁里「先订阅实时、再读环」，所以
//! 环覆盖 `seq <= lastSeq`、接收端覆盖之后的全部，不缺不重。
//!
//! 环语义：per-chat 单调 `seq`（从 1 起），条数 + 字节双上限，头部裁剪。
//! `floorSeq` = **环内保留的最小 seq**（空环时 = `lastSeq + 1`）。读者已见到
//! `afterSeq` 时：`floorSeq - 1 <= afterSeq <= lastSeq` 可无缺口续传；否则
//! （已被裁掉，或大于 lastSeq——app 重启后 seq 重新计数）回 `reset`。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;

/// docs/112 建议值：4000 条 / 8 MB。
pub const DEFAULT_MAX_EVENTS: usize = 4000;
pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 实时广播缓冲；订阅方落后超过它会收到 Lagged，由 WS 层按已发 seq 回环补读。
const BROADCAST_CAPACITY: usize = 1024;
/// 已结束 chat 的事件日志保留上限（按 updatedAt 淘汰最旧的）。
const MAX_CLOSED_LOGS: usize = 32;
/// 每 chat 记住的最近 promptId 数（`user_prompt` 去重窗口）。
const PROMPT_ID_WINDOW: usize = 256;
/// 用户 prompt 事件。
pub const USER_PROMPT_KIND: &str = "user_prompt";

#[derive(Debug, Clone, Copy)]
pub struct RingLimits {
    pub max_events: usize,
    pub max_bytes: usize,
}

impl Default for RingLimits {
    fn default() -> Self {
        Self {
            max_events: DEFAULT_MAX_EVENTS,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoggedEvent {
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    bytes: usize,
}

impl LoggedEvent {
    /// WS 下行帧 `{"type":"event","seq","kind","payload"}`。
    pub fn frame(&self) -> Value {
        serde_json::json!({
            "type": "event",
            "seq": self.seq,
            "kind": self.kind,
            "payload": self.payload,
        })
    }
}

/// 读者按 `afterSeq` 续传时该收到什么。
#[derive(Debug, Clone, PartialEq)]
pub enum ReplayPlan {
    /// 无缺口：补发 `seq > afterSeq` 的事件。
    Delta(Vec<Arc<LoggedEvent>>),
    /// 客户端先清空、套 snapshot，再接收环内全部事件（`seq >= floorSeq`）。
    Reset {
        floor_seq: u64,
        events: Vec<Arc<LoggedEvent>>,
    },
}

impl ReplayPlan {
    pub fn events(&self) -> &[Arc<LoggedEvent>] {
        match self {
            Self::Delta(events) | Self::Reset { events, .. } => events,
        }
    }
}

/// 纯数据结构：seq 分配 + 双上限裁剪 + 续传判定。
#[derive(Debug)]
pub struct EventRing {
    events: VecDeque<Arc<LoggedEvent>>,
    last_seq: u64,
    bytes: usize,
    limits: RingLimits,
}

impl EventRing {
    pub fn new(limits: RingLimits) -> Self {
        Self {
            events: VecDeque::new(),
            last_seq: 0,
            bytes: 0,
            limits,
        }
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// 环内保留的最小 seq；空环时 `lastSeq + 1`。
    pub fn floor_seq(&self) -> u64 {
        self.events
            .front()
            .map_or(self.last_seq + 1, |event| event.seq)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn push(&mut self, kind: &str, payload: Value) -> Arc<LoggedEvent> {
        self.last_seq += 1;
        let bytes = kind.len() + serde_json::to_vec(&payload).map_or(0, |raw| raw.len());
        let event = Arc::new(LoggedEvent {
            seq: self.last_seq,
            kind: kind.to_string(),
            payload,
            bytes,
        });
        self.events.push_back(event.clone());
        self.bytes += bytes;
        // 至少保留刚写入的那条：单条超过字节上限时环里只剩它。
        while self.events.len() > 1
            && (self.events.len() > self.limits.max_events || self.bytes > self.limits.max_bytes)
        {
            if let Some(evicted) = self.events.pop_front() {
                self.bytes -= evicted.bytes;
            }
        }
        event
    }

    pub fn replay(&self, after_seq: u64) -> ReplayPlan {
        let floor = self.floor_seq();
        if after_seq + 1 < floor || after_seq > self.last_seq {
            return ReplayPlan::Reset {
                floor_seq: floor,
                events: self.events.iter().cloned().collect(),
            };
        }
        ReplayPlan::Delta(
            self.events
                .iter()
                .filter(|event| event.seq > after_seq)
                .cloned()
                .collect(),
        )
    }
}

struct ChatLog {
    ring: EventRing,
    tx: broadcast::Sender<Arc<LoggedEvent>>,
    updated_at: i64,
    /// 最近一次 `state` 事件的 payload（AcpChatSnapshot），供 reset 帧使用。
    last_state: Option<Value>,
    closed: bool,
    prompt_ids: VecDeque<String>,
    prompt_id_set: HashSet<String>,
}

impl ChatLog {
    fn new(limits: RingLimits, now: i64) -> Self {
        Self {
            ring: EventRing::new(limits),
            tx: broadcast::channel(BROADCAST_CAPACITY).0,
            updated_at: now,
            last_state: None,
            closed: false,
            prompt_ids: VecDeque::new(),
            prompt_id_set: HashSet::new(),
        }
    }

    fn remember_prompt(&mut self, prompt_id: &str) -> bool {
        if !self.prompt_id_set.insert(prompt_id.to_string()) {
            return false;
        }
        self.prompt_ids.push_back(prompt_id.to_string());
        if self.prompt_ids.len() > PROMPT_ID_WINDOW {
            if let Some(old) = self.prompt_ids.pop_front() {
                self.prompt_id_set.remove(&old);
            }
        }
        true
    }
}

/// 订阅结果：实时接收端 + 当时的续传计划，二者在同一把锁下取得。
pub struct Subscription {
    pub receiver: broadcast::Receiver<Arc<LoggedEvent>>,
    pub plan: ReplayPlan,
    pub last_seq: u64,
    pub snapshot: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatLogInfo {
    pub last_seq: u64,
    pub updated_at: i64,
}

pub struct AcpEventHub {
    logs: Mutex<HashMap<String, ChatLog>>,
    limits: RingLimits,
}

impl Default for AcpEventHub {
    fn default() -> Self {
        Self::new(RingLimits::default())
    }
}

impl AcpEventHub {
    pub fn new(limits: RingLimits) -> Self {
        Self {
            logs: Mutex::new(HashMap::new()),
            limits,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ChatLog>> {
        self.logs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 追加 + 广播（同一临界区）。返回分配到的 seq；`user_prompt` 的
    /// promptId 已出现过时不入环、返回 None（调用方据此不再转发）。
    pub fn publish(&self, chat_id: &str, kind: &str, payload: &Value) -> Option<u64> {
        let now = now_millis();
        let mut logs = self.lock();
        let limits = self.limits;
        let log = logs
            .entry(chat_id.to_string())
            .or_insert_with(|| ChatLog::new(limits, now));
        if kind == USER_PROMPT_KIND {
            if let Some(prompt_id) = payload.get("promptId").and_then(Value::as_str) {
                if !log.remember_prompt(prompt_id) {
                    return None;
                }
            }
        }
        let event = log.ring.push(kind, payload.clone());
        log.updated_at = now;
        let mut became_closed = false;
        if kind == "state" {
            let finished = matches!(
                payload.get("phase").and_then(Value::as_str),
                Some("exited" | "failed")
            );
            became_closed = finished && !log.closed;
            log.closed = finished;
            log.last_state = Some(payload.clone());
        }
        let seq = event.seq;
        // 没有订阅者时 send 返回 Err，属正常情况。
        let _ = log.tx.send(event);
        if became_closed {
            prune_closed(&mut logs);
        }
        Some(seq)
    }

    /// 该 chat 是否已见过这个 promptId（幂等重试判定）。
    pub fn has_prompt(&self, chat_id: &str, prompt_id: &str) -> bool {
        self.lock()
            .get(chat_id)
            .is_some_and(|log| log.prompt_id_set.contains(prompt_id))
    }

    /// 先订阅实时、再读环（同一把锁），保证无缺口无重复。chat 无日志时 None。
    pub fn subscribe(&self, chat_id: &str, after_seq: u64) -> Option<Subscription> {
        let logs = self.lock();
        let log = logs.get(chat_id)?;
        Some(Subscription {
            receiver: log.tx.subscribe(),
            plan: log.ring.replay(after_seq),
            last_seq: log.ring.last_seq(),
            snapshot: log.last_state.clone(),
        })
    }

    /// Lagged 之后重读环：只给出续传计划，不新建接收端。
    pub fn replay(&self, chat_id: &str, after_seq: u64) -> Option<(ReplayPlan, Option<Value>)> {
        let logs = self.lock();
        let log = logs.get(chat_id)?;
        Some((log.ring.replay(after_seq), log.last_state.clone()))
    }

    pub fn info(&self, chat_id: &str) -> Option<ChatLogInfo> {
        self.lock().get(chat_id).map(|log| ChatLogInfo {
            last_seq: log.ring.last_seq(),
            updated_at: log.updated_at,
        })
    }
}

fn prune_closed(logs: &mut HashMap<String, ChatLog>) {
    let mut closed: Vec<(i64, String)> = logs
        .iter()
        .filter(|(_, log)| log.closed)
        .map(|(id, log)| (log.updated_at, id.clone()))
        .collect();
    if closed.len() <= MAX_CLOSED_LOGS {
        return;
    }
    closed.sort();
    let excess = closed.len() - MAX_CLOSED_LOGS;
    for (_, id) in closed.into_iter().take(excess) {
        logs.remove(&id);
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "event_log_tests.rs"]
mod tests;
