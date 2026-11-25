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
    /// 供应商凭证等敏感环境变量：不进命令行，经独立通道写进远端 0600 临时文件，
    /// 由 `remote_command` 前置的 `. 文件 && rm -f 文件` 读入后立即删除。
    pub secret_env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
}

/// 远端写环境文件的脚本：经用户登录 shell 交给 `sh -c`（不依赖登录 shell 的语法），
/// 内容从 stdin 读入，`umask 077` 保证文件只有本人可读，打印文件路径作为唯一输出。
/// 脚本里只能用双引号——外层用单引号包给 `sh -c`。
const WRITE_ENV_FILE_SCRIPT: &str = "sh -c 'umask 077 && f=$(mktemp \"${TMPDIR:-/tmp}/.ccpanes-env.XXXXXX\") && cat > \"$f\" && printf %s \"$f\"'";

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 环境文件内容：每行一条 `export K='v'`（POSIX 单引号转义）。
pub(super) fn env_file_content(secret_env: &[(String, String)]) -> String {
    secret_env
        .iter()
        .map(|(key, value)| format!("export {key}={}\n", shell_quote(value)))
        .collect()
}

/// 在独立 channel 上把敏感环境变量写进远端临时文件，返回文件路径。
fn upload_secret_env(session: &Session, secret_env: &[(String, String)]) -> Result<String> {
    let mut channel = session
        .channel_session()
        .context("Failed to open SSH channel for launch environment")?;
    channel
        .exec(WRITE_ENV_FILE_SCRIPT)
        .context("Failed to start remote launch environment writer")?;
    channel
        .write_all(env_file_content(secret_env).as_bytes())
        .context("Failed to send launch environment")?;
    channel
        .send_eof()
        .context("Failed to finish launch environment")?;
    let mut path = String::new();
    channel
        .read_to_string(&mut path)
        .context("Failed to read remote launch environment path")?;
    channel.wait_close().ok();
    let status = channel.exit_status().unwrap_or(-1);
    let path = path.trim().to_string();
    if status != 0 || !path.starts_with('/') || path.contains('\'') || path.contains('\n') {
        return Err(anyhow!(
            "Remote host could not create a private launch environment file (exit {status})"
        ));
    }
    Ok(path)
}

/// 启动失败时尽力删掉还没被读走的环境文件。
fn remove_remote_file(session: &Session, path: &str) {
    if let Ok(mut channel) = session.channel_session() {
        let _ = channel.exec(&format!("rm -f {}", shell_quote(path)));
        let _ = channel.wait_close();
    }
}

pub(super) fn spawn_ssh_terminal(
    connection_service: &SshConnectionService,
    config: SshTerminalConfig<'_>,
) -> Result<PtySpawnResult> {
    let session = connection_service.connect_info(config.connection)?;
    let env_file = if config.secret_env.is_empty() {
        None
    } else {
        Some(upload_secret_env(&session, config.secret_env)?)
    };
    let remote_command = match env_file.as_deref() {
        Some(path) => {
            let quoted = shell_quote(path);
            format!(". {quoted} && rm -f {quoted} && {}", config.remote_command)
        }
        None => config.remote_command.to_string(),
    };
    let started = start_terminal_channel(&session, &remote_command, config.cols, config.rows);
    let channel = match started {
        Ok(channel) => channel,
        Err(error) => {
            if let Some(path) = env_file.as_deref() {
                remove_remote_file(&session, path);
            }
            return Err(error);
        }
    };
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
        // 远端进程不受本机 Job / nice 管辖；"不涉及"而非"不支持"。
        policy_outcome: None,
    })
}

fn start_terminal_channel(
    session: &Session,
    remote_command: &str,
    cols: u16,
    rows: u16,
) -> Result<Channel> {
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
            Some((u32::from(cols), u32::from(rows), 0, 0)),
        )
        .context("Failed to request remote SSH PTY")?;
    channel
        .exec(remote_command)
        .context("Failed to start remote SSH shell")?;
    Ok(channel)
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
    fn env_file_quotes_values_for_posix_sourcing() {
        let content = super::env_file_content(&[
            ("PLAIN".to_string(), "value".to_string()),
            ("TRICKY".to_string(), "a'b $HOME `x`".to_string()),
        ]);
        assert_eq!(
            content,
            "export PLAIN='value'\nexport TRICKY='a'\\''b $HOME `x`'\n"
        );
    }

    #[test]
    fn detects_libssh2_would_block() {
        let error = ssh2::Error::from_errno(ErrorCode::Session(LIBSSH2_ERROR_EAGAIN));
        assert!(is_would_block(&error));
    }
}
