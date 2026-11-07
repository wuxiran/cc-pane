//! SSH 本地端口转发（相当于 `ssh -L 127.0.0.1:<随机>:127.0.0.1:<remote_port>`）。
//!
//! 用于把远程服务器上只监听回环的 headless cc-panes-web 映射到本机
//! （docs/111-multi-device.md）。每台设备一条 SSH 会话、一个线程：
//! `ssh2::Session` 的 channel 不能被两个线程同时驱动（每次读写都持 session 锁，
//! 两个阻塞线程对搬会互相等锁），所以所有被转发的 TCP 连接都在同一线程里
//! 以非阻塞方式轮询，与 `ssh_proxy_bridge` 的跳板中继同理。
//!
//! 会话断开（keepalive 失败）后线程退出、监听端口关闭，`is_alive()` 变为 false，
//! 由上层（DeviceService）按需重建。

use std::io::ErrorKind;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use ssh2::Session;

use super::ssh_relay::{ChannelIo, Relay, RelayStep};

const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const OPEN_TIMEOUT_MS: u32 = 15_000;
const IDLE_SLEEP: Duration = Duration::from_millis(2);

pub struct SshPortForward {
    local_addr: SocketAddr,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SshPortForward {
    /// 在本机 `127.0.0.1:0` 上监听，把每个连接经 `direct-tcpip` 转发到
    /// 远端视角下的 `remote_host:remote_port`。`session` 必须已认证。
    pub fn start(session: Session, remote_host: &str, remote_port: u16) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .context("Failed to bind a loopback port for the SSH forward")?;
        listener
            .set_nonblocking(true)
            .context("Failed to make the SSH forward listener non-blocking")?;
        let local_addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let worker = Worker {
            session,
            listener,
            remote_host: remote_host.to_string(),
            remote_port,
            stop: stop.clone(),
            alive: alive.clone(),
            pairs: Vec::new(),
        };
        let thread = thread::Builder::new()
            .name(format!("ccpanes-ssh-forward-{remote_port}"))
            .spawn(move || worker.run())
            .context("Failed to start the SSH forward thread")?;
        Ok(Self {
            local_addr,
            stop,
            alive,
            thread: Some(thread),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

impl Drop for SshPortForward {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Pair {
    local: TcpStream,
    channel: ssh2::Channel,
    remote: ChannelIo,
    relay: Relay,
}

struct Worker {
    session: Session,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    pairs: Vec<Pair>,
}

impl Worker {
    fn run(mut self) {
        self.session
            .set_keepalive(true, KEEPALIVE_INTERVAL.as_secs() as u32);
        self.session.set_blocking(false);
        let mut next_keepalive = Instant::now() + KEEPALIVE_INTERVAL;
        while !self.stop.load(Ordering::SeqCst) {
            let mut progressed = self.accept_new();
            progressed |= self.pump_all();
            if Instant::now() >= next_keepalive {
                if let Err(error) = self.session.keepalive_send() {
                    if !is_would_block(&error) {
                        tracing::info!(%error, port = self.remote_port, "SSH forward session lost");
                        break;
                    }
                }
                next_keepalive = Instant::now() + KEEPALIVE_INTERVAL;
            }
            if !progressed {
                thread::sleep(IDLE_SLEEP);
            }
        }
        self.alive.store(false, Ordering::SeqCst);
        for pair in std::mem::take(&mut self.pairs) {
            self.close(pair);
        }
    }

    fn accept_new(&mut self) -> bool {
        let mut accepted = false;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    accepted = true;
                    if let Err(error) = self.open(stream) {
                        tracing::debug!(%error, port = self.remote_port, "SSH forward open failed");
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return accepted,
                Err(error) => {
                    tracing::debug!(%error, "SSH forward accept failed");
                    return accepted;
                }
            }
        }
    }

    fn open(&mut self, local: TcpStream) -> Result<()> {
        local.set_nonblocking(true)?;
        let _ = local.set_nodelay(true);
        // 打开 channel 这一步用阻塞模式：非阻塞下要自己重试 EAGAIN，且没有更好的时机。
        self.session.set_blocking(true);
        self.session.set_timeout(OPEN_TIMEOUT_MS);
        let opened = self
            .session
            .channel_direct_tcpip(&self.remote_host, self.remote_port, None);
        self.session.set_timeout(0);
        self.session.set_blocking(false);
        let channel = opened.with_context(|| {
            format!(
                "Failed to open SSH forward to {}:{}",
                self.remote_host, self.remote_port
            )
        })?;
        let remote = ChannelIo::new(&channel);
        self.pairs.push(Pair {
            local,
            channel,
            remote,
            relay: Relay::new(),
        });
        Ok(())
    }

    fn pump_all(&mut self) -> bool {
        let mut progressed = false;
        let mut index = 0;
        while index < self.pairs.len() {
            let pair = &mut self.pairs[index];
            let outcome = pair.relay.step(&mut pair.local, &mut pair.remote);
            match outcome {
                Ok(RelayStep::Idle) => index += 1,
                Ok(RelayStep::Progressed) => {
                    progressed = true;
                    index += 1;
                }
                Ok(RelayStep::Finished) | Err(_) => {
                    progressed = true;
                    let pair = self.pairs.swap_remove(index);
                    self.close(pair);
                }
            }
        }
        progressed
    }

    fn close(&self, mut pair: Pair) {
        let _ = pair.local.shutdown(std::net::Shutdown::Both);
        // 切回阻塞再关闭：非阻塞下 close 返回 EAGAIN 会被忽略，远端转发泄漏。
        self.session.set_blocking(true);
        self.session.set_timeout(2_000);
        let _ = pair.channel.send_eof();
        let _ = pair.channel.close();
        self.session.set_timeout(0);
        self.session.set_blocking(false);
    }
}

/// LIBSSH2_ERROR_EAGAIN
fn is_would_block(error: &ssh2::Error) -> bool {
    matches!(error.code(), ssh2::ErrorCode::Session(-37))
}
