use crate::models::{
    KillProcessResult, ManagedSessionRoot, OrphanProcessInfo, ResourceTree, SessionProcessInfo,
    SessionResourceUsage, SystemStats, TruncatedProcessSummary,
};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

mod diagnostics;

#[cfg(any(windows, test))]
mod process_math;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
use process_math::cpu_percent_since;

#[cfg(not(windows))]
use sysinfo::{Pid, UpdateKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ProcessIdentity {
    pid: u32,
    started_at: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct WindowsCpuSample {
    creation_time_100ns: u64,
    total_time_100ns: u64,
    sampled_at: std::time::Instant,
}

#[derive(Default)]
struct ResourceProcessSampler {
    known_family: HashSet<ProcessIdentity>,
    #[cfg(windows)]
    cpu_samples: HashMap<u32, WindowsCpuSample>,
}

#[derive(Debug, Clone)]
struct ProcessSnapshot {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    command: String,
    started_at: Option<u64>,
    cpu_percent: f32,
    memory_bytes: u64,
}

struct ProcessIndex<'a> {
    by_pid: HashMap<u32, &'a ProcessSnapshot>,
    children: HashMap<u32, Vec<u32>>,
}

impl<'a> ProcessIndex<'a> {
    fn new(processes: &'a [ProcessSnapshot]) -> Self {
        let mut by_pid = HashMap::with_capacity(processes.len());
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for process in processes {
            by_pid.insert(process.pid, process);
            if let Some(parent_pid) = process.parent_pid {
                children.entry(parent_pid).or_default().push(process.pid);
            }
        }
        Self { by_pid, children }
    }

    fn descendants_including(&self, root: u32) -> HashSet<u32> {
        let mut result = HashSet::new();
        let mut frontier = vec![root];
        while let Some(pid) = frontier.pop() {
            if !result.insert(pid) {
                continue;
            }
            if let Some(children) = self.children.get(&pid) {
                frontier.extend(children.iter().copied());
            }
        }
        result
    }

    fn ancestors_including(&self, pid: u32) -> HashSet<u32> {
        let mut result = HashSet::new();
        let mut current = Some(pid);
        while let Some(current_pid) = current {
            if !result.insert(current_pid) {
                break;
            }
            current = self
                .by_pid
                .get(&current_pid)
                .and_then(|process| process.parent_pid);
        }
        result
    }
}

/// 按调用采样整机资源，不创建线程或定时任务。
pub struct SystemStatsService {
    system: Mutex<System>,
    resource_process_sampler: Mutex<ResourceProcessSampler>,
}

impl Default for SystemStatsService {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemStatsService {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
            resource_process_sampler: Mutex::new(ResourceProcessSampler::default()),
        }
    }

    pub fn get_system_stats(&self) -> SystemStats {
        let mut system = self.system.lock();
        system.refresh_cpu_usage();
        system.refresh_memory();

        system_stats(&system)
    }

    /// 仅由前端资源管理器弹层按需调用，不创建后台线程或定时器。
    pub fn get_resource_tree(&self, sessions: &[ManagedSessionRoot]) -> ResourceTree {
        let started = std::time::Instant::now();
        let mut system = self.system.lock();
        let mut sampler = self.resource_process_sampler.lock();
        let processes =
            refresh_resource_snapshot(&mut system, std::process::id(), sessions, &mut sampler);
        let stats = system_stats(&system);
        let elapsed = started.elapsed().as_micros() as u64;
        let tree = build_resource_tree_from_snapshot(
            stats,
            &processes,
            sessions,
            std::process::id(),
            &sampler.known_family,
            elapsed,
        );
        tracing::debug!(
            elapsed_micros = tree.elapsed_micros,
            process_count = processes.len(),
            session_count = tree.sessions.len(),
            orphan_count = tree.orphans.len(),
            "[system-stats] resource tree sample completed"
        );
        tree
    }

    /// 重新枚举并二次判定，只允许终止当前仍被识别为孤立根节点的 PID。
    pub fn kill_orphan_processes(
        &self,
        pids: &[u32],
        sessions: &[ManagedSessionRoot],
    ) -> Vec<KillProcessResult> {
        let (processes, known_family) = {
            let mut system = self.system.lock();
            let mut sampler = self.resource_process_sampler.lock();
            let processes =
                refresh_resource_snapshot(&mut system, std::process::id(), sessions, &mut sampler);
            let known_family = sampler.known_family.clone();
            (processes, known_family)
        };
        kill_orphans_from_snapshot(
            &processes,
            sessions,
            pids,
            std::process::id(),
            &known_family,
            |pid| crate::pty::kill_process_tree_by_pid(pid).map_err(|error| error.to_string()),
        )
    }
}

