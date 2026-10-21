use std::io;
use std::mem::{size_of, MaybeUninit};

/// Darwin's killpg returns EPERM when its group contains only zombies: XNU
/// excludes SZOMB members before counting signal recipients (kern_sig.c).
/// Do not generalize that to real permission failures, or reap the owned group
/// leader early: its unreaped PID still protects the group against reuse.
pub(super) fn confirmed_finished_group(error: &io::Error, exited: bool, pgid: i32) -> bool {
    error.raw_os_error() == Some(libc::EPERM)
        && exited
        && group_members(pgid)
            .and_then(|members| all_members_finished(pgid, &members, process_status))
            .unwrap_or(false)
}

fn group_members(pgid: i32) -> io::Result<Vec<i32>> {
    let mut capacity = 32;
    loop {
        let mut members = vec![0i32; capacity];
        // The libproc wrapper returns a PID count, while its buffer size is bytes.
        // https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c
        let count = unsafe {
            libc::proc_listpgrppids(
                pgid,
                members.as_mut_ptr().cast(),
                (members.len() * size_of::<i32>()) as i32,
            )
        };
        if count <= 0 {
            return Err(io::Error::other(
                "Could not inspect verification process group",
            ));
        }
        if (count as usize) < members.len() {
            members.truncate(count as usize);
            return Ok(members);
        }
        // A full buffer can be truncated; never use it to assert complete cleanup.
        if capacity >= 32_768 {
            return Err(io::Error::other(
                "Verification process group listing was truncated",
            ));
        }
        capacity *= 2;
    }
}

fn process_status(pid: i32) -> io::Result<Option<(i32, u32)>> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    // PROC_PIDTBSDINFO writes this public SDK layout. Darwin may report ESRCH
    // for zombies as well as reaped members; neither can execute further work.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        let error = io::Error::last_os_error();
        return if written == 0 && error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(io::Error::other(format!(
                "Could not inspect verification process {pid}: {error}"
            )))
        };
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid as u32 {
        return Err(io::Error::other("Verification process identity changed"));
    }
    Ok(Some((info.pbi_pgid as i32, info.pbi_status)))
}

fn all_members_finished(
    pgid: i32,
    members: &[i32],
    mut status: impl FnMut(i32) -> io::Result<Option<(i32, u32)>>,
) -> io::Result<bool> {
    // The owned, unreaped leader must be present; empty/partial results are not proof.
    if !members.contains(&pgid) {
        return Ok(false);
    }
    for &pid in members {
        // waitid(WEXITED | WNOWAIT) already proved that the owned leader exited.
        // It remains unreaped throughout this check; proc_pidinfo may hide it.
        if pid == pgid {
            continue;
        }
        match status(pid)? {
            Some((group, libc::SZOMB)) if group == pgid => {}
            None => {} // Another member exited or was reaped after enumeration.
            _ => return Ok(false),
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_group_of_finished_members_is_accepted() {
        assert!(all_members_finished(10, &[10, 11], |_| Ok(Some((10, libc::SZOMB)))).unwrap());
        assert!(!all_members_finished(10, &[], |_| unreachable!()).unwrap());
        assert!(!all_members_finished(10, &[11], |_| unreachable!()).unwrap());
        assert!(all_members_finished(10, &[10], |_| unreachable!()).unwrap());
        assert!(!all_members_finished(10, &[10, 11], |_| Ok(Some((20, libc::SZOMB)))).unwrap());
        assert!(!all_members_finished(10, &[10, 11], |pid| {
            Ok(Some((10, if pid == 10 { libc::SZOMB } else { libc::SRUN })))
        })
        .unwrap());
        assert!(all_members_finished(10, &[10, 11], |pid| {
            Ok((pid == 10).then_some((10, libc::SZOMB)))
        })
        .unwrap());
    }

    #[test]
    fn inspection_and_permission_errors_are_not_success() {
        let denied = || io::Error::from_raw_os_error(libc::EPERM);
        assert!(all_members_finished(10, &[10, 11], |_| Err(denied())).is_err());
        assert!(!confirmed_finished_group(&denied(), false, -1));
        assert!(!confirmed_finished_group(&denied(), true, -1));
        assert!(!confirmed_finished_group(
            &io::Error::from_raw_os_error(libc::EACCES),
            true,
            -1
        ));
    }

    #[test]
    fn owned_exited_shell_is_confirmed_without_reaping() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let observed = loop {
            if super::super::observe_child(pid).unwrap() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        let confirmed = observed
            && confirmed_finished_group(
                &io::Error::from_raw_os_error(libc::EPERM),
                true,
                pid as i32,
            );
        let members = group_members(pid as i32);
        let state = process_status(pid as i32);
        // Always collect the owned fixture before asserting, including on failure.
        let _ = child.kill();
        let status = child.wait().unwrap();
        assert!(observed);
        assert!(confirmed, "group members: {members:?}, leader: {state:?}");
        assert!(status.success());
    }
}
