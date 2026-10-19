//! Own the child in one task, with cancellation independent of its wait future.
//! Both adapter and ACP terminal processes use this lifecycle so closing a chat
//! also terminates descendants and releases their inherited stdout/stderr pipes.

use crate::services::process_guard::ProcessGuard;
use std::process::ExitStatus;
use tokio::process::Child;
use tokio::sync::watch;

type ProcessExit = Result<ExitStatus, String>;

/// Sends cancellation even if a caller drops its pending `kill()` future.
/// Dropping the owner closes the channel, which also stops the child.
pub(crate) struct AcpProcess {
    cancel: watch::Sender<bool>,
    exit: watch::Receiver<Option<ProcessExit>>,
}

struct TreeGuard(Option<ProcessGuard>);

impl TreeGuard {
    fn terminate(&mut self) {
        if let Some(guard) = self.0.take() {
            guard.kill_tree();
        }
    }
}

impl Drop for TreeGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl AcpProcess {
    pub(crate) fn new(mut child: Child, guard: Option<ProcessGuard>) -> Self {
        let (cancel, mut cancelled) = watch::channel(false);
        let (exited, exit) = watch::channel(None);
        let mut guard = TreeGuard(guard);
        tokio::spawn(async move {
            let result = tokio::select! {
                result = child.wait() => result,
                _ = cancelled.changed() => {
                    // `changed` also resolves if the owner is dropped. Do not
                    // hold any caller-visible mutex while awaiting process exit.
                    guard.terminate();
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // A successful root process can leave background descendants behind.
            // Kill those before announcing exit, so readers can drain to EOF.
            drop(guard);
            let _ = exited.send(Some(result.map_err(|error| error.to_string())));
        });
        Self { cancel, exit }
    }

    pub(crate) fn request_kill(&self) {
        self.cancel.send_replace(true);
    }

    pub(crate) async fn kill(&self) -> ProcessExit {
        self.request_kill();
        self.wait().await
    }

    pub(crate) async fn wait(&self) -> ProcessExit {
        let mut exit = self.exit.clone();
        loop {
            if let Some(result) = exit.borrow_and_update().clone() {
                return result;
            }
            if exit.changed().await.is_err() {
                return Err("ACP process monitor stopped before reporting exit".to_string());
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::services::process_guard;
    use std::{process::Stdio, time::Duration};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    async fn start(script: &str) -> (AcpProcess, BufReader<tokio::process::ChildStdout>) {
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", script])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        process_guard::configure_command(command.as_std_mut());
        let mut child = command.spawn().unwrap();
        let guard = super::super::attach_guard(&child).unwrap();
        let stdout = child.stdout.take().unwrap();
        (AcpProcess::new(child, guard), BufReader::new(stdout))
    }

    #[tokio::test]
    async fn stopping_adapter_terminates_descendants_holding_its_pipes() {
        let (process, mut stdout) = start("sleep 30 & printf 'ready\\n'; wait").await;
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        let status = tokio::time::timeout(Duration::from_secs(3), process.kill())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        let mut tail = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_to_string(&mut tail))
            .await
            .expect("descendant kept pipe open after adapter stop")
            .unwrap();
    }

    #[tokio::test]
    async fn adapter_natural_exit_reaps_descendants_and_keeps_original_exit_status() {
        let (process, mut stdout) = start("sleep 30 & printf finished; exit 7").await;
        let status = tokio::time::timeout(Duration::from_secs(3), process.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(7));
        let mut output = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_to_string(&mut output))
            .await
            .expect("descendant survived adapter exit")
            .unwrap();
        assert_eq!(output, "finished");
    }

    #[tokio::test]
    async fn dropping_process_owner_cancels_without_a_pending_waiter() {
        let (process, mut stdout) = start("sleep 30 & printf 'ready\\n'; wait").await;
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        drop(process);
        let mut output = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_to_string(&mut output))
            .await
            .expect("dropped owner leaked its process tree")
            .unwrap();
    }
}
