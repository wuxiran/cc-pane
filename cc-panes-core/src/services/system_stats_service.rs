use crate::models::{
    KillProcessResult, ManagedSessionRoot, OrphanProcessInfo, ResourceTree, SessionResourceUsage,
    SystemStats,
};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone)]
struct ProcessSnapshot {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    command: String,
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
        let processes = refresh_resource_snapshot(&mut system, std::process::id(), sessions);
        let stats = system_stats(&system);
        let elapsed = started.elapsed().as_micros() as u64;
        let tree = build_resource_tree_from_snapshot(
            stats,
            &processes,
            sessions,
            std::process::id(),
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
        let processes = {
            let mut system = self.system.lock();
            refresh_resource_snapshot(&mut system, std::process::id(), sessions)
        };
        kill_orphans_from_snapshot(&processes, sessions, pids, std::process::id(), |pid| {
            crate::pty::kill_process_tree_by_pid(pid).map_err(|error| error.to_string())
        })
    }
}

fn refresh_resource_snapshot(
    system: &mut System,
    self_pid: u32,
    sessions: &[ManagedSessionRoot],
) -> Vec<ProcessSnapshot> {
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
        .collect::<HashSet<_>>();
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
            process.cpu_percent = details.cpu_usage();
            process.memory_bytes = details.memory();
        }
    }
    processes
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
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
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

