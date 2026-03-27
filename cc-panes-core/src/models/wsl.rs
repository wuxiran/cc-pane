use serde::{Deserialize, Serialize};

/// WSL 分发版运行状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WslDistroState {
    Running,
    Stopped,
    Installing,
    Unknown,
}

/// WSL 分发版信息（由 `wsl.exe --list --verbose` 解析得到）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    /// 分发版名称（如 Ubuntu, Debian）
    pub name: String,
    /// 运行状态
    pub state: WslDistroState,
    /// WSL 版本（1 或 2）
    pub wsl_version: u8,
    /// 是否为默认分发版
    pub is_default: bool,
    /// 默认用户名（通过 `wsl -d <name> -e whoami` 获取）
    pub default_user: Option<String>,
    /// 是否已作为 SSH Machine 导入
    pub already_imported: bool,
}
