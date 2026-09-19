//! SSH 连接路由桥接：每主机 SOCKS5 / HTTP 代理隧道与跳板机中继。
//!
//! 内嵌终端直接用 `ssh2` 建连，不经过系统 `ssh`，因此 `-J` 与
//! `ProxyCommand` 都用不上，代理和跳板必须在 Rust 侧自己实现：
//!
//! - **代理**：与代理完成 SOCKS5 / HTTP CONNECT 协商后，这条 TCP 连接
//!   本身就是通往目标的隧道，可直接交给 `Session::set_tcp_stream`，
//!   不需要任何中继线程。
//! - **跳板**：`Session::set_tcp_stream` 只接受裸 OS socket
//!   (`AsRawFd` / `AsRawSocket`)，而 SSH channel 的 `Stream` 不是，
//!   所以需要一对回环 socket 加一个中继线程在两端之间搬字节。
//!
//! 中继线程必须单线程轮询：`ssh2::Stream` 的每次读写都会持有 session
//! 互斥锁，两个阻塞线程对搬会互相等锁而死锁。
//!
//! 凭据安全：代理密码只以 `&str` 在调用栈内传递，绝不写进日志、错误
//! 信息或任何持久化结构；HTTP Basic 的 base64 结果等价于明文，同样
//! 不得出现在任何诊断输出里。

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ssh2::Session;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use super::ssh_relay::{pump_bidirectional, ChannelIo};
use crate::models::{SshProxyConfig, SshProxyKind};

/// 与直连路径保持一致的握手超时；协商完成后 socket 交给 ssh2 管理。
pub(crate) const BRIDGE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_SESSION_TIMEOUT_MS: u32 = 15_000;
const MAX_HTTP_RESPONSE_HEADERS: usize = 16 * 1024;

const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_AUTH_NONE: u8 = 0x00;
const SOCKS5_AUTH_PASSWORD: u8 = 0x02;
const SOCKS5_AUTH_REJECTED: u8 = 0xff;
const SOCKS5_USERPASS_VERSION: u8 = 0x01;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_REPLY_SUCCESS: u8 = 0x00;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_ATYP_IPV6: u8 = 0x04;

struct JumpRelayResources {
    relay_side: TcpStream,
    jump_session: Session,
    channel: ssh2::Channel,
}

impl Drop for JumpRelayResources {
    fn drop(&mut self) {
        // 切回阻塞模式再关闭：非阻塞下 libssh2 返回 EAGAIN，
        // channel 释放会被忽略从而泄漏远端转发。
        let _ = self.relay_side.shutdown(std::net::Shutdown::Both);
        self.jump_session.set_blocking(true);
        let _ = self.channel.close();
        let _ = self.channel.wait_close();
    }
}