fn build_resource_tree_from_snapshot(
    system: SystemStats,
    processes: &[ProcessSnapshot],
    sessions: &[ManagedSessionRoot],
    self_pid: u32,
    elapsed_micros: u64,
) -> ResourceTree {
    let index = ProcessIndex::new(processes);
    let family = family_pids(processes, self_pid);
    let analysis = analyze_process_ownership(&index, processes, sessions, &family);
    let mut assigned = HashSet::new();
    let mut session_usage = sessions
        .iter()
        .map(|session| {
            let owned = index.descendants_including(session.root_pid);
            let process_ids = owned
                .into_iter()
                .filter(|pid| assigned.insert(*pid))
                .collect::<HashSet<_>>();
            let (cpu_percent, memory_bytes) = aggregate(&index, &process_ids);
            SessionResourceUsage {
                session_id: session.session_id.clone(),
                root_pid: session.root_pid,
                cpu_percent,
                memory_bytes,
                process_count: process_ids
                    .iter()
                    .filter(|pid| index.by_pid.contains_key(pid))
                    .count() as u32,
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
    family_descendants: HashSet<u32>,
}

fn analyze_process_ownership(
    index: &ProcessIndex<'_>,
    processes: &[ProcessSnapshot],
    sessions: &[ManagedSessionRoot],
    family: &HashSet<u32>,
) -> OwnershipAnalysis {
    let protected_family = family
        .iter()
        .flat_map(|pid| index.ancestors_including(*pid))
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
    let family_descendants = family
        .iter()
        .flat_map(|pid| index.descendants_including(*pid))
        .collect();
    debug_assert!(processes.len() >= family.len());
    OwnershipAnalysis {
        protected_family,
        managed,
        managed_context,
        family_descendants,
    }
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
        .filter(|process| analysis.family_descendants.contains(&process.pid))
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
    mut kill: F,
) -> Vec<KillProcessResult>
where
    F: FnMut(u32) -> Result<(), String>,
{
    let index = ProcessIndex::new(processes);
    let family = family_pids(processes, self_pid);
    let analysis = analyze_process_ownership(&index, processes, sessions, &family);
    let allowed = orphan_roots(&index, processes, &analysis);
    let mut seen = HashSet::new();

    pids.iter()
        .map(|pid| {
            let guard_error = if !seen.insert(*pid) {
                Some("duplicate pid".to_string())
            } else if *pid == self_pid || analysis.protected_family.contains(pid) {
                Some("protected CC-Panes process".to_string())
            } else if analysis.managed.contains(pid) || analysis.managed_context.contains(pid) {
                Some("managed session process".to_string())
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
mod tests {
    use super::*;
    use crate::models::ManagedSessionRoot;

    fn process(
        pid: u32,
        parent_pid: Option<u32>,
        name: &str,
        command: &str,
        cpu_percent: f32,
        memory_bytes: u64,
    ) -> ProcessSnapshot {
        ProcessSnapshot {
            pid,
            parent_pid,
            name: name.to_string(),
            command: command.to_string(),
            cpu_percent,
            memory_bytes,
        }
    }

    fn snapshot() -> Vec<ProcessSnapshot> {
        vec![
            process(1, None, "explorer.exe", "explorer.exe", 0.0, 1_000),
            process(10, Some(1), "cc-panes.exe", "cc-panes.exe", 1.0, 100),
            // Active session: its ConPTY ancestor must not be reported as orphaned.
            process(
                19,
                Some(10),
                "conhost.exe",
                "conhost.exe --headless",
                1.0,
                10,
            ),
            process(20, Some(19), "pwsh.exe", "pwsh.exe", 10.0, 50),
            process(21, Some(20), "codex.exe", "codex.exe", 20.0, 100),
            // Genuine orphan terminal tree.
            process(
                30,
                Some(10),
                "conhost.exe",
                "conhost.exe --headless",
                2.0,
                20,
            ),
            process(31, Some(30), "powershell.exe", "powershell.exe", 3.0, 30),
            // Conservative exclusions: MCP, dev server, and active package manager.
            process(40, Some(10), "node.exe", "node mcp-server.js", 4.0, 40),
            process(50, Some(10), "cmd.exe", "cmd /c npm run dev", 5.0, 50),
            process(51, Some(50), "node.exe", "node vite.js", 6.0, 60),
            process(60, Some(10), "node.exe", "node npm-cli.js install", 7.0, 70),
        ]
    }

    #[test]
    fn resource_tree_aggregates_managed_session_descendants_once() {
        let tree = build_resource_tree_from_snapshot(
            SystemStats {
                cpu_percent: 50.0,
                mem_used: 4_000,
                mem_total: 10_000,
            },
            &snapshot(),
            &[ManagedSessionRoot {
                session_id: "session-1".to_string(),
                root_pid: 20,
            }],
            10,
            250,
        );

        assert_eq!(tree.sessions.len(), 1);
        assert_eq!(tree.sessions[0].session_id, "session-1");
        assert_eq!(tree.sessions[0].root_pid, 20);
        assert_eq!(tree.sessions[0].process_count, 2);
        assert_eq!(tree.sessions[0].cpu_percent, 30.0);
        assert_eq!(tree.sessions[0].memory_bytes, 150);
        assert_eq!(tree.app_memory_bytes, 100);
        assert_eq!(tree.app_memory_percent, 1.0);
        assert_eq!(tree.elapsed_micros, 250);
    }

    #[test]
    fn orphan_detection_excludes_active_conpty_family_and_whitelisted_branches() {
        let tree = build_resource_tree_from_snapshot(
            SystemStats {
                cpu_percent: 0.0,
                mem_used: 0,
                mem_total: 1_000,
            },
            &snapshot(),
            &[ManagedSessionRoot {
                session_id: "session-1".to_string(),
                root_pid: 20,
            }],
            10,
            0,
        );

        let orphan = tree.orphans.first().expect("one conservative orphan root");
        assert_eq!(tree.orphans.len(), 1);
        assert_eq!(orphan.pid, 30);
        assert_eq!(orphan.process_count, 2);
        assert_eq!(orphan.cpu_percent, 5.0);
        assert_eq!(orphan.memory_bytes, 50);
    }

    #[test]
    fn kill_guard_rejects_self_managed_unknown_and_reports_partial_failure() {
        let sessions = [ManagedSessionRoot {
            session_id: "session-1".to_string(),
            root_pid: 20,
        }];
        let results =
            kill_orphans_from_snapshot(&snapshot(), &sessions, &[10, 20, 30, 999], 10, |pid| {
                if pid == 30 {
                    Err("simulated taskkill failure".to_string())
                } else {
                    Ok(())
                }
            });

        assert_eq!(results.len(), 4);
        assert!(!results[0].success);
        assert!(results[0].error.as_deref().unwrap().contains("protected"));
        assert!(!results[1].success);
        assert!(results[1]
            .error
            .as_deref()
            .unwrap()
            .contains("managed session"));
        assert!(!results[2].success);
        assert_eq!(
            results[2].error.as_deref(),
            Some("simulated taskkill failure")
        );
        assert!(!results[3].success);
        assert!(results[3]
            .error
            .as_deref()
            .unwrap()
            .contains("current orphan"));
    }

    #[test]
    fn live_resource_tree_enumeration_stays_within_budget() {
        let service = SystemStatsService::new();
        let tree = service.get_resource_tree(&[]);
        println!(
            "resource tree enumeration: {} us ({} sessions, {} orphans)",
            tree.elapsed_micros,
            tree.sessions.len(),
            tree.orphans.len()
        );
        assert!(
            tree.app_memory_bytes > 0,
            "self process resources were not refreshed"
        );

        assert!(
            tree.elapsed_micros < 100_000,
            "resource tree enumeration exceeded 100ms budget: {} us",
            tree.elapsed_micros
        );
    }
}
