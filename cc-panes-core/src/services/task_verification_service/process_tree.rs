use crate::utils::AppResult;
use tokio::process::{Child, Command};

#[cfg(target_os = "macos")]
mod macos;

pub(super) fn configure(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        // Assign the suspended child to a job before it can create descendants.
        command.creation_flags(0x08000000 | 0x00000004);
    }
}

pub(super) struct ProcessTree {
    #[cfg(unix)]
    pgid: i32,
    #[cfg(unix)]
    token: String,
    killed: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    job: windows::Win32::Foundation::HANDLE,
}

impl ProcessTree {
    #[cfg(unix)]
    pub(super) fn attach(child: &Child, token: String) -> AppResult<Self> {
        Ok(Self {
            pgid: child.id().ok_or("Verification process already exited")? as i32,
            token,
            killed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    #[cfg(unix)]
    pub(super) fn kill(&self) -> AppResult<()> {
        if self.killed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Ok(());
        }
        // The runner observes exit with WNOWAIT, retaining the unreaped child
        // identity until cleanup finishes. Platform binaries may hide environ
        // on macOS, so ordinary group cleanup must not depend on the nonce.
        let group_result = observe_child(self.pgid as u32).and_then(|_exited| {
            if unsafe { libc::killpg(self.pgid, libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    #[cfg(target_os = "macos")]
                    if macos::confirmed_finished_group(&error, _exited, self.pgid) {
                        return Ok(());
                    }
                    Err(error)
                }
            }
        });
        let detached = super::unix_cleanup::terminate(&self.token, self.pgid as u32);
        group_result
            .map_err(crate::utils::AppError::from)
            .and(detached)
    }

    #[cfg(windows)]
    pub(super) fn attach(child: &Child, _token: String) -> AppResult<Self> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let raw = child
            .raw_handle()
            .ok_or("Missing verification process handle")?;
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(win_error)?;
        let guard = Self {
            job,
            killed: std::sync::atomic::AtomicBool::new(false),
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(win_error)?;
            AssignProcessToJobObject(job, HANDLE(raw)).map_err(win_error)?;
        }
        resume_child(child.id().ok_or("Verification process already exited")?)?;
        Ok(guard)
    }

    #[cfg(windows)]
    pub(super) fn kill(&self) -> AppResult<()> {
        if self.killed.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Ok(());
        }
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self.job, 1) }
            .map_err(win_error)
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        let _ = self.kill();
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(windows)]
fn win_error(error: windows::core::Error) -> crate::utils::AppError {
    crate::utils::AppError::from(error.to_string())
}

/// std/tokio do not expose the primary thread handle, so locate that suspended
/// thread using Toolhelp. No user code runs until the job assignment succeeds.
#[cfg(windows)]
fn resume_child(pid: u32) -> AppResult<()> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(win_error)?;
    let result = (|| {
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        unsafe { Thread32First(snapshot, &mut entry) }.map_err(win_error)?;
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                        .map_err(win_error)?;
                let resumed = unsafe { ResumeThread(thread) };
                unsafe {
                    let _ = CloseHandle(thread);
                }
                return if resumed == u32::MAX {
                    Err(std::io::Error::last_os_error().into())
                } else {
                    Ok(())
                };
            }
            if unsafe { Thread32Next(snapshot, &mut entry) }.is_err() {
                return Err("Suspended verification thread was not found".into());
            }
        }
    })();
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
}

/// Observe without reaping: the owned zombie still reserves the leader PID and
/// its process-group identity until cleanup and the subsequent Child::wait.
#[cfg(unix)]
pub(super) fn observe_child(pid: u32) -> std::io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == 0 {
        Ok(unsafe { info.si_pid() } != 0)
    } else {
        Err(std::io::Error::last_os_error())
    }
}
