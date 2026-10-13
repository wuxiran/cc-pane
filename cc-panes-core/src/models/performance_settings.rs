//! `[performance]` 性能设置 —— 0.12.22 性能专项（docs/107）所有开关的唯一来源。
//!
//! 从 `models::settings` 拆出（settings.rs 已触到行数棘轮上限，同
//! `orchestrator_settings.rs` / `quick_terminal_settings.rs` 范式），仍由
//! `models::settings` 重导出。
//!
//! 约束：
//! - 每个字段都必须 `#[serde(default)]`：老 config.toml 没有 `[performance]` 节
//!   或缺任意子键都要能整体回落默认，否则老配置升级直接失败。
//! - 所有数值都在 [`PerformanceSettings::merge_missing_defaults`] 里钳到合法区间，
//!   手改 config.toml 写了 0 / 超大值不会让会话建不起来，也不会悄悄丢掉整项。
//! - `Option<u32>` 字段 `None` = "按核数自动"，有效值统一走 `effective_*(cores)`，
//!   各注入点不得自行折算。
//! - `terminal.lower_session_priority` / `session_cpu_weight` **不迁**到这里
//!   （存储位置不动，只迁 UI）。

use serde::{Deserialize, Serialize};

/// 显式 `build_jobs` / `rg_threads` 的上限（再高只是调度开销）。
pub const MAX_BUILD_JOBS: u32 = 512;
/// 构建并行度自动值的下限：再少编译就慢到不可用。
pub const MIN_AUTO_BUILD_JOBS: u32 = 2;
/// 自动算 `build_jobs` 时给 UI / 其他窗格留出的核数。
pub const BUILD_JOBS_RESERVED_CORES: u32 = 8;
/// 门禁槽位钳位区间。
pub const MIN_HEAVY_GATE_SLOTS: u32 = 1;
pub const MAX_HEAVY_GATE_SLOTS: u32 = 32;
/// 自动算门禁槽位时每槽对应的核数。
pub const HEAVY_GATE_CORES_PER_SLOT: u32 = 8;
/// 门禁排队超时钳位区间（秒）。
pub const MIN_HEAVY_GATE_TIMEOUT_SECS: u32 = 10;
pub const MAX_HEAVY_GATE_TIMEOUT_SECS: u32 = 3600;
pub const DEFAULT_HEAVY_GATE_TIMEOUT_SECS: u32 = 300;
/// WSL cgroup CPUWeight（systemd 1..=10000）。
pub const MIN_WSL_CPU_WEIGHT: u32 = 1;
pub const MAX_WSL_CPU_WEIGHT: u32 = 10_000;
pub const DEFAULT_WSL_CPU_WEIGHT: u32 = 20;
/// WSL MemoryHigh 百分比钳位区间（0 = 不设）。默认 **0**：与 0.12.21 一致，不给
/// WSL 编译加内存软限——MemoryHigh 一到就触发激进回收 + throttle，默认开会把
/// 正常构建拖慢而用户不知道原因。上限 90：留 10% 给宿主，再高等于没设。
pub const MAX_WSL_MEMORY_HIGH_PERCENT: u32 = 90;
pub const DEFAULT_WSL_MEMORY_HIGH_PERCENT: u32 = 0;
/// Job 内存通知阈值百分比（0 = 关）。
pub const MAX_JOB_MEMORY_NOTIFY_PERCENT: u32 = 100;
pub const DEFAULT_JOB_MEMORY_NOTIFY_PERCENT: u32 = 25;
/// 隐藏窗格停泊数钳位区间。
pub const MIN_PARKED_TERMINAL_LIMIT: u32 = 2;
pub const MAX_PARKED_TERMINAL_LIMIT: u32 = 12;
pub const DEFAULT_PARKED_TERMINAL_LIMIT: u32 = 6;
/// 隐藏到停泊的延迟钳位区间（秒）。
pub const MIN_PARK_DELAY_SECS: u32 = 5;
pub const MAX_PARK_DELAY_SECS: u32 = 600;
pub const DEFAULT_PARK_DELAY_SECS: u32 = 30;

fn default_true() -> bool {
    true
}

fn default_heavy_gate_timeout_secs() -> u32 {
    DEFAULT_HEAVY_GATE_TIMEOUT_SECS
}

fn default_wsl_cpu_weight() -> u32 {
    DEFAULT_WSL_CPU_WEIGHT
}

fn default_wsl_memory_high_percent() -> u32 {
    DEFAULT_WSL_MEMORY_HIGH_PERCENT
}

fn default_job_memory_notify_percent() -> u32 {
    DEFAULT_JOB_MEMORY_NOTIFY_PERCENT
}

