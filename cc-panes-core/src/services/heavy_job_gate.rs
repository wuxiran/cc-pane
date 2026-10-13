//! 重负载门禁（docs/107 P6，W8 骨架）。
//!
//! 纯逻辑、无 I/O、无系统时钟：所有方法都显式接收 `now`，便于假时钟测试。
//! 持久化 / HTTP / 事件由 app 侧的 `heavy_job_routes` 负责，这里只回答"谁拿槽、谁排队"。
//!
//! 语义：
//! - **每会话一槽**：同一会话已持槽再来申请 → `Passthrough`，绝不让 agent 自己把自己锁死。
//! - **FIFO + priority**：`priority` 小者先；同优先级按入队时刻。前台会话由调用方给 0。
//! - **永不无限期阻塞**：等待超过 `timeout` → 强制放行（`Lease.forced = true`），记日志。
//! - **回收**：持槽方 60 s 无心跳视为已死（ctl 被 kill）；排队方 60 s 不再轮询同样出队。
//! - **授予是"挂起"的**：`release`/`reap` 腾出槽位时直接把队首转成租约放进 `pending`，
//!   该会话下一次 `acquire` 立刻 `Granted`；它若再不来，由心跳超时回收。
//!
//! `HeavyRunTarget` 是 P7（辅机卸载）的接缝：现在只有 `Local`，序列化带 `target` tag。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// 持槽方多久没心跳算死。ctl 每 20 s 心跳一次，三次丢失才回收。
pub const LEASE_SILENCE_TIMEOUT: Duration = Duration::from_secs(60);
/// 排队方多久没再轮询算放弃（ctl 被 kill / 终端关闭）。长轮询 ≤ 25 s，两轮不见即出队。
pub const WAITER_SILENCE_TIMEOUT: Duration = Duration::from_secs(60);

/// 重负载命令在哪跑。P7 会加 `Remote { machine }`；serde tag 固定为 `target`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "target", rename_all = "camelCase")]
pub enum HeavyRunTarget {
    #[default]
    Local,
}

impl HeavyRunTarget {
    /// 写进台账 `target` 列的值。
    pub fn as_str(self) -> &'static str {
        match self {
            HeavyRunTarget::Local => "local",
        }
    }
}

/// 门禁配置快照。每次 `acquire` 前由调用方从设置重读，切开关即时生效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateConfig {
    pub enabled: bool,
    /// 并发槽位数（≥ 1）。
    pub slots: u32,
    /// 排队超时：到点强制放行。
    pub timeout: Duration,
}

