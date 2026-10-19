//! Version probes must drain both pipes while the child runs, and the deadline
//! must include pipe EOF (a launcher may leave inherited pipes in a descendant).
use crate::utils::AppResult;
use cc_cli_adapters::{no_window_command, normalize_cli_command};
use std::io;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_STREAM_BYTES: usize = 512 * 1024;

pub(super) async fn probe(
    command: String,
    version_args: Option<Vec<String>>,
    timeout: Duration,
) -> AppResult<String> {
    let command = normalize_cli_command(&command);
    if command.is_empty() {
        return Err("CLI command is empty".into());
    }
    let args = version_args.unwrap_or_else(|| vec!["--version".to_string()]);
    let mut child = tokio::process::Command::from(no_window_command(command))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Failed to start CLI command: {error}"))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let capture = async {
        let (status, stdout, stderr) =
            tokio::try_join!(child.wait(), read_output(stdout), read_output(stderr))?;
        Ok::<_, io::Error>(Output {
            status,
            stdout,
            stderr,
        })
    };
    let result = tokio::time::timeout(timeout, capture)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "CLI command timed out"))
        .and_then(|result| result);
    match result {
        Ok(output) => display_output(output),
        Err(error) => {
            // Explicitly reap the probe itself. Descendants may be an existing
            // CLI's daemon, so do not kill an entire process group.
            let _ = child.kill().await;
            Err(format!("Failed to read CLI output: {error}").into())
        }
    }
}

async fn read_output(reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader
        .take(MAX_STREAM_BYTES as u64 + 1)
        .read_to_end(&mut output)
        .await?;
    if output.len() > MAX_STREAM_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            format!("CLI command output limit exceeded ({MAX_STREAM_BYTES} bytes per stream)"),
        ));
    }
    Ok(output)
}

fn display_output(output: Output) -> AppResult<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = super::first_non_empty([stdout.trim(), stderr.trim()])
        .unwrap_or_else(|| "Command completed without output".to_string());
    let text = super::truncate_cli_launcher_output(&text);
    if !output.status.success() {
        let status = output
            .status
            .code()
            .map_or_else(|| "signal".into(), |code| code.to_string());
        return Err(format!("CLI command exited with {status}: {text}").into());
    }
    Ok(text)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct ProbeProcess(PathBuf);

    impl ProbeProcess {
        fn pid(&self) -> Option<i32> {
            std::fs::read_to_string(&self.0).ok()?.trim().parse().ok()
        }

        async fn assert_reaped(&self) {
            let pid = self.pid().expect("probe must record its PID");
            tokio::time::timeout(Duration::from_secs(2), async {
                // SAFETY: signal zero only probes existence of our isolated child.
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("probe must be reaped");
            // Disarm cleanup after observing exit, before the OS can reuse the PID.
            std::fs::remove_file(&self.0).unwrap();
        }
    }

    impl Drop for ProbeProcess {
        fn drop(&mut self) {
            if let Some(pid) = self.pid() {
                // SAFETY: the PID was written by this test's isolated child.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    fn shell_args(script: &str, pid_file: Option<&ProbeProcess>) -> Option<Vec<String>> {
        let mut args = vec!["-c".into(), script.into(), "ccpanes-probe-test".into()];
        if let Some(process) = pid_file {
            args.push(process.0.to_string_lossy().into_owned());
        }
        Some(args)
    }

    #[tokio::test]
    async fn drains_both_pipes_while_process_is_running() {
        let result = probe(
            "/bin/sh".into(),
            shell_args(
                "printf '%262144s' 'version 1.0'; printf '%262144s' 'diagnostic' >&2",
                None,
            ),
            Duration::from_secs(3),
        )
        .await;
        assert_eq!(result.unwrap(), "version 1.0");
    }

    #[tokio::test]
    async fn rejects_excessive_output_without_waiting_for_process_exit() {
        let result = probe(
            "/bin/sh".into(),
            shell_args("printf '%524289s' x; exec /bin/sleep 30", None),
            Duration::from_secs(3),
        )
        .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("output limit exceeded"));
    }

    #[tokio::test]
    async fn deadline_includes_pipes_inherited_by_a_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let descendant = ProbeProcess(temp.path().join("descendant.pid"));
        let result = probe(
            "/bin/sh".into(),
            shell_args(
                "/bin/sleep 30 & printf '%s' \"$!\" > \"$1\"",
                Some(&descendant),
            ),
            Duration::from_millis(200),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert!(descendant.pid().is_some());
    }

    #[tokio::test]
    async fn deadline_kills_and_reaps_the_probe() {
        let temp = tempfile::tempdir().unwrap();
        let process = ProbeProcess(temp.path().join("probe.pid"));
        let result = probe(
            "/bin/sh".into(),
            shell_args(
                "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                Some(&process),
            ),
            Duration::from_millis(200),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        process.assert_reaped().await;
    }

    #[tokio::test]
    async fn cancelling_probe_kills_and_reaps_its_child() {
        let temp = tempfile::tempdir().unwrap();
        let process = ProbeProcess(temp.path().join("probe.pid"));
        let task = tokio::spawn(probe(
            "/bin/sh".into(),
            shell_args(
                "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                Some(&process),
            ),
            Duration::from_secs(30),
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if process.pid().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        process.assert_reaped().await;
    }
}
