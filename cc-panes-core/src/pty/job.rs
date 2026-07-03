//! Windows Job Object：PTY 子进程树的"宿主暴毙"兜底。
//!
//! 显式关闭会话时 `kill_process_by_pid` 走 `taskkill /T /F` 能杀整棵树，
//! 但 CC-Panes 自身崩溃 / 被任务管理器强杀时没人执行 taskkill——
//! 此时 pwsh 里起的 `npm run dev` 等子孙进程会全部沦为孤儿。
//! Job Object 配置 `KILL_ON_JOB_CLOSE` 后，宿主死亡 → OS 回收句柄 →
//! 整棵进程树被内核击杀，是 Windows 上唯一可靠的孤儿防护。
//!
//! 移植自 Terax proc/job.rs（MIT）。**没有替代方案前不要移除**。

#![cfg(windows)]

use anyhow::{anyhow, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// 持有 Job Object 句柄；Drop（含进程异常终止时的 OS 句柄回收）即击杀
/// 已分配进程及其所有子孙。
pub struct ProcessJob {
    handle: HANDLE,
}

// SAFETY: Job Object 句柄本身线程安全，仅在 Drop 时关闭一次。
unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// 为已 spawn 的进程创建 Job 并分配进入。
    /// spawn 与 assign 之间存在极小窗口（此间创建的孙进程不入 Job），可接受。
    pub fn create_for(pid: u32) -> Result<Self> {
        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|e| anyhow!("CreateJobObjectW failed: {e}"))?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(e) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(anyhow!("SetInformationJobObject failed: {e}"));
            }

            let process = match OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid) {
                Ok(p) => p,
                Err(e) => {
                    let _ = CloseHandle(job);
                    return Err(anyhow!("OpenProcess({pid}) failed: {e}"));
                }
            };

            let assign = AssignProcessToJobObject(job, process);
            let _ = CloseHandle(process);
            if let Err(e) = assign {
                let _ = CloseHandle(job);
                return Err(anyhow!("AssignProcessToJobObject({pid}) failed: {e}"));
            }

            Ok(Self { handle: job })
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn create_for_invalid_pid_errors() {
        assert!(ProcessJob::create_for(0xFFFF_FFFE).is_err());
    }

    #[test]
    fn drop_kills_assigned_process_tree() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe");

        let job = ProcessJob::create_for(child.id()).expect("create job");
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => break,
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    panic!("child survived 3s after ProcessJob drop");
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}
