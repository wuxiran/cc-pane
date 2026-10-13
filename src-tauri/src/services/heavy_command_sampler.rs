//! 重负载命令的边沿触发采样器（docs/107 P2b，docs/41 教训：监控本身不得吃资源）。
//!
//! 状态机（纯逻辑在 [`SamplerStateMachine`]，线程只负责喂数据）：
//! - **空闲**：每 5 s 只查一次整机 CPU（`refresh_cpu_usage`，微秒级），**不建进程树**。
//! - 整机 CPU ≥ 60% 连续 2 次 → **武装**：每 2 s 建一次会话进程树。
//! - 某会话树 CPU ≥ 100%（一个核）或内存 ≥ 2 GiB 持续 5 s → 开 **episode**，记峰值 /
//!   cpu_seconds / 最重子进程命令；低于阈值持续 10 s → 封账 `merge_episode`。
//! - 整机 CPU < 45% 持续 20 s 且无开着的 episode → **解除武装**。
//!
//! episode 期间每次建树都发 Tauri 事件 `heavy-session-usage`（标签琥珀徽标），
//! 封账时再发一次 `active:false` 让前端清徽标。
//!
//! **独立的 `SystemStatsService` 实例**：`windows.rs` 每次调用都会覆盖 CPU 基线，与弹层 /
//! performance_recorder 共用一个实例会互相把 CPU 读成 0（照 `performance_recorder/mod.rs`）。

use crate::services::TerminalBackendState;
use cc_panes_core::models::{
    HeavyEpisode, HeavySamplerStats, HeavySessionContext, JobMemoryWarning, ManagedSessionRoot,
    SessionResourceUsage,
};
use cc_panes_core::services::heavy_command_normalize::{normalize, redact};
use cc_panes_core::services::TerminalBackend;
use cc_panes_core::services::{SessionStatusInfo, SettingsService, SystemStatsService};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

use super::heavy_command_recorder::HeavyCommandRecorder;

pub const IDLE_INTERVAL: Duration = Duration::from_secs(5);
pub const ARMED_INTERVAL: Duration = Duration::from_secs(2);
/// 整机 CPU 武装阈值（连续 [`ARM_STREAK`] 次）。
pub const ARM_CPU_PERCENT: f32 = 60.0;
pub const ARM_STREAK: u8 = 2;
/// 整机 CPU 解除阈值（持续 [`DISARM_HOLD`]）。
pub const DISARM_CPU_PERCENT: f32 = 45.0;
pub const DISARM_HOLD: Duration = Duration::from_secs(20);
/// 会话树开 episode 的阈值：CPU 一个核 / 内存 2 GiB，持续 [`EPISODE_OPEN_HOLD`]。
pub const EPISODE_CPU_PERCENT: f32 = 100.0;
pub const EPISODE_MEM_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const EPISODE_OPEN_HOLD: Duration = Duration::from_secs(5);
/// 低于阈值持续多久封账。
pub const EPISODE_CLOSE_HOLD: Duration = Duration::from_secs(10);

/// 一次建树后，单个会话的输入。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionSample {
    pub session_id: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    /// 最重子进程（按 CPU）的命令行；没有明细时为空。
    pub heaviest_command: Option<String>,
}

impl SessionSample {
    fn heavy(&self) -> bool {
        self.cpu_percent >= EPISODE_CPU_PERCENT || self.memory_bytes >= EPISODE_MEM_BYTES
    }
}

