//! WSL 会话的 cgroup 读数（0.12.22 W6）。
//!
//! WSL 会话在 Windows 侧只有一个 `wsl.exe` 根进程，Toolhelp 看不到 Linux 侧的 cargo/rustc；
//! 资源管理器对它只能显示几十 MB 的假读数。W6 让 WSL 会话跑在
//! `systemd-run --user --scope --unit=ccpanes-<session8>` 里（见 `wsl_codex::plan_wsl_scope`），
//! 于是 Linux 侧有了一个按会话命名的 cgroup，`memory.current` / `cpu.stat` 就是真读数。
//!
//! 约束（docs/41：监控不得常驻吃资源）：
//! - **只在 WSL utility VM 已在跑时**才碰 `wsl.exe`（`is_wsl_vm_running` 零副作用探测），
//!   VM 关着时统计路径对 `wsl.exe` 的调用次数必须为零——否则资源管理器一开就把 VM 唤醒；
//! - 每个发行版**一次** `wsl.exe -d X -- sh -c '…'` 读完所有 `ccpanes-*` scope，2 s 缓存；
//! - CPU 由两次 `usage_usec` 差分得出，首次采样为 0。
//!
//! 批量脚本里**没有 `$(...)`**：经 `wsl.exe` argv 传递的命令含命令替换会被静默搅坏
//! （CLAUDE.md 的 argv 引号坑）。

use parking_lot::Mutex;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// scope 单元名前缀；批量脚本按它匹配目录。
pub const WSL_SCOPE_UNIT_PREFIX: &str = "ccpanes-";

/// 读数缓存 TTL：弹层 1 s 刷新 + 采样器 2 s 建树，2 s 内复用同一份。
pub const WSL_CGROUP_CACHE_TTL: Duration = Duration::from_secs(2);

/// `systemd-run --unit=` 用的单元名（不带 `.scope`）：`ccpanes-` + 会话 id 前 8 个字母数字。
pub fn wsl_scope_unit_name(session_id: &str) -> String {
    let mut short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if short.is_empty() {
        short.push_str("session");
    }
    format!("{WSL_SCOPE_UNIT_PREFIX}{short}")
}

/// cgroup 目录名（systemd 给 `--scope` 单元加 `.scope` 后缀）。
pub fn wsl_scope_unit_file(session_id: &str) -> String {
    format!("{}.scope", wsl_scope_unit_name(session_id))
}

/// 一次读完用户 slice 下所有 `ccpanes-*.scope` 的 `memory.current` 与 `cpu.stat`。
///
/// 输出按 `unit=` / `mem=` / `cpu=` / `end=` 分段（见 [`parse_cgroup_batch`]）。
/// `--user --scope` 默认落在 `user@UID.service/app.slice/`，也兼容直接挂在 service 下的布局。
pub const WSL_CGROUP_BATCH_SCRIPT: &str = "for d in /sys/fs/cgroup/user.slice/user-*.slice/user@*.service/*/ccpanes-*.scope /sys/fs/cgroup/user.slice/user-*.slice/user@*.service/ccpanes-*.scope; do [ -d \"$d\" ] || continue; echo \"unit=${d##*/}\"; echo mem=; cat \"$d/memory.current\" 2>/dev/null || echo 0; echo cpu=; cat \"$d/cpu.stat\" 2>/dev/null; echo end=; done";

/// 单个 scope 的原始读数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgroupReading {
    /// 目录名，如 `ccpanes-1a2b3c4d.scope`。
    pub unit: String,
    pub memory_bytes: u64,
    /// `cpu.stat` 的 `usage_usec`（累计）。
    pub usage_usec: u64,
}

/// 解析批量脚本输出。容忍缺段（没有 `cpu.stat` 的老内核 → `usage_usec = 0`）与乱序噪声。
pub fn parse_cgroup_batch(output: &str) -> Vec<CgroupReading> {
    #[derive(PartialEq)]
    enum Section {
        None,
        Mem,
        Cpu,
    }
    let mut readings = Vec::new();
    let mut current: Option<CgroupReading> = None;
    let mut section = Section::None;
    for raw in output.lines() {
        let line = raw.trim();
        if let Some(unit) = line.strip_prefix("unit=") {
            if let Some(done) = current.take() {
                readings.push(done);
            }
            let unit = unit.trim();
            if unit.starts_with(WSL_SCOPE_UNIT_PREFIX) {
                current = Some(CgroupReading {
                    unit: unit.to_string(),
                    memory_bytes: 0,
                    usage_usec: 0,
                });
            }
            section = Section::None;
            continue;
        }
        match line {
            "mem=" => section = Section::Mem,
            "cpu=" => section = Section::Cpu,
            "end=" => {
                if let Some(done) = current.take() {
                    readings.push(done);
                }
                section = Section::None;
            }
            _ => {
                let Some(reading) = current.as_mut() else {
                    continue;
                };
                match section {
                    Section::Mem => {
                        if let Ok(bytes) = line.parse::<u64>() {
                            reading.memory_bytes = bytes;
                        }
                    }
                    Section::Cpu => {
                        if let Some(value) = line.strip_prefix("usage_usec ") {
                            if let Ok(usec) = value.trim().parse::<u64>() {
                                reading.usage_usec = usec;
                            }
                        }
                    }
                    Section::None => {}
                }
            }
        }
    }
    if let Some(done) = current.take() {
        readings.push(done);
    }
    readings
}

