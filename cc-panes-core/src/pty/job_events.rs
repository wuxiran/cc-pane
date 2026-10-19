//! Windows Job Object 通知限事件（0.12.22 W5）：进程级单完成端口 + 一条监听线程。
//!
//! `job.rs` 第四段给 Job 设 **通知型** 内存水位（`JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH` +
//! `JobObjectNotificationLimitInformation`）。越线时内核往 Job 关联的完成端口投递
//! `JOB_OBJECT_MSG_NOTIFICATION_LIMIT`，本模块的线程收到后用
//! `QueryInformationJobObject(JobObjectLimitViolationInformation)` 读出实际字节数，再回调。
//!
//! 设计约束：
//! - **一个端口、一条线程**服务所有会话：30 个窗格不能起 30 条阻塞线程（docs/41）。
//! - 文档称通知限"只触发一次、重设后才再发"，**实测不是**：Win11 26200 上越线后每次
//!   内存提交都会再投递（一个闲置 PowerShell 1.5 s 内 7 条，cargo build 会是风暴）。
//!   因此监听线程按键做 [`NOTIFY_DEBOUNCE`] 去抖：窗口内只回调一次，其余消息只消费不回调。
//!   回落清除时仍经 [`crate::pty::PtyProcess::rearm_job_memory_notify`] 重设一次水位，
//!   兜底文档描述的一次性语义在别的内核版本上成立的情形。
//! - 回调在**不持有注册表锁**的情况下调用：回调会进 TerminalService 推状态，而 `ProcessJob`
//!   的 Drop 也要拿注册表锁注销；锁内回调是死锁坑。
//! - 完成端口句柄进程生命周期内不关闭；监听线程用 `spawn_optional`，起不来只 warn
//!   （内存告警是可选能力，不能因它拖垮会话创建）。
//!
//! 非 Windows 只保留跨平台事件类型，不构建完成端口实现。

use std::sync::Arc;

/// 越线事件（字节数来自内核，不是我们算的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobMemoryNotification {
    pub bytes: u64,
    pub limit_bytes: u64,
}

/// 越线回调。`Send + Sync`：在监听线程上调用。
pub type JobMemoryCallback = Arc<dyn Fn(JobMemoryNotification) + Send + Sync>;

#[cfg(windows)]
mod imp {
    use super::{JobMemoryCallback, JobMemoryNotification};
    use anyhow::{anyhow, Result};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use windows::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::System::JobObjects::{
        JobObjectAssociateCompletionPortInformation, JobObjectLimitViolationInformation,
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
        JOBOBJECT_LIMIT_VIOLATION_INFORMATION, JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH,
    };
    use windows::Win32::System::Threading::INFINITE;
    use windows::Win32::System::IO::{
        CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
    };

    /// winnt.h `JOB_OBJECT_MSG_NOTIFICATION_LIMIT`。windows 0.62 把它放在
    /// `Win32_System_SystemServices`，为一个 u32 多拉一个 feature 不值。
    const JOB_OBJECT_MSG_NOTIFICATION_LIMIT: u32 = 11;

    /// 同一 Job 两次回调的最小间隔。越线是持续状态而非瞬时事件，UI 只需要知道"仍在线上"。
    pub(crate) const NOTIFY_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(2);

    struct Entry {
        job: HANDLE,
        limit_bytes: u64,
        callback: JobMemoryCallback,
        last_fired: Option<std::time::Instant>,
    }

    // SAFETY: HANDLE 只是内核对象引用；Entry 只在注册表锁内被读写。
    unsafe impl Send for Entry {}

    struct Registry {
        port: HANDLE,
        entries: Mutex<HashMap<usize, Entry>>,
    }

    // SAFETY: 端口句柄全局唯一且永不关闭；entries 由 Mutex 保护。
    unsafe impl Send for Registry {}
    unsafe impl Sync for Registry {}

    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    /// 完成键从 1 起：0 留给"未注册"。
    static NEXT_KEY: AtomicUsize = AtomicUsize::new(1);

