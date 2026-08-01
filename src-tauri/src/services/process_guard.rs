//! OS-level guarantee that a spawned child process — and its whole descendant
//! tree — is reclaimed when this (parent) process goes away, regardless of how
//! the parent dies (clean exit, panic, crash, or `taskkill /F`).
//!
//! The cooperative `stop()` path in [`super::web_access_lifecycle`] still does a
//! best-effort graceful shutdown, but it only runs when the parent exits
//! normally. This guard is the backstop that covers the abnormal paths:
//!
//! * **Windows** — the child is assigned to a Job Object created with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job handle is held for the
//!   lifetime of the parent process; when the last handle closes (including
//!   implicitly when the parent dies), the kernel terminates every process in
//!   the job — the child *and* any grandchildren it spawned (PTYs, CLIs).
//! * **Unix** — the child is spawned into its own process group; `stop()` signals
//!   the whole group so descendants die with the leader.
//!
//! 与 PTY 那套 Job Object 是**两条独立的链**：`cc-panes-core/src/pty/job.rs` 保的是
//! 终端会话，本文件保的是 web-access 子进程。后者此前只有 `child.kill()`——
//! CLAUDE.md 记着「`kill()` 只杀直接子进程」，宿主崩溃时 web 进程及其孙子进程
//! 会变成孤儿，端口一直被占。
//!
//! 来源：从 `fix-web-process-lifecycle` 分支（2026-06，5 周未合）**逐项抽取**而非
//! 整分支合并。那条分支基线停在 0.10.5，整分支合会把版本号退回、删掉
//! `tauri-plugin-single-instance`/`deep-link`/`socket2` 等依赖、抹掉
//! `web_access_lifecycle` 后加的 daemon_expected 告警，还会把 `no_window_command`
//! 换回裸 `Command`（Windows 上闪黑窗）。本文件是那条分支里 main 真正缺失的部分，
//! 其余 8 个文件 main 均已有更新的实现。

use std::process::{Child, Command};

use cc_panes_core::utils::AppResult;

#[cfg(windows)]
use crate::utils::AppError;

/// Prepare a [`Command`] so the spawned child can be reliably terminated
/// together with its descendants. Call this before `spawn()`.
pub fn configure_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group whose id equals the child pid (the leader), so the
        // whole tree can be signalled via `killpg` later.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        // Nothing to do pre-spawn on Windows; the Job Object is assigned right
        // after spawn in `ProcessGuard::attach`.
        let _ = command;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
    }
}

/// Holds the OS resources that bind a child's lifetime to this process.
///
/// On Windows it owns the Job Object handle (dropping it kills the tree). On
/// Unix it records the process-group id used for signalling.
pub struct ProcessGuard {
    #[cfg(windows)]
    job: JobHandle,
    #[cfg(unix)]
    pgid: i32,
}

impl ProcessGuard {
    /// Attach a freshly spawned child to the OS-level guard.
    ///
    /// On Windows any failure (create/limit/assign) is fatal: the caller must
    /// treat the child as unguarded and abort the launch, because an unguarded
    /// child could outlive the parent.
    #[cfg(windows)]
    pub fn attach(child: &Child) -> AppResult<Self> {
        Ok(Self {
            job: attach_windows(child)?,
        })
    }

    #[cfg(unix)]
    pub fn attach(child: &Child) -> AppResult<Self> {
        // The child is its own group leader (configure_command set pgid=0), so
        // the group id equals the child pid.
        Ok(Self {
            pgid: child.id() as i32,
        })
    }

    #[cfg(not(any(unix, windows)))]
    pub fn attach(_child: &Child) -> AppResult<Self> {
        Ok(Self {})
    }

    /// First, gentle termination request for the child and its descendants.
    pub fn request_terminate(&self, child: &mut Child) {
        #[cfg(windows)]
        {
            // Terminating the job kills the child and every grandchild at once.
            self.job.terminate();
            let _ = child;
        }
        #[cfg(unix)]
        {
            self.signal_group(libc::SIGTERM);
            let _ = child;
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child.kill();
        }
    }

    /// Forceful termination after the graceful window elapses.
    pub fn force_kill(&self, child: &mut Child) {
        #[cfg(windows)]
        {
            self.job.terminate();
            let _ = child.kill();
        }
        #[cfg(unix)]
        {
            self.signal_group(libc::SIGKILL);
            let _ = child;
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child.kill();
        }
    }

    #[cfg(unix)]
    fn signal_group(&self, signum: i32) {
        // SAFETY: killpg on our own child's process group; ignore ESRCH etc.
        unsafe {
            libc::killpg(self.pgid, signum);
        }
    }
}

#[cfg(windows)]
struct JobHandle(windows::Win32::Foundation::HANDLE);

// SAFETY: a job-object HANDLE is just a kernel handle value; it is owned
// exclusively by this struct and only used from behind the lifecycle mutex.
#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: self.0 is a valid job handle owned by this struct.
        unsafe {
            let _ = TerminateJobObject(self.0, 0);
        }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        // SAFETY: self.0 was created by CreateJobObjectW and is owned solely by
        // this struct, so it is closed exactly once. Because the job was created
        // with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, closing the last handle also
        // terminates any processes still alive in the job.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn attach_windows(child: &Child) -> AppResult<JobHandle> {
    use std::os::windows::io::AsRawHandle;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: standard Win32 Job Object setup; every handle is checked and
    // cleaned up on the error paths. The child handle is valid for the duration
    // of this call because we hold `&Child`.
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|e| AppError::from(format!("CreateJobObjectW failed: {e}")))?;

        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };

        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(AppError::from(format!(
                "SetInformationJobObject failed: {e}"
            )));
        }

        let child_handle = HANDLE(child.as_raw_handle());
        if let Err(e) = AssignProcessToJobObject(job, child_handle) {
            let _ = CloseHandle(job);
            return Err(AppError::from(format!(
                "AssignProcessToJobObject failed: {e}"
            )));
        }

        Ok(JobHandle(job))
    }
}
