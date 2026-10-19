//! WebKit's XPC services are parented to launchd, not to the desktop app.
//! Attribute only known WebKit services whose responsibility PID AND resource
//! coalition match the app. A shared terminal coalition alone is insufficient.

use super::super::{diagnostics::DiagnosticProcess, ProcessSnapshot};
use std::collections::HashMap;
use std::mem::{size_of, MaybeUninit};
use std::sync::OnceLock;
use std::time::Instant;

// Apple XNU bsd/sys/proc_info_private.h (PROC_PIDCOALITIONINFO = 20) and
// osfmk/mach/coalition.h (RESOURCE = 0, NUM_TYPES = 2):
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
// The SPI is optional: an unsupported flavor/size fails closed. No entitlement,
// process arguments, task_for_pid access, or external command is required.
const PROC_PIDCOALITIONINFO: i32 = 20;
type ResponsiblePid = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity {
    seconds: u64,
    micros: u64,
}

impl Identity {
    fn from_bsd(info: &libc::proc_bsdinfo) -> Self {
        Self {
            seconds: info.pbi_start_tvsec,
            micros: info.pbi_start_tvusec,
        }
    }
}

#[derive(Clone, Copy)]
struct CpuSample {
    identity: Identity,
    total_ticks: u64,
    at: Instant,
}

#[derive(Default)]
pub(in super::super) struct DiagnosticSampler {
    previous: HashMap<u32, CpuSample>,
}

/// All callers use plain C integer structs and the matching libproc flavor.
unsafe fn pid_info<T>(pid: u32, flavor: i32) -> Option<T> {
    let pid = i32::try_from(pid).ok()?;
    let mut info = MaybeUninit::<T>::uninit();
    // SAFETY: caller guarantees the type matches this flavor; libproc receives
    // its complete writable size, and short/failed reads are never consumed.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            flavor,
            0,
            info.as_mut_ptr().cast(),
            size_of::<T>() as i32,
        )
    };
    (written == size_of::<T>() as i32).then(|| unsafe { info.assume_init() })
}

fn bsd_info(pid: u32) -> Option<libc::proc_bsdinfo> {
    // SAFETY: PROC_PIDTBSDINFO writes the public SDK's proc_bsdinfo layout.
    unsafe { pid_info(pid, libc::PROC_PIDTBSDINFO) }
}

fn resource_coalition(pid: u32) -> Option<u64> {
    // SAFETY: XNU defines two u64 coalition IDs followed by three reserved u64s.
    let info: [u64; 5] = unsafe { pid_info(pid, PROC_PIDCOALITIONINFO)? };
    (info[0] != 0).then_some(info[0])
}

fn responsible_pid(pid: u32) -> Option<u32> {
    static FUNCTION: OnceLock<Option<ResponsiblePid>> = OnceLock::new();
    let function = FUNCTION.get_or_init(|| {
        // Exported by libSystem/libquarantine in the macOS SDK's .tbd files.
        // Resolve once rather than hard-linking a private SPI: future systems
        // without it retain app/daemon samples, without guessing WebKit owners.
        let address = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        if address.is_null() {
            None
        } else {
            // SAFETY: libSystem's responsibility SPI takes and returns pid_t.
            Some(unsafe { std::mem::transmute::<*mut libc::c_void, ResponsiblePid>(address) })
        }
    });
    // SAFETY: the checked symbol has this signature and takes no pointers.
    let responsible = unsafe { function.as_ref()?(i32::try_from(pid).ok()?) };
    (responsible > 0).then_some(responsible as u32)
}

fn webkit_role(name: &str) -> Option<&'static str> {
    let service = name.strip_prefix("com.apple.WebKit.")?;
    match service.split('.').next()? {
        "WebContent" => Some("renderer"),
        "GPU" => Some("gpu"),
        "Networking" => Some("network"),
        _ => None,
    }
}

fn owned_webkit(
    app: u32,
    app_coalition: Option<u64>,
    responsible: Option<u32>,
    coalition: Option<u64>,
) -> bool {
    responsible == Some(app) && app_coalition.is_some() && coalition == app_coalition
}

// libc deprecates its Mach bindings in favor of a separate crate; the OS API
// remains supported. Keep this one binding with the existing libc dependency.
#[allow(deprecated)]
fn mach_timebase() -> Option<(u32, u32)> {
    static TIMEBASE: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *TIMEBASE.get_or_init(|| {
        let mut info = MaybeUninit::<libc::mach_timebase_info>::uninit();
        // SAFETY: the public SDK function writes the entire timebase on success.
        if unsafe { libc::mach_timebase_info(info.as_mut_ptr()) } != 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        (info.numer != 0 && info.denom != 0).then_some((info.numer, info.denom))
    })
}