/// 拼 `host:port`，IPv6 字面量加方括号（HTTP CONNECT 的 authority 要求）。
pub(crate) fn format_address(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 解析并连上 `host:port`，逐个候选地址尝试直到超时。
pub(crate) fn open_tcp_stream(address: &str) -> Result<TcpStream> {
    use std::net::ToSocketAddrs;

    let host = address
        .rsplit_once(':')
        .map(|(host, _)| host.trim_start_matches('[').trim_end_matches(']'))
        .unwrap_or(address);
    address
        .to_socket_addrs()
        .with_context(|| format!("Failed to resolve {host}"))?
        .find_map(|socket| TcpStream::connect_timeout(&socket, BRIDGE_CONNECT_TIMEOUT).ok())
        .with_context(|| format!("Failed to connect to {address}"))
}

/// 经代理打通到 `target_host:target_port` 的 TCP 隧道。
///
/// 返回的 `TcpStream` 已处于「隧道内部」状态，可直接作为 SSH 传输层。
/// `password` 为 keyring 取出的代理密码，配置了用户名时才需要。
pub(crate) fn open_proxy_tunnel(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
    password: Option<&str>,
) -> Result<TcpStream> {
    let address = format_address(&proxy.host, proxy.port);
    let kind = proxy.kind.as_str();
    let mut stream = open_tcp_stream(&address)
        .with_context(|| format!("Failed to connect to {kind} proxy {address}"))?;
    stream.set_read_timeout(Some(BRIDGE_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(BRIDGE_CONNECT_TIMEOUT))?;

    match proxy.kind {
        SshProxyKind::Socks5 => {
            socks5_handshake(&mut stream, proxy, target_host, target_port, password)
        }
        SshProxyKind::Http => {
            http_connect_handshake(&mut stream, proxy, target_host, target_port, password)
        }
    }
    .with_context(|| {
        format!("{kind} proxy {address} failed to tunnel to {target_host}:{target_port}")
    })?;

    // 保留与直连路径相同的 socket 超时设置：ssh2 的阻塞 IO 依赖它兜底，
    // 协议层超时另由 Session::set_timeout 在握手完成后配置。
    Ok(stream)
}

/// 在已认证的跳板会话上开 `direct-tcpip` 转发，返回目标会话该用的本地 socket。
///
/// 中继线程持有跳板会话与 channel 的所有权，因此调用方只需保管返回的
/// `TcpStream`：目标会话关闭 → 回环 socket 收到 EOF → 线程自行退出并
/// 释放跳板资源，不需要额外的生命周期守卫。
pub(crate) fn establish_jump_tunnel(
    jump_session: Session,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream> {
    jump_session.set_blocking(true);
    let channel = jump_session
        .channel_direct_tcpip(target_host, target_port, None)
        .with_context(|| {
            format!("Failed to open jump-host forward to {target_host}:{target_port}")
        })?;
    let mut stream = ChannelIo::new(&channel);

    let (session_side, relay_side) = create_loopback_pair()?;
    relay_side
        .set_nonblocking(true)
        .context("Failed to switch the jump relay socket to non-blocking mode")?;
    jump_session.set_timeout(RELAY_SESSION_TIMEOUT_MS);
    jump_session.set_blocking(false);

    let resources = JumpRelayResources {
        relay_side,
        jump_session,
        channel,
    };
    if let Err(error) = thread::Builder::new()
        .name("ccpanes-ssh-jump-relay".to_string())
        .spawn(move || {
            let mut resources = resources;
            let outcome = pump_bidirectional(&mut resources.relay_side, &mut stream);
            if let Err(error) = outcome {
                tracing::debug!(%error, "SSH jump-host relay stopped");
            }
        })
    {
        // `resources` is dropped with the rejected closure, invoking its
        // cleanup guard before the error reaches the caller.
        return Err(anyhow::anyhow!(
            "Failed to start SSH jump-host relay thread: {error}"
        ));
    }

    Ok(session_side)
}

/// 建一对已连接的回环 socket：`(交给目标会话的一端, 留给中继线程的一端)`。
fn create_loopback_pair() -> Result<(TcpStream, TcpStream)> {
    let listener =
        TcpListener::bind("127.0.0.1:0").context("Failed to bind a loopback relay socket")?;
    let address = listener
        .local_addr()
        .context("Failed to read the loopback relay address")?;
    // 内核 backlog 会让 connect 在 accept 之前完成，所以同线程顺序调用不会自锁。
    let session_side =
        TcpStream::connect(address).context("Failed to connect the loopback relay socket")?;
    let (relay_side, _) = listener
        .accept()
        .context("Failed to accept the loopback relay connection")?;
    drop(listener);
    Ok((session_side, relay_side))
}

// ---------------------------------------------------------------------------
// SOCKS5
// ---------------------------------------------------------------------------

fn socks5_handshake(
    stream: &mut TcpStream,
    proxy: &SshProxyConfig,
    host: &str,
    port: u16,
    password: Option<&str>,
) -> Result<()> {
    let mut greeting = vec![SOCKS5_VERSION];
    if proxy.requires_credentials() {
        greeting.push(2);
        greeting.extend_from_slice(&[SOCKS5_AUTH_NONE, SOCKS5_AUTH_PASSWORD]);
    } else {
        greeting.push(1);
        greeting.push(SOCKS5_AUTH_NONE);
    }
    stream
        .write_all(&greeting)
        .context("Failed to send the SOCKS5 greeting to the proxy")?;

    let mut chosen = [0_u8; 2];
    stream
        .read_exact(&mut chosen)
        .context("SOCKS5 proxy closed the connection during the greeting")?;
    if chosen[0] != SOCKS5_VERSION {
        bail!("SOCKS5 proxy replied with an unsupported protocol version");
    }
    match chosen[1] {
        SOCKS5_AUTH_NONE => {}
        SOCKS5_AUTH_PASSWORD => socks5_authenticate(
            stream,
            proxy.username.as_deref().unwrap_or_default(),
            password.unwrap_or_default(),
        )?,
        SOCKS5_AUTH_REJECTED => {
            bail!("SOCKS5 proxy rejected every authentication method offered")
        }
        method => {
            bail!("SOCKS5 proxy selected an unsupported authentication method ({method:#04x})")
        }
    }

    let mut request = vec![SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00];
    append_socks5_address(&mut request, host)?;
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .with_context(|| format!("Failed to send the SOCKS5 connect request for {host}:{port}"))?;

    let mut reply = [0_u8; 4];
    stream.read_exact(&mut reply).with_context(|| {
        format!("SOCKS5 proxy closed the connection while reaching {host}:{port}")
    })?;
    if reply[0] != SOCKS5_VERSION {
        bail!("SOCKS5 proxy replied with an unsupported protocol version");
    }
    if reply[1] != SOCKS5_REPLY_SUCCESS {
        bail!(
            "SOCKS5 proxy refused the connection to {host}:{port} ({})",
            socks5_reply_text(reply[1])
        );
    }

    // 跳过代理回传的绑定地址：长度由地址类型决定，不读干净会污染后续 SSH 流。
    let bound_length = match reply[3] {
        SOCKS5_ATYP_IPV4 => 4_usize,
        SOCKS5_ATYP_IPV6 => 16,
        SOCKS5_ATYP_DOMAIN => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .context("SOCKS5 proxy sent a truncated bound-address length")?;
            usize::from(length[0])
        }
        atyp => bail!("SOCKS5 proxy returned an unsupported bound address type ({atyp:#04x})"),
    };
    let mut sink = vec![0_u8; bound_length + 2];
    stream
        .read_exact(&mut sink)
        .context("SOCKS5 proxy sent a truncated bound address")?;
    Ok(())
}

fn socks5_authenticate(stream: &mut TcpStream, username: &str, password: &str) -> Result<()> {
    if username.len() > 255 || password.len() > 255 {
        bail!("SOCKS5 proxy credentials exceed the 255-byte protocol limit");
    }
    let mut request = Vec::with_capacity(username.len() + password.len() + 3);
    request.push(SOCKS5_USERPASS_VERSION);
    request.push(username.len() as u8);
    request.extend_from_slice(username.as_bytes());
    request.push(password.len() as u8);
    request.extend_from_slice(password.as_bytes());
    // 注意：request 含明文口令，任何错误都只能用固定文案，不得带 payload。
    stream
        .write_all(&request)
        .context("Failed to send the SOCKS5 proxy credentials")?;

    let mut reply = [0_u8; 2];
    stream
        .read_exact(&mut reply)
        .context("SOCKS5 proxy closed the connection during authentication")?;
    if reply[0] != SOCKS5_USERPASS_VERSION {
        bail!("SOCKS5 proxy returned a malformed authentication reply");
    }
    if reply[1] != 0x00 {
        bail!("SOCKS5 proxy rejected the stored proxy credentials");
    }
    Ok(())
}

fn append_socks5_address(buffer: &mut Vec<u8>, host: &str) -> Result<()> {
    let trimmed = host.trim_matches(['[', ']']);
    match trimmed.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            buffer.push(SOCKS5_ATYP_IPV4);
            buffer.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            buffer.push(SOCKS5_ATYP_IPV6);
            buffer.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let bytes = trimmed.as_bytes();
            if bytes.len() > 255 {
                bail!("SOCKS5 target hostname exceeds the 255-byte protocol limit");
            }
            buffer.push(SOCKS5_ATYP_DOMAIN);
            buffer.push(bytes.len() as u8);
            buffer.extend_from_slice(bytes);
        }
    }
    Ok(())
}