/// 换算后的会话读数（按单元名索引）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CgroupUsage {
    pub memory_bytes: u64,
    pub cpu_percent: f32,
}

/// 跑一次批量脚本：入参发行版名，返回 stdout；`None` = 超时 / 起不来。
pub type CgroupRunner = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// VM 是否在跑（零副作用）。
pub type VmGate = Box<dyn Fn() -> bool + Send + Sync>;

struct CachedSample {
    at: Instant,
    usage: HashMap<String, CgroupUsage>,
}

/// 按发行版缓存 + CPU 差分的采样器。`SystemStatsService` 持有一个。
pub struct WslCgroupSampler {
    runner: CgroupRunner,
    vm_running: VmGate,
    cache_ttl: Duration,
    cache: Mutex<HashMap<String, CachedSample>>,
    /// unit → (usage_usec, 采样时刻)，供下次差分。
    prev_cpu: Mutex<HashMap<String, (u64, Instant)>>,
    /// 真正起 `wsl.exe` 的次数（验收：VM 关着时必须为 0）。
    spawn_count: AtomicUsize,
}

impl Default for WslCgroupSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl WslCgroupSampler {
    /// 生产构造：`wsl.exe` 运行器 + `is_wsl_vm_running` 门控。
    pub fn new() -> Self {
        Self::with_runner(
            Box::new(run_cgroup_batch_via_wsl),
            Box::new(crate::services::wsl_discovery_service::is_wsl_vm_running),
        )
    }

    /// 测试 / 注入构造。
    pub fn with_runner(runner: CgroupRunner, vm_running: VmGate) -> Self {
        Self {
            runner,
            vm_running,
            cache_ttl: WSL_CGROUP_CACHE_TTL,
            cache: Mutex::new(HashMap::new()),
            prev_cpu: Mutex::new(HashMap::new()),
            spawn_count: AtomicUsize::new(0),
        }
    }

    pub fn spawn_count(&self) -> usize {
        self.spawn_count.load(Ordering::Relaxed)
    }

    /// 读取这些发行版下所有 `ccpanes-*` scope 的读数，按单元文件名索引。
    /// VM 没在跑 → 空表且**不**起任何进程。
    pub fn sample(&self, distros: &[String]) -> HashMap<String, CgroupUsage> {
        self.sample_at(distros, Instant::now())
    }

    pub fn sample_at(&self, distros: &[String], now: Instant) -> HashMap<String, CgroupUsage> {
        let mut merged = HashMap::new();
        if distros.is_empty() {
            return merged;
        }
        let wanted: BTreeSet<&str> = distros.iter().map(String::as_str).collect();
        // 先用缓存，命中就不问 VM 状态（VM 状态探测本身也要遍历进程表）。
        let mut missing = Vec::new();
        {
            let cache = self.cache.lock();
            for distro in wanted {
                match cache.get(distro) {
                    Some(sample) if now.duration_since(sample.at) < self.cache_ttl => {
                        merged.extend(sample.usage.iter().map(|(k, v)| (k.clone(), *v)));
                    }
                    _ => missing.push(distro.to_string()),
                }
            }
        }
        if missing.is_empty() {
            return merged;
        }
        if !(self.vm_running)() {
            // VM 关着 = 没有任何 WSL 会话在跑，也就没有读数；绝不为了读数把 VM 唤醒。
            return merged;
        }
        for distro in missing {
            self.spawn_count.fetch_add(1, Ordering::Relaxed);
            let readings = (self.runner)(&distro)
                .map(|output| parse_cgroup_batch(&output))
                .unwrap_or_default();
            let usage = self.convert(readings, now);
            merged.extend(usage.iter().map(|(k, v)| (k.clone(), *v)));
            self.cache
                .lock()
                .insert(distro, CachedSample { at: now, usage });
        }
        merged
    }

    fn convert(&self, readings: Vec<CgroupReading>, now: Instant) -> HashMap<String, CgroupUsage> {
        let mut prev = self.prev_cpu.lock();
        readings
            .into_iter()
            .map(|reading| {
                let cpu_percent = match prev.get(&reading.unit) {
                    Some((last_usec, last_at)) if now > *last_at => {
                        let elapsed = now.duration_since(*last_at).as_micros() as f64;
                        let delta = reading.usage_usec.saturating_sub(*last_usec) as f64;
                        if elapsed > 0.0 {
                            (delta / elapsed * 100.0) as f32
                        } else {
                            0.0
                        }
                    }
                    _ => 0.0,
                };
                prev.insert(reading.unit.clone(), (reading.usage_usec, now));
                (
                    reading.unit,
                    CgroupUsage {
                        memory_bytes: reading.memory_bytes,
                        cpu_percent,
                    },
                )
            })
            .collect()
    }
}

