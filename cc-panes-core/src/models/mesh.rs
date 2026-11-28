//! Bot 组网（docs/112 §5）：已配对对端的地址候选与在线记录。
//!
//! 对端身份 = `DeviceService` 里的设备（令牌在 keyring）；这里只补组网需要的
//! 地址候选（手填 / 局域网 mDNS / Tailscale）、对方实例 id 与最近在线时间。

use serde::{Deserialize, Serialize};

/// 地址从哪来。探测择优时按 `priority` 升序（局域网最快，Tailscale 兜底，手填最后）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum MeshAddressSource {
    Lan,
    Tailscale,
    Manual,
}

impl MeshAddressSource {
    pub fn priority(self) -> u8 {
        match self {
            Self::Lan => 0,
            Self::Tailscale => 1,
            Self::Manual => 2,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeshAddress {
    /// `http://host:port`（无尾斜杠）。
    pub url: String,
    pub source: MeshAddressSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeshPeerRecord {
    /// 对应 `DeviceService` 的设备 id。
    pub device_id: String,
    /// 对方 `<data>/instance-id`（`/api/device/info` 回报）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default)]
    pub addresses: Vec<MeshAddress>,
    /// 最近一次探测成功的地址（下次先试它）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// 规范化地址：去空白与尾斜杠，只收 http(s)。
pub fn normalize_mesh_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
}

impl MeshPeerRecord {
    /// 合并一个地址候选（同 url 只保留一条，来源取优先级更高者）。返回是否有变化。
    pub fn merge_address(&mut self, url: &str, source: MeshAddressSource) -> bool {
        let Some(url) = normalize_mesh_url(url) else {
            return false;
        };
        if let Some(existing) = self.addresses.iter_mut().find(|a| a.url == url) {
            if source.priority() < existing.source.priority() {
                existing.source = source;
                return true;
            }
            return false;
        }
        self.addresses.push(MeshAddress {
            url,
            source,
            last_ok_at: None,
        });
        true
    }

    /// 探测顺序：上次成功的地址最先，其余按来源优先级。
    pub fn probe_order(&self) -> Vec<String> {
        let mut addresses = self.addresses.clone();
        addresses.sort_by_key(|a| a.source.priority());
        let mut out: Vec<String> = Vec::new();
        if let Some(preferred) = &self.preferred_url {
            out.push(preferred.clone());
        }
        for address in addresses {
            if !out.contains(&address.url) {
                out.push(address.url);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_dedupes_and_upgrades_source() {
        let mut peer = MeshPeerRecord::default();
        assert!(peer.merge_address("http://10.0.0.2:18080/", MeshAddressSource::Manual));
        assert!(!peer.merge_address("http://10.0.0.2:18080", MeshAddressSource::Manual));
        assert!(peer.merge_address("http://10.0.0.2:18080", MeshAddressSource::Lan));
        assert_eq!(peer.addresses.len(), 1);
        assert_eq!(peer.addresses[0].source, MeshAddressSource::Lan);
        assert!(!peer.merge_address("ftp://x", MeshAddressSource::Lan));
    }

    #[test]
    fn probe_order_prefers_last_success_then_priority() {
        let mut peer = MeshPeerRecord::default();
        peer.merge_address("http://manual:1", MeshAddressSource::Manual);
        peer.merge_address("http://100.64.0.2:1", MeshAddressSource::Tailscale);
        peer.merge_address("http://192.168.1.2:1", MeshAddressSource::Lan);
        assert_eq!(
            peer.probe_order(),
            vec![
                "http://192.168.1.2:1",
                "http://100.64.0.2:1",
                "http://manual:1"
            ]
        );
        peer.preferred_url = Some("http://manual:1".into());
        assert_eq!(peer.probe_order()[0], "http://manual:1");
        assert_eq!(peer.probe_order().len(), 3);
    }
}
