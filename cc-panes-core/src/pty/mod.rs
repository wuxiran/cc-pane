//! PTY 抽象层 — 全平台统一使用 portable-pty
//!
//! 提供统一的 `spawn_pty()` 入口，Windows/macOS/Linux 均使用 portable-pty。
//! portable-pty 在 Windows 上内部使用 ConPTY，无需自研绑定。

use crate::models::{PolicyOutcome, SessionResourcePolicy};
use crate::utils::{simplify_path, validate_spawn_cwd};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

#[cfg(windows)]
mod job;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// 会话级资源策略（降优先级 / CPU 权重）。
    ///
    /// 刻意不给 `PtyConfig` 加 `Default`：`cols`/`rows` 默认 0 会 spawn 出 0×0
    /// 终端，是个安静的陷阱。字面量构造点只有 3 处，显式写出来更安全。
    pub resource_policy: SessionResourcePolicy,
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

    /// 对运行中的会话重新下发资源策略（"降优先级"这一档干预，低于杀进程）。
    ///
    /// 默认返回 `Unsupported`，实现者按需覆盖——这样新增实现不会被迫关心资源策略。
    fn set_resource_policy(&self, _policy: &SessionResourcePolicy) -> Result<PolicyOutcome> {
        Ok(PolicyOutcome::Unsupported)
    }
}

/// portable-pty 包装的 PTY 进程（全平台通用）
struct PortablePtyProcess {
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    /// 使用 AtomicBool 消除 wait() 和 kill() 之间的锁竞态
    exited: AtomicBool,
    /// 创建时存储 PID，kill() 通过 OS API 按 PID 终止，绕过 child 锁死锁
    pid: u32,
    /// Windows：KILL_ON_JOB_CLOSE Job Object。宿主进程异常终止时由 OS 回收
    /// 句柄并击杀整棵子进程树（taskkill 只覆盖显式 kill 路径）。
    /// 同时承载会话级资源策略（优先级 / CPU 权重），见 `set_resource_policy`。
    #[cfg(windows)]
    job: Option<job::ProcessJob>,
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

    fn set_resource_policy(&self, policy: &SessionResourcePolicy) -> Result<PolicyOutcome> {
        #[cfg(windows)]
        {
            match self.job.as_ref() {
                Some(job) => job.reapply_policy(policy),
                // Job 创建当初就失败了（权限受限），没有可调的载体。
                None => Ok(PolicyOutcome::Unsupported),
            }
        }
        #[cfg(unix)]
        {
            match policy.nice_increment() {
                Some(increment) => {
                    apply_unix_nice_increment(self.pid, increment);
                    Ok(PolicyOutcome::Applied)
                }
                // 提高优先级需要 CAP_SYS_NICE，普通用户降了就回不去。
                None => Ok(PolicyOutcome::degraded(
                    "raising priority back requires CAP_SYS_NICE",
                )),
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = policy;
            Ok(PolicyOutcome::Unsupported)
        }
    }

    fn wait(&self) -> Result<ExitStatus> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| anyhow!("child lock poisoned"))?;
        let status = child.wait()?;
        self.exited.store(true, Ordering::Release);

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
        if self.exited.load(Ordering::Acquire) {
            return Ok(());
        }

        // 通过 OS API 按 PID 终止进程，绕过 child 互斥锁
        // 解决 wait() 持锁阻塞导致 kill() 获取 child 锁死锁的问题
        kill_process_by_pid(self.pid)?;

        // Unix: kill 后回收子进程，防止僵尸
        #[cfg(unix)]
        reap_child(self.pid);

        self.exited.store(true, Ordering::Release);
        Ok(())
    }
}