fn refresh_resource_snapshot(
    system: &mut System,
    self_pid: u32,
    sessions: &[ManagedSessionRoot],
    sampler: &mut ResourceProcessSampler,
) -> Vec<ProcessSnapshot> {
    #[cfg(not(windows))]
    system.refresh_cpu_usage();
    system.refresh_memory();

    // Toolhelp / procfs 只建立 PID-parent-name 拓扑，再由 sysinfo 刷新相关 PID。
    let mut processes = capture_process_topology(system);
    let index = ProcessIndex::new(&processes);
    let family = family_pids(&processes, self_pid);
    let relevant = family
        .iter()
        .flat_map(|pid| index.descendants_including(*pid))
        .chain(
            sessions
                .iter()
                .flat_map(|session| index.descendants_including(session.root_pid)),
        )
        .chain(
            sampler
                .known_family
                .iter()
                .flat_map(|identity| index.descendants_including(identity.pid)),
        )
        .collect::<HashSet<_>>();
    #[cfg(windows)]
    windows::refresh_process_details(&mut processes, &relevant, sampler);
    #[cfg(not(windows))]
    if !relevant.is_empty() {
        let relevant_pids = relevant
            .iter()
            .copied()
            .map(Pid::from_u32)
            .collect::<Vec<_>>();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&relevant_pids),
            false,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_cmd(UpdateKind::OnlyIfNotSet),
        );
        for process in &mut processes {
            if !relevant.contains(&process.pid) {
                continue;
            }
            let Some(details) = system.process(Pid::from_u32(process.pid)) else {
                continue;
            };
            process.command = details
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            process.started_at = Some(details.start_time());
            process.cpu_percent = details.cpu_usage();
            process.memory_bytes = details.memory();
        }
    }
    remember_live_family_identities(&processes, self_pid, sampler);
    processes
}

fn remember_live_family_identities(
    processes: &[ProcessSnapshot],
    self_pid: u32,
    sampler: &mut ResourceProcessSampler,
) {
    sampler.known_family.extend(
        processes
            .iter()
            .filter(|process| process.pid == self_pid || is_cc_panes_family(&process.name))
            .filter_map(|process| {
                process.started_at.map(|started_at| ProcessIdentity {
                    pid: process.pid,
                    started_at,
                })
            }),
    );
}

fn system_stats(system: &System) -> SystemStats {
    SystemStats {
        cpu_percent: system.global_cpu_usage(),
        mem_used: system.used_memory(),
        mem_total: system.total_memory(),
    }
}

#[cfg(not(target_os = "linux"))]
fn capture_processes(system: &System) -> Vec<ProcessSnapshot> {
    system
        .processes()
        .iter()
        .map(|(pid, process)| ProcessSnapshot {
            pid: pid.as_u32(),
            parent_pid: process.parent().map(|parent| parent.as_u32()),
            name: process.name().to_string_lossy().into_owned(),
            command: process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            started_at: Some(process.start_time()),
            cpu_percent: process.cpu_usage(),
            memory_bytes: process.memory(),
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn capture_process_topology(_system: &mut System) -> Vec<ProcessSnapshot> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            let name_start = stat.find('(')? + 1;
            let name_end = stat.rfind(')')?;
            let name = stat.get(name_start..name_end)?.to_string();
            let parent_pid = stat
                .get(name_end + 1..)?
                .split_whitespace()
                .nth(1)?
                .parse::<u32>()
                .ok();
            Some(ProcessSnapshot {
                pid,
                parent_pid,
                name,
                command: String::new(),
                started_at: None,
                cpu_percent: 0.0,
                memory_bytes: 0,
            })
        })
        .collect()
}

