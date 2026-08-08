use crate::models::{PolicyOutcome, SessionResourcePolicy, SshConnectionInfo};
use crate::pty::{PtyProcess, PtySpawnResult};
use anyhow::{anyhow, Context, Result};
use ssh2::{Channel, ErrorCode, ExtendedData, Session, Stream};
use std::io::{self, Read, Write};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::SshConnectionService;

const IO_RETRY_DELAY: Duration = Duration::from_millis(8);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const LIBSSH2_ERROR_EAGAIN: i32 = -37;

pub(super) struct SshTerminalConfig<'a> {
    pub connection: &'a SshConnectionInfo,
    pub remote_command: &'a str,
    pub cols: u16,
    pub rows: u16,
}

pub(super) fn spawn_ssh_terminal(
    connection_service: &SshConnectionService,
    config: SshTerminalConfig<'_>,
) -> Result<PtySpawnResult> {
    let session = connection_service.connect_info(config.connection)?;
    let mut channel = session
        .channel_session()
        .context("Failed to open SSH terminal channel")?;
    channel
        .handle_extended_data(ExtendedData::Merge)
        .context("Failed to merge SSH terminal stderr")?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((u32::from(config.cols), u32::from(config.rows), 0, 0)),
        )
        .context("Failed to request remote SSH PTY")?;
    channel
        .exec(config.remote_command)
        .context("Failed to start remote SSH shell")?;
    session.set_blocking(false);

    let stopped = Arc::new(AtomicBool::new(false));
    let reader = SshChannelReader {
        stream: channel.stream(0),
        session: session.clone(),
        stopped: stopped.clone(),
        last_keepalive: Instant::now(),
    };
    let writer = SshChannelWriter {
        stream: channel.stream(0),
        stopped: stopped.clone(),
    };
    let process = SshChannelProcess {
        channel: Mutex::new(channel),
        session,
        stopped,
    };

    Ok(PtySpawnResult {
        process: Arc::new(process),
        reader: Box::new(reader),
        writer: Box::new(writer),
    })
}

struct SshChannelProcess {
    channel: Mutex<Channel>,
    session: Session,
    stopped: Arc<AtomicBool>,
}

impl PtyProcess for SshChannelProcess {
    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| anyhow!("SSH channel lock poisoned"))?;
        retry_ssh2(|| channel.request_pty_size(u32::from(cols), u32::from(rows), None, None))
            .context("Failed to resize remote SSH PTY")
    }

    fn pid(&self) -> u32 {
        0
    }

    fn wait(&self) -> Result<ExitStatus> {
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Ok(exit_status(1));
            }
            let eof = self
                .channel
                .lock()
                .map_err(|_| anyhow!("SSH channel lock poisoned"))?
                .eof();
            if eof {
                break;
            }
            thread::sleep(IO_RETRY_DELAY);
        }

        let mut channel = self
            .channel
            .lock()
            .map_err(|_| anyhow!("SSH channel lock poisoned"))?;
        retry_ssh2(|| channel.wait_close()).context("Failed waiting for remote SSH shell")?;
        let code = channel.exit_status().unwrap_or(0);
        self.stopped.store(true, Ordering::Release);
        Ok(exit_status(code))
    }

    fn kill(&self) -> Result<()> {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Ok(mut channel) = self.channel.lock() {
            let _ = channel.send_eof();
            let _ = channel.close();
        }
        let _ = self
            .session
            .disconnect(None, "CC-Panes terminal closed", None);
        Ok(())
    }

    fn set_resource_policy(&self, _policy: &SessionResourcePolicy) -> Result<PolicyOutcome> {
        Ok(PolicyOutcome::Unsupported)
    }
}

struct SshChannelReader {
    stream: Stream,
    session: Session,
    stopped: Arc<AtomicBool>,
    last_keepalive: Instant,
}

impl Read for SshChannelReader {
    fn read(&mut self, data: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Ok(0);
            }
            match self.stream.read(data) {
                Ok(size) => return Ok(size),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if self.last_keepalive.elapsed() >= KEEPALIVE_INTERVAL {
                        let _ = self.session.keepalive_send();
                        self.last_keepalive = Instant::now();
                    }
                    thread::sleep(IO_RETRY_DELAY);
                }
                Err(error) => {
                    self.stopped.store(true, Ordering::Release);
                    return Err(error);
                }
            }
        }
    }
}

struct SshChannelWriter {
    stream: Stream,
    stopped: Arc<AtomicBool>,
}

impl Write for SshChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "remote SSH terminal is closed",
                ));
            }
            match self.stream.write(data) {
                Ok(size) => return Ok(size),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(IO_RETRY_DELAY)
                }
                Err(error) => {
                    self.stopped.store(true, Ordering::Release);
                    return Err(error);
                }
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        loop {
            match self.stream.flush() {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(IO_RETRY_DELAY)
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn retry_ssh2<T>(mut operation: impl FnMut() -> std::result::Result<T, ssh2::Error>) -> Result<T> {
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_would_block(&error) => thread::sleep(IO_RETRY_DELAY),
            Err(error) => return Err(error.into()),
        }
    }
}

fn is_would_block(error: &ssh2::Error) -> bool {
    matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN))
}

#[cfg(unix)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code.max(0) << 8)
}

#[cfg(windows)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(code.max(0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_libssh2_would_block() {
        let error = ssh2::Error::from_errno(ErrorCode::Session(LIBSSH2_ERROR_EAGAIN));
        assert!(is_would_block(&error));
    }
}
