//! 平台休眠抑制。只挡系统空闲休眠，显示器照常熄屏；合盖、手动睡眠不受影响。
//!
//! - macOS：IOPMAssertion `PreventUserIdleSystemSleep`（直接链接系统框架，不引入
//!   新 crate）；创建失败时退回 `caffeinate -i -w <pid>` 子进程。
//! - Windows：专用线程上 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`，
//!   该状态绑定线程，释放时在同一线程上清掉。
//! - Linux：`systemd-inhibit --what=sleep` 包一个读 stdin 的 `cat`；放锁时关掉
//!   stdin，进程意外退出时管道也会关闭，锁随之释放。
//!
//! 进程崩溃时锁都会被系统自动回收，不会把机器永远挂着。

use std::sync::Arc;

use crate::utils::AppResult;

/// 持锁凭证：drop 即释放。
pub trait InhibitorHold: Send {}

/// 抽象出来便于测试替身。
pub trait SleepInhibitor: Send + Sync {
    fn acquire(&self, reason: &str) -> AppResult<Box<dyn InhibitorHold>>;
}

/// 当前平台的实现。
pub fn system_inhibitor() -> Arc<dyn SleepInhibitor> {
    Arc::new(PlatformInhibitor)
}

struct PlatformInhibitor;

impl SleepInhibitor for PlatformInhibitor {
    fn acquire(&self, reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
        platform::acquire(reason)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod child {
    use super::InhibitorHold;
    use std::process::Child;

    /// 子进程形式的锁：drop 时关 stdin、杀进程并回收。
    pub(super) struct ChildHold(pub(super) Child);

    impl InhibitorHold for ChildHold {}

    impl Drop for ChildHold {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::child::ChildHold;
    use super::InhibitorHold;
    use crate::utils::{AppError, AppResult};
    use std::ffi::{c_char, c_void, CString};
    use std::process::{Command, Stdio};

    type CFStringRef = *const c_void;
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const ASSERTION_LEVEL_ON: u32 = 255;
    const IO_RETURN_SUCCESS: i32 = 0;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    struct AssertionHold(u32);

    impl InhibitorHold for AssertionHold {}

    impl Drop for AssertionHold {
        fn drop(&mut self) {
            // SAFETY: id 由 IOPMAssertionCreateWithName 成功返回，且只释放一次。
            let result = unsafe { IOPMAssertionRelease(self.0) };
            if result != IO_RETURN_SUCCESS {
                tracing::warn!(result, "keep-awake: IOPMAssertionRelease failed");
            }
        }
    }

    struct CfString(CFStringRef);

    impl CfString {
        fn new(value: &str) -> Option<Self> {
            let c_str = CString::new(value).ok()?;
            // SAFETY: c_str 是合法的 NUL 结尾 UTF-8；返回值按 Create 规则由我们 Release。
            let raw = unsafe {
                CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), CF_STRING_ENCODING_UTF8)
            };
            (!raw.is_null()).then_some(Self(raw))
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            // SAFETY: 指针非空且来自 CFStringCreateWithCString。
            unsafe { CFRelease(self.0) };
        }
    }

    fn create_assertion(reason: &str) -> AppResult<AssertionHold> {
        let kind = CfString::new("PreventUserIdleSystemSleep")
            .ok_or_else(|| AppError::from("CFStringCreate failed"))?;
        let name = CfString::new(reason).ok_or_else(|| AppError::from("CFStringCreate failed"))?;
        let mut id = 0u32;
        // SAFETY: 两个 CFString 在调用期间存活；id 是有效的输出指针。
        let result =
            unsafe { IOPMAssertionCreateWithName(kind.0, ASSERTION_LEVEL_ON, name.0, &mut id) };
        if result != IO_RETURN_SUCCESS {
            return Err(AppError::from(format!(
                "IOPMAssertionCreateWithName returned {result:#x}"
            )));
        }
        Ok(AssertionHold(id))
    }

    fn spawn_caffeinate() -> AppResult<ChildHold> {
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| AppError::from(format!("spawn caffeinate failed: {error}")))?;
        Ok(ChildHold(child))
    }

    pub(super) fn acquire(reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
        match create_assertion(reason) {
            Ok(hold) => Ok(Box::new(hold)),
            Err(error) => {
                tracing::warn!(error = %error, "keep-awake: IOPMAssertion failed; falling back to caffeinate");
                Ok(Box::new(spawn_caffeinate()?))
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::InhibitorHold;
    use crate::utils::{AppError, AppResult};
    use std::sync::mpsc;
    use std::thread::JoinHandle;

    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_CONTINUOUS: u32 = 0x8000_0000;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    struct ThreadHold {
        stop: Option<mpsc::Sender<()>>,
        join: Option<JoinHandle<()>>,
    }

    impl InhibitorHold for ThreadHold {}

    impl Drop for ThreadHold {
        fn drop(&mut self) {
            drop(self.stop.take());
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    pub(super) fn acquire(_reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        // 执行状态绑定在调用线程上，所以设置与清除必须在同一条专用线程里。
        let join = crate::pty::thread::spawn_named("cc-panes-keep-awake-win", move || {
            // SAFETY: 纯 Win32 调用，无指针参数。
            let ok = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
            let _ = ready_tx.send(ok);
            if !ok {
                return;
            }
            // Sender 被 drop 时 recv 返回 Err，线程据此结束。
            let _ = stop_rx.recv();
            // SAFETY: 同上。
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        })
        .map_err(|error| AppError::from(format!("spawn keep-awake thread failed: {error}")))?;
        if !ready_rx.recv().unwrap_or(false) {
            let _ = join.join();
            return Err(AppError::from("SetThreadExecutionState failed"));
        }
        Ok(Box::new(ThreadHold {
            stop: Some(stop_tx),
            join: Some(join),
        }))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::child::ChildHold;
    use super::InhibitorHold;
    use crate::utils::{AppError, AppResult};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// systemd-inhibit 拿不到锁（无 logind / 权限不足）时会立刻退出，等一小会儿看结果。
    const STARTUP_PROBE: Duration = Duration::from_millis(300);

    pub(super) fn acquire(reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
        let mut child = Command::new("systemd-inhibit")
            .args([
                "--what=sleep",
                "--who=CC-Panes",
                &format!("--why={reason}"),
                "--mode=block",
                "cat",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| AppError::from(format!("spawn systemd-inhibit failed: {error}")))?;
        std::thread::sleep(STARTUP_PROBE);
        match child.try_wait() {
            Ok(Some(status)) => Err(AppError::from(format!(
                "systemd-inhibit exited early: {status}"
            ))),
            _ => Ok(Box::new(ChildHold(child))),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::InhibitorHold;
    use crate::utils::{AppError, AppResult};

    pub(super) fn acquire(_reason: &str) -> AppResult<Box<dyn InhibitorHold>> {
        Err(AppError::from(
            "keep-awake is not supported on this platform",
        ))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn assertions() -> String {
        let output = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .expect("pmset");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// 真机验证：会真的创建一个系统电源断言。`cargo test -- --ignored` 手动跑。
    #[test]
    #[ignore]
    fn real_assertion_is_visible_to_pmset_and_released_on_drop() {
        let reason = "CC-Panes keep-awake self-test";
        let hold = system_inhibitor().acquire(reason).expect("acquire");
        assert!(assertions().contains(reason));
        drop(hold);
        assert!(!assertions().contains(reason));
    }
}
