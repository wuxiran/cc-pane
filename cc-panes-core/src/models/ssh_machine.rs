use serde::{Deserialize, Serialize};

/// SSH 认证方式
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    #[default]
    Key,
    Agent,
}

/// SSH 机器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshMachine {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// 默认远端工作目录（连接时自动 cd，为空则用 ~）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_port() -> u16 {
    22
}

/// SSH 机器配置文件包装
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SshMachineConfig {
    pub machines: Vec<SshMachine>,
}
