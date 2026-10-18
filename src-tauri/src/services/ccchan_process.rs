//! A structured chat turn owns its process tree. Stop/replacement interrupts
//! pipe readers, and a second send cannot start against the same CLI thread.
use crate::services::process_guard::{configure_command, ProcessGuard};
use crate::utils::{AppError, AppResult};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct ChatProcess {
    state: Mutex<ProcessState>,
}

#[derive(Default)]
struct ProcessState {
    stopped: bool,
    busy: bool,
    child: Option<(Child, ProcessGuard)>,
}

impl std::fmt::Debug for ChatProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatProcess").finish_non_exhaustive()
    }
}

impl ChatProcess {
    pub fn begin(self: &Arc<Self>) -> AppResult<Turn> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped {
            return Err(AppError::from("Chat session has stopped"));
        }
        if state.busy {
            return Err(AppError::from("A chat response is already running"));
        }
        state.busy = true;
        Ok(Turn(self.clone()))
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped = true;
        kill_child(&mut state);
    }
}

fn kill_child(state: &mut ProcessState) {
    if let Some((mut child, guard)) = state.child.take() {
        guard.force_kill(&mut child);
        let _ = child.wait();
    }
}

pub(super) struct Turn(Arc<ChatProcess>);

impl Turn {
    pub fn spawn(&self, command: &mut Command) -> AppResult<(ChildStdout, Option<ChildStderr>)> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped {
            return Err(AppError::from("Chat session has stopped"));
        }
        configure_command(command);
        let mut child = command.spawn().map_err(|e| AppError::from(e.to_string()))?;
        let guard = match ProcessGuard::attach(&child) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        state.child = Some((child, guard));
        let stdout = stdout.ok_or_else(|| AppError::from("Chat stdout is unavailable"))?;
        Ok((stdout, stderr))
    }

    pub fn wait(&self) -> AppResult<ExitStatus> {
        loop {
            {
                let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.stopped {
                    return Err(AppError::from("Chat session has stopped"));
                }
                let (child, _) = state
                    .child
                    .as_mut()
                    .ok_or_else(|| AppError::from("Chat process is missing"))?;
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| AppError::from(e.to_string()))?
                {
                    kill_child(&mut state);
                    return Ok(status);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        kill_child(&mut state);
        state.busy = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;

    #[test]
    fn rejects_overlapping_turns_and_start_after_stop() {
        let process = Arc::new(ChatProcess::default());
        let turn = process.begin().unwrap();
        assert!(process.begin().is_err());
        drop(turn);
        assert!(process.begin().is_ok());
        process.stop();
        assert!(process.begin().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_descendants_and_unblocks_output_reader() {
        let process = Arc::new(ChatProcess::default());
        let turn = process.begin().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 60 & echo ready; wait"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (stdout, _) = turn.spawn(&mut command).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            tx.send(line).unwrap();
            reader.read_to_string(&mut String::new()).unwrap();
            tx.send("closed".into()).unwrap();
        });
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            "ready\n"
        );
        process.stop();
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            "closed"
        );
        assert!(turn.wait().is_err());
        reader.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn drop_reaps_process_on_read_or_setup_error() {
        let process = Arc::new(ChatProcess::default());
        let turn = process.begin().unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 60"]).stdout(Stdio::piped());
        turn.spawn(&mut command).unwrap();
        drop(turn);
        let state = process.state.lock().unwrap();
        assert!(state.child.is_none());
        assert!(!state.busy);
    }
}
