use crate::utils::{AppError, AppResult};
use std::ffi::OsString;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System, UpdateKind};

/// No environment contents are persisted or logged. The random marker only
/// identifies descendants of this explicit check, including setsid children.
pub(super) fn terminate(token: &str, root_pid: u32) -> AppResult<()> {
    let marker = OsString::from(format!("CCPANES_VERIFICATION_RUN_ID={token}"));
    let mut system = System::new();
    refresh(&mut system);
    if system.processes().is_empty() {
        return Err("Could not inspect verification processes for cleanup".into());
    }
    let mut uncertain = false;
    for _ in 0..3 {
        uncertain |= !signal_matching(&mut system, &marker, root_pid);
        std::thread::sleep(Duration::from_millis(20));
        refresh(&mut system);
        if !system.processes().values().any(|process| {
            process.status() != ProcessStatus::Zombie && process.environ().contains(&marker)
        }) {
            return if uncertain {
                Err("Verification process cleanup could not be fully confirmed".into())
            } else {
                Ok(())
            };
        }
    }
    Err(AppError::from(
        "Verification descendants remain after process cleanup",
    ))
}

fn refresh(system: &mut System) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
    );
}

fn signal_matching(system: &mut System, marker: &OsString, root_pid: u32) -> bool {
    let matches: Vec<_> = system
        .processes()
        .iter()
        .filter(|(_, process)| process.environ().contains(marker))
        .map(|(pid, process)| (*pid, process.start_time()))
        .collect();
    let mut confirmed = true;
    for (pid, started) in matches {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_environ(UpdateKind::Always),
        );
        let Some(process) = system.process(pid) else {
            continue;
        };
        // Recheck the start time AND nonce just before signalling a PID.
        if process.status() != ProcessStatus::Zombie
            && process.start_time() == started
            && process.environ().contains(marker)
        {
            // Only signal the group while a nonce-verified live member still
            // owns it; a reaped leader's numeric pgid alone could be reused.
            if unsafe { libc::getpgid(pid.as_u32() as i32) } == root_pid as i32 {
                confirmed &= unsafe { libc::killpg(root_pid as i32, libc::SIGKILL) } == 0;
            } else {
                confirmed &= process.kill_with(Signal::Kill) == Some(true);
            }
        }
    }
    confirmed
}