fn default_parked_terminal_limit() -> u32 {
    DEFAULT_PARKED_TERMINAL_LIMIT
}

fn default_park_delay_secs() -> u32 {
    DEFAULT_PARK_DELAY_SECS
}

/// `[performance]` 设置（TOML 键为 camelCase，与其余节一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSettings {
    /// 向新会话注入构建并行度环境（CARGO_BUILD_JOBS / MAKEFLAGS / … / RIPGREP_CONFIG_PATH）。
    /// 只影响新会话；用户进程环境里已有的键不覆盖。
    #[serde(default = "default_true")]
    pub build_parallelism_enabled: bool,
    /// 构建并行度；`None` = `max(2, cores - 8)`。
    #[serde(default)]
    pub build_jobs: Option<u32>,
    /// ripgrep 线程数；`None` = `max(2, build_jobs / 2)`。
    #[serde(default)]
    pub rg_threads: Option<u32>,
    /// Codex 轻量模式：`tui.animations=false`、`tui.auto_recap=false`。
    #[serde(default = "default_true")]
    pub codex_lightweight_enabled: bool,
    /// Codex 低配模式：`agents.max_concurrent_threads_per_session=2`。
    #[serde(default)]
    pub codex_low_spec_mode: bool,
    /// 重负载门禁（`cc-panes-ctl run --heavy`）。默认关 = 直通。
    #[serde(default)]
    pub heavy_gate_enabled: bool,
    /// 门禁槽位；`None` = `max(1, cores / 8)`，钳 1..=32。
    #[serde(default)]
    pub heavy_gate_slots: Option<u32>,
    /// 门禁排队超时（秒），到点强制放行；钳 10..=3600。
    #[serde(default = "default_heavy_gate_timeout_secs")]
    pub heavy_gate_timeout_secs: u32,
    /// 重负载命令台账（hook + 采样器落 SQLite）。
    #[serde(default = "default_true")]
    pub heavy_ledger_enabled: bool,
    /// WSL 会话进 systemd user scope 并带 cgroup 配额（探测到 systemd 才生效）。
    #[serde(default = "default_true")]
    pub wsl_quota_enabled: bool,
    /// WSL scope 的 `CPUWeight`（systemd 1..=10000，默认 20）。
    #[serde(default = "default_wsl_cpu_weight")]
    pub wsl_cpu_weight: u32,
    /// WSL scope 的 `MemoryHigh` 占物理内存百分比（0 = 不设，默认）。钳 0..=90。
    #[serde(default = "default_wsl_memory_high_percent")]
    pub wsl_memory_high_percent: u32,
    /// Windows Job 内存**通知**阈值占物理内存百分比（0 = 关）。只告警不限制。
    #[serde(default = "default_job_memory_notify_percent")]
    pub job_memory_notify_percent: u32,
    /// 隐藏窗格最多保留多少个未停泊的 xterm 实例；超出按 LRU 停泊。钳 2..=12。
    #[serde(default = "default_parked_terminal_limit")]
    pub parked_terminal_limit: u32,
    /// 窗格隐藏多久后停泊（秒）。钳 5..=600。
    #[serde(default = "default_park_delay_secs")]
    pub park_delay_secs: u32,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            build_parallelism_enabled: true,
            build_jobs: None,
            rg_threads: None,
            codex_lightweight_enabled: true,
            codex_low_spec_mode: false,
            heavy_gate_enabled: false,
            heavy_gate_slots: None,
            heavy_gate_timeout_secs: default_heavy_gate_timeout_secs(),
            heavy_ledger_enabled: true,
            wsl_quota_enabled: true,
            wsl_cpu_weight: default_wsl_cpu_weight(),
            wsl_memory_high_percent: default_wsl_memory_high_percent(),
            job_memory_notify_percent: default_job_memory_notify_percent(),
            parked_terminal_limit: default_parked_terminal_limit(),
            park_delay_secs: default_park_delay_secs(),
        }
    }
}