/// 创建 PTY 进程（全平台统一入口）
pub fn spawn_pty(config: PtyConfig) -> Result<PtySpawnResult> {
    validate_spawn_cwd(&config.cwd).map_err(anyhow::Error::new)?;
    #[cfg_attr(not(any(windows, unix)), allow(unused_variables))]
    let policy = config.resource_policy;
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

    // 兜底闸门：cmd.exe 拒绝 `\\?\` cwd 并静默回落 C:\Windows，任何上游漏网都在此拦下。
    // 非 Windows 平台为 no-op。见 docs/35-unc-path-contamination.md。
    cmd.cwd(simplify_path(&config.cwd));
    for key in env_remove_keys(config.env_remove) {
        cmd.env_remove(key);
    }
    for (key, value) in &config.env {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd)?;
    let pid = child.process_id().unwrap_or(0) as u32;
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    // Windows：把子进程挂进 KILL_ON_JOB_CLOSE Job，宿主暴毙时由内核清树。
    // 创建失败（权限受限等）不阻断 spawn——显式 kill 路径仍有 taskkill /T 兜底。
    // 资源策略在同一处下发，但失败只降级、不影响孤儿防护（见 job::create_for_with_policy）。
    #[cfg(windows)]
    let job = if pid != 0 {
        match job::ProcessJob::create_for_with_policy(pid, &policy) {
            Ok((j, outcome)) => {
                // 降级必须可见：静默失败 = 用户以为限制生效、实际裸奔（docs/45 教训）。
                if let PolicyOutcome::Degraded { reason } = &outcome {
                    tracing::warn!(
                        pid,
                        reason = %reason,
                        "resource policy degraded (session still started)"
                    );
                }
                Some(j)
            }
            Err(e) => {
                tracing::warn!("ProcessJob create failed for pid {pid} (non-fatal): {e}");
                None
            }
        }
    } else {
        None
    };

    // Unix：优先级用 nice 表达（Windows 侧走 Job 的 PRIORITY_CLASS）。
    #[cfg(unix)]
    if pid != 0 {
        if let Some(increment) = policy.nice_increment() {
            apply_unix_nice_increment(pid, increment);
        }
    }

    Ok(PtySpawnResult {
        process: Arc::new(PortablePtyProcess {
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            exited: AtomicBool::new(false),
            pid,
            #[cfg(windows)]
            job,
        }),
        reader,
        writer,
    })
}

/// Unix：基于进程继承到的当前 nice 值，按增量调低调度优先级。
///
/// 失败只 warn——查询或设置在容器/受限环境下可能被拒，但那不该阻断会话。
#[cfg(unix)]
fn apply_unix_nice_increment(pid: u32, increment: i8) {
    errno::set_errno(errno::Errno(0));
    // SAFETY: getpriority 只读取指定 PID 的调度属性，不解引用用户态指针。
    let current = unsafe { libc::getpriority(libc::PRIO_PROCESS, pid) };
    let get_error = errno::errno();
    if current == -1 && get_error.0 != 0 {
        tracing::warn!(
            pid,
            increment,
            error = %std::io::Error::from_raw_os_error(get_error.0),
            "getpriority failed (non-fatal, session still started)"
        );
        return;
    }

    let target = unix_nice_target(current, increment);
    if target == current {
        return;
    }
    // SAFETY: setpriority 对不存在的 pid 只返回 -1，不会有内存安全问题。
    let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, target) };
    if rc != 0 {
        tracing::warn!(
            pid,
            increment,
            current,
            target,
            error = %std::io::Error::last_os_error(),
            "setpriority failed (non-fatal, session still started)"
        );
    }
}

#[cfg(unix)]
fn unix_nice_target(current: i32, increment: i8) -> i32 {
    current.saturating_add(i32::from(increment)).min(19)
}

