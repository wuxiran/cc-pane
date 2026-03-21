//! PTY 抽象层 — 全平台统一使用 portable-pty
//!
//! 提供统一的 `spawn_pty()` 入口，Windows/macOS/Linux 均使用 portable-pty。
//! portable-pty 在 Windows 上内部使用 ConPTY，无需自研绑定。

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};

/// PTY 创建配置
pub struct PtyConfig {
    pub cols: u16,
    pub rows: u16,
    pub cwd: PathBuf,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// 需要从继承环境中移除的变量名列表
    pub env_remove: Vec<String>,
}

/// PTY 创建后返回的三件套（所有权一次性转移）
pub struct PtySpawnResult {
    /// 进程控制句柄（Arc 共享，session 和 wait 线程各持一份）
    pub process: Arc<dyn PtyProcess>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

/// PTY 进程控制接口（不含 I/O）
///
/// 所有方法均为 `&self`，内部使用 Mutex 实现线程安全。
/// 这样 session（resize/kill）和 wait 线程可以通过 `Arc<dyn PtyProcess>` 共享。
pub trait PtyProcess: Send + Sync {
    fn resize(&self, cols: u16, rows: u16) -> Result<()>;
    fn pid(&self) -> u32;
    fn wait(&self) -> Result<ExitStatus>;
    fn kill(&self) -> Result<()>;
}

/// portable-pty 包装的 PTY 进程（全平台通用）
struct PortablePtyProcess {
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    exited: Mutex<bool>,
    /// 创建时存储 PID，kill() 通过 OS API 按 PID 终止，绕过 child 锁死锁
    pid: u32,
}

impl PtyProcess for PortablePtyProcess {
    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("master lock poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn pid(&self) -> u32 {
        self.pid
    }

    fn wait(&self) -> Result<ExitStatus> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| anyhow!("child lock poisoned"))?;
        let status = child.wait()?;
        {
            let mut exited = self
                .exited
                .lock()
                .map_err(|_| anyhow!("exited lock poisoned"))?;
            *exited = true;
        }

        // ExitStatus::from_raw() 的参数含义因平台而异：
        //   Unix: wait status 格式 — exit code 编码为 (code << 8)
        //   Windows: 直接使用 exit code
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if status.success() {
                Ok(ExitStatus::from_raw(0))
            } else {
                Ok(ExitStatus::from_raw(1 << 8)) // exit code 1
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            if status.success() {
                Ok(ExitStatus::from_raw(0))
            } else {
                Ok(ExitStatus::from_raw(1))
            }
        }
    }

    fn kill(&self) -> Result<()> {
        let exited = self
            .exited
            .lock()
            .map_err(|_| anyhow!("exited lock poisoned"))?;
        if *exited {
            return Ok(());
        }
        drop(exited);

        // 通过 OS API 按 PID 终止进程，绕过 child 互斥锁
        // 解决 wait() 持锁阻塞导致 kill() 获取 child 锁死锁的问题
        kill_process_by_pid(self.pid)?;

        let mut exited = self
            .exited
            .lock()
            .map_err(|_| anyhow!("exited lock poisoned"))?;
        *exited = true;
        Ok(())
    }
}

/// 创建 PTY 进程（全平台统一入口）
pub fn spawn_pty(config: PtyConfig) -> Result<PtySpawnResult> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: config.rows,
        cols: config.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = if config.command.is_empty() {
        CommandBuilder::new_default_prog()
    } else {
        let mut c = CommandBuilder::new(&config.command);
        for arg in &config.args {
            c.arg(arg);
        }
        c
    };

    cmd.cwd(&config.cwd);
    for key in &config.env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in &config.env {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd)?;
    let pid = child.process_id().unwrap_or(0) as u32;
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    Ok(PtySpawnResult {
        process: Arc::new(PortablePtyProcess {
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            exited: Mutex::new(false),
            pid,
        }),
        reader,
        writer,
    })
}

/// 跨平台按 PID 终止进程树
///
/// - Windows: 使用 `taskkill /T /F /PID` 递归杀死整个进程树
/// - Unix: 先尝试 `killpg` 杀进程组，失败则回退到杀单进程
fn kill_process_by_pid(pid: u32) -> Result<()> {
    if pid == 0 {
        return Err(anyhow!("invalid pid 0, cannot kill"));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // taskkill /T = 杀进程树, /F = 强制终止
        let output = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match output {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                // 进程已不存在时 taskkill 返回非零但不算错误
                if stderr.contains("not found") || stderr.contains("找不到") {
                    Ok(())
                } else {
                    Err(anyhow!("taskkill failed for pid {}: {}", pid, stderr.trim()))
                }
            }
            Err(e) => Err(anyhow!("taskkill spawn failed: {}", e)),
        }
    }

    #[cfg(unix)]
    {
        // 先尝试杀进程组（PTY 子进程通常在同一进程组）
        let ret = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            // 进程组杀失败，回退到杀单进程
            let ret2 = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            if ret2 != 0 {
                let err2 = std::io::Error::last_os_error();
                if err2.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                return Err(anyhow!("kill({}) failed: {}", pid, err2));
            }
        }
        Ok(())
    }
}
