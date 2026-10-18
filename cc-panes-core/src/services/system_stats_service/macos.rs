//! Read topology without asking sysinfo to refresh every process's arguments,
//! executable and thread information. Detailed sampling remains limited to the
//! selected family; topology enumeration does not mutate its sampling state.

use super::ProcessSnapshot;
use std::io;
use std::mem::{size_of, MaybeUninit};

mod diagnostics;
pub(super) use diagnostics::DiagnosticSampler;

fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    for _ in 0..3 {
        // SAFETY: a null buffer queries the required PID count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        let capacity = count as usize + 64;
        let mut pids = vec![0; capacity];
        let bytes = i32::try_from(capacity * size_of::<libc::pid_t>())
            .map_err(|_| io::Error::other("process list too large"))?;
        // SAFETY: the initialized vector has room for exactly `bytes` bytes.
        let written = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if written <= 0 {
            return Err(io::Error::last_os_error());
        }
        if (written as usize) < capacity {
            pids.truncate(written as usize);
            return Ok(pids);
        }
    }
    Err(io::Error::other("process list kept growing during capture"))
}

fn process_info(pid: libc::pid_t) -> Option<ProcessSnapshot> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    // SAFETY: libproc receives a correctly sized writable struct. Read it only
    // when the returned byte count confirms the entire struct was initialized.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if written != size_of::<libc::proc_bsdinfo>() as i32 {
        return None; // Process exited or is inaccessible; never fabricate a root.
    }
    let info = unsafe { info.assume_init() };
    Some(ProcessSnapshot {
        pid: info.pbi_pid,
        parent_pid: (info.pbi_ppid != 0).then_some(info.pbi_ppid),
        name: process_name(&info),
        command: String::new(),
        started_at: Some(info.pbi_start_tvsec),
        cpu_percent: 0.0,
        memory_bytes: 0,
    })
}

fn process_name(info: &libc::proc_bsdinfo) -> String {
    let name = if info.pbi_name[0] != 0 {
        &info.pbi_name[..]
    } else {
        &info.pbi_comm[..]
    };
    let bytes: Vec<u8> = name
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

pub(super) fn capture_topology() -> io::Result<Vec<ProcessSnapshot>> {
    Ok(process_ids()?
        .into_iter()
        .filter(|pid| *pid > 0)
        .filter_map(process_info)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_contains_current_process_and_parent_without_reading_arguments() {
        let processes = capture_topology().unwrap();
        let current = processes
            .iter()
            .find(|p| p.pid == std::process::id())
            .unwrap();
        assert_eq!(current.parent_pid, Some(unsafe { libc::getppid() } as u32));
        assert!(!current.name.is_empty());
        assert!(current.started_at.is_some_and(|time| time > 0));
        assert!(processes.iter().all(|p| p.command.is_empty()));
    }

    #[test]
    fn selected_process_cpu_remains_bounded_with_topology_sampling() {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
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
        let ids = [Pid::from_u32(child.0.id())];
        let mut system = System::new();
        for _ in 0..2 {
            super::super::capture_process_topology(&mut system);
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&ids),
                true,
                ProcessRefreshKind::nothing().with_cpu(),
            );
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        super::super::capture_process_topology(&mut system);
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&ids),
            true,
            ProcessRefreshKind::nothing().with_cpu(),
        );
        let cpu = system.process(ids[0]).unwrap().cpu_usage();
        // The optimization must preserve the one-core = 100% CPU convention.
        // One single-threaded child cannot consume many cores.
        assert!(cpu.is_finite() && (0.0..=150.0).contains(&cpu), "cpu={cpu}");
    }

    #[test]
    #[ignore = "manual macOS sampling benchmark; prints timings without a noisy CI threshold"]
    fn benchmark_topology() {
        use std::hint::black_box;
        use std::time::Instant;
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        let mut old = Vec::new();
        let mut new = Vec::new();
        for _ in 0..31 {
            let started = Instant::now();
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            black_box(super::super::capture_processes(&system));
            old.push(started.elapsed().as_micros());
            let started = Instant::now();
            black_box(capture_topology().unwrap());
            new.push(started.elapsed().as_micros());
        }
        old.sort_unstable();
        new.sort_unstable();
        println!("macos topology processes={} samples=31 old_p50_us={} old_p95_us={} new_p50_us={} new_p95_us={}", system.processes().len(), old[15], old[29], new[15], new[29]);
    }
}