impl PerformanceSettings {
    /// 把越界值钳回合法区间（而不是丢弃：手改配置写了个 0 不该让整项消失）。
    /// 显式 `Some(0)` 的并行度 / 槽位视为"自动"，退化为 `None`。
    pub fn merge_missing_defaults(&mut self) {
        self.build_jobs = self
            .build_jobs
            .filter(|jobs| *jobs > 0)
            .map(|jobs| jobs.min(MAX_BUILD_JOBS));
        self.rg_threads = self
            .rg_threads
            .filter(|threads| *threads > 0)
            .map(|threads| threads.min(MAX_BUILD_JOBS));
        self.heavy_gate_slots = self
            .heavy_gate_slots
            .filter(|slots| *slots > 0)
            .map(|slots| slots.clamp(MIN_HEAVY_GATE_SLOTS, MAX_HEAVY_GATE_SLOTS));
        self.heavy_gate_timeout_secs = self
            .heavy_gate_timeout_secs
            .clamp(MIN_HEAVY_GATE_TIMEOUT_SECS, MAX_HEAVY_GATE_TIMEOUT_SECS);
        self.wsl_cpu_weight = self
            .wsl_cpu_weight
            .clamp(MIN_WSL_CPU_WEIGHT, MAX_WSL_CPU_WEIGHT);
        self.wsl_memory_high_percent = self
            .wsl_memory_high_percent
            .min(MAX_WSL_MEMORY_HIGH_PERCENT);
        self.job_memory_notify_percent = self
            .job_memory_notify_percent
            .min(MAX_JOB_MEMORY_NOTIFY_PERCENT);
        self.parked_terminal_limit = self
            .parked_terminal_limit
            .clamp(MIN_PARKED_TERMINAL_LIMIT, MAX_PARKED_TERMINAL_LIMIT);
        self.park_delay_secs = self
            .park_delay_secs
            .clamp(MIN_PARK_DELAY_SECS, MAX_PARK_DELAY_SECS);
    }

    /// 有效构建并行度：显式值优先，否则 `max(2, cores - 8)`。
    pub fn effective_build_jobs(&self, cores: u32) -> u32 {
        match self.build_jobs {
            Some(jobs) if jobs > 0 => jobs.min(MAX_BUILD_JOBS),
            _ => cores
                .saturating_sub(BUILD_JOBS_RESERVED_CORES)
                .max(MIN_AUTO_BUILD_JOBS),
        }
    }

    /// 有效 ripgrep 线程数：显式值优先，否则 `max(2, build_jobs / 2)`。
    pub fn effective_rg_threads(&self, cores: u32) -> u32 {
        match self.rg_threads {
            Some(threads) if threads > 0 => threads.min(MAX_BUILD_JOBS),
            _ => (self.effective_build_jobs(cores) / 2).max(MIN_AUTO_BUILD_JOBS),
        }
    }

    /// 有效门禁槽位：显式值优先，否则 `max(1, cores / 8)`；统一钳 1..=32。
    pub fn effective_heavy_slots(&self, cores: u32) -> u32 {
        let slots = match self.heavy_gate_slots {
            Some(slots) if slots > 0 => slots,
            _ => (cores / HEAVY_GATE_CORES_PER_SLOT).max(MIN_HEAVY_GATE_SLOTS),
        };
        slots.clamp(MIN_HEAVY_GATE_SLOTS, MAX_HEAVY_GATE_SLOTS)
    }
}

/// 物理内存总量（字节）。Job 内存通知水位 = `job_memory_notify_percent` × 本值，
/// 在 spawn 时算一次。拿不到时返回 0，调用方据此不设水位。
pub fn total_memory_bytes() -> u64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory()
}