impl GateConfig {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            slots: 1,
            timeout: Duration::from_secs(300),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquireRequest {
    pub session_id: String,
    pub cmd_normalized: String,
    /// 小者优先；前台会话 0，其他 1。
    pub priority: u8,
}

/// 一张槽位租约。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub id: String,
    pub session_id: String,
    pub cmd_normalized: String,
    pub target: HeavyRunTarget,
    pub acquired_at: Instant,
    pub last_heartbeat: Instant,
    /// 排队超时强制放行（超出槽位数）。
    pub forced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquireOutcome {
    Granted(Lease),
    /// 1-based 位次 / 队列总长。
    Queued {
        position: u32,
        total: u32,
    },
    /// 不经门禁，直接跑（门禁关 / 已持槽）。
    Passthrough(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Waiter {
    session_id: String,
    cmd_normalized: String,
    priority: u8,
    enqueued_at: Instant,
    last_seen: Instant,
}

/// `reap` 的结果，调用方据此发事件 / 记日志。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReapReport {
    /// 心跳静默被回收的租约。
    pub dropped_leases: Vec<Lease>,
    /// 不再轮询被出队的会话。
    pub dropped_waiters: Vec<String>,
    /// 等待超时被强制放行的会话（租约已挂起等它来取）。
    pub forced: Vec<String>,
}

/// 对外快照（`GET /api/heavy-jobs`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GateSnapshot {
    pub enabled: bool,
    pub slots: u32,
    pub timeout_secs: u64,
    pub held: Vec<HeldSnapshot>,
    pub queue: Vec<QueuedSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeldSnapshot {
    pub lease_id: String,
    pub session_id: String,
    pub cmd_normalized: String,
    #[serde(flatten)]
    pub target: HeavyRunTarget,
    pub held_ms: u64,
    pub forced: bool,
    /// 租约已授予但会话尚未来取（下一次轮询即到手）。
    pub pending_pickup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSnapshot {
    pub session_id: String,
    pub cmd_normalized: String,
    pub position: u32,
    pub priority: u8,
    pub waited_ms: u64,
}

/// 某会话当前的排队位次；`None` = 不在队里。
pub type QueuePositions = HashMap<String, (u32, u32)>;

#[derive(Debug)]
pub struct HeavyJobGate {
    config: GateConfig,
    held: Vec<Lease>,
    /// 已授予、等会话来取的租约（也计入 `held`，这里只是索引）。
    pending: HashMap<String, String>,
    queue: VecDeque<Waiter>,
    next_lease_seq: u64,
}

impl HeavyJobGate {
    pub fn new(config: GateConfig) -> Self {
        Self {
            config,
            held: Vec::new(),
            pending: HashMap::new(),
            queue: VecDeque::new(),
            next_lease_seq: 1,
        }
    }

    pub fn config(&self) -> GateConfig {
        self.config
    }

    /// 更新配置。槽位调小不收回已发租约；调大则由下一次 `acquire`/`release` 自然放人。
    pub fn configure(&mut self, config: GateConfig) {
        self.config = GateConfig {
            slots: config.slots.max(1),
            ..config
        };
    }

    pub fn acquire(&mut self, now: Instant, request: AcquireRequest) -> AcquireOutcome {
        if !self.config.enabled {
            return AcquireOutcome::Passthrough("gate disabled".to_string());
        }
        // 已挂起的授予：来取。
        if let Some(lease_id) = self.pending.remove(&request.session_id) {
            if let Some(lease) = self.held.iter_mut().find(|lease| lease.id == lease_id) {
                lease.last_heartbeat = now;
                return AcquireOutcome::Granted(lease.clone());
            }
        }
        if self
            .held
            .iter()
            .any(|lease| lease.session_id == request.session_id)
        {
            return AcquireOutcome::Passthrough("session already holds a slot".to_string());
        }

        // 入队或刷新。
        match self
            .queue
            .iter_mut()
            .find(|waiter| waiter.session_id == request.session_id)
        {
            Some(waiter) => {
                waiter.last_seen = now;
                waiter.cmd_normalized = request.cmd_normalized.clone();
                waiter.priority = request.priority;
            }
            None => self.queue.push_back(Waiter {
                session_id: request.session_id.clone(),
                cmd_normalized: request.cmd_normalized.clone(),
                priority: request.priority,
                enqueued_at: now,
                last_seen: now,
            }),
        }
        self.sort_queue();
        self.promote(now);

        // 自己被放出来了？
        if let Some(lease_id) = self.pending.remove(&request.session_id) {
            if let Some(lease) = self.held.iter().find(|lease| lease.id == lease_id) {
                return AcquireOutcome::Granted(lease.clone());
            }
        }
        // 等待超时 → 强制放行（超出槽位）。
        let timed_out = self
            .queue
            .iter()
            .find(|waiter| waiter.session_id == request.session_id)
            .is_some_and(|waiter| now.duration_since(waiter.enqueued_at) >= self.config.timeout);
        if timed_out {
            let waiter = self
                .remove_waiter(&request.session_id)
                .expect("waiter exists");
            let lease = self.grant(now, waiter, true);
            return AcquireOutcome::Granted(lease);
        }

        let position = self
            .queue
            .iter()
            .position(|waiter| waiter.session_id == request.session_id)
            .map(|index| index as u32 + 1)
            .unwrap_or(0);
        AcquireOutcome::Queued {
            position,
            total: self.queue.len() as u32,
        }
    }

    /// 归还租约。返回被归还的租约（不存在 → None，幂等）。腾出的槽位立刻挂起授予给队首。
    pub fn release(&mut self, now: Instant, lease_id: &str) -> Option<Lease> {
        let index = self.held.iter().position(|lease| lease.id == lease_id)?;
        let lease = self.held.remove(index);
        self.pending.retain(|_, id| id != lease_id);
        self.promote(now);
        Some(lease)
    }

    /// 心跳。未知租约 → false（ctl 应视为已被回收，继续跑但不再心跳）。
    pub fn heartbeat(&mut self, now: Instant, lease_id: &str) -> bool {
        match self.held.iter_mut().find(|lease| lease.id == lease_id) {
            Some(lease) => {
                lease.last_heartbeat = now;
                true
            }
            None => false,
        }
    }

    /// 回收：静默租约、失联等待者、超时等待者（强制放行并挂起）。
    pub fn reap(&mut self, now: Instant) -> ReapReport {
        let mut report = ReapReport::default();

        let (alive, dead): (Vec<Lease>, Vec<Lease>) = self
            .held
            .drain(..)
            .partition(|lease| now.duration_since(lease.last_heartbeat) < LEASE_SILENCE_TIMEOUT);
        self.held = alive;
        for lease in dead {
            self.pending.retain(|_, id| *id != lease.id);
            report.dropped_leases.push(lease);
        }

        let silent: Vec<String> = self
            .queue
            .iter()
            .filter(|waiter| now.duration_since(waiter.last_seen) >= WAITER_SILENCE_TIMEOUT)
            .map(|waiter| waiter.session_id.clone())
            .collect();
        for session_id in &silent {
            self.remove_waiter(session_id);
        }
        report.dropped_waiters = silent;

        let timed_out: Vec<String> = self
            .queue
            .iter()
            .filter(|waiter| now.duration_since(waiter.enqueued_at) >= self.config.timeout)
            .map(|waiter| waiter.session_id.clone())
            .collect();
        for session_id in &timed_out {
            if let Some(waiter) = self.remove_waiter(session_id) {
                let lease = self.grant(now, waiter, true);
                self.pending.insert(session_id.clone(), lease.id);
            }
        }
        report.forced = timed_out;

        self.promote(now);
        report
    }

    pub fn snapshot(&self, now: Instant) -> GateSnapshot {
        GateSnapshot {
            enabled: self.config.enabled,
            slots: self.config.slots,
            timeout_secs: self.config.timeout.as_secs(),
            held: self
                .held
                .iter()
                .map(|lease| HeldSnapshot {
                    lease_id: lease.id.clone(),
                    session_id: lease.session_id.clone(),
                    cmd_normalized: lease.cmd_normalized.clone(),
                    target: lease.target,
                    held_ms: now.duration_since(lease.acquired_at).as_millis() as u64,
                    forced: lease.forced,
                    pending_pickup: self.pending.contains_key(&lease.session_id),
                })
                .collect(),
            queue: self
                .queue
                .iter()
                .enumerate()
                .map(|(index, waiter)| QueuedSnapshot {
                    session_id: waiter.session_id.clone(),
                    cmd_normalized: waiter.cmd_normalized.clone(),
                    position: index as u32 + 1,
                    priority: waiter.priority,
                    waited_ms: now.duration_since(waiter.enqueued_at).as_millis() as u64,
                })
                .collect(),
        }
    }

    /// 每个排队会话的 (position, total)，供调用方 diff 后发"排队 n/m"事件。
    pub fn queue_positions(&self) -> QueuePositions {
        let total = self.queue.len() as u32;
        self.queue
            .iter()
            .enumerate()
            .map(|(index, waiter)| (waiter.session_id.clone(), (index as u32 + 1, total)))
            .collect()
    }

    pub fn held_leases(&self) -> &[Lease] {
        &self.held
    }

    fn sort_queue(&mut self) {
        // VecDeque 没有稳定排序；队列很短，转一下即可。
        let mut waiters: Vec<Waiter> = self.queue.drain(..).collect();
        waiters.sort_by(|left, right| {
            left.priority
                .cmp(&right.priority)
                .then(left.enqueued_at.cmp(&right.enqueued_at))
        });
        self.queue = waiters.into();
    }

    /// 有空槽就把队首转成挂起租约。
    fn promote(&mut self, now: Instant) {
        while (self.held.len() as u32) < self.config.slots {
            let Some(waiter) = self.queue.pop_front() else {
                break;
            };
            let session_id = waiter.session_id.clone();
            let lease = self.grant(now, waiter, false);
            self.pending.insert(session_id, lease.id);
        }
    }

    fn grant(&mut self, now: Instant, waiter: Waiter, forced: bool) -> Lease {
        let lease = Lease {
            id: format!("lease-{}", self.next_lease_seq),
            session_id: waiter.session_id,
            cmd_normalized: waiter.cmd_normalized,
            target: HeavyRunTarget::Local,
            acquired_at: now,
            last_heartbeat: now,
            forced,
        };
        self.next_lease_seq += 1;
        self.held.push(lease.clone());
        lease
    }

    fn remove_waiter(&mut self, session_id: &str) -> Option<Waiter> {
        let index = self
            .queue
            .iter()
            .position(|waiter| waiter.session_id == session_id)?;
        self.queue.remove(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(slots: u32, timeout_secs: u64) -> GateConfig {
        GateConfig {
            enabled: true,
            slots,
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    fn request(session: &str) -> AcquireRequest {
        AcquireRequest {
            session_id: session.to_string(),
            cmd_normalized: "cargo build".to_string(),
            priority: 1,
        }
    }

    fn granted(outcome: AcquireOutcome) -> Lease {
        match outcome {
            AcquireOutcome::Granted(lease) => lease,
            other => panic!("expected Granted, got {other:?}"),
        }
    }

    #[test]
    fn disabled_gate_passes_through_without_touching_state() {
        let mut gate = HeavyJobGate::new(GateConfig::disabled());
        let now = Instant::now();
        assert_eq!(
            gate.acquire(now, request("a")),
            AcquireOutcome::Passthrough("gate disabled".to_string())
        );
        let snapshot = gate.snapshot(now);
        assert!(snapshot.held.is_empty() && snapshot.queue.is_empty());
    }

    #[test]
    fn grants_up_to_slots_then_queues_with_positions() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        let lease = granted(gate.acquire(now, request("a")));
        assert_eq!(lease.target, HeavyRunTarget::Local);
        assert!(!lease.forced);

        assert_eq!(
            gate.acquire(now, request("b")),
            AcquireOutcome::Queued {
                position: 1,
                total: 1
            }
        );
        assert_eq!(
            gate.acquire(now + Duration::from_secs(1), request("c")),
            AcquireOutcome::Queued {
                position: 2,
                total: 2
            }
        );
        // 再轮询不重复入队
        assert_eq!(
            gate.acquire(now + Duration::from_secs(2), request("b")),
            AcquireOutcome::Queued {
                position: 1,
                total: 2
            }
        );
        assert_eq!(gate.queue_positions().get("c"), Some(&(2, 2)));
    }

    #[test]
    fn one_lease_per_session_second_request_passes_through() {
        let mut gate = HeavyJobGate::new(config(4, 300));
        let now = Instant::now();
        granted(gate.acquire(now, request("a")));
        assert!(matches!(
            gate.acquire(now, request("a")),
            AcquireOutcome::Passthrough(_)
        ));
        assert_eq!(gate.held_leases().len(), 1);
    }

    #[test]
    fn release_hands_slot_to_head_of_queue_fifo() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        let lease = granted(gate.acquire(now, request("a")));
        gate.acquire(now + Duration::from_millis(10), request("b"));
        gate.acquire(now + Duration::from_millis(20), request("c"));

        assert!(gate
            .release(now + Duration::from_secs(5), &lease.id)
            .is_some());
        // 幂等
        assert!(gate
            .release(now + Duration::from_secs(5), &lease.id)
            .is_none());
        // b 已挂起授予；c 仍排第一（队列总长 1）
        assert_eq!(gate.queue_positions().get("c"), Some(&(1, 1)));
        assert!(gate.snapshot(now).held[0].pending_pickup);
        let lease_b = granted(gate.acquire(now + Duration::from_secs(6), request("b")));
        assert_eq!(lease_b.session_id, "b");
        assert_eq!(
            gate.acquire(now + Duration::from_secs(6), request("c")),
            AcquireOutcome::Queued {
                position: 1,
                total: 1
            }
        );
    }

    #[test]
    fn priority_zero_jumps_queue_but_not_held_slots() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        let lease = granted(gate.acquire(now, request("a")));
        gate.acquire(now + Duration::from_millis(10), request("b"));
        let mut foreground = request("fg");
        foreground.priority = 0;
        assert_eq!(
            gate.acquire(now + Duration::from_millis(20), foreground),
            AcquireOutcome::Queued {
                position: 1,
                total: 2
            }
        );
        assert_eq!(gate.queue_positions().get("b"), Some(&(2, 2)));
        gate.release(now + Duration::from_secs(1), &lease.id);
        let next = granted(gate.acquire(now + Duration::from_secs(1), request("fg")));
        assert_eq!(next.session_id, "fg");
    }

    #[test]
    fn waiter_past_timeout_is_force_granted_on_poll_and_on_reap() {
        let mut gate = HeavyJobGate::new(config(1, 10));
        let now = Instant::now();
        granted(gate.acquire(now, request("a")));
        gate.acquire(now, request("b"));
        gate.acquire(now, request("c"));

        // 轮询路径
        let lease_b = granted(gate.acquire(now + Duration::from_secs(10), request("b")));
        assert!(lease_b.forced);
        assert_eq!(gate.held_leases().len(), 2);

        // reap 路径：c 超时 → 挂起，下一次轮询即到手
        let report = gate.reap(now + Duration::from_secs(11));
        assert_eq!(report.forced, vec!["c".to_string()]);
        let lease_c = granted(gate.acquire(now + Duration::from_secs(11), request("c")));
        assert!(lease_c.forced);
        assert!(gate.queue_positions().is_empty());
    }

    #[test]
    fn reap_drops_silent_leases_and_silent_waiters() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        let lease = granted(gate.acquire(now, request("a")));
        gate.acquire(now, request("b"));
        gate.acquire(now + Duration::from_secs(30), request("c"));

        // a 心跳到 30 s；b 之后不再轮询；c 在 30 s 还活着
        assert!(gate.heartbeat(now + Duration::from_secs(30), &lease.id));
        let report = gate.reap(now + Duration::from_secs(61));
        // b 失联出队；a 的最后心跳在 30 s，61 s 时静默 31 s < 60 s，仍持有
        assert_eq!(report.dropped_waiters, vec!["b".to_string()]);
        assert!(report.dropped_leases.is_empty());
        assert_eq!(gate.queue_positions().get("c"), Some(&(1, 1)));
        // c 继续轮询，保持在队
        gate.acquire(now + Duration::from_secs(61), request("c"));

        let report = gate.reap(now + Duration::from_secs(91));
        assert_eq!(report.dropped_leases.len(), 1);
        assert_eq!(report.dropped_leases[0].id, lease.id);
        // 槽位腾出 → c 挂起授予
        assert!(gate.queue_positions().is_empty());
        assert_eq!(gate.snapshot(now).held.len(), 1);
        assert!(!gate.heartbeat(now + Duration::from_secs(92), &lease.id));
    }

    #[test]
    fn toggling_config_live_changes_next_acquire() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        granted(gate.acquire(now, request("a")));
        assert!(matches!(
            gate.acquire(now, request("b")),
            AcquireOutcome::Queued { .. }
        ));
        gate.configure(config(2, 300));
        assert!(matches!(
            gate.acquire(now, request("b")),
            AcquireOutcome::Granted(_)
        ));
        gate.configure(GateConfig::disabled());
        assert_eq!(
            gate.acquire(now, request("c")),
            AcquireOutcome::Passthrough("gate disabled".to_string())
        );
    }

    #[test]
    fn snapshot_serializes_target_tag_and_positions() {
        let mut gate = HeavyJobGate::new(config(1, 300));
        let now = Instant::now();
        granted(gate.acquire(now, request("a")));
        gate.acquire(now, request("b"));
        let json = serde_json::to_value(gate.snapshot(now + Duration::from_millis(5))).unwrap();
        assert_eq!(json["held"][0]["target"], "local");
        assert_eq!(json["held"][0]["sessionId"], "a");
        assert_eq!(json["queue"][0]["position"], 1);
        assert_eq!(json["slots"], 1);
        assert_eq!(
            serde_json::to_value(HeavyRunTarget::Local).unwrap(),
            serde_json::json!({ "target": "local" })
        );
    }
}
