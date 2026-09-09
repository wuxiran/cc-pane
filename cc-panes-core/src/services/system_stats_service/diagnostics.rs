use super::{capture_process_topology, ProcessIndex, SystemStatsService};
use serde::Serialize;

/// Numeric process telemetry only. Command lines are used for classification,
/// never returned or persisted (they may contain provider credentials).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticProcess {
    pub pid: u32,
    pub role: &'static str,
    pub resident_bytes: u64,
    pub private_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
}

fn role(pid: u32, app: u32, daemon: Option<u32>, command: &str) -> &'static str {
    if pid == app {
        return "app";
    }
    if Some(pid) == daemon {
        return "daemon";
    }
    if command.contains("--type=renderer") {
        return "renderer";
    }
    if command.contains("--type=gpu-process") {
        return "gpu";
    }
    "webview-or-helper"
}

impl SystemStatsService {
    /// Independent low-frequency recorder sampling; never walks PTY/CLI trees.
    pub fn get_diagnostic_processes(&self, daemon: Option<u32>) -> Vec<DiagnosticProcess> {
        let app = std::process::id();
        let mut system = self.system.lock();
        let topology = capture_process_topology(&mut system);
        let daemon = daemon.filter(|pid| {
            topology.iter().any(|p| {
                p.pid == *pid
                    && matches!(
                        p.name.to_ascii_lowercase().as_str(),
                        "cc-panes-daemon" | "cc-panes-daemon.exe"
                    )
            })
        });
        let family = ProcessIndex::new(&topology).descendants_including(app);
        let mut selected: Vec<_> = topology
            .iter()
            .filter(|p| {
                let name = p.name.to_ascii_lowercase();
                p.pid == app
                    || Some(p.pid) == daemon
                    || (family.contains(&p.pid)
                        && (name.contains("webview")
                            || name.contains("webkit")
                            || name == "cc-panes-web.exe"))
            })
            .collect();
        selected.sort_by_key(|p| p.pid != app && Some(p.pid) != daemon);
        selected.truncate(32);
        #[cfg(windows)]
        {
            sample_windows(
                &selected,
                app,
                daemon,
                &mut self.resource_process_sampler.lock(),
            )
        }
        #[cfg(not(windows))]
        {
            sample_unix(&selected, app, daemon, &mut system)
        }
    }
}

#[cfg(windows)]
fn sample_windows(
    processes: &[&super::ProcessSnapshot],
    app: u32,
    daemon: Option<u32>,
    sampler: &mut super::ResourceProcessSampler,
) -> Vec<DiagnosticProcess> {
    let now = std::time::Instant::now();
    let mut next = std::collections::HashMap::new();
    let samples = processes
        .iter()
        .filter_map(|p| {
            let details = super::windows::query_process_details(p.pid)?;
            let cpu_percent = details.cpu_times.and_then(|(creation, total)| {
                let percent = sampler
                    .cpu_samples
                    .get(&p.pid)
                    .filter(|old| old.creation_time_100ns == creation)
                    .map(|old| {
                        super::cpu_percent_since(
                            old.total_time_100ns,
                            total,
                            now.saturating_duration_since(old.sampled_at),
                        )
                    });
                next.insert(
                    p.pid,
                    super::WindowsCpuSample {
                        creation_time_100ns: creation,
                        total_time_100ns: total,
                        sampled_at: now,
                    },
                );
                percent
            });
            Some(DiagnosticProcess {
                pid: p.pid,
                role: role(p.pid, app, daemon, &details.command),
                resident_bytes: details.memory_bytes,
                private_bytes: details.private_bytes,
                cpu_percent,
            })
        })
        .collect();
    sampler.cpu_samples = next;
    samples
}

#[cfg(not(windows))]
fn sample_unix(
    processes: &[&super::ProcessSnapshot],
    app: u32,
    daemon: Option<u32>,
    system: &mut sysinfo::System,
) -> Vec<DiagnosticProcess> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
    let pids: Vec<_> = processes.iter().map(|p| Pid::from_u32(p.pid)).collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    processes
        .iter()
        .filter_map(|p| {
            let process = system.process(Pid::from_u32(p.pid))?;
            Some(DiagnosticProcess {
                pid: p.pid,
                role: role(p.pid, app, daemon, &p.command),
                resident_bytes: process.memory(),
                private_bytes: None,
                cpu_percent: Some(process.cpu_usage()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_never_serializes_command_line_secrets() {
        let process = DiagnosticProcess {
            pid: 3,
            role: role(
                3,
                1,
                Some(2),
                "msedgewebview2 --type=renderer --token=SECRET",
            ),
            resident_bytes: 5,
            private_bytes: Some(4),
            cpu_percent: None,
        };
        let json = serde_json::to_string(&process).unwrap();
        assert!(json.contains("renderer"));
        assert!(!json.contains("SECRET"));
        assert!(!json.contains("command"));
        assert_eq!(role(1, 1, Some(2), ""), "app");
        assert_eq!(role(2, 1, Some(2), ""), "daemon");
    }
}