fn cpu_percent(
    previous: Option<&CpuSample>,
    current: CpuSample,
    timebase: Option<(u32, u32)>,
) -> Option<f32> {
    let previous = previous.filter(|old| old.identity == current.identity)?;
    let elapsed = current
        .at
        .checked_duration_since(previous.at)?
        .as_secs_f64();
    let consumed = current.total_ticks.checked_sub(previous.total_ticks)?;
    let (numer, denom) = timebase.filter(|(numer, denom)| *numer != 0 && *denom != 0)?;
    // XNU osfmk/kern/bsd_kern.c fill_taskprocinfo uses recount_times_mach:
    // https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c
    // These are Mach ticks, not
    // nanoseconds. Subtract before converting, and multiply as f64 so long-lived
    // process counters cannot overflow when the timebase is e.g. 125 / 3.
    let consumed_ns = consumed as f64 * f64::from(numer) / f64::from(denom);
    (elapsed > 0.0).then(|| (consumed_ns / 1_000_000_000.0 / elapsed * 100.0) as f32)
}

impl DiagnosticSampler {
    pub(in super::super) fn sample(
        &mut self,
        topology: &[ProcessSnapshot],
        app: u32,
        daemon: Option<u32>,
    ) -> Vec<DiagnosticProcess> {
        let Some(app_info) = bsd_info(app) else {
            self.previous.clear();
            return Vec::new();
        };
        let app_identity = Identity::from_bsd(&app_info);
        let app_coalition = resource_coalition(app);
        let mut next = HashMap::new();
        let mut selected = Vec::new();
        // App/daemon first, then at most 30 attributed services. Only candidates
        // get native detail queries; no all-process CPU or argument refresh.
        let candidates = topology
            .iter()
            .filter(|p| p.pid == app || Some(p.pid) == daemon)
            .chain(topology.iter().filter(|p| {
                p.pid != app && Some(p.pid) != daemon && webkit_role(&p.name).is_some()
            }));
        for process in candidates {
            if let Some((reading, baseline)) =
                self.sample_process(process, app, daemon, app_coalition)
            {
                next.insert(process.pid, baseline);
                selected.push(reading);
                if selected.len() == 32 {
                    break;
                }
            }
        }
        // Also close the app-PID reuse race in out-of-process manual probes.
        if bsd_info(app).map(|p| Identity::from_bsd(&p)) != Some(app_identity) {
            selected.clear();
            next.clear();
        }
        self.previous = next;
        selected
    }

