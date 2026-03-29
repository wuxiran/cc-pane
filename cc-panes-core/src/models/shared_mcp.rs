//! 共享 MCP Server 配置与状态模型

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 桥接模式：如何将 stdio MCP server 转为 HTTP
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeMode {
    /// 使用 `npx mcp-proxy --port PORT -- CMD ARGS`
    #[default]
    McpProxy,
    /// 直接设置 `MODE=http PORT=PORT` 环境变量启动
    NativeHttp,
}

/// 单个共享 MCP Server 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMcpServerConfig {
    /// 原始启动命令（如 "npx"）
    pub command: String,
    /// 命令参数（如 ["-y", "@upstash/context7-mcp"]）
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 是否启用共享
    #[serde(default = "default_true")]
    pub shared: bool,
    /// 分配的端口
    pub port: u16,
    /// 桥接模式
    #[serde(default)]
    pub bridge_mode: BridgeMode,
}

fn default_true() -> bool {
    true
}

/// 共享 MCP Server 运行时状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SharedMcpServerStatus {
    Stopped,
    Starting,
    Running,
    Failed { message: String },
}

/// 共享 MCP Server 运行时信息（前端展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMcpServerInfo {
    pub name: String,
    pub config: SharedMcpServerConfig,
    pub status: SharedMcpServerStatus,
    /// 进程 PID（Running 时有值）
    pub pid: Option<u32>,
    /// HTTP URL（Running 时有值）
    pub url: Option<String>,
    /// 重启次数
    pub restart_count: u32,
}

/// 全局共享 MCP 配置文件（持久化到 shared-mcp.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMcpConfig {
    /// 服务器配置（name → config）
    #[serde(default)]
    pub servers: HashMap<String, SharedMcpServerConfig>,
    /// 端口范围起始
    #[serde(default = "default_port_start")]
    pub port_range_start: u16,
    /// 端口范围结束
    #[serde(default = "default_port_end")]
    pub port_range_end: u16,
    /// 健康检查间隔（秒）
    #[serde(default = "default_health_check_interval")]
    pub health_check_interval_secs: u64,
    /// 最大自动重启次数
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,
}

fn default_port_start() -> u16 {
    3100
}
fn default_port_end() -> u16 {
    3199
}
fn default_health_check_interval() -> u64 {
    30
}
fn default_max_restarts() -> u32 {
    3
}

impl Default for SharedMcpConfig {
    fn default() -> Self {
        Self {
            servers: HashMap::new(),
            port_range_start: default_port_start(),
            port_range_end: default_port_end(),
            health_check_interval_secs: default_health_check_interval(),
            max_restarts: default_max_restarts(),
        }
    }
}
