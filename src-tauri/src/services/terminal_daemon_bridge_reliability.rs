use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::debug;

pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(1);
pub(super) const WEBSOCKET_STATUS_INTERVAL: Duration = Duration::from_secs(5);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(5);
// daemon HTTP client uses `Connection: close`; one snapshot per tick plus one status per five
// ticks caps fallback churn at 1.2 short TCP connections per second per session.
const POLL_STATUS_EVERY_TICKS: usize = 5;

pub(super) fn skip_missed_interval(period: Duration) -> tokio::time::Interval {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}

#[derive(Clone, Copy)]
pub(super) struct ConnectRetryPolicy {
    pub(super) max_attempts: usize,
    connect_timeout: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    pub(super) max_concurrent: usize,
}

impl Default for ConnectRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            connect_timeout: Duration::from_secs(3),
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(1),
            max_concurrent: 4,
        }
    }
}

impl ConnectRetryPolicy {
    fn backoff_after_failure(self, failure_number: usize) -> Duration {
        let exponent = failure_number.saturating_sub(1).min(31) as u32;
        self.initial_backoff
            .saturating_mul(1_u32 << exponent)
            .min(self.max_backoff)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BridgeConnectStats {
    pub(super) connect_attempts: u64,
    pub(super) connect_failures: u64,
    pub(super) active_connects: usize,
    pub(super) max_concurrent_connects: usize,
}

#[derive(Default)]
struct BridgeConnectCounters {
    connect_attempts: AtomicU64,
    connect_failures: AtomicU64,
    active_connects: AtomicUsize,
    max_concurrent_connects: AtomicUsize,
    fallbacks: AtomicU64,
}

#[derive(Clone)]
pub(super) struct BridgeTelemetry {
    connect_limit: Arc<Semaphore>,
    counters: Arc<BridgeConnectCounters>,
}

impl BridgeTelemetry {
    pub(super) fn new(max_concurrent: usize) -> Self {
        assert!(
            max_concurrent > 0,
            "websocket connect limit must be positive"
        );
        Self {
            connect_limit: Arc::new(Semaphore::new(max_concurrent)),
            counters: Arc::new(BridgeConnectCounters::default()),
        }
    }

    async fn begin_connect(&self) -> anyhow::Result<ActiveConnectGuard> {
        let permit = self
            .connect_limit
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow::anyhow!("websocket connect limiter closed"))?;
        self.counters
            .connect_attempts
            .fetch_add(1, Ordering::Relaxed);
        let active = self.counters.active_connects.fetch_add(1, Ordering::SeqCst) + 1;
        self.counters
            .max_concurrent_connects
            .fetch_max(active, Ordering::SeqCst);
        Ok(ActiveConnectGuard {
            _permit: permit,
            counters: self.counters.clone(),
        })
    }

    fn record_connect_failure(&self) {
        self.counters
            .connect_failures
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn record_fallback(&self) {
        self.counters.fallbacks.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn fallbacks(&self) -> u64 {
        self.counters.fallbacks.load(Ordering::Relaxed)
    }

    pub(super) fn stats(&self) -> BridgeConnectStats {
        BridgeConnectStats {
            connect_attempts: self.counters.connect_attempts.load(Ordering::Relaxed),
            connect_failures: self.counters.connect_failures.load(Ordering::Relaxed),
            active_connects: self.counters.active_connects.load(Ordering::SeqCst),
            max_concurrent_connects: self.counters.max_concurrent_connects.load(Ordering::SeqCst),
        }
    }

    pub(super) fn bridge_stats<I>(&self, modes: I) -> BridgeStats
    where
        I: IntoIterator<Item = BridgeMode>,
    {
        let mut stats = BridgeStats {
            tracked_sessions: 0,
            connecting_sessions: 0,
            websocket_sessions: 0,
            polling_sessions: 0,
            connect_attempts: 0,
            connect_failures: 0,
            fallbacks: self.fallbacks(),
            active_connects: 0,
            max_concurrent_connects: 0,
        };
        for mode in modes {
            stats.tracked_sessions += 1;
            match mode {
                BridgeMode::Connecting => stats.connecting_sessions += 1,
                BridgeMode::Websocket => stats.websocket_sessions += 1,
                BridgeMode::Polling => stats.polling_sessions += 1,
            }
        }
        let connect = self.stats();
        stats.connect_attempts = connect.connect_attempts;
        stats.connect_failures = connect.connect_failures;
        stats.active_connects = connect.active_connects;
        stats.max_concurrent_connects = connect.max_concurrent_connects;
        stats
    }
}

struct ActiveConnectGuard {
    _permit: OwnedSemaphorePermit,
    counters: Arc<BridgeConnectCounters>,
}

impl Drop for ActiveConnectGuard {
    fn drop(&mut self) {
        self.counters.active_connects.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(super) async fn connect_with_retry<T, F, Fut>(
    policy: ConnectRetryPolicy,
    telemetry: BridgeTelemetry,
    mut connect: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    if policy.max_attempts == 0 {
        anyhow::bail!("websocket connect attempts must be positive");
    }

    let mut last_error = None;
    for attempt in 1..=policy.max_attempts {
        let active_connect = telemetry.begin_connect().await?;
        let result = tokio::time::timeout(policy.connect_timeout, connect())
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "websocket connect timed out after {} ms",
                    policy.connect_timeout.as_millis()
                )
            })
            .and_then(|result| result);
        drop(active_connect);

        match result {
            Ok(connected) => return Ok(connected),
            Err(error) => {
                telemetry.record_connect_failure();
                debug!(
                    attempt,
                    max_attempts = policy.max_attempts,
                    error = %error,
                    "terminal daemon websocket connect attempt failed"
                );
                last_error = Some(error);
            }
        }

        if attempt < policy.max_attempts {
            tokio::time::sleep(policy.backoff_after_failure(attempt)).await;
        }
    }

    Err(last_error.expect("positive retry count always records an error"))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum BridgeMode {
    #[default]
    Connecting,
    Websocket,
    Polling,
}

impl BridgeMode {
    pub(super) fn enter_websocket(&mut self) {
        *self = Self::Websocket;
    }

    pub(super) fn enter_polling(&mut self) {
        *self = Self::Polling;
    }
}

/// Probe in the background while the caller keeps polling. Each round retains
/// the shared concurrency limit and bounded handshake timeout.
pub(super) async fn reconnect_when_available<T, F, Fut>(
    policy: ConnectRetryPolicy,
    telemetry: BridgeTelemetry,
    mut connect: F,
) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    loop {
        tokio::time::sleep(RECONNECT_INTERVAL).await;
        match connect_with_retry(policy, telemetry.clone(), &mut connect).await {
            Ok(connected) => return connected,
            Err(error) => debug!(%error, "terminal websocket reconnect deferred"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PollWork {
    SnapshotOnly,
    SnapshotAndStatus,
}

#[derive(Default)]
pub(super) struct PollingSchedule {
    tick: usize,
}

impl PollingSchedule {
    pub(super) fn next_work(&mut self) -> PollWork {
        let work = if self.tick == 0 {
            PollWork::SnapshotAndStatus
        } else {
            PollWork::SnapshotOnly
        };
        self.tick = (self.tick + 1) % POLL_STATUS_EVERY_TICKS;
        work
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStats {
    pub tracked_sessions: usize,
    pub connecting_sessions: usize,
    pub websocket_sessions: usize,
    pub polling_sessions: usize,
    pub connect_attempts: u64,
    pub connect_failures: u64,
    pub fallbacks: u64,
    pub active_connects: usize,
    pub max_concurrent_connects: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn test_retry_policy(max_attempts: usize, max_concurrent: usize) -> ConnectRetryPolicy {
        ConnectRetryPolicy {
            max_attempts,
            connect_timeout: Duration::from_secs(1),
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
            max_concurrent,
        }
    }

    #[tokio::test]
    async fn websocket_connect_retries_are_bounded_then_allow_a_scheduled_probe() {
        let telemetry = BridgeTelemetry::new(4);
        let calls = Arc::new(AtomicUsize::new(0));
        let connector_calls = calls.clone();

        let result: anyhow::Result<()> =
            connect_with_retry(test_retry_policy(3, 4), telemetry.clone(), move || {
                connector_calls.fetch_add(1, Ordering::SeqCst);
                async { anyhow::bail!("mock connect failure") }
            })
            .await;

        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(
            telemetry.stats(),
            BridgeConnectStats {
                connect_attempts: 3,
                connect_failures: 3,
                active_connects: 0,
                max_concurrent_connects: 1,
            }
        );

        let mut mode = BridgeMode::Connecting;
        assert_eq!(mode, BridgeMode::Connecting);
        mode.enter_polling();
        assert_eq!(mode, BridgeMode::Polling);
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_waits_between_rounds_and_recovers_after_an_outage() {
        let telemetry = BridgeTelemetry::new(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let connector_calls = calls.clone();
        let task = tokio::spawn(reconnect_when_available(
            test_retry_policy(1, 1),
            telemetry.clone(),
            move || {
                let call = connector_calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if call == 0 {
                        anyhow::bail!("offline")
                    } else {
                        Ok(42)
                    }
                }
            },
        ));
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(RECONNECT_INTERVAL).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!task.is_finished());
        tokio::time::advance(RECONNECT_INTERVAL).await;
        assert_eq!(task.await.unwrap(), 42);
        assert_eq!(telemetry.stats().active_connects, 0);
    }

    #[tokio::test]
    async fn websocket_connect_mock_sequence_succeeds_before_retry_limit() {
        let telemetry = BridgeTelemetry::new(4);
        let mut outcomes = VecDeque::from([Err("first"), Err("second"), Ok(42_u8)]);

        let connected = connect_with_retry(test_retry_policy(3, 4), telemetry.clone(), move || {
            let outcome = outcomes
                .pop_front()
                .expect("connector called at most three times");
            async move { outcome.map_err(anyhow::Error::msg) }
        })
        .await
        .expect("third attempt should connect");

        assert_eq!(connected, 42);
        assert_eq!(telemetry.stats().connect_attempts, 3);
        assert_eq!(telemetry.stats().connect_failures, 2);
        assert_eq!(telemetry.stats().active_connects, 0);
    }

    #[tokio::test]
    async fn timed_out_connect_releases_active_slot() {
        let telemetry = BridgeTelemetry::new(1);
        let policy = ConnectRetryPolicy {
            max_attempts: 1,
            connect_timeout: Duration::from_millis(1),
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::ZERO,
            max_concurrent: 1,
        };

        let result: anyhow::Result<()> = connect_with_retry(policy, telemetry.clone(), || async {
            std::future::pending().await
        })
        .await;

        assert!(result.is_err());
        assert_eq!(telemetry.stats().connect_attempts, 1);
        assert_eq!(telemetry.stats().connect_failures, 1);
        assert_eq!(telemetry.stats().active_connects, 0);
    }

    #[test]
    fn websocket_retry_backoff_is_exponential_and_capped() {
        let policy = ConnectRetryPolicy {
            max_attempts: 6,
            connect_timeout: Duration::from_secs(3),
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(1),
            max_concurrent: 4,
        };

        assert_eq!(policy.backoff_after_failure(1), Duration::from_millis(250));
        assert_eq!(policy.backoff_after_failure(2), Duration::from_millis(500));
        assert_eq!(policy.backoff_after_failure(3), Duration::from_secs(1));
        assert_eq!(policy.backoff_after_failure(4), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn websocket_handshakes_respect_global_concurrency_limit() {
        let telemetry = BridgeTelemetry::new(2);
        let release = Arc::new(Semaphore::new(0));
        let mut tasks = Vec::new();

        for _ in 0..6 {
            let task_telemetry = telemetry.clone();
            let task_release = release.clone();
            tasks.push(tokio::spawn(async move {
                connect_with_retry(test_retry_policy(1, 2), task_telemetry, move || {
                    let connector_release = task_release.clone();
                    async move {
                        connector_release
                            .acquire()
                            .await
                            .expect("test release semaphore open")
                            .forget();
                        Ok::<_, anyhow::Error>(())
                    }
                })
                .await
            }));
        }

        tokio::time::timeout(Duration::from_secs(1), async {
            while telemetry.stats().active_connects < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("two handshakes should enter connector");
        assert_eq!(telemetry.stats().active_connects, 2);
        assert_eq!(telemetry.stats().max_concurrent_connects, 2);

        release.add_permits(6);
        for task in tasks {
            task.await
                .expect("connect task should not panic")
                .expect("mock connector should succeed");
        }

        assert_eq!(telemetry.stats().active_connects, 0);
        assert_eq!(telemetry.stats().max_concurrent_connects, 2);
    }

    #[test]
    fn polling_schedule_separates_snapshot_and_status_requests() {
        let mut schedule = PollingSchedule::default();

        assert_eq!(schedule.next_work(), PollWork::SnapshotAndStatus);
        for _ in 0..4 {
            assert_eq!(schedule.next_work(), PollWork::SnapshotOnly);
        }
        assert_eq!(schedule.next_work(), PollWork::SnapshotAndStatus);
        assert_eq!(POLL_INTERVAL, Duration::from_secs(1));
    }

    #[test]
    fn bridge_stats_count_each_session_mode() {
        let telemetry = BridgeTelemetry::new(4);
        telemetry.record_fallback();

        let stats = telemetry.bridge_stats([
            BridgeMode::Connecting,
            BridgeMode::Websocket,
            BridgeMode::Polling,
            BridgeMode::Polling,
        ]);

        assert_eq!(stats.tracked_sessions, 4);
        assert_eq!(stats.connecting_sessions, 1);
        assert_eq!(stats.websocket_sessions, 1);
        assert_eq!(stats.polling_sessions, 2);
        assert_eq!(stats.fallbacks, 1);
        assert_eq!(stats.connect_attempts, 0);
        assert_eq!(stats.active_connects, 0);
    }
}
