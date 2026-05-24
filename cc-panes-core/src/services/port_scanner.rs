use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use std::collections::HashSet;
use tracing::{debug, warn};

/// 从系统 socket 表抓出的原始监听条目
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListeningSocket {
    pub pid: u32,
    pub port: u16,
    /// "tcp" / "tcp6" / "udp" / "udp6"
    pub protocol: String,
    pub listen_addr: String,
}

/// 端口扫描器：薄封装 netstat2，跨平台一致
pub struct PortScanner;

impl PortScanner {
    /// 列出所有监听中的 TCP socket + 所有 UDP socket（UDP 无 LISTEN 概念，全部视为监听）
    pub fn list_listening() -> Result<Vec<ListeningSocket>, String> {
        let af_flags = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
        let proto_flags = ProtocolFlags::TCP | ProtocolFlags::UDP;

        let entries = get_sockets_info(af_flags, proto_flags).map_err(|e| {
            warn!(err = %e, "get_sockets_info failed");
            e.to_string()
        })?;

        let mut out = Vec::with_capacity(entries.len());
        for si in entries {
            let (port, listen_addr, protocol, keep) = match &si.protocol_socket_info {
                ProtocolSocketInfo::Tcp(tcp) => {
                    if tcp.state != TcpState::Listen {
                        continue;
                    }
                    let proto = if tcp.local_addr.is_ipv6() {
                        "tcp6"
                    } else {
                        "tcp"
                    };
                    (tcp.local_port, tcp.local_addr.to_string(), proto, true)
                }
                ProtocolSocketInfo::Udp(udp) => {
                    let proto = if udp.local_addr.is_ipv6() {
                        "udp6"
                    } else {
                        "udp"
                    };
                    (udp.local_port, udp.local_addr.to_string(), proto, true)
                }
            };
            if !keep {
                continue;
            }
            for pid in &si.associated_pids {
                out.push(ListeningSocket {
                    pid: *pid,
                    port,
                    protocol: protocol.to_string(),
                    listen_addr: listen_addr.clone(),
                });
            }
        }

        debug!(
            count = out.len(),
            "port_scanner: listening sockets enumerated"
        );
        Ok(out)
    }

    /// 仅保留属于给定 PID 集合的监听项
    pub fn list_listening_for_pids(pids: &HashSet<u32>) -> Result<Vec<ListeningSocket>, String> {
        Ok(Self::list_listening()?
            .into_iter()
            .filter(|s| pids.contains(&s.pid))
            .collect())
    }

    /// 查询某些端口当前被谁监听（返回每个端口的所有 (pid, protocol, addr)）
    pub fn find_by_ports(ports: &[u16]) -> Result<Vec<ListeningSocket>, String> {
        let port_set: HashSet<u16> = ports.iter().copied().collect();
        Ok(Self::list_listening()?
            .into_iter()
            .filter(|s| port_set.contains(&s.port))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn detects_own_listening_socket() {
        // 绑定一个临时端口监听，验证扫描器能拿到当前进程 + 该端口
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind random port");
        let port = listener.local_addr().expect("local_addr").port();
        let self_pid = std::process::id();

        let listening = PortScanner::list_listening().expect("scan");
        let hit = listening
            .iter()
            .find(|s| s.pid == self_pid && s.port == port);
        assert!(
            hit.is_some(),
            "expected to find self pid {} on port {} in scan results (got {} entries)",
            self_pid,
            port,
            listening.len()
        );
        drop(listener);
    }

    #[test]
    fn find_by_ports_filters_correctly() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let other_port = if port == 65535 { 1024 } else { port + 1 };

        let hits = PortScanner::find_by_ports(&[port, other_port]).expect("scan");
        assert!(
            hits.iter().any(|s| s.port == port),
            "should hit bound port {}",
            port
        );
        drop(listener);
    }

    #[test]
    fn list_listening_for_pids_filters_by_pid() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let self_pid = std::process::id();
        let mut set = HashSet::new();
        set.insert(self_pid);
        let hits = PortScanner::list_listening_for_pids(&set).expect("scan");
        assert!(hits.iter().all(|s| s.pid == self_pid));
        assert!(
            hits.iter().any(|s| s.port == port),
            "should find own listener at {}",
            port
        );
        drop(listener);
    }
}