    fn sample_process(
        &self,
        process: &ProcessSnapshot,
        app: u32,
        daemon: Option<u32>,
        app_coalition: Option<u64>,
    ) -> Option<(DiagnosticProcess, CpuSample)> {
        let before = bsd_info(process.pid)?;
        if process.started_at != Some(before.pbi_start_tvsec)
            || process.name != super::process_name(&before)
        {
            return None;
        }
        let identity = Identity::from_bsd(&before);
        let role = if process.pid == app {
            "app"
        } else if Some(process.pid) == daemon {
            "daemon"
        } else {
            if !owned_webkit(
                app,
                app_coalition,
                responsible_pid(process.pid),
                resource_coalition(process.pid),
            ) {
                return None;
            }
            webkit_role(&process.name)?
        };
        // SAFETY: PROC_PIDTASKINFO writes the public SDK's proc_taskinfo layout.
        let task: libc::proc_taskinfo = unsafe { pid_info(process.pid, libc::PROC_PIDTASKINFO)? };
        let current = CpuSample {
            identity,
            total_ticks: task.pti_total_user.checked_add(task.pti_total_system)?,
            at: Instant::now(),
        };
        if bsd_info(process.pid).map(|p| Identity::from_bsd(&p)) != Some(identity) {
            return None;
        }
        Some((
            DiagnosticProcess {
                pid: process.pid,
                role,
                resident_bytes: task.pti_resident_size,
                private_bytes: None,
                cpu_percent: cpu_percent(self.previous.get(&process.pid), current, mach_timebase()),
            },
            current,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn xpc_ownership_requires_both_exact_app_and_known_coalition() {
        assert!(owned_webkit(1, Some(10), Some(1), Some(10)));
        assert!(!owned_webkit(1, Some(10), Some(2), Some(10)));
        assert!(!owned_webkit(1, Some(10), Some(1), Some(11)));
        assert!(!owned_webkit(1, None, Some(1), None));
        assert!(!owned_webkit(1, Some(10), None, Some(10)));
    }

    #[test]
    fn webkit_roles_use_service_names_and_support_development_variants() {
        assert_eq!(webkit_role("com.apple.WebKit.WebContent"), Some("renderer"));
        assert_eq!(
            webkit_role("com.apple.WebKit.WebContent.Development"),
            Some("renderer")
        );
        assert_eq!(webkit_role("com.apple.WebKit.GPU"), Some("gpu"));
        assert_eq!(webkit_role("com.apple.WebKit.Networking"), Some("network"));
        assert_eq!(webkit_role("com.apple.WebKit.GPUFake"), None);
        assert_eq!(webkit_role("other-webkit"), None);
    }

    #[test]
    fn cpu_baseline_rejects_reused_pids_resets_and_missing_samples() {
        let previous = CpuSample {
            identity: Identity {
                seconds: 1,
                micros: 1,
            },
            total_ticks: 100,
            at: Instant::now(),
        };
        let current = CpuSample {
            total_ticks: 1_000_000_100,
            at: previous.at + Duration::from_secs(1),
            ..previous
        };
        assert_eq!(
            cpu_percent(Some(&previous), current, Some((1, 1))),
            Some(100.0)
        );
        assert_eq!(cpu_percent(None, current, Some((1, 1))), None);
        assert_eq!(
            cpu_percent(
                Some(&previous),
                CpuSample {
                    identity: Identity {
                        seconds: 1,
                        micros: 2
                    },
                    ..current
                },
                Some((1, 1)),
            ),
            None
        );
        assert_eq!(cpu_percent(Some(&current), previous, Some((1, 1))), None);
        assert_eq!(
            cpu_percent(
                Some(&previous),
                CpuSample {
                    total_ticks: 1,
                    ..current
                },
                Some((1, 1)),
            ),
            None
        );
        assert_eq!(cpu_percent(Some(&previous), previous, Some((1, 1))), None);
    }

    #[test]
    fn native_samples_use_null_for_first_cpu_and_prune_stale_baselines() {
        let topology = super::super::capture_topology().unwrap();
        let mut sampler = DiagnosticSampler::default();
        let first = sampler.sample(&topology, std::process::id(), None);
        let app = first.iter().find(|p| p.role == "app").unwrap();
        assert!(app.resident_bytes > 0);
        assert_eq!(app.cpu_percent, None);
        assert!(serde_json::to_value(app).unwrap()["cpuPercent"].is_null());
        assert_eq!(sampler.previous.len(), first.len());
        assert!(sampler.sample(&topology, u32::MAX, None).is_empty());
        assert!(sampler.previous.is_empty());
    }

    #[test]
    fn cpu_converts_mach_tick_deltas_and_rejects_unavailable_timebase() {
        let previous = CpuSample {
            identity: Identity {
                seconds: 1,
                micros: 2,
            },
            total_ticks: u64::MAX - 24_000_000,
            at: Instant::now(),
        };
        let current = CpuSample {
            total_ticks: u64::MAX,
            at: previous.at + Duration::from_secs(1),
            ..previous
        };
        // Apple Silicon: 24 million Mach ticks represent one CPU second.
        assert_eq!(
            cpu_percent(Some(&previous), current, Some((125, 3))),
            Some(100.0)
        );
        assert_eq!(cpu_percent(Some(&previous), current, None), None);
        assert_eq!(cpu_percent(Some(&previous), current, Some((125, 0))), None);
        assert_eq!(cpu_percent(Some(&previous), current, Some((0, 3))), None);
    }

    #[test]
    #[ignore = "manual busy-loop CPU probe; timing-dependent lower bound is unsuitable for loaded CI"]
    fn probe_busy_process_cpu_units() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Child(
            std::process::Command::new("/bin/sh")
                .args(["-c", "while :; do :; done"])
                .spawn()
                .unwrap(),
        );
        std::thread::sleep(Duration::from_millis(100));
        let mut sampler = DiagnosticSampler::default();
        let topology = super::super::capture_topology().unwrap();
        sampler.sample(&topology, child.0.id(), None);
        std::thread::sleep(Duration::from_millis(600));
        let sample = sampler.sample(
            &super::super::capture_topology().unwrap(),
            child.0.id(),
            None,
        );
        let process = sample.iter().find(|p| p.pid == child.0.id()).unwrap();
        let cpu = process.cpu_percent.unwrap();
        println!(
            "timebase={:?} single_busy_thread_cpu_percent={cpu}",
            mach_timebase()
        );
        assert!((25.0..=150.0).contains(&cpu), "one busy thread cpu={cpu}");
    }

    #[test]
    #[ignore = "manual metadata-only probe: set CCPANES_DIAGNOSTIC_APP_PID to a running app PID"]
    fn probe_running_app_webkit() {
        let app: u32 = std::env::var("CCPANES_DIAGNOSTIC_APP_PID")
            .unwrap()
            .parse()
            .unwrap();
        let topology = super::super::capture_topology().unwrap();
        let mut sampler = DiagnosticSampler::default();
        let started = Instant::now();
        let first = sampler.sample(&topology, app, None);
        println!(
            "first_sample_us={} processes={}",
            started.elapsed().as_micros(),
            serde_json::to_string(&first).unwrap()
        );
        std::thread::sleep(Duration::from_millis(250));
        let started = Instant::now();
        let second = sampler.sample(&super::super::capture_topology().unwrap(), app, None);
        println!(
            "topology_and_second_sample_us={} processes={}",
            started.elapsed().as_micros(),
            serde_json::to_string(&second).unwrap()
        );
        assert!(second.iter().any(|p| p.role == "renderer"));
        assert!(second.iter().any(|p| p.role == "gpu"));
        for process in second.iter().filter(|p| p.role != "app") {
            assert_eq!(responsible_pid(process.pid), Some(app));
            assert_eq!(resource_coalition(process.pid), resource_coalition(app));
        }
    }
}