    fn registry() -> Option<&'static Registry> {
        REGISTRY
            .get_or_init(|| {
                // SAFETY: INVALID_HANDLE_VALUE + None 即"新建一个不绑定文件的端口"。
                let port = match unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, None, 0, 1) }
                {
                    Ok(port) => port,
                    Err(error) => {
                        tracing::warn!(%error, "job memory notify disabled: CreateIoCompletionPort failed");
                        return None;
                    }
                };
                let listener_port = port.0 as usize;
                crate::pty::thread::spawn_optional("cc-panes-job-events", move || {
                    listen(HANDLE(listener_port as *mut _))
                });
                Some(Registry {
                    port,
                    entries: Mutex::new(HashMap::new()),
                })
            })
            .as_ref()
    }

    /// 把 Job 关联到进程级完成端口并登记回调。返回完成键（注销用）。
    ///
    /// 必须在设通知水位**之前**调用：端口关联晚于越线，那条消息就丢了。
    pub(crate) fn register(
        job: HANDLE,
        limit_bytes: u64,
        callback: JobMemoryCallback,
    ) -> Result<usize> {
        let registry = registry().ok_or_else(|| anyhow!("completion port unavailable"))?;
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: key as *mut _,
            CompletionPort: registry.port,
        };
        // SAFETY: job 是调用方持有的有效 Job 句柄；结构体大小与 info class 匹配。
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectAssociateCompletionPortInformation,
                &assoc as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        }
        .map_err(|error| anyhow!("associate completion port: {error}"))?;
        registry
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                key,
                Entry {
                    job,
                    limit_bytes,
                    callback,
                    last_fired: None,
                },
            );
        Ok(key)
    }

    /// 更新已登记条目的水位（reapply 改了阈值时）。未登记则忽略。
    pub(crate) fn update_limit(key: usize, limit_bytes: u64) {
        if key == 0 {
            return;
        }
        if let Some(registry) = registry() {
            if let Some(entry) = registry
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&key)
            {
                entry.limit_bytes = limit_bytes;
            }
        }
    }

    /// 注销。**必须在 `CloseHandle(job)` 之前**调用：否则句柄号被复用后监听线程会查到别的 Job。
    pub(crate) fn unregister(key: usize) {
        if key == 0 {
            return;
        }
        if let Some(registry) = registry() {
            registry
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key);
        }
    }

    /// 读 Job 当前越线信息；只在确实是内存越线时返回字节数。
    ///
    /// # Safety
    /// `job` 必须是有效 Job 句柄。
    unsafe fn query_memory_violation(job: HANDLE) -> Option<u64> {
        let mut info = JOBOBJECT_LIMIT_VIOLATION_INFORMATION::default();
        QueryInformationJobObject(
            Some(job),
            JobObjectLimitViolationInformation,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<JOBOBJECT_LIMIT_VIOLATION_INFORMATION>() as u32,
            None,
        )
        .ok()?;
        ((info.ViolationLimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY_HIGH).0 != 0)
            .then_some(info.JobMemory)
    }

    fn listen(port: HANDLE) {
        loop {
            let mut message: u32 = 0;
            let mut key: usize = 0;
            let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
            // SAFETY: 端口句柄进程生命周期内有效；三个出参都是本地变量。
            let result = unsafe {
                GetQueuedCompletionStatus(port, &mut message, &mut key, &mut overlapped, INFINITE)
            };
            if let Err(error) = result {
                // 失败且没取到任何包 = 端口本身出问题；避免忙等。
                if overlapped.is_null() {
                    tracing::warn!(%error, "job events: GetQueuedCompletionStatus failed");
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                continue;
            }
            if message != JOB_OBJECT_MSG_NOTIFICATION_LIMIT {
                continue;
            }
            let Some(registry) = registry() else { continue };
            // 锁内只查 Job + 去抖记账，回调在锁外（见模块注释）。
            let fired = {
                let mut entries = registry.entries.lock().unwrap_or_else(|e| e.into_inner());
                entries.get_mut(&key).and_then(|entry| {
                    let now = std::time::Instant::now();
                    if entry
                        .last_fired
                        .is_some_and(|last| now.duration_since(last) < NOTIFY_DEBOUNCE)
                    {
                        return None;
                    }
                    // SAFETY: 条目仍在表里 ⇒ ProcessJob 尚未 Drop ⇒ 句柄有效。
                    let bytes = unsafe { query_memory_violation(entry.job) }?;
                    entry.last_fired = Some(now);
                    Some((
                        Arc::clone(&entry.callback),
                        JobMemoryNotification {
                            bytes,
                            limit_bytes: entry.limit_bytes,
                        },
                    ))
                })
            };
            if let Some((callback, notification)) = fired {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    callback(notification)
                }));
            }
        }
    }
}

#[cfg(windows)]
pub(crate) use imp::{register, unregister, update_limit};
