//! 其他运行 CC-Panes 的设备（服务器 / 另一台电脑），docs/111-multi-device.md。

use serde::{Deserialize, Serialize};

/// headless 服务端在远程机器上的默认端口（只监听回环，经 SSH 隧道访问）。
pub const DEFAULT_DEVICE_REMOTE_PORT: u16 = 18_765;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceConnection {
    /// 经已保存的 SSH 机器建立本地端口转发，访问对方回环上的 cc-panes-web。
    #[serde(rename_all = "camelCase")]
    Ssh {
        machine_id: String,
        #[serde(default = "default_remote_port")]
        remote_port: u16,
    },
    /// 直接访问对方的 cc-panes-web（局域网 / Tailscale）。
    #[serde(rename_all = "camelCase")]
    Direct { base_url: String },
}

fn default_remote_port() -> u16 {
    DEFAULT_DEVICE_REMOTE_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub connection: DeviceConnection,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfig {
    #[serde(default)]
    pub devices: Vec<Device>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAddRequest {
    pub name: String,
    pub connection: DeviceConnection,
    /// 直连设备时由用户填入；SSH 设备在部署时自动生成。
    #[serde(default)]
    pub token: Option<String>,
}

/// 访问某台设备所需的 HTTP 端点与凭据（SSH 设备的 base_url 是本机转发端口）。
#[derive(Debug, Clone)]
pub struct DeviceEndpoint {
    pub base_url: String,
    pub token: Option<String>,
}

/// 列表展示用：不含令牌明文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    #[serde(flatten)]
    pub device: Device,
    pub has_token: bool,
    /// SSH 设备的机器显示名（`user@host`），直连设备为 base_url
    pub target_label: String,
}
