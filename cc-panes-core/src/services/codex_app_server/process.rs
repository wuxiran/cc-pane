//! Private process ownership. On Unix do not reap the group leader before
//! terminating descendants: its unreaped PID prevents process-group ID reuse.

use std::process::ExitStatus;
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::utils::{AppError, AppResult};

type Exit = Result<ExitStatus, String>;

pub(super) fn configure(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    // Suspended until assignment to the kill-on-close job succeeds.
    command.creation_flags(0x08000000 | 0x00000004);
}

pub(super) struct Process {
    cancel: watch::Sender<bool>,
    exit: watch::Receiver<Option<Exit>>,
}

impl Process {
    pub(super) async fn new(mut child: Child) -> AppResult<Self> {
        let tree = match Tree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };
        let (cancel, mut cancelled) = watch::channel(false);
        let (exited, exit) = watch::channel(None);
        tokio::spawn(async move {
            let mut tree = tree;
            #[cfg(unix)]
            let result = {
                let pid = child.id().expect("owned child must have PID");
                tokio::select! {
                    _ = observe_exit(pid) => {},
                    _ = cancelled.changed() => {},
                }
                tree.kill();
                let _ = child.start_kill();
                child.wait().await
            };
            #[cfg(windows)]
            let result = tokio::select! {
                result = child.wait() => result,
                _ = cancelled.changed() => {
                    tree.kill();
                    let _ = child.start_kill();
                    child.wait().await
                },
            };
            tree.kill();
            let _ = exited.send(Some(result.map_err(|error| error.to_string())));
        });
        Ok(Self { cancel, exit })
    }

    pub(super) async fn wait(&self) -> Exit {
        let mut exit = self.exit.clone();
        loop {
            if let Some(result) = exit.borrow_and_update().clone() {
                return result;
            }
            if exit.changed().await.is_err() {
                return Err("Codex process monitor stopped unexpectedly".into());
            }
        }
    }

    pub(super) async fn stop(&self) -> Exit {
        self.cancel.send_replace(true);
        self.wait().await
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

#[cfg(unix)]
async fn observe_exit(pid: u32) {
    loop {
        let finished = {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            result != 0 || unsafe { info.si_pid() } != 0
        };
        if finished {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

struct Tree {
    killed: bool,
    #[cfg(unix)]
    pgid: i32,
    #[cfg(windows)]
    job: windows::Win32::Foundation::HANDLE,
}

// The job is exclusively owned by the process-monitor task.
#[cfg(windows)]
unsafe impl Send for Tree {}

impl Tree {
    #[cfg(unix)]
    fn attach(child: &Child) -> AppResult<Self> {
        Ok(Self {
            killed: false,
            pgid: child
                .id()
                .ok_or_else(|| AppError::from("Codex process already exited"))?
                as i32,
        })
    }

    #[cfg(windows)]
    fn attach(child: &Child) -> AppResult<Self> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let raw = child.raw_handle().ok_or("Missing Codex process handle")?;
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(win_error)?;
        let guard = Self { job, killed: false };
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
        resume_child(child.id().ok_or("Codex process already exited")?)?;
        Ok(guard)
    }

    fn kill(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        self.kill();
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(windows)]
fn win_error(error: windows::core::Error) -> AppError {
    error.to_string().into()
}

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
                return Err("Suspended Codex process thread was not found".into());
            }
        }
    })();
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
}
