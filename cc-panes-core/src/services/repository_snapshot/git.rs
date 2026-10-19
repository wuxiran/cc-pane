use crate::utils::{AppError, AppResult};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 128 * 1024 * 1024;

pub(super) fn command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(cwd);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
        .args(["-c", "core.hooksPath=/dev/null"]);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

pub(super) fn private(repository: &Path) -> Command {
    let mut command = command(repository);
    command.arg("--git-dir").arg(repository);
    command
}

pub(super) fn run(command: Command, input: Vec<u8>) -> AppResult<Vec<u8>> {
    run_with_timeout(command, input, TIMEOUT)
}

fn run_with_timeout(mut command: Command, input: Vec<u8>, timeout: Duration) -> AppResult<Vec<u8>> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or("Git stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("Git stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr is unavailable")?;
    let writer = background(move || stdin.write_all(&input));
    let output_reader = background(move || read_bounded(stdout));
    let error_reader = background(move || read_bounded(stderr));
    let start = Instant::now();
    let result = (|| {
        let status = wait_for_exit(&mut child, start, timeout)?;
        let stdout = receive(output_reader, start, timeout)?;
        let stderr = receive(error_reader, start, timeout)?;
        if !status.success() {
            return Err(format!(
                "Repository snapshot Git failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            )
            .into());
        }
        receive(writer, start, timeout)?;
        Ok(stdout)
    })();
    if result.is_err() {
        terminate(&mut child);
    }
    result
}

fn wait_for_exit(child: &mut Child, start: Instant, timeout: Duration) -> AppResult<ExitStatus> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if start.elapsed() >= timeout {
            return Err(timed_out());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn background<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Receiver<std::io::Result<T>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
}

fn receive<T>(
    receiver: Receiver<std::io::Result<T>>,
    start: Instant,
    timeout: Duration,
) -> AppResult<T> {
    Ok(receiver
        .recv_timeout(timeout.saturating_sub(start.elapsed()))
        .map_err(|_| timed_out())??)
}

fn timed_out() -> AppError {
    AppError::from("Repository snapshot Git command timed out or its I/O worker failed")
}

fn read_bounded(reader: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_OUTPUT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_OUTPUT {
        return Err(std::io::Error::other(
            "Repository snapshot Git output is too large",
        ));
    }
    Ok(bytes)
}

fn terminate(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // Every command owns a fresh process group, including any Git helper.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn text(bytes: Vec<u8>) -> AppResult<String> {
    String::from_utf8(bytes)
        .map(|value| value.trim_end_matches(['\r', '\n']).to_string())
        .map_err(|_| "Repository snapshots require UTF-8 Git paths".into())
}

pub(super) fn oid(value: &str) -> AppResult<()> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid repository snapshot object ID".into());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    #[test]
    fn timeout_also_covers_descendants_holding_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5 & exit 0"]).process_group(0);
        let started = Instant::now();
        assert!(run_with_timeout(command, vec![], Duration::from_millis(100)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