#[cfg(windows)]
fn capture_process_topology(system: &mut System) -> Vec<ProcessSnapshot> {
    capture_windows_process_topology().unwrap_or_else(|error| {
        tracing::warn!(error = %error, "[system-stats] Toolhelp snapshot failed; using sysinfo fallback");
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        capture_processes(system)
    })
}

#[cfg(windows)]
fn capture_windows_process_topology() -> Result<Vec<ProcessSnapshot>, String> {
    use ::windows::Win32::Foundation::CloseHandle;
    use ::windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: the snapshot handle is closed after successful creation and
    // PROCESSENTRY32W.dwSize is initialized as required by Toolhelp.
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|error| error.to_string())?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut processes = Vec::new();
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                processes.push(ProcessSnapshot {
                    pid: entry.th32ProcessID,
                    parent_pid: (entry.th32ParentProcessID != 0)
                        .then_some(entry.th32ParentProcessID),
                    name: String::from_utf16_lossy(&entry.szExeFile[..name_len]),
                    command: String::new(),
                    started_at: None,
                    cpu_percent: 0.0,
                    memory_bytes: 0,
                });
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        CloseHandle(snapshot).map_err(|error| error.to_string())?;
        Ok(processes)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn capture_process_topology(system: &mut System) -> Vec<ProcessSnapshot> {
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    capture_processes(system)
}

/// 单会话明细条数上限。`cargo build` 能挂出上百个 rustc，全量回传会把每 3 秒一次的
/// 弹层轮询 payload 撑爆；超出部分聚合进 `truncated` 回传，不静默丢弃。
const SESSION_PROCESS_DETAIL_LIMIT: usize = 24;
/// 命令行截断长度。明细里的 command 只用于识别进程（tooltip），
/// 没必要每 3 秒把完整 rustc 命令行（常有数百字符）回传一遍。
const SESSION_PROCESS_COMMAND_LIMIT: usize = 200;

/// 按字符边界截断，避免在多字节字符中间切断（路径里有中文时会 panic）。
fn truncate_command(command: &str) -> String {
    if command.chars().count() <= SESSION_PROCESS_COMMAND_LIMIT {
        return command.to_string();
    }
    let mut truncated: String = command
        .chars()
        .take(SESSION_PROCESS_COMMAND_LIMIT)
        .collect();
    truncated.push('…');
    truncated
}

