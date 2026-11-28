//! 防环（docs/112 §5.4）：`hops` 上限 + 「同一 traceId 回到已经过的 Bot 即拒绝」。
//!
//! 已见集合按节点存（Bot id 只在本机唯一）：发起方在本机记下 (trace, 发起 Bot)，
//! 接收方在投递前记下 (trace, 目标 Bot)。有界（条数 + TTL），不随时间无限增长。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::utils::{AppError, AppResult};

/// 一条消息最多被 Bot 转手几次（人 → Bot = 0，Bot → Bot 每次 +1）。
pub const MAX_HOPS: u32 = 3;
const SEEN_CAPACITY: usize = 4096;
const SEEN_TTL: Duration = Duration::from_secs(60 * 60);

pub fn new_trace_id() -> String {
    format!("tr-{}", uuid::Uuid::new_v4())
}

/// traceId 只收可打印的短 ASCII（进日志 / 进事件载荷）。
pub fn valid_trace_id(trace_id: &str) -> bool {
    !trace_id.is_empty()
        && trace_id.len() <= 80
        && trace_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

pub fn check_hops(hops: u32) -> AppResult<()> {
    if hops > MAX_HOPS {
        return Err(AppError::coded(
            "MESH_HOPS_EXCEEDED",
            format!("Message was forwarded too many times ({hops} > {MAX_HOPS})"),
        ));
    }
    Ok(())
}

#[derive(Default)]
pub struct TraceGuard {
    inner: Mutex<Seen>,
}

#[derive(Default)]
struct Seen {
    order: VecDeque<(String, Instant)>,
    keys: HashMap<String, Instant>,
}

fn key(trace_id: &str, bot_id: &str) -> String {
    format!("{trace_id}\u{1f}{bot_id}")
}

impl Seen {
    fn prune(&mut self, now: Instant) {
        while let Some((front, at)) = self.order.front() {
            let expired = now.duration_since(*at) > SEEN_TTL;
            if !expired && self.order.len() < SEEN_CAPACITY {
                break;
            }
            if self.keys.get(front) == Some(at) {
                self.keys.remove(front);
            }
            self.order.pop_front();
        }
    }
}

impl TraceGuard {
    /// 记下 (trace, bot)；已经见过 → `MESH_LOOP_DETECTED`。
    pub fn enter(&self, trace_id: &str, bot_id: &str) -> AppResult<()> {
        let now = Instant::now();
        let mut seen = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        seen.prune(now);
        let key = key(trace_id, bot_id);
        if seen.keys.contains_key(&key) {
            return Err(AppError::coded(
                "MESH_LOOP_DETECTED",
                "This conversation already passed through this bot (traceId seen)",
            ));
        }
        seen.keys.insert(key.clone(), now);
        seen.order.push_back((key, now));
        Ok(())
    }

    /// 发起方标记自己（不报错：同一 Bot 在一条 trace 里可以连发多条）。
    pub fn mark(&self, trace_id: &str, bot_id: &str) {
        let _ = self.enter(trace_id, bot_id);
    }

    /// 投递在受理前就失败时撤销（例如目标 Bot 不存在），不让一次失败锁死这条 trace。
    pub fn forget(&self, trace_id: &str, bot_id: &str) {
        let mut seen = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        seen.keys.remove(&key(trace_id, bot_id));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hops_limit() {
        assert!(check_hops(0).is_ok());
        assert!(check_hops(MAX_HOPS).is_ok());
        assert_eq!(
            check_hops(MAX_HOPS + 1).unwrap_err().code(),
            Some("MESH_HOPS_EXCEEDED")
        );
    }

    #[test]
    fn same_trace_same_bot_is_a_loop() {
        let guard = TraceGuard::default();
        guard.enter("t1", "a").unwrap();
        guard.enter("t1", "b").unwrap();
        guard.enter("t2", "a").unwrap();
        assert_eq!(
            guard.enter("t1", "a").unwrap_err().code(),
            Some("MESH_LOOP_DETECTED")
        );
        guard.forget("t1", "a");
        guard.enter("t1", "a").unwrap();
        guard.mark("t1", "a");
    }

    #[test]
    fn capacity_is_bounded() {
        let guard = TraceGuard::default();
        for i in 0..(SEEN_CAPACITY + 50) {
            guard.enter(&format!("t{i}"), "a").unwrap();
        }
        assert!(guard.len() <= SEEN_CAPACITY);
    }

    #[test]
    fn trace_id_validation() {
        assert!(valid_trace_id(&new_trace_id()));
        assert!(!valid_trace_id(""));
        assert!(!valid_trace_id("a b"));
        assert!(!valid_trace_id(&"x".repeat(81)));
    }
}