/// 生产运行器：`wsl.exe -d <distro> -- sh -c <script>`，2 s 超时。
#[cfg(windows)]
fn run_cgroup_batch_via_wsl(distro: &str) -> Option<String> {
    let wsl_path = which::which("wsl.exe").ok()?;
    let args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        WSL_CGROUP_BATCH_SCRIPT.to_string(),
    ];
    cc_cli_adapters::run_with_timeout(&wsl_path, &args, Duration::from_secs(2))
}

#[cfg(not(windows))]
fn run_cgroup_batch_via_wsl(_distro: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    const SAMPLE: &str = "unit=ccpanes-1a2b3c4d.scope\nmem=\n2147483648\ncpu=\nusage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\nnr_periods 0\nend=\nunit=ccpanes-deadbeef.scope\nmem=\n1024\ncpu=\nend=\nunit=other.scope\nmem=\n9\nend=\n";

    #[test]
    fn unit_name_takes_first_8_alnum_and_never_empties() {
        assert_eq!(
            wsl_scope_unit_name("1a2b3c4d-ffff-0000"),
            "ccpanes-1a2b3c4d"
        );
        assert_eq!(wsl_scope_unit_name("a-b-c"), "ccpanes-abc");
        assert_eq!(wsl_scope_unit_name("///"), "ccpanes-session");
        assert_eq!(wsl_scope_unit_file("1a2b3c4d"), "ccpanes-1a2b3c4d.scope");
    }

    #[test]
    fn batch_script_has_no_command_substitution() {
        assert!(!WSL_CGROUP_BATCH_SCRIPT.contains("$("));
        assert!(WSL_CGROUP_BATCH_SCRIPT.contains("ccpanes-*.scope"));
    }

    #[test]
    fn parses_batch_output_by_unit_and_ignores_foreign_scopes() {
        let readings = parse_cgroup_batch(SAMPLE);
        assert_eq!(
            readings,
            vec![
                CgroupReading {
                    unit: "ccpanes-1a2b3c4d.scope".into(),
                    memory_bytes: 2_147_483_648,
                    usage_usec: 5_000_000,
                },
                CgroupReading {
                    unit: "ccpanes-deadbeef.scope".into(),
                    memory_bytes: 1024,
                    usage_usec: 0,
                },
            ]
        );
        assert!(parse_cgroup_batch("").is_empty());
        assert!(parse_cgroup_batch("garbage\nmem=\n12\n").is_empty());
    }

    fn sampler(outputs: Vec<&'static str>, vm: bool) -> (WslCgroupSampler, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let sampler = WslCgroupSampler::with_runner(
            Box::new(move |_distro| {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                outputs.get(index).map(|s| s.to_string())
            }),
            Box::new(move || vm),
        );
        (sampler, calls)
    }

    #[test]
    fn zero_wsl_spawns_when_vm_is_not_running() {
        let (sampler, calls) = sampler(vec![SAMPLE], false);
        let usage = sampler.sample(&["Ubuntu".to_string()]);
        assert!(usage.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(sampler.spawn_count(), 0);
        // 没有 WSL 根时也不碰 wsl.exe（连 VM 探测都不做）。
        let (sampler, calls) = sampler_vm_panics();
        assert!(sampler.sample(&[]).is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    fn sampler_vm_panics() -> (WslCgroupSampler, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let sampler = WslCgroupSampler::with_runner(
            Box::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                None
            }),
            Box::new(|| panic!("vm gate must not be consulted without WSL roots")),
        );
        (sampler, calls)
    }

    #[test]
    fn one_spawn_per_distro_with_2s_cache_and_cpu_delta() {
        let second = "unit=ccpanes-1a2b3c4d.scope\nmem=\n3000\ncpu=\nusage_usec 6000000\nend=\n";
        let (sampler, calls) = sampler(vec![SAMPLE, second], true);
        let t0 = Instant::now();
        let first = sampler.sample_at(&["Ubuntu".to_string()], t0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let hot = first["ccpanes-1a2b3c4d.scope"];
        assert_eq!(hot.memory_bytes, 2_147_483_648);
        assert_eq!(hot.cpu_percent, 0.0, "first sample has no delta");

        // 1 s 内：缓存命中，不再起进程
        let cached = sampler.sample_at(&["Ubuntu".to_string()], t0 + Duration::from_secs(1));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cached["ccpanes-1a2b3c4d.scope"].memory_bytes, 2_147_483_648);

        // 2 s 后重新读：usage_usec 5s → 6s，经过 2 s → 50% CPU
        let t2 = t0 + Duration::from_secs(2);
        let fresh = sampler.sample_at(&["Ubuntu".to_string()], t2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let hot = fresh["ccpanes-1a2b3c4d.scope"];
        assert_eq!(hot.memory_bytes, 3000);
        assert!((hot.cpu_percent - 50.0).abs() < 0.5, "{}", hot.cpu_percent);
        assert_eq!(sampler.spawn_count(), 2);
    }

    #[test]
    fn runner_failure_yields_empty_but_still_counts_spawn() {
        let (sampler, _) = sampler(vec![], true);
        assert!(sampler.sample(&["Ubuntu".to_string()]).is_empty());
        assert_eq!(sampler.spawn_count(), 1);
    }
}
