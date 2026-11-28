//! SSH 本地端口转发（相当于 `ssh -L 127.0.0.1:<随机>:127.0.0.1:<remote_port>`）。
//!
//! 用于把远程服务器上只监听回环的 headless cc-panes-web 映射到本机
//! （docs/111-multi-device.md），以及把远程 dev server 端口映射到本机预览
//! （`PortPreviewService`，docs/116 §B）。每台设备一条 SSH 会话、一个线程：
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
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(200);

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
        Self::start_with_local_port(session, remote_host, remote_port, None)
    }

    /// 同 [`Self::start`]，但优先监听 `127.0.0.1:<preferred_local_port>`（被占用则退回随机端口）。
    /// 端口预览用它让本机端口尽量与远端一致，dev server 里写死的回调地址更可能直接可用。
    pub fn start_with_local_port(
        session: Session,
        remote_host: &str,
        remote_port: u16,
        preferred_local_port: Option<u16>,
    ) -> Result<Self> {
        let listener = bind_loopback(preferred_local_port)
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

/// 绑定本机回环端口：先试 `preferred`（0 视同未指定），被占用或无权限时退回系统分配的空闲端口。
///
/// 先探测一次有没有人在 `127.0.0.1:<preferred>` 上应答：std 在 Unix 上给监听 socket 开了
/// `SO_REUSEADDR`，BSD/macOS 允许它绑到「已被别人以通配地址监听」的端口上，
/// 不探测就会把用户本机同端口的 dev server 遮住。
pub fn bind_loopback(preferred: Option<u16>) -> std::io::Result<TcpListener> {
    if let Some(port) = preferred.filter(|port| *port != 0) {
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let occupied = TcpStream::connect_timeout(&address, LOCAL_PROBE_TIMEOUT).is_ok();
        if !occupied {
            if let Ok(listener) = TcpListener::bind(address) {
                return Ok(listener);
            }
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
}

/// LIBSSH2_ERROR_EAGAIN
fn is_would_block(error: &ssh2::Error) -> bool {
    matches!(error.code(), ssh2::ErrorCode::Session(-37))
}

#[cfg(test)]
mod tests {
    use super::bind_loopback;

    #[test]
    fn bind_loopback_prefers_the_requested_port_when_free() {
        let probe = bind_loopback(None).unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        let listener = bind_loopback(Some(free)).unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), free);
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }

    #[test]
    fn bind_loopback_falls_back_when_the_port_is_taken() {
        let taken = bind_loopback(None).unwrap();
        let port = taken.local_addr().unwrap().port();
        let listener = bind_loopback(Some(port)).unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), port);
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }

    #[test]
    fn bind_loopback_treats_zero_as_any_port() {
        let listener = bind_loopback(Some(0)).unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }
}