fn socks5_reply_text(code: u8) -> &'static str {
    match code {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown SOCKS5 failure",
    }
}

// ---------------------------------------------------------------------------
// HTTP CONNECT
// ---------------------------------------------------------------------------

fn http_connect_handshake(
    stream: &mut TcpStream,
    proxy: &SshProxyConfig,
    host: &str,
    port: u16,
    password: Option<&str>,
) -> Result<()> {
    let authority = format_address(host, port);
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if proxy.requires_credentials() {
        // base64 只是编码不是加密，token 等价于明文口令，禁止进入任何错误信息。
        let token = STANDARD.encode(format!(
            "{}:{}",
            proxy.username.as_deref().unwrap_or_default(),
            password.unwrap_or_default()
        ));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Proxy-Connection: keep-alive\r\n\r\n");

    stream
        .write_all(request.as_bytes())
        .with_context(|| format!("Failed to send the HTTP CONNECT request for {authority}"))?;

    let response = read_http_response(stream)
        .with_context(|| format!("HTTP proxy closed the connection while reaching {authority}"))?;
    let status = parse_http_status(&response)?;
    if !(200..300).contains(&status) {
        bail!("HTTP proxy refused CONNECT to {authority} (status {status})");
    }
    Ok(())
}

/// 逐字节读到头部结束符为止：一次多读就会吞掉隧道里的 SSH 数据。
fn read_http_response(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut response = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    loop {
        stream.read_exact(&mut byte)?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            return Ok(response);
        }
        if response.len() > MAX_HTTP_RESPONSE_HEADERS {
            bail!("HTTP proxy response headers exceeded {MAX_HTTP_RESPONSE_HEADERS} bytes");
        }
    }
}

