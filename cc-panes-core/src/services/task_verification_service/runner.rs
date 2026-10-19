use super::process_tree::{self, ProcessTree};
use crate::utils::{AppError, AppResult};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
    error: Option<String>,
}

pub(super) struct Execution {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    pub error: Option<String>,
    pub duration_ms: u64,
}

pub(super) fn execute(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    lease: &super::storage::TaskLock,
) -> AppResult<Execution> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(execute_async(command, cwd, timeout, lease))
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    let mut shell = {
        let mut shell = Command::new("cmd.exe");
        shell.args(["/D", "/S", "/C", command]);
        shell
    };
    #[cfg(not(windows))]
    let mut shell = {
        let mut shell = Command::new("/bin/sh");
        shell.args(["-c", command]);
        shell
    };
    shell
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process_tree::configure(&mut shell);
    shell
}

async fn execute_async(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    lease: &super::storage::TaskLock,
) -> AppResult<Execution> {
    let started = Instant::now();
    let (mut child, tree) = spawn_check(command, cwd, lease).await?;
    let stdout = Arc::new(Mutex::new(CapturedOutput::default()));
    let stderr = Arc::new(Mutex::new(CapturedOutput::default()));
    let out_reader = tokio::spawn(drain(
        child.stdout.take().ok_or("Missing stdout")?,
        stdout.clone(),
    ));
    let err_reader = tokio::spawn(drain(
        child.stderr.take().ok_or("Missing stderr")?,
        stderr.clone(),
    ));
    let (exit_code, signal, timed_out, error) = wait_for_check(&mut child, &tree, timeout).await;
    let drain_error = finish_draining(out_reader, err_reader).await;
    finish(
        stdout,
        stderr,
        exit_code,
        signal,
        timed_out,
        error.or(drain_error),
        started,
    )
}

async fn spawn_check(
    command: &str,
    cwd: &Path,
    lease: &super::storage::TaskLock,
) -> AppResult<(Child, ProcessTree)> {
    let token = uuid::Uuid::new_v4().to_string();
    let mut shell = shell_command(command);
    shell
        .current_dir(cwd)
        .env("CCPANES_VERIFICATION_RUN_ID", &token);
    lease.inherit_into(&mut shell);
    let mut child = shell.spawn()?;
    match ProcessTree::attach(&child, token) {
        Ok(tree) => Ok((child, tree)),
        Err(error) => {
            let _ = child.kill().await;
            Err(error)
        }
    }
}

#[cfg(windows)]
async fn wait_for_check(
    child: &mut Child,
    tree: &ProcessTree,
    timeout: Duration,
) -> (Option<i32>, Option<i32>, bool, Option<String>) {
    let waited = tokio::time::timeout(timeout, child.wait()).await;
    let timed_out = waited.is_err();
    // Reclaim descendants even after successful shells exit with background jobs.
    let cleanup_error = tree.kill().err().map(|error| error.to_string());
    let status = match waited {
        Ok(status) => status,
        Err(_) => {
            let _ = child.start_kill();
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .unwrap_or_else(|_| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Process did not exit after cleanup",
                    ))
                })
        }
    };
    let (exit_code, signal, error) = exit_details(status);
    (exit_code, signal, timed_out, error.or(cleanup_error))
}

#[cfg(unix)]
async fn wait_for_check(
    child: &mut Child,
    tree: &ProcessTree,
    timeout: Duration,
) -> (Option<i32>, Option<i32>, bool, Option<String>) {
    let observed = observe_until_exit(child.id().unwrap_or(0), timeout).await;
    let timed_out = observed
        .as_ref()
        .err()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut);
    let observation_error = observed
        .err()
        .filter(|error| error.kind() != std::io::ErrorKind::TimedOut)
        .map(|error| error.to_string());
    let cleanup_error = tree.kill().err().map(|error| error.to_string());
    let _ = child.start_kill();
    let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .unwrap_or_else(|_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Process did not exit after cleanup",
            ))
        });
    let (exit_code, signal, error) = exit_details(status);
    (
        exit_code,
        signal,
        timed_out,
        error.or(observation_error).or(cleanup_error),
    )
}

#[cfg(unix)]
async fn observe_until_exit(pid: u32, timeout: Duration) -> std::io::Result<()> {
    let started = Instant::now();
    loop {
        match process_tree::observe_child(pid) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
        if started.elapsed() >= timeout {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Verification timed out",
            ));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn finish_draining(
    mut stdout: tokio::task::JoinHandle<()>,
    mut stderr: tokio::task::JoinHandle<()>,
) -> Option<String> {
    let drained = tokio::time::timeout(Duration::from_secs(2), async {
        let (out, err) = tokio::join!(&mut stdout, &mut stderr);
        out.and(err)
    })
    .await;
    stdout.abort();
    stderr.abort();
    match drained {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("Output drain timed out after process cleanup".to_string()),
    }
}

fn exit_details(
    status: std::io::Result<std::process::ExitStatus>,
) -> (Option<i32>, Option<i32>, Option<String>) {
    match status {
        Ok(status) => {
            #[cfg(unix)]
            let signal = {
                use std::os::unix::process::ExitStatusExt;
                status.signal()
            };
            #[cfg(not(unix))]
            let signal = None;
            (status.code(), signal, None)
        }
        Err(error) => (None, None, Some(error.to_string())),
    }
}

async fn drain<R: AsyncRead + Unpin>(mut reader: R, target: Arc<Mutex<CapturedOutput>>) {
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await;
        let mut capture = target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match read {
            Ok(0) => return,
            Ok(count) => {
                let retained = count.min(OUTPUT_LIMIT.saturating_sub(capture.bytes.len()));
                capture.bytes.extend_from_slice(&chunk[..retained]);
                capture.truncated |= retained < count;
            }
            Err(error) => {
                capture.error = Some(error.to_string());
                return;
            }
        }
    }
}

fn finish(
    stdout: Arc<Mutex<CapturedOutput>>,
    stderr: Arc<Mutex<CapturedOutput>>,
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
    error: Option<String>,
    started: Instant,
) -> AppResult<Execution> {
    let stdout = stdout
        .lock()
        .map_err(|_| AppError::from("Output capture lock poisoned"))?;
    let stderr = stderr
        .lock()
        .map_err(|_| AppError::from("Output capture lock poisoned"))?;
    Ok(Execution {
        exit_code,
        signal,
        timed_out,
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        output_truncated: stdout.truncated || stderr.truncated,
        error: error
            .or_else(|| stdout.error.clone())
            .or_else(|| stderr.error.clone()),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
