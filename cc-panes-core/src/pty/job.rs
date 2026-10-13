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
use std::sync::atomic::{AtomicBool, Ordering};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, ProcessPowerThrottling, SetProcessInformation,
    TerminateProcess, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE,
};

/// 持有 Job Object 句柄；Drop（含进程异常终止时的 OS 句柄回收）即击杀
/// 已分配进程及其所有子孙。
pub struct ProcessJob {
    handle: HANDLE,
    /// 曾对本 Job 下发过 EcoQoS。EcoQoS 是逐进程状态而非 Job 限制：只有开过才需要在
    /// "调回正常"时逐进程清掉；从未开过就不碰（旧系统上 `SetProcessInformation` 必失败，
    /// 默认路径不能被它误报成 Degraded）。
    eco_qos_applied: AtomicBool,
}

// SAFETY: Job Object 句柄本身线程安全，仅在 Drop 时关闭一次。
unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Terminate the retained job identity, including descendants, without a PID lookup.
    pub fn terminate(&self) -> Result<()> {
        unsafe { TerminateJobObject(self.handle, 1) }
            .map_err(|error| anyhow!("TerminateJobObject failed: {error}"))
    }

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
            let outcome = apply_policy(job, policy, policy.eco_qos);

            Ok((
                Self {
                    handle: job,
                    eco_qos_applied: AtomicBool::new(policy.eco_qos),
                },
                outcome,
            ))
        }
    }

    /// 对运行中的会话重新下发策略（批次 5 的"降优先级"干预档位）。
    pub fn reapply_policy(&self, policy: &SessionResourcePolicy) -> Result<PolicyOutcome> {
        if self.handle.is_invalid() {
            return Ok(PolicyOutcome::Unsupported);
        }
        let touch_eco_qos = policy.eco_qos || self.eco_qos_applied.load(Ordering::Acquire);
        // SAFETY: handle 由本类型持有，Drop 前始终有效。
        let outcome = unsafe { apply_policy(self.handle, policy, touch_eco_qos) };
        if policy.eco_qos {
            self.eco_qos_applied.store(true, Ordering::Release);
        }
        Ok(outcome)
    }

    /// Job 内当前所有 pid（含 assign 之后新生的子孙）。W8 拿槽重放 EcoQoS 时要用。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn process_ids(&self) -> Result<Vec<u32>> {
        // SAFETY: handle 由本类型持有，Drop 前始终有效。
        unsafe { job_process_ids(self.handle) }
    }
}

/// 枚举 Job 内的 pid。缓冲不够时按返回的 `NumberOfAssignedProcesses` 扩容重试。
///
/// # Safety
/// `job` 必须是有效的 Job Object 句柄。
unsafe fn job_process_ids(job: HANDLE) -> Result<Vec<u32>> {
    let header = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
    let slot = std::mem::size_of::<usize>();
    let mut capacity = 64usize;
    for _ in 0..4 {
        let mut buffer = vec![0u8; header + capacity * slot];
        let mut returned = 0u32;
        let result = QueryInformationJobObject(
            Some(job),
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            Some(&mut returned),
        );
        // 缓冲不够时 Win32 返回 ERROR_MORE_DATA，但头部已写入 NumberOfAssignedProcesses。
        let head =
            std::ptr::read_unaligned(buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>());
        let assigned = head.NumberOfAssignedProcesses as usize;
        let listed = (head.NumberOfProcessIdsInList as usize).min(capacity);
        if result.is_ok() || listed >= assigned {
            let list_offset = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
            let pids = (0..listed)
                .map(|index| {
                    let ptr = buffer
                        .as_ptr()
                        .add(list_offset + index * slot)
                        .cast::<usize>();
                    std::ptr::read_unaligned(ptr) as u32
                })
                .collect();
            return Ok(pids);
        }
        if assigned <= capacity {
            return Err(anyhow!(
                "QueryInformationJobObject(ProcessIdList) failed: {}",
                result.err().map(|e| e.to_string()).unwrap_or_default()
            ));
        }
        capacity = assigned + 16;
    }
    Err(anyhow!(
        "QueryInformationJobObject(ProcessIdList): pid list kept growing"
    ))
}

