//! 发现（docs/112 §5.1）：局域网 mDNS `_ccpanes._tcp` + Tailscale tailnet 节点。
//!
//! - **广播**只在「Web 访问开启 + 允许其他设备连接」时进行（默认不广播）；
//! - **浏览**按需进行（打开联系人 / 点刷新），一次 ~2 秒后停；不常驻；
//! - Tailscale 只跑 `tailscale status --json`（只读）；CLI 不在 → 状态里如实写
//!   `tailscale: notInstalled`，界面据此提示，不报错。
//!
//! 发现只是「看见」：互联仍必须走一次配对（设备令牌）。

use std::collections::HashMap;
use std::net::IpAddr;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use serde_json::Value;
use tracing::{debug, info, warn};

use cc_panes_core::models::MeshAddressSource;

pub const SERVICE_TYPE: &str = "_ccpanes._tcp.local.";
const BROWSE_WINDOW: Duration = Duration::from_millis(2200);
const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_TAILSCALE_PEERS: usize = 64;

/// 本机广播的内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertisement {
    pub instance_id: String,
    pub name: String,
    pub version: String,
    pub port: u16,
}

/// 发现到的一个 CC-Panes 节点。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredNode {
    pub source: MeshAddressSource,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 可尝试的地址（`http://ip:port`）。
    pub addresses: Vec<String>,
    /// Tailscale 节点是否在线（mDNS 结果恒 true）。
    pub online: bool,
    /// `/api/health` 是否通（Tailscale 节点探测端口后填）。
    pub reachable: bool,
    /// 已与本机配对的设备 id（按实例 id / 主机名归并）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub nodes: Vec<DiscoveredNode>,
    /// `running` / `notInstalled` / `stopped` / `error`。
    pub tailscale: String,
    /// `ok` / `error:<原因>`。
    pub mdns: String,
    /// 本机是否正在广播（Web 访问 + 允许其他设备连接）。
    pub advertising: bool,
}

#[derive(Default)]
pub struct MdnsHub {
    inner: Mutex<MdnsState>,
}

#[derive(Default)]
struct MdnsState {
    daemon: Option<ServiceDaemon>,
    advertised: Option<(Advertisement, String)>,
}

fn txt(ad: &Advertisement) -> HashMap<String, String> {
    HashMap::from([
        ("instanceId".to_string(), ad.instance_id.clone()),
        ("name".to_string(), ad.name.clone()),
        ("version".to_string(), ad.version.clone()),
        ("port".to_string(), ad.port.to_string()),
    ])
}

/// mDNS 主机名：只留字母数字和 `-`。
fn host_label(name: &str, instance_id: &str) -> String {
    let mut label: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    label = label.trim_matches('-').to_string();
    if label.is_empty() {
        label = format!(
            "ccpanes-{}",
            &instance_id.chars().take(8).collect::<String>()
        );
    }
    format!("{label}.local.")
}

impl MdnsState {
    fn daemon(&mut self) -> Result<&ServiceDaemon, String> {
        if self.daemon.is_none() {
            self.daemon = Some(ServiceDaemon::new().map_err(|error| error.to_string())?);
        }
        Ok(self.daemon.as_ref().expect("daemon just created"))
    }

    /// 既不广播也不浏览时关掉守护线程。
    fn release_if_idle(&mut self) {
        if self.advertised.is_none() {
            if let Some(daemon) = self.daemon.take() {
                let _ = daemon.shutdown();
            }
        }
    }
}

