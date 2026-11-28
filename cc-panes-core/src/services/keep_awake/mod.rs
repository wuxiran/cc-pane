//! KeepAwakeService —— agent 在工作时阻止系统空闲休眠。
//!
//! 「在工作」完全复用现有活动源：PTY 会话的 `SessionStatus::is_busy()`（hook / OSC /
//! ANSI 推断共同维护）、ACP 对话的 `Generating` 阶段。各进程把自己看得见的那份
//! 计数周期性上报给本服务，本服务按来源做引用计数，总数 > 0 时持锁，全部空闲
//! 满 [`DEFAULT_RELEASE_GRACE`] 后释放。
//!
//! 进程归属：PTY 会话的判定跑在 daemon 里（关掉桌面窗口后会话仍在 daemon 跑），
//! ACP 对话与非 daemon 模式的会话跑在 app 进程里，各自持各自的锁，系统层面叠加。

mod inhibitor;
mod policy;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::services::terminal_service::SessionStatusInfo;

pub use inhibitor::{system_inhibitor, InhibitorHold, SleepInhibitor};
pub use policy::{
    ActivityTally, KeepAwakeAction, KeepAwakePolicy, DEFAULT_RELEASE_GRACE, DEFAULT_RETRY_BACKOFF,
};

/// 轮询活动源的间隔。拿锁延迟最多这么久，远小于任何系统的空闲休眠时间。
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);

const HOLD_REASON: &str = "CC-Panes: agents are working";

/// PTY 会话中「在工作」的数量（复用 `SessionStatus::is_busy()`，与前端绿色家族同口径）。
pub fn busy_session_count(sessions: &[SessionStatusInfo]) -> usize {
    sessions
        .iter()
        .filter(|session| session.status.is_busy())
        .count()
}

/// 一次采样：开关状态 + 本进程各来源的在工作数量。
#[derive(Debug, Clone, Default)]
pub struct KeepAwakeSample {
    pub enabled: bool,
    pub sources: Vec<(&'static str, usize)>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    pub enabled: bool,
    /// 当前是否真的持有系统锁。
    pub holding: bool,
    pub busy_count: usize,
}

struct Inner {
    policy: KeepAwakePolicy,
    tally: ActivityTally,
    enabled: bool,
    hold: Option<Box<dyn InhibitorHold>>,
}

pub struct KeepAwakeService {
    inhibitor: Arc<dyn SleepInhibitor>,
    inner: Mutex<Inner>,
}

impl KeepAwakeService {
    pub fn new(inhibitor: Arc<dyn SleepInhibitor>) -> Self {
        Self::with_policy(inhibitor, KeepAwakePolicy::default())
    }

    pub fn with_policy(inhibitor: Arc<dyn SleepInhibitor>, policy: KeepAwakePolicy) -> Self {
        Self {
            inhibitor,
            inner: Mutex::new(Inner {
                policy,
                tally: ActivityTally::default(),
                enabled: false,
                hold: None,
            }),
        }
    }

    /// 记下一次采样并据此拿锁 / 放锁，返回本轮动作。
    pub fn apply(&self, sample: &KeepAwakeSample, now: Instant) -> KeepAwakeAction {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.enabled = sample.enabled;
        for (source, busy) in &sample.sources {
            inner.tally.set(source, *busy);
        }
        let busy = inner.tally.total();
        let action = inner.policy.evaluate(sample.enabled, busy, now);
        match action {
            KeepAwakeAction::Acquire => match self.inhibitor.acquire(HOLD_REASON) {
                Ok(hold) => {
                    inner.hold = Some(hold);
                    inner.policy.acquire_succeeded();
                    info!(busy, "keep-awake: agents working; preventing idle sleep");
                }
                Err(error) => {
                    inner.policy.acquire_failed(now);
                    warn!(error = %error, "keep-awake: failed to prevent idle sleep; will retry later");
                }
            },
            KeepAwakeAction::Release => {
                inner.hold = None;
                info!(
                    enabled = sample.enabled,
                    "keep-awake: agents idle; system may sleep again"
                );
            }
            KeepAwakeAction::None => {}
        }
        action
    }

    pub fn status(&self) -> KeepAwakeStatus {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        KeepAwakeStatus {
            enabled: inner.enabled,
            holding: inner.hold.is_some(),
            busy_count: inner.tally.total(),
        }
    }

