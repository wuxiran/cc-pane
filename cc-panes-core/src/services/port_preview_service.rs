//! 远程 dev server 端口的本机预览隧道（docs/116 §B，参考 t3code `PreviewTunnel`）。
//!
//! SSH 终端输出里出现 `localhost:PORT` 时，用户点「在本机预览」：
//! 为这条会话建一条 SSH 本地端口转发（复用 [`SshPortForward`]），本机端口尽量与远端一致，
//! 被占用则随机挑空闲端口，再在内置浏览器里打开。
//!
//! 生命周期：同一会话 + 同一远端地址复用一条隧道；用户可列出/关闭；会话结束
//! （`terminal-exit` / `session-killed`）时由宿主调用 [`PortPreviewService::close_for_session`] 回收；
//! SSH 断线的隧道在下次列出/打开时被清掉。只支持 SSH——WSL 的 localhost 本来就通。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::ssh_connection_service::SshConnectionService;
use super::ssh_port_forward::SshPortForward;
use crate::models::SshConnectionInfo;

/// 防止失控地开隧道（每条都占一个 SSH 会话和一个线程）。
const MAX_TUNNELS: usize = 32;
const ALLOWED_REMOTE_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1"];

/// 给前端的隧道摘要（不含任何凭据）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortPreviewTunnel {
    pub id: String,
    pub session_id: String,
    /// SSH 目标主机（展示用）
    pub ssh_host: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub created_at: u64,
}

/// 一条活着的转发。真实实现是 [`SshPortForward`]；测试用假的。
pub trait PreviewForward: Send {
    fn local_port(&self) -> u16;
    fn is_alive(&self) -> bool;
}

impl PreviewForward for SshPortForward {
    fn local_port(&self) -> u16 {
        self.local_addr().port()
    }

    fn is_alive(&self) -> bool {
        SshPortForward::is_alive(self)
    }
}

/// 建转发的方式（阻塞：要完成 SSH 握手）。
pub trait PreviewForwarder: Send + Sync {
    fn open(
        &self,
        ssh: &SshConnectionInfo,
        remote_host: &str,
        remote_port: u16,
        preferred_local_port: Option<u16>,
    ) -> Result<Box<dyn PreviewForward>>;
}

/// 经内嵌 ssh2 连接建转发：凭据、代理、跳板都走 `SshConnectionService` 的同一套逻辑。
pub struct SshPreviewForwarder {
    ssh_connection: Arc<SshConnectionService>,
}

impl SshPreviewForwarder {
    pub fn new(ssh_connection: Arc<SshConnectionService>) -> Self {
        Self { ssh_connection }
    }
}

impl PreviewForwarder for SshPreviewForwarder {
    fn open(
        &self,
        ssh: &SshConnectionInfo,
        remote_host: &str,
        remote_port: u16,
        preferred_local_port: Option<u16>,
    ) -> Result<Box<dyn PreviewForward>> {
        let session = self
            .ssh_connection
            .connect_info(ssh)
            .with_context(|| format!("Failed to connect to {}", ssh.host))?;
        let forward = SshPortForward::start_with_local_port(
            session,
            remote_host,
            remote_port,
            preferred_local_port,
        )?;
        Ok(Box::new(forward))
    }
}

struct Entry {
    info: PortPreviewTunnel,
    forward: Box<dyn PreviewForward>,
}

pub struct PortPreviewService {
    forwarder: Box<dyn PreviewForwarder>,
    tunnels: Mutex<HashMap<String, Entry>>,
}

/// 只允许回环地址：这是「预览远端本机的 dev server」，不是任意跳板。
pub fn normalize_preview_remote_host(host: &str) -> Result<String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let host = host.to_ascii_lowercase();
    let host = if host == "0.0.0.0" || host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        host
    };
    if !ALLOWED_REMOTE_HOSTS.contains(&host.as_str()) {
        bail!("Port preview only forwards loopback addresses");
    }
    Ok(host)
}

impl PortPreviewService {
    pub fn new(forwarder: Box<dyn PreviewForwarder>) -> Self {
        Self {
            forwarder,
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_ssh(ssh_connection: Arc<SshConnectionService>) -> Self {
        Self::new(Box::new(SshPreviewForwarder::new(ssh_connection)))
    }

    /// 打开（或复用）一条隧道。阻塞调用。
    pub fn open(
        &self,
        session_id: &str,
        ssh: &SshConnectionInfo,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<PortPreviewTunnel> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            bail!("A terminal session is required");
        }
        if remote_port == 0 {
            bail!("Invalid remote port");
        }
        let remote_host = normalize_preview_remote_host(remote_host)?;
        self.prune_dead();
        if let Some(existing) = self.find(session_id, &remote_host, remote_port) {
            return Ok(existing);
        }
        if self.lock().len() >= MAX_TUNNELS {
            bail!("Too many port previews are open; close some first");
        }
        // 握手可能要好几秒，不持锁。
        let forward = self
            .forwarder
            .open(ssh, &remote_host, remote_port, Some(remote_port))?;
        let info = PortPreviewTunnel {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            ssh_host: ssh.host.clone(),
            remote_host,
            remote_port,
            local_port: forward.local_port(),
            created_at: now_ms(),
        };
        // 并发打开同一目标时以先到者为准，后到的转发在锁外 drop（会 join 转发线程）。
        let winner = {
            let mut tunnels = self.lock();
            let existing = tunnels
                .values()
                .find(|entry| {
                    same_target(
                        &entry.info,
                        &info.session_id,
                        &info.remote_host,
                        remote_port,
                    )
                })
                .map(|entry| entry.info.clone());
            if existing.is_none() {
                tunnels.insert(
                    info.id.clone(),
                    Entry {
                        info: info.clone(),
                        forward,
                    },
                );
                return Ok(info);
            }
            existing
        };
        Ok(winner.unwrap_or(info))
    }

    pub fn list(&self) -> Vec<PortPreviewTunnel> {
        self.prune_dead();
        let mut list: Vec<_> = self
            .lock()
            .values()
            .map(|entry| entry.info.clone())
            .collect();
        list.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        list
    }

    /// 关闭一条；不存在返回 false。
    pub fn close(&self, id: &str) -> bool {
        let removed = self.lock().remove(id);
        let closed = removed.is_some();
        drop(removed); // 在锁外 join 转发线程
        closed
    }

    /// 会话结束时回收它名下所有隧道，返回关掉的条数。
    pub fn close_for_session(&self, session_id: &str) -> usize {
        self.remove_where(|entry| entry.info.session_id == session_id)
    }

    fn prune_dead(&self) -> usize {
        self.remove_where(|entry| !entry.forward.is_alive())
    }

    fn remove_where(&self, predicate: impl Fn(&Entry) -> bool) -> usize {
        let removed: Vec<Entry> = {
            let mut tunnels = self.lock();
            let ids: Vec<String> = tunnels
                .iter()
                .filter(|(_, entry)| predicate(entry))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| tunnels.remove(id)).collect()
        };
        removed.len()
    }

    fn find(
        &self,
        session_id: &str,
        remote_host: &str,
        remote_port: u16,
    ) -> Option<PortPreviewTunnel> {
        self.lock()
            .values()
            .find(|entry| same_target(&entry.info, session_id, remote_host, remote_port))
            .map(|entry| entry.info.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.tunnels
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

fn same_target(
    info: &PortPreviewTunnel,
    session_id: &str,
    remote_host: &str,
    remote_port: u16,
) -> bool {
    info.session_id == session_id
        && info.remote_host == remote_host
        && info.remote_port == remote_port
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
