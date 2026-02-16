//! IPC 通信模块 - 用于钩子通知 TUI

use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::models::Event;

/// 默认端口
pub const DEFAULT_PORT: u16 = 19836;

/// 状态通知
#[derive(Debug, Clone)]
pub struct StatusNotify {
    pub status: String,
    pub message: Option<String>,
}

/// 启动 IPC 服务端（在后台线程运行）
pub fn start_server(port: u16, event_tx: mpsc::UnboundedSender<Event>) -> Result<()> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr)
        .with_context(|| format!("无法绑定 IPC 端口 {}", addr))?;

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                if let Some(notify) = handle_client(stream) {
                    let _ = event_tx.send(Event::StatusNotify(notify));
                }
            }
        }
    });

    Ok(())
}

/// 处理客户端连接
fn handle_client(mut stream: TcpStream) -> Option<StatusNotify> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;

    // 解析格式: STATUS:message
    let line = line.trim();
    let (status, message) = {
        let mut parts = line.splitn(2, ':');
        let s = parts.next().unwrap_or("").to_string();
        let m = parts.next().map(|m| m.to_string());
        (s, m)
    };

    // 发送确认
    let _ = stream.write_all(b"OK\n");

    Some(StatusNotify { status, message })
}

/// 发送通知到 TUI（客户端模式）
pub fn send_notify(port: u16, status: &str, message: Option<&str>) -> Result<()> {
    let addr = format!("127.0.0.1:{}", port);
    let mut stream = TcpStream::connect(&addr)
        .with_context(|| format!("无法连接到 TUI ({})", addr))?;

    // 发送格式: STATUS:message
    let msg = match message {
        Some(m) => format!("{}:{}\n", status, m),
        None => format!("{}\n", status),
    };
    stream.write_all(msg.as_bytes())?;

    // 等待确认
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response)?;

    Ok(())
}