impl MdnsHub {
    fn lock(&self) -> std::sync::MutexGuard<'_, MdnsState> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn advertising(&self) -> bool {
        self.lock().advertised.is_some()
    }

    /// 把广播状态对齐到期望值（None = 不广播）。幂等。
    pub fn sync(&self, wanted: Option<Advertisement>) {
        let mut state = self.lock();
        if state.advertised.as_ref().map(|(ad, _)| ad) == wanted.as_ref() {
            return;
        }
        if let Some((_, fullname)) = state.advertised.take() {
            if let Some(daemon) = state.daemon.as_ref() {
                let _ = daemon.unregister(&fullname);
            }
            info!("bot mesh: mDNS advertisement withdrawn");
        }
        let Some(ad) = wanted else {
            state.release_if_idle();
            return;
        };
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            &format!(
                "{}-{}",
                ad.name,
                &ad.instance_id.chars().take(6).collect::<String>()
            ),
            &host_label(&ad.name, &ad.instance_id),
            "",
            ad.port,
            txt(&ad),
        )
        .map(ServiceInfo::enable_addr_auto);
        let result = info.map_err(|e| e.to_string()).and_then(|info| {
            let fullname = info.get_fullname().to_string();
            state
                .daemon()?
                .register(info)
                .map_err(|e| e.to_string())
                .map(|()| fullname)
        });
        match result {
            Ok(fullname) => {
                info!(port = ad.port, "bot mesh: advertising _ccpanes._tcp");
                state.advertised = Some((ad, fullname));
            }
            Err(error) => {
                warn!(error = %error, "bot mesh: mDNS advertisement failed");
                state.release_if_idle();
            }
        }
    }

    /// 浏览一个窗口期，收集解析出的节点（阻塞，调用方放 spawn_blocking）。
    pub fn browse(&self, own_instance: Option<&str>) -> Result<Vec<DiscoveredNode>, String> {
        let receiver = {
            let mut state = self.lock();
            state
                .daemon()?
                .browse(SERVICE_TYPE)
                .map_err(|e| e.to_string())?
        };
        let deadline = std::time::Instant::now() + BROWSE_WINDOW;
        let mut nodes: HashMap<String, DiscoveredNode> = HashMap::new();
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            let Ok(event) = receiver.recv_timeout(left) else {
                break;
            };
            if let ServiceEvent::ServiceResolved(resolved) = event {
                let instance = resolved
                    .get_property_val_str("instanceId")
                    .map(str::to_string);
                if instance.is_some() && instance.as_deref() == own_instance {
                    continue;
                }
                let port = resolved
                    .get_property_val_str("port")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(resolved.get_port());
                let mut addresses: Vec<String> = resolved
                    .get_addresses()
                    .iter()
                    .map(|ip| ip.to_ip_addr())
                    .filter(|ip| ip.is_ipv4() && !ip.is_loopback())
                    .map(|ip| format!("http://{ip}:{port}"))
                    .collect();
                addresses.sort();
                let key = instance
                    .clone()
                    .unwrap_or_else(|| resolved.get_fullname().to_string());
                let entry = nodes.entry(key).or_insert_with(|| DiscoveredNode {
                    source: MeshAddressSource::Lan,
                    name: resolved
                        .get_property_val_str("name")
                        .unwrap_or(resolved.get_hostname())
                        .to_string(),
                    instance_id: instance.clone(),
                    version: resolved.get_property_val_str("version").map(str::to_string),
                    addresses: Vec::new(),
                    online: true,
                    reachable: true,
                    paired_device_id: None,
                });
                for address in addresses {
                    if !entry.addresses.contains(&address) {
                        entry.addresses.push(address);
                    }
                }
            }
        }
        let mut state = self.lock();
        if let Some(daemon) = state.daemon.as_ref() {
            let _ = daemon.stop_browse(SERVICE_TYPE);
        }
        state.release_if_idle();
        debug!(count = nodes.len(), "bot mesh: mDNS browse finished");
        Ok(nodes.into_values().collect())
    }
}

/// tailnet 里的一个节点（来自 `tailscale status --json` 的 `Peer`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailnetPeer {
    pub host_name: String,
    pub dns_name: Option<String>,
    pub ips: Vec<IpAddr>,
    pub online: bool,
}

pub fn parse_tailnet_peers(json_text: &str) -> Result<Vec<TailnetPeer>, String> {
    let value: Value = serde_json::from_str(json_text).map_err(|e| e.to_string())?;
    let Some(peers) = value.get("Peer").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<TailnetPeer> = peers
        .values()
        .map(|peer| TailnetPeer {
            host_name: peer["HostName"].as_str().unwrap_or_default().to_string(),
            dns_name: peer["DNSName"]
                .as_str()
                .map(|n| n.trim_end_matches('.').to_string())
                .filter(|n| !n.is_empty()),
            ips: peer["TailscaleIPs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|ip| ip.as_str()?.parse::<IpAddr>().ok())
                .filter(IpAddr::is_ipv4)
                .collect(),
            online: peer["Online"].as_bool().unwrap_or(false),
        })
        .filter(|peer| !peer.ips.is_empty())
        .collect();
    out.sort_by(|a, b| a.host_name.cmp(&b.host_name));
    out.truncate(MAX_TAILSCALE_PEERS);
    Ok(out)
}

/// `tailscale status --json` 的节点列表。Err = 状态字（notInstalled / stopped / error）。
pub fn tailnet_peers() -> Result<Vec<TailnetPeer>, &'static str> {
    let mut command = Command::new(crate::services::tailscale_service::tailscale_binary());
    command
        .args(["status", "--json"])
        .current_dir(std::env::temp_dir());
    let output = match cc_panes_core::utils::output_with_timeout(&mut command, TAILSCALE_TIMEOUT) {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("notInstalled"),
        Err(_) => return Err("error"),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let state = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("BackendState")?.as_str().map(str::to_string));
    if state.as_deref() != Some("Running") {
        return Err("stopped");
    }
    parse_tailnet_peers(&text).map_err(|_| "error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tailnet_peers() {
        let json = r#"{
            "BackendState": "Running",
            "Peer": {
                "nodekey:a": {"HostName": "studio", "DNSName": "studio.tail1.ts.net.", "TailscaleIPs": ["100.64.0.2", "fd7a::2"], "Online": true},
                "nodekey:b": {"HostName": "phone", "TailscaleIPs": [], "Online": true},
                "nodekey:c": {"HostName": "laptop", "TailscaleIPs": ["100.64.0.3"], "Online": false}
            }
        }"#;
        let peers = parse_tailnet_peers(json).unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].host_name, "laptop");
        assert!(!peers[0].online);
        assert_eq!(peers[1].dns_name.as_deref(), Some("studio.tail1.ts.net"));
        assert_eq!(peers[1].ips, vec!["100.64.0.2".parse::<IpAddr>().unwrap()]);
        assert!(parse_tailnet_peers("{}").unwrap().is_empty());
        assert!(parse_tailnet_peers("nope").is_err());
    }

    #[test]
    fn host_labels_are_dns_safe() {
        assert_eq!(host_label("Wu's Mac", "abc"), "Wu-s-Mac.local.");
        assert_eq!(
            host_label("吴的电脑", "abcdef123"),
            "ccpanes-abcdef12.local."
        );
    }
}
