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

use crate::models::{PolicyOutcome, SessionResourcePolicy};
use anyhow::{anyhow, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows::Win32::System::Threading::{
    OpenProcess, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// 持有 Job Object 句柄；Drop（含进程异常终止时的 OS 句柄回收）即击杀
/// 已分配进程及其所有子孙。
pub struct ProcessJob {
    handle: HANDLE,
}

// SAFETY: Job Object 句柄本身线程安全，仅在 Drop 时关闭一次。
unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// 建 Job + 分配进程 + 应用资源策略，返回策略结果供上层上报。
    ///
    /// spawn 与 assign 之间存在极小窗口（此间创建的孙进程不入 Job），可接受。
    ///
    /// **两段式下发是刻意的，不要合并回一次调用。** `SetInformationJobObject`
    /// 是全有或全无：一次调用里塞进策略 flag 后，只要有任何一项被组策略 /
    /// AppLocker / 嵌套 Job 拒绝，整次调用就失败——而调用方对失败的处理是把
    /// 整个 Job 丢掉（`pty/mod.rs` 降级成 `_job = None`），于是连
    /// `KILL_ON_JOB_CLOSE` 的孤儿防护一起赔进去。所以：
    ///
    /// 1. 第一次只设 `KILL_ON_JOB_CLOSE`，失败才返回 `Err`（维持原语义）；
    /// 2. 之后的策略下发失败一律**保留 Job**，只产出 [`PolicyOutcome::Degraded`]。
    pub fn create_for_with_policy(
        pid: u32,
        policy: &SessionResourcePolicy,
    ) -> Result<(Self, PolicyOutcome)> {
        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|e| anyhow!("CreateJobObjectW failed: {e}"))?;

            // —— 第一段：孤儿防护，必须成功 ——
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

            // —— 第二段：资源策略，失败不影响已建立的孤儿防护 ——
            let outcome = apply_policy(job, policy);

            Ok((Self { handle: job }, outcome))
        }
    }

    /// 对运行中的会话重新下发策略（批次 5 的"降优先级"干预档位）。
    pub fn reapply_policy(&self, policy: &SessionResourcePolicy) -> Result<PolicyOutcome> {
        if self.handle.is_invalid() {
            return Ok(PolicyOutcome::Unsupported);
        }
        // SAFETY: handle 由本类型持有，Drop 前始终有效。
        Ok(unsafe { apply_policy(self.handle, policy) })
    }
}

/// 下发资源策略。任何失败都只降级、不销毁 Job（调用方已持有孤儿防护）。
///
/// # Safety
/// `job` 必须是有效的 Job Object 句柄。
unsafe fn apply_policy(job: HANDLE, policy: &SessionResourcePolicy) -> PolicyOutcome {
    let mut failures: Vec<String> = Vec::new();

    // 始终整体重写 LimitFlags，**不做 is_noop 早退**：早退会让"把优先级调回正常"
    // 变成空操作（批次 5 的干预档位要能双向调）。`KILL_ON_JOB_CLOSE` 必须每次都带上
    // ——SetInformationJobObject 是整结构体覆盖，漏掉它就等于亲手拆了孤儿防护。
    {
        // PRIORITY_CLASS 作用于**整棵进程树**（含 assign 之后新建的子孙），
        // 这正是我们要的：cargo 是 CLI 的孙进程，对根 pid 调 SetPriorityClass 管不到它。
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = if policy.lower_priority {
            info.BasicLimitInformation.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS.0;
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PRIORITY_CLASS
        } else {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        };
        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            failures.push(format!("priority class: {e}"));
        }
    }

    // CPU 配额只在显式设置时下发。不为"清空"发一次 ControlFlags=0：CPU rate control
    // 需要 Win8+，在不支持的系统上那一次调用必然失败，会把默认路径（不设权重）
    // 全都误报成 Degraded——降级提示一旦变成噪声就没人看了。
    if let Some(weight) = policy.effective_cpu_weight() {
        // WEIGHT_BASED 是软配额：仅在 CPU 满载竞争时按权重分配，空闲时照样跑满。
        // 不用 HARD_CAP——那会把正常编译拖成龟速。
        let rate = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                | JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 {
                Weight: u32::from(weight),
            },
        };
        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectCpuRateControlInformation,
            &rate as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
        ) {
            failures.push(format!("cpu rate control: {e}"));
        }
    }

    if failures.is_empty() {
        PolicyOutcome::Applied
    } else {
        PolicyOutcome::degraded(failures.join("; "))
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
        assert!(ProcessJob::create_for_with_policy(
            0xFFFF_FFFE,
            &SessionResourcePolicy::disabled()
        )
        .is_err());
    }

    /// 查回 Job 的 LimitFlags。
    ///
    /// 注意：**不能**用 `QueryInformationJobObject(None, ..)` 去查"当前进程所在的
    /// Job"来做断言——MSIX 打包的进程自带一层容器 Job，嵌套 Job 下该调用只报最内层，
    /// 实测会看到 `0x800`(BREAKAWAY_OK) 而不是我们设的值（docs/71 第 2.7 节）。
    /// 这里显式传入自己创建的句柄，绕开该陷阱。
    fn query_limit_flags(job: &ProcessJob) -> u32 {
        use windows::Win32::System::JobObjects::QueryInformationJobObject;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(job.handle),
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                None,
            )
            .expect("QueryInformationJobObject");
        }
        info.BasicLimitInformation.LimitFlags.0
    }

    fn spawn_sleeper() -> std::process::Child {
        Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe")
    }

    #[test]
    fn policy_applies_priority_class_to_job() {
        let mut child = spawn_sleeper();
        let policy = SessionResourcePolicy {
            lower_priority: true,
            cpu_weight: None,
        };
        let (job, outcome) =
            ProcessJob::create_for_with_policy(child.id(), &policy).expect("create job");

        assert_eq!(
            outcome,
            PolicyOutcome::Applied,
            "priority class should apply"
        );
        let flags = query_limit_flags(&job);
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_PRIORITY_CLASS.0,
            0,
            "PRIORITY_CLASS missing from LimitFlags: 0x{flags:08X}"
        );

        drop(job);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// 回归护栏：应用资源策略**绝不能**赔掉孤儿防护。
    ///
    /// 两段式下发之前，策略与 KILL_ON_JOB_CLOSE 挤在同一次 SetInformationJobObject
    /// 里，任何一项被拒就整次失败 → 调用方丢弃整个 Job → 宿主暴毙时进程树变孤儿。
    #[test]
    fn policy_never_drops_kill_on_job_close() {
        let mut child = spawn_sleeper();
        let policy = SessionResourcePolicy {
            lower_priority: true,
            cpu_weight: Some(2),
        };
        let (job, _) = ProcessJob::create_for_with_policy(child.id(), &policy).expect("create job");

        let flags = query_limit_flags(&job);
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0,
            0,
            "KILL_ON_JOB_CLOSE lost after applying policy: 0x{flags:08X}"
        );

        drop(job);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// 策略生效后 Drop 仍须清树——孤儿防护的端到端验证。
    #[test]
    fn policy_job_still_kills_tree_on_drop() {
        let mut child = spawn_sleeper();
        let (job, _) =
            ProcessJob::create_for_with_policy(child.id(), &SessionResourcePolicy::default())
                .expect("create job");
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => break,
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    panic!("child survived 3s after policy-applied ProcessJob drop");
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    #[test]
    fn drop_kills_assigned_process_tree() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe");

        let (job, _) =
            ProcessJob::create_for_with_policy(child.id(), &SessionResourcePolicy::disabled())
                .expect("create job");
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