/// 对单个进程开/关 EcoQoS（`PROCESS_POWER_THROTTLING_EXECUTION_SPEED`）。
///
/// 只动 `EXECUTION_SPEED` 位；`IGNORE_TIMER_RESOLUTION` 等其他位保持系统默认。
fn set_process_eco_qos(pid: u32, enabled: bool) -> Result<()> {
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: if enabled {
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        } else {
            0
        },
    };
    unsafe {
        let process = OpenProcess(PROCESS_SET_INFORMATION, false, pid)
            .map_err(|e| anyhow!("OpenProcess({pid}) failed: {e}"))?;
        let result = SetProcessInformation(
            process,
            ProcessPowerThrottling,
            (&state as *const PROCESS_POWER_THROTTLING_STATE).cast(),
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
        let _ = CloseHandle(process);
        result.map_err(|e| anyhow!("SetProcessInformation({pid}) failed: {e}"))
    }
}

/// 下发资源策略。任何失败都只降级、不销毁 Job（调用方已持有孤儿防护）。
///
/// `touch_eco_qos`：是否执行第三段（逐进程 EcoQoS）。调用方只在"要开"或"曾开过要关"
/// 时置 true——见 [`ProcessJob::eco_qos_applied`]。
///
/// # Safety
/// `job` 必须是有效的 Job Object 句柄。
unsafe fn apply_policy(
    job: HANDLE,
    policy: &SessionResourcePolicy,
    touch_eco_qos: bool,
) -> PolicyOutcome {
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

    // —— 第三段：EcoQoS（效率模式），逐进程 ——
    // Job 没有 EcoQoS 级别的限制，只能枚举当前 pid 逐个 SetProcessInformation；
    // assign 之后新生的子进程**不会**继承，需要时由调用方重放（docs/107 gotcha）。
    if touch_eco_qos {
        match job_process_ids(job) {
            Ok(pids) => {
                let mut failed = 0usize;
                let mut last_error = String::new();
                for pid in &pids {
                    if let Err(e) = set_process_eco_qos(*pid, policy.eco_qos) {
                        failed += 1;
                        last_error = e.to_string();
                    }
                }
                if failed > 0 {
                    failures.push(format!(
                        "eco qos: {failed}/{} processes failed: {last_error}",
                        pids.len()
                    ));
                }
            }
            Err(e) => failures.push(format!("eco qos: {e}")),
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

/// Retained fallback identity for a child which could not be assigned to a Job.
pub struct ProcessHandle(HANDLE);
// SAFETY: the owned process handle supports concurrent OS operations and closes once.
unsafe impl Send for ProcessHandle {}
unsafe impl Sync for ProcessHandle {}
impl ProcessHandle {
    pub fn open(pid: u32) -> Result<Self> {
        unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .map(Self)
        .map_err(|error| anyhow!("OpenProcess failed: {error}"))
    }
    pub fn terminate(&self) -> Result<()> {
        let mut code = 0;
        unsafe { GetExitCodeProcess(self.0, &mut code) }
            .map_err(|error| anyhow!("GetExitCodeProcess failed: {error}"))?;
        if code != 259 {
            return Ok(());
        } // STILL_ACTIVE
        unsafe { TerminateProcess(self.0, 1) }
            .map_err(|error| anyhow!("TerminateProcess failed: {error}"))
    }
}
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
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
            eco_qos: false,
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
            eco_qos: false,
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

    /// 回读某进程的 EcoQoS 状态位。
    fn query_eco_qos(pid: u32) -> u32 {
        use windows::Win32::System::Threading::{
            GetProcessInformation, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ..Default::default()
        };
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).unwrap();
            GetProcessInformation(
                process,
                ProcessPowerThrottling,
                (&mut state as *mut PROCESS_POWER_THROTTLING_STATE).cast(),
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
            .expect("GetProcessInformation");
            let _ = CloseHandle(process);
        }
        state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED
    }

    /// EcoQoS 开 → 任务管理器会给叶子图标；关 → 位清零。两次都必须 Applied。
    #[test]
    fn eco_qos_applies_per_process_and_can_be_cleared() {
        let mut child = spawn_sleeper();
        let eco = SessionResourcePolicy {
            lower_priority: false,
            cpu_weight: None,
            eco_qos: true,
        };
        let (job, outcome) =
            ProcessJob::create_for_with_policy(child.id(), &eco).expect("create job");
        assert_eq!(outcome, PolicyOutcome::Applied, "eco qos should apply");
        assert!(job.process_ids().unwrap().contains(&child.id()));
        assert_ne!(query_eco_qos(child.id()), 0, "EXECUTION_SPEED bit not set");

        let normal = SessionResourcePolicy::disabled();
        let outcome = job.reapply_policy(&normal).expect("reapply");
        assert_eq!(outcome, PolicyOutcome::Applied);
        assert_eq!(
            query_eco_qos(child.id()),
            0,
            "EXECUTION_SPEED bit not cleared"
        );

        let flags = query_limit_flags(&job);
        assert_ne!(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0);

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