    /// 起一条后台线程，按 `interval` 调用 `sampler` 并应用结果。
    /// `sampler` 返回 None 表示本轮取数失败，跳过（保持现状）。
    pub fn spawn_poller<F>(self: &Arc<Self>, thread_name: &str, interval: Duration, mut sampler: F)
    where
        F: FnMut() -> Option<KeepAwakeSample> + Send + 'static,
    {
        let service = Arc::clone(self);
        crate::pty::thread::spawn_optional(thread_name, move || loop {
            // 先睡后采：启动期不和其他初始化抢资源，首轮最多晚一个间隔。
            std::thread::sleep(interval);
            if let Some(sample) = sampler() {
                service.apply(&sample, Instant::now());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::terminal_service::SessionStatus;
    use crate::utils::{AppError, AppResult};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeInhibitor {
        acquired: AtomicUsize,
        live: Arc<AtomicUsize>,
        fail: AtomicBool,
    }

    struct FakeHold(Arc<AtomicUsize>);
    impl InhibitorHold for FakeHold {}
    impl Drop for FakeHold {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl SleepInhibitor for FakeInhibitor {
        fn acquire(&self, _reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(AppError::from("no inhibitor"));
            }
            self.acquired.fetch_add(1, Ordering::SeqCst);
            self.live.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeHold(self.live.clone())))
        }
    }

    fn sample(enabled: bool, sources: &[(&'static str, usize)]) -> KeepAwakeSample {
        KeepAwakeSample {
            enabled,
            sources: sources.to_vec(),
        }
    }

    fn service(fake: &Arc<FakeInhibitor>) -> KeepAwakeService {
        KeepAwakeService::with_policy(
            fake.clone(),
            KeepAwakePolicy::new(Duration::from_secs(60), Duration::from_secs(600)),
        )
    }

    #[test]
    fn holds_while_any_source_busy_and_releases_after_grace() {
        let fake = Arc::new(FakeInhibitor::default());
        let svc = service(&fake);
        let t0 = Instant::now();
        svc.apply(&sample(true, &[("pty", 1)]), t0);
        svc.apply(&sample(true, &[("acp", 1)]), t0);
        assert_eq!(fake.acquired.load(Ordering::SeqCst), 1);
        assert_eq!(svc.status().busy_count, 2);

        // pty 空闲，acp 仍在跑：不放
        svc.apply(&sample(true, &[("pty", 0)]), t0 + Duration::from_secs(120));
        assert!(svc.status().holding);

        svc.apply(&sample(true, &[("acp", 0)]), t0 + Duration::from_secs(130));
        assert!(svc.status().holding);
        svc.apply(&sample(true, &[]), t0 + Duration::from_secs(190));
        assert!(!svc.status().holding);
        assert_eq!(fake.live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn disabled_never_holds() {
        let fake = Arc::new(FakeInhibitor::default());
        let svc = service(&fake);
        svc.apply(&sample(false, &[("pty", 3)]), Instant::now());
        assert_eq!(fake.acquired.load(Ordering::SeqCst), 0);
        let status = svc.status();
        assert!(!status.enabled && !status.holding);
    }

    #[test]
    fn acquire_failure_is_not_fatal_and_backs_off() {
        let fake = Arc::new(FakeInhibitor::default());
        fake.fail.store(true, Ordering::SeqCst);
        let svc = service(&fake);
        let t0 = Instant::now();
        assert_eq!(
            svc.apply(&sample(true, &[("pty", 1)]), t0),
            KeepAwakeAction::Acquire
        );
        assert!(!svc.status().holding);
        fake.fail.store(false, Ordering::SeqCst);
        assert_eq!(
            svc.apply(&sample(true, &[("pty", 1)]), t0 + Duration::from_secs(5)),
            KeepAwakeAction::None
        );
        svc.apply(&sample(true, &[("pty", 1)]), t0 + Duration::from_secs(600));
        assert!(svc.status().holding);
    }

    fn info(id: &str, status: SessionStatus) -> SessionStatusInfo {
        let mut value: SessionStatusInfo = serde_json::from_value(serde_json::json!({
            "sessionId": id,
            "status": "idle",
            "lastOutputAt": 0,
            "updatedAt": 0,
        }))
        .expect("session status info");
        value.status = status;
        value
    }

    #[test]
    fn counts_only_busy_sessions() {
        let sessions = vec![
            info("a", SessionStatus::Thinking),
            info("b", SessionStatus::ToolRunning),
            info("c", SessionStatus::Idle),
            info("d", SessionStatus::WaitingInput),
            info("e", SessionStatus::Exited),
            info("f", SessionStatus::Compacting),
            info("g", SessionStatus::Initializing),
        ];
        assert_eq!(busy_session_count(&sessions), 3);
    }

    #[test]
    fn status_serializes_camel_case() {
        let json = serde_json::to_value(KeepAwakeStatus {
            enabled: true,
            holding: false,
            busy_count: 2,
        })
        .unwrap();
        assert_eq!(json["busyCount"], 2);
    }
}