/// 前端徽标事件载荷（`heavy-session-usage`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavySessionUsagePayload {
    pub session_id: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    /// `false` = episode 已封账，前端据此清徽标。
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum EpisodeEvent {
    Usage(HeavySessionUsagePayload),
    Closed(HeavyEpisode),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TickDecision {
    /// 继续睡，不建树。
    Idle,
    /// 建树并调用 `on_tree`。
    SampleTree,
}

#[derive(Debug)]
struct OpenEpisode {
    started_at_ms: i64,
    peak_cpu: f32,
    peak_mem: u64,
    cpu_seconds: f64,
    heaviest: Option<(f32, String)>,
    below_since: Option<Instant>,
}

#[derive(Debug, Default)]
struct SessionTrack {
    heavy_since: Option<Instant>,
    open: Option<OpenEpisode>,
}

/// 纯状态机：所有时间都由调用方注入，便于假时钟测试。
#[derive(Debug)]
pub(crate) struct SamplerStateMachine {
    armed: bool,
    high_streak: u8,
    low_since: Option<Instant>,
    last_tree_at: Option<Instant>,
    tracks: HashMap<String, SessionTrack>,
    pub(crate) stats: HeavySamplerStats,
}

impl SamplerStateMachine {
    pub(crate) fn new() -> Self {
        Self {
            armed: false,
            high_streak: 0,
            low_since: None,
            last_tree_at: None,
            tracks: HashMap::new(),
            stats: HeavySamplerStats::default(),
        }
    }

    pub(crate) fn interval(&self) -> Duration {
        if self.armed {
            ARMED_INTERVAL
        } else {
            IDLE_INTERVAL
        }
    }

    #[cfg(test)]
    pub(crate) fn armed(&self) -> bool {
        self.armed
    }

    /// 每个 tick 先喂整机 CPU。返回要不要建树。
    pub(crate) fn on_cpu_sample(&mut self, machine_cpu: f32, now: Instant) -> TickDecision {
        if machine_cpu >= ARM_CPU_PERCENT {
            self.high_streak = self.high_streak.saturating_add(1);
            self.low_since = None;
            if !self.armed && self.high_streak >= ARM_STREAK {
                self.armed = true;
                debug!(machine_cpu, "[heavy-sampler] armed");
            }
        } else {
            self.high_streak = 0;
            if machine_cpu < DISARM_CPU_PERCENT {
                let since = *self.low_since.get_or_insert(now);
                let has_open = self.tracks.values().any(|track| track.open.is_some());
                if self.armed && !has_open && now.duration_since(since) >= DISARM_HOLD {
                    self.armed = false;
                    self.tracks.clear();
                    self.last_tree_at = None;
                    debug!("[heavy-sampler] disarmed");
                }
            } else {
                self.low_since = None;
            }
        }
        self.stats.armed = self.armed;
        if self.armed {
            TickDecision::SampleTree
        } else {
            self.stats.idle_ticks += 1;
            TickDecision::Idle
        }
    }

    /// 建树后的每个会话样本。返回要发的事件（徽标 / 封账）。
    pub(crate) fn on_tree(&mut self, samples: &[SessionSample], now: Instant) -> Vec<EpisodeEvent> {
        self.stats.tree_samples += 1;
        let dt = self
            .last_tree_at
            .map(|previous| now.duration_since(previous))
            .unwrap_or(Duration::ZERO)
            .as_secs_f64();
        self.last_tree_at = Some(now);
        let mut events = Vec::new();

        // 消失的会话：开着的 episode 立即封账。
        let live: std::collections::HashSet<&str> =
            samples.iter().map(|s| s.session_id.as_str()).collect();
        let gone: Vec<String> = self
            .tracks
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect();
        for session_id in gone {
            if let Some(track) = self.tracks.remove(&session_id) {
                if let Some(open) = track.open {
                    events.push(close_episode(&session_id, open, now_millis()));
                    events.push(EpisodeEvent::Usage(HeavySessionUsagePayload {
                        session_id,
                        cpu_percent: 0.0,
                        memory_bytes: 0,
                        active: false,
                    }));
                    self.stats.closed_episodes += 1;
                }
            }
        }

        for sample in samples {
            let track = self.tracks.entry(sample.session_id.clone()).or_default();
            let heavy = sample.heavy();
            match track.open.as_mut() {
                None => {
                    if heavy {
                        let since = *track.heavy_since.get_or_insert(now);
                        if now.duration_since(since) >= EPISODE_OPEN_HOLD {
                            track.open = Some(OpenEpisode {
                                started_at_ms: now_millis()
                                    - now.duration_since(since).as_millis() as i64,
                                peak_cpu: sample.cpu_percent,
                                peak_mem: sample.memory_bytes,
                                cpu_seconds: 0.0,
                                heaviest: sample
                                    .heaviest_command
                                    .clone()
                                    .map(|cmd| (sample.cpu_percent, cmd)),
                                below_since: None,
                            });
                            events.push(EpisodeEvent::Usage(usage(sample, true)));
                        }
                    } else {
                        track.heavy_since = None;
                    }
                }
                Some(open) => {
                    open.peak_cpu = open.peak_cpu.max(sample.cpu_percent);
                    open.peak_mem = open.peak_mem.max(sample.memory_bytes);
                    open.cpu_seconds += f64::from(sample.cpu_percent) / 100.0 * dt;
                    if let Some(cmd) = sample.heaviest_command.as_deref() {
                        let replace = open
                            .heaviest
                            .as_ref()
                            .is_none_or(|(cpu, _)| sample.cpu_percent > *cpu);
                        if replace {
                            open.heaviest = Some((sample.cpu_percent, cmd.to_string()));
                        }
                    }
                    if heavy {
                        open.below_since = None;
                        events.push(EpisodeEvent::Usage(usage(sample, true)));
                    } else {
                        let since = *open.below_since.get_or_insert(now);
                        if now.duration_since(since) >= EPISODE_CLOSE_HOLD {
                            let open = track.open.take().expect("checked open");
                            track.heavy_since = None;
                            events.push(close_episode(
                                &sample.session_id,
                                open,
                                now_millis() - now.duration_since(since).as_millis() as i64,
                            ));
                            events.push(EpisodeEvent::Usage(usage(sample, false)));
                            self.stats.closed_episodes += 1;
                        } else {
                            // 仍在观察期：继续亮徽标，但用真实读数。
                            events.push(EpisodeEvent::Usage(usage(sample, true)));
                        }
                    }
                }
            }
        }
        self.stats.open_episodes = self
            .tracks
            .values()
            .filter(|track| track.open.is_some())
            .count() as u32;
        events
    }
}

fn usage(sample: &SessionSample, active: bool) -> HeavySessionUsagePayload {
    HeavySessionUsagePayload {
        session_id: sample.session_id.clone(),
        cpu_percent: sample.cpu_percent,
        memory_bytes: sample.memory_bytes,
        active,
    }
}

fn close_episode(session_id: &str, open: OpenEpisode, ended_at: i64) -> EpisodeEvent {
    let (cmd_normalized, cmd_redacted) = match open.heaviest {
        Some((_, command)) => (normalize(&command), redact(&command)),
        None => (String::new(), String::new()),
    };
    EpisodeEvent::Closed(HeavyEpisode {
        session_id: session_id.to_string(),
        context: HeavySessionContext::default(),
        cmd_normalized,
        cmd_redacted,
        started_at: open.started_at_ms,
        ended_at: ended_at.max(open.started_at_ms),
        peak_cpu_pct: open.peak_cpu,
        peak_mem_bytes: open.peak_mem,
        cpu_seconds: open.cpu_seconds,
    })
}

/// 把资源树的会话条目压成采样输入。
pub(crate) fn session_sample(usage: &SessionResourceUsage) -> SessionSample {
    let heaviest = usage
        .processes
        .iter()
        .filter(|process| !process.command.trim().is_empty())
        .max_by(|left, right| {
            left.cpu_percent
                .partial_cmp(&right.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|process| process.command.clone());
    SessionSample {
        session_id: usage.session_id.clone(),
        cpu_percent: usage.cpu_percent,
        memory_bytes: usage.memory_bytes,
        heaviest_command: heaviest,
    }
}

/// 带 Job 内存越线告警的会话（W5）。树采样后据此判回落。
pub(crate) fn job_memory_warnings_of(
    statuses: &[SessionStatusInfo],
) -> HashMap<String, JobMemoryWarning> {
    statuses
        .iter()
        .filter_map(|status| {
            status
                .job_memory_warning
                .map(|warning| (status.session_id.clone(), warning))
        })
        .collect()
}

/// 树内存已回落到水位 80% 以下的告警会话（纯函数，便于测试）。
pub(crate) fn recovered_job_memory_sessions(
    warnings: &HashMap<String, JobMemoryWarning>,
    sessions: &[SessionResourceUsage],
) -> Vec<String> {
    let mut recovered = sessions
        .iter()
        .filter(|usage| {
            warnings
                .get(&usage.session_id)
                .is_some_and(|warning| warning.recovered_by(usage.memory_bytes))
        })
        .map(|usage| usage.session_id.clone())
        .collect::<Vec<_>>();
    recovered.sort();
    recovered
}

/// 回落的告警交给后端清除（daemon 模式走路由）。失败只记日志：告警多留一会儿不致命。
pub(crate) fn clear_recovered_job_memory_warnings(
    backend: &dyn TerminalBackend,
    warnings: &HashMap<String, JobMemoryWarning>,
    sessions: &[SessionResourceUsage],
) -> usize {
    let recovered = recovered_job_memory_sessions(warnings, sessions);
    let mut cleared = 0usize;
    for session_id in recovered {
        match backend.clear_job_memory_warning(&session_id) {
            Ok(true) => cleared += 1,
            Ok(false) => {}
            Err(error) => {
                debug!(%error, session_id, "[heavy-sampler] clear job memory warning failed")
            }
        }
    }
    cleared
}

pub(crate) fn session_roots(statuses: Vec<SessionStatusInfo>) -> Vec<ManagedSessionRoot> {
    statuses
        .into_iter()
        .filter(|status| !status.status.is_terminal())
        .filter_map(|status| {
            status.pid.map(|root_pid| ManagedSessionRoot {
                session_id: status.session_id,
                root_pid,
            })
        })
        .collect()
}

/// 采样器句柄（Tauri `manage`）。
pub struct HeavyCommandSampler {
    stats: Mutex<HeavySamplerStats>,
    stop: AtomicBool,
    shutdown: Mutex<Option<mpsc::Sender<()>>>,
}

impl HeavyCommandSampler {
    pub fn start(
        recorder: Arc<HeavyCommandRecorder>,
        settings: Arc<SettingsService>,
        terminal_backend: Arc<TerminalBackendState>,
        app_handle: AppHandle,
    ) -> Arc<Self> {
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let sampler = Arc::new(Self {
            stats: Mutex::new(HeavySamplerStats::default()),
            stop: AtomicBool::new(false),
            shutdown: Mutex::new(Some(shutdown_tx)),
        });
        let worker = sampler.clone();
        let spawned = std::thread::Builder::new()
            .name("heavy-sampler".into())
            .spawn(move || {
                worker.run(
                    recorder,
                    settings,
                    terminal_backend,
                    app_handle,
                    shutdown_rx,
                )
            });
        if let Err(error) = spawned {
            warn!(%error, "[heavy-sampler] thread spawn failed");
        }
        sampler
    }

    pub fn stats(&self) -> HeavySamplerStats {
        *self.stats.lock()
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.shutdown.lock().take();
    }

    fn run(
        &self,
        recorder: Arc<HeavyCommandRecorder>,
        settings: Arc<SettingsService>,
        terminal_backend: Arc<TerminalBackendState>,
        app_handle: AppHandle,
        shutdown: mpsc::Receiver<()>,
    ) {
        // 刻意不复用弹层 / recorder 的实例（CPU 基线互相覆盖）。
        let stats_service = SystemStatsService::new();
        let mut machine = SamplerStateMachine::new();
        {
            let mut stats = self.stats.lock();
            stats.running = true;
        }
        while !self.stop.load(Ordering::Acquire) {
            let enabled = settings.get_settings().performance.heavy_ledger_enabled;
            let now = Instant::now();
            if enabled {
                let machine_cpu = stats_service.get_system_stats().cpu_percent;
                if machine.on_cpu_sample(machine_cpu, now) == TickDecision::SampleTree {
                    let backend = terminal_backend.backend();
                    let (roots, warnings) = match backend.get_all_status() {
                        Ok(statuses) => (
                            session_roots(statuses.clone()),
                            job_memory_warnings_of(&statuses),
                        ),
                        Err(error) => {
                            debug!(%error, "[heavy-sampler] status query failed; skipping tree");
                            (Vec::new(), HashMap::new())
                        }
                    };
                    let tree = stats_service.get_resource_tree(&roots);
                    // W5：顺手判 Job 内存告警回落——树已经建好，不另起轮询。
                    if !warnings.is_empty() {
                        clear_recovered_job_memory_warnings(
                            backend.as_ref(),
                            &warnings,
                            &tree.sessions,
                        );
                    }
                    let samples: Vec<SessionSample> =
                        tree.sessions.iter().map(session_sample).collect();
                    for event in machine.on_tree(&samples, Instant::now()) {
                        match event {
                            EpisodeEvent::Usage(payload) => {
                                if let Err(error) = app_handle.emit(
                                    cc_panes_core::constants::events::HEAVY_SESSION_USAGE,
                                    &payload,
                                ) {
                                    debug!(%error, "[heavy-sampler] emit failed");
                                }
                            }
                            EpisodeEvent::Closed(episode) => recorder.record_episode(episode),
                        }
                    }
                }
            } else {
                machine.stats.idle_ticks += 1;
            }
            {
                let mut stats = self.stats.lock();
                let running = stats.running;
                *stats = machine.stats;
                stats.running = running;
            }
            let interval = if enabled {
                machine.interval()
            } else {
                IDLE_INTERVAL
            };
            match shutdown.recv_timeout(interval) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        self.stats.lock().running = false;
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, cpu: f32, mem: u64) -> SessionSample {
        SessionSample {
            session_id: id.into(),
            cpu_percent: cpu,
            memory_bytes: mem,
            heaviest_command: Some("rustc --crate-name foo --token=SECRET".into()),
        }
    }

    #[test]
    fn idle_machine_never_samples_tree_and_counts_idle_ticks() {
        let mut machine = SamplerStateMachine::new();
        let t0 = Instant::now();
        for i in 0..120 {
            let decision = machine.on_cpu_sample(30.0, t0 + Duration::from_secs(i * 5));
            assert_eq!(decision, TickDecision::Idle);
        }
        assert_eq!(machine.stats.tree_samples, 0);
        assert_eq!(machine.stats.idle_ticks, 120);
        assert!(!machine.armed());
        assert_eq!(machine.interval(), IDLE_INTERVAL);
    }

    #[test]
    fn arms_after_two_high_samples_and_disarms_after_hold_without_episodes() {
        let mut machine = SamplerStateMachine::new();
        let t0 = Instant::now();
        assert_eq!(machine.on_cpu_sample(70.0, t0), TickDecision::Idle);
        assert_eq!(
            machine.on_cpu_sample(70.0, t0 + Duration::from_secs(5)),
            TickDecision::SampleTree
        );
        assert!(machine.armed());
        assert_eq!(machine.interval(), ARMED_INTERVAL);

        // 50%：在滞回带里，保持武装
        let t = t0 + Duration::from_secs(7);
        assert_eq!(machine.on_cpu_sample(50.0, t), TickDecision::SampleTree);
        // <45% 但不足 20 s：仍武装
        let t = t + Duration::from_secs(2);
        assert_eq!(machine.on_cpu_sample(30.0, t), TickDecision::SampleTree);
        let t = t + Duration::from_secs(10);
        assert_eq!(machine.on_cpu_sample(30.0, t), TickDecision::SampleTree);
        // 满 20 s → 解除
        let t = t + Duration::from_secs(10);
        assert_eq!(machine.on_cpu_sample(30.0, t), TickDecision::Idle);
        assert!(!machine.armed());
    }

    #[test]
    fn episode_opens_after_hold_tracks_peaks_and_closes_with_redacted_command() {
        let mut machine = SamplerStateMachine::new();
        let t0 = Instant::now();
        machine.on_cpu_sample(90.0, t0);
        machine.on_cpu_sample(90.0, t0 + Duration::from_secs(5));

        let mut t = t0 + Duration::from_secs(5);
        // 5 s 内：只是候选，不开 episode、不发事件
        let events = machine.on_tree(&[sample("s1", 250.0, 500)], t);
        assert!(events.is_empty());
        t += Duration::from_secs(2);
        assert!(machine.on_tree(&[sample("s1", 300.0, 500)], t).is_empty());
        t += Duration::from_secs(3);
        let events = machine.on_tree(&[sample("s1", 400.0, 3 * 1024 * 1024 * 1024)], t);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], EpisodeEvent::Usage(p) if p.active && p.session_id == "s1"));
        assert_eq!(machine.stats.open_episodes, 1);

        // 继续重：累加 cpu_seconds（400% × 2 s = 8 s）
        t += Duration::from_secs(2);
        machine.on_tree(&[sample("s1", 400.0, 100)], t);
        // 降下来但未满 10 s：徽标仍亮
        t += Duration::from_secs(2);
        let events = machine.on_tree(&[sample("s1", 10.0, 100)], t);
        assert!(matches!(&events[0], EpisodeEvent::Usage(p) if p.active));
        t += Duration::from_secs(10);
        let events = machine.on_tree(&[sample("s1", 5.0, 100)], t);
        assert_eq!(events.len(), 2);
        let EpisodeEvent::Closed(episode) = &events[0] else {
            panic!("expected Closed, got {:?}", events[0]);
        };
        assert_eq!(episode.session_id, "s1");
        assert_eq!(episode.peak_cpu_pct, 400.0);
        assert_eq!(episode.peak_mem_bytes, 3 * 1024 * 1024 * 1024);
        assert!(
            episode.cpu_seconds > 8.0,
            "cpu_seconds={}",
            episode.cpu_seconds
        );
        assert_eq!(episode.cmd_normalized, "rustc");
        assert!(!episode.cmd_redacted.contains("SECRET"));
        assert!(episode.ended_at >= episode.started_at);
        assert!(matches!(&events[1], EpisodeEvent::Usage(p) if !p.active));
        assert_eq!(machine.stats.open_episodes, 0);
        assert_eq!(machine.stats.closed_episodes, 1);
        assert_eq!(machine.stats.tree_samples, 6);
    }

    #[test]
    fn open_episode_blocks_disarm_and_vanished_session_closes_immediately() {
        let mut machine = SamplerStateMachine::new();
        let t0 = Instant::now();
        machine.on_cpu_sample(90.0, t0);
        machine.on_cpu_sample(90.0, t0 + Duration::from_secs(5));
        let mut t = t0 + Duration::from_secs(5);
        machine.on_tree(&[sample("s1", 0.0, 4 * 1024 * 1024 * 1024)], t);
        t += Duration::from_secs(5);
        let events = machine.on_tree(&[sample("s1", 0.0, 4 * 1024 * 1024 * 1024)], t);
        assert_eq!(events.len(), 1, "memory-only episode opens too");

        // 整机 CPU 低于 45% 超过 20 s，但 episode 开着 → 不解除
        for i in 1..=6 {
            let decision = machine.on_cpu_sample(10.0, t + Duration::from_secs(i * 5));
            assert_eq!(decision, TickDecision::SampleTree);
        }
        assert!(machine.armed());

        // 会话消失 → 立即封账 + active:false
        t += Duration::from_secs(30);
        let events = machine.on_tree(&[], t);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], EpisodeEvent::Closed(_)));
        assert!(matches!(&events[1], EpisodeEvent::Usage(p) if !p.active));
        assert_eq!(machine.stats.open_episodes, 0);
    }

    #[test]
    fn session_sample_picks_heaviest_process_by_cpu() {
        use cc_panes_core::models::SessionProcessInfo;
        let usage = SessionResourceUsage {
            session_id: "s".into(),
            root_pid: 1,
            cpu_percent: 150.0,
            memory_bytes: 10,
            process_count: 2,
            processes: vec![
                SessionProcessInfo {
                    pid: 2,
                    parent_pid: Some(1),
                    name: "pwsh".into(),
                    command: "pwsh".into(),
                    cpu_percent: 1.0,
                    memory_bytes: 5,
                },
                SessionProcessInfo {
                    pid: 3,
                    parent_pid: Some(2),
                    name: "rustc".into(),
                    command: "rustc --crate-name x".into(),
                    cpu_percent: 149.0,
                    memory_bytes: 5,
                },
            ],
            truncated: None,
        };
        let sample = session_sample(&usage);
        assert_eq!(
            sample.heaviest_command.as_deref(),
            Some("rustc --crate-name x")
        );
        assert_eq!(sample.cpu_percent, 150.0);
    }

    #[test]
    fn usage_payload_serializes_camel_case_for_frontend() {
        let json = serde_json::to_value(HeavySessionUsagePayload {
            session_id: "s".into(),
            cpu_percent: 1.5,
            memory_bytes: 2,
            active: true,
        })
        .unwrap();
        assert_eq!(json["sessionId"], "s");
        assert_eq!(json["cpuPercent"], 1.5);
        assert_eq!(json["memoryBytes"], 2);
        assert_eq!(json["active"], true);
    }

    #[test]
    fn job_memory_recovery_uses_80_percent_hysteresis_and_ignores_unwarned_sessions() {
        let warning = JobMemoryWarning {
            bytes: 1_200,
            limit_bytes: 1_000,
            at: 1,
        };
        let warnings: HashMap<String, JobMemoryWarning> =
            [("hot".to_string(), warning), ("cool".to_string(), warning)]
                .into_iter()
                .collect();
        let usage = |id: &str, mem: u64| SessionResourceUsage {
            session_id: id.to_string(),
            root_pid: 1,
            cpu_percent: 0.0,
            memory_bytes: mem,
            process_count: 1,
            processes: Vec::new(),
            truncated: None,
        };
        let sessions = [usage("hot", 900), usage("cool", 100), usage("unwarned", 0)];
        assert_eq!(
            recovered_job_memory_sessions(&warnings, &sessions),
            vec!["cool".to_string()]
        );
        assert!(recovered_job_memory_sessions(&HashMap::new(), &sessions).is_empty());
    }
}