fn env_remove_keys(mut env_remove: Vec<String>) -> Vec<String> {
    if !env_remove.iter().any(|key| key == "NO_COLOR") {
        env_remove.push("NO_COLOR".to_string());
    }
    env_remove
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{env_remove_keys, spawn_pty, PtyConfig};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn invalid_cwd_config(cwd: PathBuf) -> PtyConfig {
        PtyConfig {
            cols: 80,
            rows: 24,
            cwd,
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            env_remove: Vec::new(),
            resource_policy: crate::models::SessionResourcePolicy::default(),
        }
    }

    fn temp_test_path(kind: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cc-panes-spawn-pty-{kind}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ))
    }

    /// 端到端护栏：策略从 `PtyConfig` 一路走到**真实进程的优先级**。
    ///
    /// 单测 job.rs 只证明 Job 的 LimitFlags 被设上了；这里验证经由 spawn_pty
    /// 起的真进程确实跑在 BELOW_NORMAL——中间任何一段接线断掉都会被这条测出来。
    #[cfg(windows)]
    #[test]
    fn spawn_pty_applies_below_normal_priority_to_child() {
        use windows::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let cwd = std::env::temp_dir();
        let spawn = spawn_pty(PtyConfig {
            cols: 80,
            rows: 24,
            cwd,
            command: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), "ping -n 20 127.0.0.1 > nul".to_string()],
            env: HashMap::new(),
            env_remove: Vec::new(),
            resource_policy: crate::models::SessionResourcePolicy::default(),
        })
        .expect("spawn pty");

        let pid = spawn.process.pid();
        assert_ne!(pid, 0, "need a real pid to query priority");

        let priority = unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .expect("OpenProcess for priority query");
            let class = GetPriorityClass(handle);
            let _ = windows::Win32::Foundation::CloseHandle(handle);
            class
        };

        let _ = spawn.process.kill();
        assert_eq!(
            priority, BELOW_NORMAL_PRIORITY_CLASS.0,
            "expected BELOW_NORMAL ({}), got {priority} (NORMAL is {})",
            BELOW_NORMAL_PRIORITY_CLASS.0, NORMAL_PRIORITY_CLASS.0
        );
    }

    #[test]
    fn spawn_pty_rejects_missing_cwd_before_portable_pty_fallback() {
        let path = temp_test_path("missing");
        let error = match spawn_pty(invalid_cwd_config(path)) {
            Ok(_) => panic!("missing cwd must fail"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("PATH_NOT_FOUND"));
    }

    #[test]
    fn spawn_pty_rejects_file_cwd_before_portable_pty_fallback() {
        let path = temp_test_path("file");
        std::fs::write(&path, b"not a directory").expect("create test file");

        let error = match spawn_pty(invalid_cwd_config(path.clone())) {
            Ok(_) => panic!("file cwd must fail"),
            Err(error) => error,
        };
        std::fs::remove_file(path).expect("remove test file");

        assert!(error.to_string().contains("PATH_NOT_DIRECTORY"));
    }

    #[test]
    fn env_remove_keys_adds_no_color_once() {
        let keys = env_remove_keys(vec!["TERM".to_string()]);
        assert!(keys.iter().any(|key| key == "TERM"));
        assert_eq!(
            keys.iter().filter(|key| key.as_str() == "NO_COLOR").count(),
            1
        );
    }

    #[test]
    fn env_remove_keys_does_not_duplicate_no_color() {
        let keys = env_remove_keys(vec!["NO_COLOR".to_string(), "TERM".to_string()]);
        assert_eq!(
            keys.iter().filter(|key| key.as_str() == "NO_COLOR").count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_nice_target_adds_the_increment_to_the_inherited_value() {
        assert_eq!(super::unix_nice_target(0, 5), 5);
        assert_eq!(super::unix_nice_target(10, 5), 15);
        assert_eq!(super::unix_nice_target(18, 5), 19);
        assert_eq!(super::unix_nice_target(-5, 5), 0);
    }
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
        use crate::utils::no_window_command;

        // taskkill /T = 杀进程树, /F = 强制终止
        let output = no_window_command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
        match output {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                // 进程已不存在时 taskkill 返回非零但不算错误
                if stderr.contains("not found") || stderr.contains("找不到") {
                    Ok(())
                } else {
                    Err(anyhow!(
                        "taskkill failed for pid {}: {}",
                        pid,
                        stderr.trim()
                    ))
                }
            }
            Err(e) => Err(anyhow!("taskkill spawn failed: {}", e)),
        }
    }

    #[cfg(unix)]
    {
        let pgid = -(pid as i32);
        let spid = pid as i32;

        // 先 SIGTERM 请求优雅退出
        let term_ret = unsafe { libc::kill(pgid, libc::SIGTERM) };
        if term_ret != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            // 进程组不存在，尝试单进程 SIGTERM
            let ret2 = unsafe { libc::kill(spid, libc::SIGTERM) };
            if ret2 != 0 {
                let err2 = std::io::Error::last_os_error();
                if err2.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                return Err(anyhow!("kill({}) SIGTERM failed: {}", pid, err2));
            }
        }

        // 等待 100ms 让进程响应 SIGTERM
        std::thread::sleep(std::time::Duration::from_millis(100));

        // 检查进程是否已退出，未退出则 SIGKILL 强制终止
        let check = unsafe { libc::kill(spid, 0) };
        if check == 0 {
            // 进程仍存在，SIGKILL
            let _ = unsafe { libc::kill(pgid, libc::SIGKILL) };
            // 进程组杀失败也尝试单进程
            let _ = unsafe { libc::kill(spid, libc::SIGKILL) };
        }

        Ok(())
    }
}

/// 供经过业务层安全校验的进程树清理复用。
pub(crate) fn kill_process_tree_by_pid(pid: u32) -> Result<()> {
    kill_process_by_pid(pid)
}

/// Unix: 回收子进程，防止僵尸进程
#[cfg(unix)]
fn reap_child(pid: u32) {
    // SAFETY: waitpid 是标准 POSIX 调用，pid 为有效进程 ID，
    // WNOHANG 确保非阻塞，不会影响其他线程
    unsafe {
        let mut status: libc::c_int = 0;
        libc::waitpid(pid as i32, &mut status, libc::WNOHANG);
    }
}
