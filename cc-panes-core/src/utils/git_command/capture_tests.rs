use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};

const FIXTURE_MODE: &str = "CCPANES_TEST_PIPE_CAPTURE_MODE";
const FIXTURE_DIR: &str = "CCPANES_TEST_PIPE_CAPTURE_DIR";

fn fixture_command(mode: &str, directory: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "utils::git_command::capture_tests::command_fixture",
            "--nocapture",
        ])
        .env(FIXTURE_MODE, mode)
        .env(FIXTURE_DIR, directory);
    command
}

/// Invoked in a separate copy of the test executable, avoiding shell-specific
/// pipe inheritance behavior and allowing the same regression on Windows CI.
#[test]
fn command_fixture() {
    let Ok(mode) = std::env::var(FIXTURE_MODE) else {
        return;
    };
    let directory = PathBuf::from(std::env::var_os(FIXTURE_DIR).unwrap());
    if mode == "observe-close" {
        std::thread::sleep(Duration::from_secs(1));
        let stdout_closed = std::io::stdout().write_all(b"late stdout\n").is_err();
        let stderr_closed = std::io::stderr().write_all(b"late stderr\n").is_err();
        let result = if stdout_closed && stderr_closed {
            "closed"
        } else {
            "open"
        };
        std::fs::write(directory.join("pipe-result"), result).unwrap();
    } else if mode == "large-output" {
        std::io::stdout()
            .write_all(&vec![b'x'; 256 * 1024])
            .unwrap();
        std::io::stderr()
            .write_all(&vec![b'y'; 256 * 1024])
            .unwrap();
    } else {
        let child = fixture_command("observe-close", &directory)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write(directory.join("descendant.pid"), child.id().to_string()).unwrap();
        if mode == "wait-with-descendant" {
            std::thread::sleep(Duration::from_secs(30));
        }
        // Child intentionally outlives its parent and retains both output pipes.
    }
}

struct DescendantCleanup(PathBuf);

impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        let pid_file = self.0.join("descendant.pid");
        let Some(pid) = std::fs::read_to_string(pid_file)
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            return;
        };
        #[cfg(unix)]
        // SAFETY: this PID belongs to the isolated descendant spawned by this test.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = cc_cli_adapters::no_window_command("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .status();
        }
    }
}

#[test]
fn deadline_closes_inherited_pipes_after_parent_exit_or_timeout() {
    for mode in ["exit-with-descendant", "wait-with-descendant"] {
        let directory = tempfile::tempdir().unwrap();
        let _cleanup = DescendantCleanup(directory.path().to_path_buf());
        let error = output_with_timeout(
            &mut fixture_command(mode, directory.path()),
            Duration::from_millis(250),
        )
        .expect_err("open inherited pipes must count toward the deadline");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let started = Instant::now();
        let marker = directory.path().join("pipe-result");
        while !marker.exists() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        // The descendant's write fails only if all our read ends were closed.
        // A detached blocked reader would still consume these late bytes.
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "closed");
        // The descendant has finished its work; do not kill a potentially reused PID.
        std::fs::remove_file(directory.path().join("descendant.pid")).unwrap();
    }
}

#[test]
fn drains_large_stdout_and_stderr_without_reader_threads() {
    let directory = tempfile::tempdir().unwrap();
    let output = output_with_timeout_limit(
        &mut fixture_command("large-output", directory.path()),
        Duration::from_secs(5),
        1024 * 1024,
    )
    .unwrap();
    assert!(output.status.success());
    assert!(output
        .stdout
        .windows(256 * 1024)
        .any(|w| w.iter().all(|&b| b == b'x')));
    assert_eq!(output.stderr, vec![b'y'; 256 * 1024]);
}

#[test]
fn output_limit_counts_both_streams_together() {
    let directory = tempfile::tempdir().unwrap();
    let error = output_with_timeout_limit(
        &mut fixture_command("large-output", directory.path()),
        Duration::from_secs(5),
        384 * 1024,
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
}