/// 把会话进程树摊成"谁在吃资源"的明细列表。
///
/// 按内存降序而不是按树形结构：用户展开明细是为了找元凶，不是为了看进程树形状。
fn session_process_detail(
    index: &ProcessIndex<'_>,
    pids: &HashSet<u32>,
) -> (Vec<SessionProcessInfo>, Option<TruncatedProcessSummary>) {
    let mut snapshots = pids
        .iter()
        .filter_map(|pid| index.by_pid.get(pid).copied())
        .collect::<Vec<_>>();
    // pid 作为次序键：HashSet 的迭代顺序不稳定，同内存的进程不加次序键会每次刷新都跳位。
    snapshots.sort_by(|left, right| {
        right
            .memory_bytes
            .cmp(&left.memory_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });

    let truncated = if snapshots.len() > SESSION_PROCESS_DETAIL_LIMIT {
        let rest = &snapshots[SESSION_PROCESS_DETAIL_LIMIT..];
        Some(TruncatedProcessSummary {
            process_count: rest.len() as u32,
            cpu_percent: rest.iter().map(|process| process.cpu_percent).sum(),
            memory_bytes: rest.iter().map(|process| process.memory_bytes).sum(),
        })
    } else {
        None
    };

    snapshots.truncate(SESSION_PROCESS_DETAIL_LIMIT);
    let processes = snapshots
        .into_iter()
        .map(|process| SessionProcessInfo {
            pid: process.pid,
            parent_pid: process.parent_pid,
            name: process.name.clone(),
            command: truncate_command(&process.command),
            cpu_percent: process.cpu_percent,
            memory_bytes: process.memory_bytes,
        })
        .collect();

    (processes, truncated)
}

fn build_resource_tree_from_snapshot(
    system: SystemStats,
    processes: &[ProcessSnapshot],
    sessions: &[ManagedSessionRoot],
    self_pid: u32,
    known_family: &HashSet<ProcessIdentity>,
    elapsed_micros: u64,
) -> ResourceTree {
    let index = ProcessIndex::new(processes);
    let family = family_pids(processes, self_pid);
    let analysis = analyze_process_ownership(&index, processes, sessions, &family, known_family);
    let mut assigned = HashSet::new();
    // 嵌套 session 根会让进程树重叠；先让更深（更具体）的根认领，避免结果依赖
    // TerminalService 的 HashMap 迭代顺序。相同深度再按 session_id 固定顺序。
    let mut ordered_sessions = sessions
        .iter()
        .map(|session| (index.ancestors_including(session.root_pid).len(), session))
        .collect::<Vec<_>>();
    ordered_sessions.sort_by(|(left_depth, left), (right_depth, right)| {
        right_depth
            .cmp(left_depth)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    let mut session_usage = ordered_sessions
        .into_iter()
        .map(|(_, session)| {
            let owned = index.descendants_including(session.root_pid);
            let process_ids = owned
                .into_iter()
                .filter(|pid| assigned.insert(*pid))
                .collect::<HashSet<_>>();
            let (cpu_percent, memory_bytes) = aggregate(&index, &process_ids);
            let (processes, truncated) = session_process_detail(&index, &process_ids);
            SessionResourceUsage {
                session_id: session.session_id.clone(),
                root_pid: session.root_pid,
                cpu_percent,
                memory_bytes,
                process_count: process_ids
                    .iter()
                    .filter(|pid| index.by_pid.contains_key(pid))
                    .count() as u32,
                processes,
                truncated,
            }
        })
        .collect::<Vec<_>>();
    session_usage.sort_by(|left, right| left.session_id.cmp(&right.session_id));

    let mut orphans = orphan_roots(&index, processes, &analysis)
        .into_iter()
        .filter_map(|pid| {
            let root = index.by_pid.get(&pid)?;
            let tree = index.descendants_including(pid);
            let (cpu_percent, memory_bytes) = aggregate(&index, &tree);
            Some(OrphanProcessInfo {
                pid,
                name: root.name.clone(),
                command: root.command.clone(),
                cpu_percent,
                memory_bytes,
                process_count: tree
                    .iter()
                    .filter(|tree_pid| index.by_pid.contains_key(tree_pid))
                    .count() as u32,
            })
        })
        .collect::<Vec<_>>();
    orphans.sort_by_key(|orphan| orphan.pid);

    let app_memory_bytes = family
        .iter()
        .filter_map(|pid| index.by_pid.get(pid))
        .map(|process| process.memory_bytes)
        .sum();
    let app_memory_percent = if system.mem_total == 0 {
        0.0
    } else {
        app_memory_bytes as f32 / system.mem_total as f32 * 100.0
    };

    ResourceTree {
        system,
        app_memory_bytes,
        app_memory_percent,
        sessions: session_usage,
        orphans,
        sampled_at: now_millis(),
        elapsed_micros,
    }
}

struct OwnershipAnalysis {
    protected_family: HashSet<u32>,
    managed: HashSet<u32>,
    managed_context: HashSet<u32>,
    dead_family_descendants: HashSet<u32>,
}

fn analyze_process_ownership(
    index: &ProcessIndex<'_>,
    processes: &[ProcessSnapshot],
    sessions: &[ManagedSessionRoot],
    family: &HashSet<u32>,
    known_family: &HashSet<ProcessIdentity>,
) -> OwnershipAnalysis {
    let protected_family = family
        .iter()
        .flat_map(|pid| index.ancestors_including(*pid))
        .chain(
            family
                .iter()
                .flat_map(|pid| live_family_descendants(index, *pid)),
        )
        .collect();
    let managed = sessions
        .iter()
        .flat_map(|session| index.descendants_including(session.root_pid))
        .collect::<HashSet<_>>();
    let managed_context = sessions
        .iter()
        .flat_map(|session| index.ancestors_including(session.root_pid))
        .chain(managed.iter().copied())
        .collect();
    let dead_family_descendants = known_family
        .iter()
        .flat_map(|identity| dead_family_descendants(index, *identity))
        .collect();
    debug_assert!(processes.len() >= family.len());
    OwnershipAnalysis {
        protected_family,
        managed,
        managed_context,
        dead_family_descendants,
    }
}

fn live_family_descendants(index: &ProcessIndex<'_>, root_pid: u32) -> HashSet<u32> {
    let root_started_at = index
        .by_pid
        .get(&root_pid)
        .and_then(|process| process.started_at);
    descendants_with_valid_start_order(index, root_pid, root_started_at)
}

fn dead_family_descendants(index: &ProcessIndex<'_>, identity: ProcessIdentity) -> HashSet<u32> {
    let replacement = index.by_pid.get(&identity.pid).copied();
    if replacement.and_then(|process| process.started_at) == Some(identity.started_at) {
        return HashSet::new();
    }
    let replacement_started_at = match replacement {
        Some(process) => match process.started_at {
            Some(started_at) => Some(started_at),
            None => return HashSet::new(),
        },
        None => None,
    };
    let mut descendants = HashSet::new();
    let mut frontier = index
        .children
        .get(&identity.pid)
        .cloned()
        .unwrap_or_default();
    while let Some(pid) = frontier.pop() {
        let Some(process) = index.by_pid.get(&pid).copied() else {
            continue;
        };
        let Some(started_at) = process.started_at else {
            continue;
        };
        if process.parent_pid == Some(identity.pid)
            && (started_at < identity.started_at
                || replacement_started_at.is_some_and(|replacement| started_at >= replacement))
        {
            continue;
        }
        if !descendants.insert(pid) {
            continue;
        }
        if let Some(children) = index.children.get(&pid) {
            frontier.extend(children.iter().copied().filter(|child_pid| {
                index
                    .by_pid
                    .get(child_pid)
                    .and_then(|child| child.started_at)
                    .is_some_and(|child_started_at| child_started_at >= started_at)
            }));
        }
    }
    descendants
}

fn descendants_with_valid_start_order(
    index: &ProcessIndex<'_>,
    root_pid: u32,
    root_started_at: Option<u64>,
) -> HashSet<u32> {
    let mut descendants = HashSet::new();
    let mut frontier = vec![(root_pid, root_started_at)];
    while let Some((pid, parent_started_at)) = frontier.pop() {
        if !descendants.insert(pid) {
            continue;
        }
        if let Some(children) = index.children.get(&pid) {
            for child_pid in children {
                let child_started_at = index
                    .by_pid
                    .get(child_pid)
                    .and_then(|child| child.started_at);
                let valid = match (parent_started_at, child_started_at) {
                    (Some(parent), Some(child)) => child >= parent,
                    (_, None) => true,
                    (None, Some(_)) => true,
                };
                if valid {
                    frontier.push((*child_pid, child_started_at));
                }
            }
        }
    }
    descendants
}

fn family_pids(processes: &[ProcessSnapshot], self_pid: u32) -> HashSet<u32> {
    processes
        .iter()
        .filter(|process| process.pid == self_pid || is_cc_panes_family(&process.name))
        .map(|process| process.pid)
        .collect()
}

fn is_cc_panes_family(name: &str) -> bool {
    matches!(
        normalized_process_name(name).as_str(),
        "cc-panes" | "cc-panes-daemon" | "cc-panes-web" | "cc-panes-cli-hook" | "cc-panes-cli-ho"
    )
}

fn normalized_process_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .to_string()
}

fn is_terminal_process(process: &ProcessSnapshot) -> bool {
    matches!(
        normalized_process_name(&process.name).as_str(),
        "conhost"
            | "openconsole"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "bash"
            | "sh"
            | "zsh"
            | "fish"
            | "nu"
            | "wsl"
            | "wslhost"
            | "node"
            | "deno"
            | "bun"
            | "claude"
            | "codex"
            | "gemini"
            | "kimi"
            | "opencode"
            | "cursor"
            | "grok"
    )
}

fn is_whitelisted_process(process: &ProcessSnapshot) -> bool {
    let command = process.command.to_ascii_lowercase();
    let mcp = [
        "mcp-server",
        "mcp_server",
        "model-context-protocol",
        "cc-memory-mcp",
    ]
    .iter()
    .any(|pattern| command.contains(pattern));
    let dev_server = [
        "npm run dev",
        "pnpm run dev",
        "pnpm dev",
        "yarn dev",
        "bun dev",
        "vite",
        "webpack-dev-server",
        "next dev",
        "tauri dev",
        "cargo watch",
    ]
    .iter()
    .any(|pattern| command.contains(pattern));
    let package_manager = [
        "npm install",
        "npm ci",
        "npm update",
        "npm-cli.js install",
        "npm-cli.js ci",
        "pnpm install",
        "pnpm add",
        "yarn install",
        "yarn add",
        "bun install",
        "cargo install",
    ]
    .iter()
    .any(|pattern| command.contains(pattern));
    mcp || dev_server || package_manager
}

fn branch_contains_whitelist(index: &ProcessIndex<'_>, root: u32) -> bool {
    index
        .descendants_including(root)
        .iter()
        .filter_map(|pid| index.by_pid.get(pid))
        .any(|process| is_whitelisted_process(process))
}

fn orphan_roots(
    index: &ProcessIndex<'_>,
    processes: &[ProcessSnapshot],
    analysis: &OwnershipAnalysis,
) -> HashSet<u32> {
    let eligible = processes
        .iter()
        .filter(|process| analysis.dead_family_descendants.contains(&process.pid))
        .filter(|process| !analysis.protected_family.contains(&process.pid))
        .filter(|process| !analysis.managed_context.contains(&process.pid))
        .filter(|process| is_terminal_process(process))
        .filter(|process| !branch_contains_whitelist(index, process.pid))
        .map(|process| process.pid)
        .collect::<HashSet<_>>();

    eligible
        .iter()
        .filter(|pid| {
            let mut ancestors = index.ancestors_including(**pid);
            ancestors.remove(pid);
            ancestors.is_disjoint(&eligible)
        })
        .copied()
        .collect()
}

fn aggregate(index: &ProcessIndex<'_>, pids: &HashSet<u32>) -> (f32, u64) {
    pids.iter()
        .filter_map(|pid| index.by_pid.get(pid))
        .fold((0.0, 0), |(cpu, memory), process| {
            (cpu + process.cpu_percent, memory + process.memory_bytes)
        })
}

fn kill_orphans_from_snapshot<F>(
    processes: &[ProcessSnapshot],
    sessions: &[ManagedSessionRoot],
    pids: &[u32],
    self_pid: u32,
    known_family: &HashSet<ProcessIdentity>,
    mut kill: F,
) -> Vec<KillProcessResult>
where
    F: FnMut(u32) -> Result<(), String>,
{
    let index = ProcessIndex::new(processes);
    let family = family_pids(processes, self_pid);
    let analysis = analyze_process_ownership(&index, processes, sessions, &family, known_family);
    let allowed = orphan_roots(&index, processes, &analysis);
    let mut seen = HashSet::new();

    pids.iter()
        .map(|pid| {
            let guard_error = if !seen.insert(*pid) {
                Some("duplicate pid".to_string())
            } else if *pid == self_pid || family.contains(pid) {
                Some("protected CC-Panes process".to_string())
            } else if analysis.managed.contains(pid) || analysis.managed_context.contains(pid) {
                Some("managed session process".to_string())
            } else if analysis.protected_family.contains(pid) {
                Some("protected CC-Panes process".to_string())
            } else if !allowed.contains(pid) {
                Some("not a current orphan process".to_string())
            } else {
                None
            };

            if let Some(error) = guard_error {
                return KillProcessResult {
                    pid: *pid,
                    success: false,
                    error: Some(error),
                };
            }

            match kill(*pid) {
                Ok(()) => KillProcessResult {
                    pid: *pid,
                    success: true,
                    error: None,
                },
                Err(error) => KillProcessResult {
                    pid: *pid,
                    success: false,
                    error: Some(error),
                },
            }
        })
        .collect()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests;