/// 当前机器的逻辑核数（拿不到时按 1 处理，让所有 `effective_*` 落到下限）。
pub fn logical_cores() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_plan() {
        let d = PerformanceSettings::default();
        assert!(d.build_parallelism_enabled);
        assert_eq!(d.build_jobs, None);
        assert_eq!(d.rg_threads, None);
        assert!(d.codex_lightweight_enabled);
        assert!(!d.codex_low_spec_mode);
        assert!(!d.heavy_gate_enabled);
        assert_eq!(d.heavy_gate_slots, None);
        assert_eq!(d.heavy_gate_timeout_secs, 300);
        assert!(d.heavy_ledger_enabled);
        assert!(d.wsl_quota_enabled);
        assert_eq!(d.wsl_cpu_weight, 20);
        assert_eq!(
            d.wsl_memory_high_percent, 0,
            "0 = 不设 MemoryHigh，与 0.12.21 一致"
        );
        assert_eq!(d.job_memory_notify_percent, 25);
        assert_eq!(d.parked_terminal_limit, 6);
        assert_eq!(d.park_delay_secs, 30);
    }

    #[test]
    fn missing_section_and_partial_section_fall_back_to_defaults() {
        let missing: PerformanceSettings = toml::from_str("").expect("empty parses");
        assert_eq!(missing, PerformanceSettings::default());

        let partial: PerformanceSettings =
            toml::from_str("buildJobs = 12\nheavyGateEnabled = true\n").expect("partial parses");
        assert_eq!(partial.build_jobs, Some(12));
        assert!(partial.heavy_gate_enabled);
        assert_eq!(partial.parked_terminal_limit, DEFAULT_PARKED_TERMINAL_LIMIT);
        assert!(partial.codex_lightweight_enabled);
    }

    #[test]
    fn merge_missing_defaults_clamps_every_numeric_field() {
        let mut s = PerformanceSettings {
            build_jobs: Some(0),
            rg_threads: Some(100_000),
            heavy_gate_slots: Some(999),
            heavy_gate_timeout_secs: 1,
            wsl_cpu_weight: 0,
            wsl_memory_high_percent: 250,
            job_memory_notify_percent: 101,
            parked_terminal_limit: 0,
            park_delay_secs: 10_000,
            ..PerformanceSettings::default()
        };
        s.merge_missing_defaults();
        assert_eq!(s.build_jobs, None, "explicit 0 means auto");
        assert_eq!(s.rg_threads, Some(MAX_BUILD_JOBS));
        assert_eq!(s.heavy_gate_slots, Some(MAX_HEAVY_GATE_SLOTS));
        assert_eq!(s.heavy_gate_timeout_secs, MIN_HEAVY_GATE_TIMEOUT_SECS);
        assert_eq!(s.wsl_cpu_weight, MIN_WSL_CPU_WEIGHT);
        assert_eq!(s.wsl_memory_high_percent, MAX_WSL_MEMORY_HIGH_PERCENT);
        assert_eq!(s.job_memory_notify_percent, MAX_JOB_MEMORY_NOTIFY_PERCENT);
        assert_eq!(s.parked_terminal_limit, MIN_PARKED_TERMINAL_LIMIT);
        assert_eq!(s.park_delay_secs, MAX_PARK_DELAY_SECS);

        let mut upper = PerformanceSettings {
            heavy_gate_timeout_secs: 999_999,
            wsl_cpu_weight: 999_999,
            parked_terminal_limit: 99,
            park_delay_secs: 1,
            ..PerformanceSettings::default()
        };
        upper.merge_missing_defaults();
        assert_eq!(upper.heavy_gate_timeout_secs, MAX_HEAVY_GATE_TIMEOUT_SECS);
        assert_eq!(upper.wsl_cpu_weight, MAX_WSL_CPU_WEIGHT);
        assert_eq!(upper.parked_terminal_limit, MAX_PARKED_TERMINAL_LIMIT);
        assert_eq!(upper.park_delay_secs, MIN_PARK_DELAY_SECS);
    }

    #[test]
    fn merge_missing_defaults_is_identity_on_defaults_and_zero_percent_means_off() {
        let mut s = PerformanceSettings {
            wsl_memory_high_percent: 0,
            job_memory_notify_percent: 0,
            ..PerformanceSettings::default()
        };
        let before = s.clone();
        s.merge_missing_defaults();
        assert_eq!(s, before);
    }

    #[test]
    fn effective_build_jobs_reserves_cores_with_floor() {
        let auto = PerformanceSettings::default();
        assert_eq!(auto.effective_build_jobs(32), 24);
        assert_eq!(auto.effective_build_jobs(16), 8);
        assert_eq!(auto.effective_build_jobs(8), 2);
        assert_eq!(auto.effective_build_jobs(4), 2);
        assert_eq!(auto.effective_build_jobs(1), 2);

        let explicit = PerformanceSettings {
            build_jobs: Some(6),
            ..PerformanceSettings::default()
        };
        assert_eq!(explicit.effective_build_jobs(32), 6);
    }

    #[test]
    fn effective_rg_threads_halves_build_jobs_with_floor() {
        let auto = PerformanceSettings::default();
        assert_eq!(auto.effective_rg_threads(32), 12);
        assert_eq!(auto.effective_rg_threads(8), 2);

        let explicit = PerformanceSettings {
            rg_threads: Some(3),
            ..PerformanceSettings::default()
        };
        assert_eq!(explicit.effective_rg_threads(32), 3);

        let derived = PerformanceSettings {
            build_jobs: Some(10),
            ..PerformanceSettings::default()
        };
        assert_eq!(derived.effective_rg_threads(32), 5);
    }

    #[test]
    fn effective_heavy_slots_scales_by_eight_cores_and_clamps() {
        let auto = PerformanceSettings::default();
        assert_eq!(auto.effective_heavy_slots(32), 4);
        assert_eq!(auto.effective_heavy_slots(4), 1);
        assert_eq!(auto.effective_heavy_slots(1024), 32);

        let explicit = PerformanceSettings {
            heavy_gate_slots: Some(2),
            ..PerformanceSettings::default()
        };
        assert_eq!(explicit.effective_heavy_slots(64), 2);
    }
}