fn parse_http_status(response: &[u8]) -> Result<u16> {
    let status_line = String::from_utf8_lossy(response)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut parts = status_line.split_whitespace();
    parts
        .next()
        .context("HTTP proxy returned an empty status line")?;
    let code = parts
        .next()
        .context("HTTP proxy returned a status line without a status code")?;
    code.parse::<u16>()
        .with_context(|| format!("HTTP proxy returned a non-numeric status code '{code}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    const SENTINEL: &[u8] = b"tunnel-open";
    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    fn proxy(kind: SshProxyKind, address: SocketAddr, username: Option<&str>) -> SshProxyConfig {
        SshProxyConfig {
            kind,
            host: address.ip().to_string(),
            port: address.port(),
            username: username.map(str::to_string),
        }
    }

    /// 启一个单连接 mock 服务器，返回监听地址与 handle。
    fn spawn_mock_server(
        handler: impl FnOnce(TcpStream) + Send + 'static,
    ) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock address");
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("mock accept");
            stream
                .set_read_timeout(Some(TEST_TIMEOUT))
                .expect("mock read timeout");
            handler(stream);
        });
        (address, handle)
    }

    /// 读 SOCKS5 连接请求里的目标地址，回 (kind, host, port)。
    fn read_socks5_request(stream: &mut TcpStream) -> (u8, String, u16) {
        let mut header = [0_u8; 4];
        stream.read_exact(&mut header).expect("socks header");
        assert_eq!(header[0], SOCKS5_VERSION);
        assert_eq!(header[1], SOCKS5_CMD_CONNECT);
        let (host, port) = match header[3] {
            SOCKS5_ATYP_IPV4 => {
                let mut octets = [0_u8; 4];
                stream.read_exact(&mut octets).expect("ipv4");
                (IpAddr::V4(octets.into()).to_string(), read_u16(stream))
            }
            SOCKS5_ATYP_IPV6 => {
                let mut octets = [0_u8; 16];
                stream.read_exact(&mut octets).expect("ipv6");
                (IpAddr::V6(octets.into()).to_string(), read_u16(stream))
            }
            SOCKS5_ATYP_DOMAIN => {
                let mut length = [0_u8; 1];
                stream.read_exact(&mut length).expect("domain len");
                let mut name = vec![0_u8; usize::from(length[0])];
                stream.read_exact(&mut name).expect("domain");
                (
                    String::from_utf8(name).expect("utf8 domain"),
                    read_u16(stream),
                )
            }
            other => panic!("unexpected atyp {other:#04x}"),
        };
        (header[3], host, port)
    }

    fn read_u16(stream: &mut TcpStream) -> u16 {
        let mut port = [0_u8; 2];
        stream.read_exact(&mut port).expect("port");
        u16::from_be_bytes(port)
    }

    /// 读 SOCKS5 greeting，回选中的认证方式。返回客户端提供的方法集合。
    fn read_socks5_greeting(stream: &mut TcpStream) -> Vec<u8> {
        let mut head = [0_u8; 2];
        stream.read_exact(&mut head).expect("greeting head");
        assert_eq!(head[0], SOCKS5_VERSION);
        let mut methods = vec![0_u8; usize::from(head[1])];
        stream.read_exact(&mut methods).expect("greeting methods");
        methods
    }

    fn send_socks5_bound_address(stream: &mut TcpStream) {
        // 0x05 0x00 0x00 0x01 + 127.0.0.1 + port:0 —— 成功并带 IPv4 绑定地址。
        stream
            .write_all(&[SOCKS5_VERSION, SOCKS5_REPLY_SUCCESS, 0x00, SOCKS5_ATYP_IPV4])
            .expect("reply header");
        stream
            .write_all(&[127, 0, 0, 1, 0x00, 0x00])
            .expect("reply bound");
    }

    #[test]
    fn socks5_tunnel_without_auth_reaches_target() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let methods = read_socks5_greeting(&mut stream);
            assert_eq!(
                methods,
                vec![SOCKS5_AUTH_NONE],
                "no-auth client offers only NONE"
            );
            stream
                .write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_NONE])
                .expect("method choice");
            let (atyp, host, port) = read_socks5_request(&mut stream);
            assert_eq!(atyp, SOCKS5_ATYP_DOMAIN);
            assert_eq!((host.as_str(), port), ("target.example", 2222));
            send_socks5_bound_address(&mut stream);
            stream.write_all(SENTINEL).expect("sentinel");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Socks5, address, None);
        let mut tunnel =
            open_proxy_tunnel(&config, "target.example", 2222, None).expect("tunnel opens");
        tunnel
            .set_read_timeout(Some(TEST_TIMEOUT))
            .expect("timeout");
        let mut received = [0_u8; SENTINEL.len()];
        tunnel.read_exact(&mut received).expect("read sentinel");
        assert_eq!(&received, SENTINEL, "tunnel carries bytes end to end");
        server.join().expect("mock server ok");
    }

    #[test]
    fn socks5_authenticates_with_stored_credentials() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let methods = read_socks5_greeting(&mut stream);
            assert!(
                methods.contains(&SOCKS5_AUTH_PASSWORD),
                "credentials client offers PASSWORD"
            );
            stream
                .write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_PASSWORD])
                .expect("method choice");

            let mut version = [0_u8; 1];
            stream.read_exact(&mut version).expect("userpass ver");
            assert_eq!(version[0], SOCKS5_USERPASS_VERSION);
            let mut ulen = [0_u8; 1];
            stream.read_exact(&mut ulen).expect("ulen");
            let mut user = vec![0_u8; usize::from(ulen[0])];
            stream.read_exact(&mut user).expect("user");
            let mut plen = [0_u8; 1];
            stream.read_exact(&mut plen).expect("plen");
            let mut pass = vec![0_u8; usize::from(plen[0])];
            stream.read_exact(&mut pass).expect("pass");
            let ok = user == b"proxyuser" && pass == b"proxypass";
            stream
                .write_all(&[SOCKS5_USERPASS_VERSION, u8::from(!ok)])
                .expect("auth reply");
            if !ok {
                return;
            }
            let _ = read_socks5_request(&mut stream);
            send_socks5_bound_address(&mut stream);
            stream.write_all(SENTINEL).expect("sentinel");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Socks5, address, Some("proxyuser"));
        let mut tunnel =
            open_proxy_tunnel(&config, "10.0.0.7", 22, Some("proxypass")).expect("tunnel opens");
        tunnel
            .set_read_timeout(Some(TEST_TIMEOUT))
            .expect("timeout");
        let mut received = [0_u8; SENTINEL.len()];
        tunnel.read_exact(&mut received).expect("read sentinel");
        assert_eq!(&received, SENTINEL);
        server.join().expect("mock server ok");
    }

    #[test]
    fn socks5_rejected_credentials_error_omits_the_secret() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let _ = read_socks5_greeting(&mut stream);
            stream
                .write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_PASSWORD])
                .expect("method choice");
            // 吃掉用户/口令子协商，直接回失败。
            let mut head = [0_u8; 2];
            stream.read_exact(&mut head).expect("ver+ulen");
            let mut user = vec![0_u8; usize::from(head[1])];
            stream.read_exact(&mut user).expect("user");
            let mut plen = [0_u8; 1];
            stream.read_exact(&mut plen).expect("plen");
            let mut pass = vec![0_u8; usize::from(plen[0])];
            stream.read_exact(&mut pass).expect("pass");
            stream
                .write_all(&[SOCKS5_USERPASS_VERSION, 0x01])
                .expect("auth fail");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Socks5, address, Some("proxyuser"));
        let secret = "super-secret-proxy-password";
        let error = open_proxy_tunnel(&config, "10.0.0.7", 22, Some(secret))
            .expect_err("rejected credentials must fail");
        let message = format!("{error:?}");
        assert!(
            message.contains("rejected the stored proxy credentials"),
            "error should explain the rejection: {message}"
        );
        assert!(
            !message.contains(secret),
            "proxy password must never appear in errors: {message}"
        );
        server.join().expect("mock server ok");
    }

    #[test]
    fn socks5_connect_refusal_reports_reason() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let _ = read_socks5_greeting(&mut stream);
            stream
                .write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_NONE])
                .expect("method choice");
            let _ = read_socks5_request(&mut stream);
            stream
                .write_all(&[
                    SOCKS5_VERSION,
                    0x05,
                    0x00,
                    SOCKS5_ATYP_IPV4,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                ])
                .expect("refusal");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Socks5, address, None);
        let error = open_proxy_tunnel(&config, "blocked.example", 22, None)
            .expect_err("refused connect must fail");
        assert!(
            format!("{error:?}").contains("connection refused"),
            "error should surface the SOCKS5 reason: {error:?}"
        );
        server.join().expect("mock server ok");
    }

    #[test]
    fn http_connect_sends_basic_auth_and_reaches_target() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let response = read_http_response(&mut stream).expect("read request");
            let text = String::from_utf8_lossy(&response).to_string();
            // 主机名 authority 不加方括号（方括号只用于 IPv6 字面量）。
            assert!(
                text.starts_with("CONNECT target.example:2222 HTTP/1.1\r\n"),
                "CONNECT must use the host:port authority: {text:?}"
            );
            assert!(
                text.ends_with("Proxy-Connection: keep-alive\r\n\r\n"),
                "headers must terminate exactly at the blank line: {text:?}"
            );
            let token = text
                .lines()
                .find_map(|line| line.strip_prefix("Proxy-Authorization: Basic "))
                .expect("basic auth header present");
            let decoded = String::from_utf8(STANDARD.decode(token.trim()).expect("base64 token"))
                .expect("utf8 credentials");
            assert_eq!(decoded, "proxyuser:proxypass");
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .expect("200 reply");
            stream.write_all(SENTINEL).expect("sentinel");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Http, address, Some("proxyuser"));
        let mut tunnel = open_proxy_tunnel(&config, "target.example", 2222, Some("proxypass"))
            .expect("tunnel opens");
        tunnel
            .set_read_timeout(Some(TEST_TIMEOUT))
            .expect("timeout");
        let mut received = [0_u8; SENTINEL.len()];
        tunnel.read_exact(&mut received).expect("read sentinel");
        assert_eq!(&received, SENTINEL);
        server.join().expect("mock server ok");
    }

    #[test]
    fn http_connect_refusal_reports_status_and_omits_secret() {
        let (address, server) = spawn_mock_server(|mut stream| {
            let _ = read_http_response(&mut stream).expect("read request");
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\n\r\n")
                .expect("503 reply");
            stream.flush().ok();
        });

        let config = proxy(SshProxyKind::Http, address, Some("proxyuser"));
        let secret = "another-secret-token";
        let error =
            open_proxy_tunnel(&config, "10.0.0.7", 22, Some(secret)).expect_err("503 must fail");
        let message = format!("{error:?}");
        assert!(
            message.contains("status 503"),
            "error should carry the HTTP status: {message}"
        );
        assert!(!message.contains(secret), "secret leaked: {message}");
        server.join().expect("mock server ok");
    }

    #[test]
    fn append_socks5_address_encodes_each_family() {
        let mut ipv4 = Vec::new();
        append_socks5_address(&mut ipv4, "127.0.0.1").expect("ipv4");
        assert_eq!(
            ipv4,
            vec![SOCKS5_ATYP_IPV4, 127, 0, 0, 1],
            "IPv4 uses 4 raw octets"
        );

        let mut domain = Vec::new();
        append_socks5_address(&mut domain, "example.com").expect("domain");
        assert_eq!(domain[0], SOCKS5_ATYP_DOMAIN);
        assert_eq!(domain[1], 11, "length-prefixed hostname");
        assert_eq!(&domain[2..], b"example.com");

        // 方括号包裹的 IPv6 字面量要先剥括号再按 16 字节编码。
        let mut ipv6 = Vec::new();
        append_socks5_address(&mut ipv6, "[::1]").expect("ipv6");
        assert_eq!(ipv6[0], SOCKS5_ATYP_IPV6);
        assert_eq!(ipv6.len(), 17, "IPv6 uses 16 raw bytes plus the type byte");
        assert_eq!(ipv6[16], 1);
    }

    #[test]
    fn parse_http_status_reads_the_numeric_code() {
        assert_eq!(
            parse_http_status(b"HTTP/1.1 200 Connection established\r\n\r\n").expect("200"),
            200
        );
        assert_eq!(
            parse_http_status(b"HTTP/1.0 407 Proxy Authentication Required\r\n\r\n").expect("407"),
            407
        );
        assert!(
            parse_http_status(b"").is_err(),
            "empty response is an error"
        );
        assert!(
            parse_http_status(b"HTTP/1.1 notanumber\r\n\r\n").is_err(),
            "non-numeric code is an error"
        );
    }

    #[test]
    fn format_address_brackets_only_ipv6() {
        assert_eq!(format_address("example.com", 22), "example.com:22");
        assert_eq!(format_address("127.0.0.1", 2222), "127.0.0.1:2222");
        assert_eq!(format_address("::1", 22), "[::1]:22");
        assert_eq!(
            format_address("fe80::1", 22),
            "[fe80::1]:22",
            "IPv6 literal needs brackets for the CONNECT authority"
        );
    }

    /// 中继核心：双向搬运必须两个方向都通，且任一端 EOF 后线程干净退出。
    #[test]
    fn relay_pumps_bytes_both_directions_until_eof() {
        let (mut client_a, relay_a) = create_loopback_pair().expect("pair a");
        let (mut client_b, relay_b) = create_loopback_pair().expect("pair b");
        client_a
            .set_read_timeout(Some(TEST_TIMEOUT))
            .expect("timeout a");
        client_b
            .set_read_timeout(Some(TEST_TIMEOUT))
            .expect("timeout b");

        let pump = thread::spawn(move || {
            let mut relay_a = relay_a;
            let mut relay_b = relay_b;
            relay_a.set_nonblocking(true).expect("nb a");
            relay_b.set_nonblocking(true).expect("nb b");
            pump_bidirectional(&mut relay_a, &mut relay_b).expect("pump clean")
        });

        client_a.write_all(b"ping->").expect("write a");
        client_a.flush().ok();
        let mut buf = [0_u8; 6];
        client_b.read_exact(&mut buf).expect("read at b");
        assert_eq!(&buf, b"ping->", "a->b direction works");

        client_b.write_all(b"<-pong").expect("write b");
        client_b.flush().ok();
        client_a.read_exact(&mut buf).expect("read at a");
        assert_eq!(&buf, b"<-pong", "b->a direction works");

        drop(client_a);
        drop(client_b);
        pump.join().expect("relay exits on EOF without error");
    }
}
