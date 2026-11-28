//! 保持唤醒的纯判定逻辑：多来源引用计数 + 释放防抖。不碰任何平台调用，可单测。

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// 最后一个会话转空闲后，再等这么久才释放。连续两轮之间的空档（跑构建、等下一条
/// 指令）不会让机器在队列中途睡过去。
pub const DEFAULT_RELEASE_GRACE: Duration = Duration::from_secs(60);

/// 拿锁失败后的重试间隔。没有 logind 的 Linux 之类的环境不会每轮都失败、刷日志。
pub const DEFAULT_RETRY_BACKOFF: Duration = Duration::from_secs(600);

/// 各活动来源当前的「在工作」数量。总数 > 0 即需要保持唤醒。
///
/// 来源各自整体上报自己的计数（如 daemon 的 PTY 会话、app 的 ACP 对话），
/// 互不覆盖：只更新本次上报到的来源。
#[derive(Debug, Default, Clone)]
pub struct ActivityTally {
    sources: BTreeMap<&'static str, usize>,
}

impl ActivityTally {
    pub fn set(&mut self, source: &'static str, busy: usize) {
        if busy == 0 {
            self.sources.remove(source);
        } else {
            self.sources.insert(source, busy);
        }
    }

    pub fn total(&self) -> usize {
        self.sources.values().sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepAwakeAction {
    None,
    Acquire,
    Release,
}

/// 何时拿锁、何时放锁的状态机。
#[derive(Debug, Clone)]
pub struct KeepAwakePolicy {
    grace: Duration,
    retry_backoff: Duration,
    held: bool,
    idle_since: Option<Instant>,
    retry_at: Option<Instant>,
}

impl Default for KeepAwakePolicy {
    fn default() -> Self {
        Self::new(DEFAULT_RELEASE_GRACE, DEFAULT_RETRY_BACKOFF)
    }
}

impl KeepAwakePolicy {
    pub fn new(grace: Duration, retry_backoff: Duration) -> Self {
        Self {
            grace,
            retry_backoff,
            held: false,
            idle_since: None,
            retry_at: None,
        }
    }

    pub fn held(&self) -> bool {
        self.held
    }

    /// 根据开关与在工作数量决定本轮动作。返回 Acquire 时策略已视为持锁，
    /// 调用方拿锁失败必须回调 [`Self::acquire_failed`]。
    pub fn evaluate(&mut self, enabled: bool, busy: usize, now: Instant) -> KeepAwakeAction {
        if !enabled {
            // 关掉开关立即释放；重新打开时立即重试，不等退避。
            self.idle_since = None;
            self.retry_at = None;
            return self.release();
        }
        if busy > 0 {
            self.idle_since = None;
            if self.held || self.retry_at.is_some_and(|at| now < at) {
                return KeepAwakeAction::None;
            }
            self.held = true;
            return KeepAwakeAction::Acquire;
        }
        if !self.held {
            self.idle_since = None;
            return KeepAwakeAction::None;
        }
        let since = *self.idle_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= self.grace {
            self.idle_since = None;
            return self.release();
        }
        KeepAwakeAction::None
    }

    pub fn acquire_succeeded(&mut self) {
        self.retry_at = None;
    }

    pub fn acquire_failed(&mut self, now: Instant) {
        self.held = false;
        self.retry_at = Some(now + self.retry_backoff);
    }

    fn release(&mut self) -> KeepAwakeAction {
        if std::mem::take(&mut self.held) {
            KeepAwakeAction::Release
        } else {
            KeepAwakeAction::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRACE: Duration = Duration::from_secs(60);
    const BACKOFF: Duration = Duration::from_secs(600);

    fn policy() -> KeepAwakePolicy {
        KeepAwakePolicy::new(GRACE, BACKOFF)
    }

    #[test]
    fn tally_sums_sources_independently() {
        let mut tally = ActivityTally::default();
        tally.set("pty", 2);
        tally.set("acp", 1);
        assert_eq!(tally.total(), 3);
        tally.set("pty", 0);
        assert_eq!(tally.total(), 1);
        tally.set("acp", 0);
        assert_eq!(tally.total(), 0);
    }

    #[test]
    fn acquires_once_while_busy() {
        let mut p = policy();
        let t0 = Instant::now();
        assert_eq!(p.evaluate(true, 1, t0), KeepAwakeAction::Acquire);
        assert_eq!(
            p.evaluate(true, 3, t0 + Duration::from_secs(5)),
            KeepAwakeAction::None
        );
        assert!(p.held());
    }

    #[test]
    fn idle_does_not_acquire() {
        let mut p = policy();
        assert_eq!(p.evaluate(true, 0, Instant::now()), KeepAwakeAction::None);
        assert!(!p.held());
    }

    #[test]
    fn releases_only_after_grace() {
        let mut p = policy();
        let t0 = Instant::now();
        p.evaluate(true, 1, t0);
        let idle = t0 + Duration::from_secs(10);
        assert_eq!(p.evaluate(true, 0, idle), KeepAwakeAction::None);
        assert_eq!(
            p.evaluate(true, 0, idle + Duration::from_secs(59)),
            KeepAwakeAction::None
        );
        assert_eq!(p.evaluate(true, 0, idle + GRACE), KeepAwakeAction::Release);
        assert!(!p.held());
        assert_eq!(p.evaluate(true, 0, idle + GRACE * 2), KeepAwakeAction::None);
    }

    #[test]
    fn busy_within_grace_keeps_same_hold_and_restarts_timer() {
        let mut p = policy();
        let t0 = Instant::now();
        p.evaluate(true, 1, t0);
        p.evaluate(true, 0, t0 + Duration::from_secs(1));
        assert_eq!(
            p.evaluate(true, 1, t0 + Duration::from_secs(50)),
            KeepAwakeAction::None
        );
        // 计时从第二次转空闲重新算
        let idle2 = t0 + Duration::from_secs(55);
        assert_eq!(p.evaluate(true, 0, idle2), KeepAwakeAction::None);
        assert_eq!(
            p.evaluate(true, 0, idle2 + Duration::from_secs(30)),
            KeepAwakeAction::None
        );
        assert_eq!(p.evaluate(true, 0, idle2 + GRACE), KeepAwakeAction::Release);
    }

    #[test]
    fn disabling_releases_immediately() {
        let mut p = policy();
        let t0 = Instant::now();
        p.evaluate(true, 2, t0);
        assert_eq!(p.evaluate(false, 2, t0), KeepAwakeAction::Release);
        assert_eq!(p.evaluate(false, 2, t0), KeepAwakeAction::None);
        assert_eq!(p.evaluate(true, 2, t0), KeepAwakeAction::Acquire);
    }

    #[test]
    fn failed_acquire_backs_off() {
        let mut p = policy();
        let t0 = Instant::now();
        assert_eq!(p.evaluate(true, 1, t0), KeepAwakeAction::Acquire);
        p.acquire_failed(t0);
        assert!(!p.held());
        assert_eq!(
            p.evaluate(true, 1, t0 + Duration::from_secs(5)),
            KeepAwakeAction::None
        );
        assert_eq!(p.evaluate(true, 1, t0 + BACKOFF), KeepAwakeAction::Acquire);
        p.acquire_succeeded();
        assert!(p.held());
    }

    #[test]
    fn re_enabling_clears_backoff() {
        let mut p = policy();
        let t0 = Instant::now();
        p.evaluate(true, 1, t0);
        p.acquire_failed(t0);
        p.evaluate(false, 1, t0);
        assert_eq!(
            p.evaluate(true, 1, t0 + Duration::from_secs(1)),
            KeepAwakeAction::Acquire
        );
    }
}
