use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::launch_profile::LaunchProviderSelection;

/// CLI 工具类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CliTool {
    #[default]
    None,
    Claude,
    Codex,
    Gemini,
    Kimi,
    Glm,
    Opencode,
    Cursor,
    Grok,
}

impl CliTool {
    /// 转换为 CLI 适配器注册表中的 id 字符串
    pub fn as_id(&self) -> &str {
        match self {
            CliTool::None => "none",
            CliTool::Claude => "claude",
            CliTool::Codex => "codex",
            CliTool::Gemini => "gemini",
            CliTool::Kimi => "kimi",
            CliTool::Glm => "glm",
            CliTool::Opencode => "opencode",
            CliTool::Cursor => "cursor",
            CliTool::Grok => "grok",
        }
    }
}

/// WSL 启动信息
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslLaunchInfo {
    pub remote_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_remote_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

/// 创建终端会话请求
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    pub project_path: String,
    pub cols: u16,
    pub rows: u16,
    pub workspace_name: Option<String>,
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    pub launch_profile_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_snapshot_id: Option<String>,
    #[serde(default)]
    pub launch_claude: bool,
    #[serde(default)]
    pub cli_tool: CliTool,
    pub resume_id: Option<String>,
    #[serde(default)]
    pub skip_mcp: bool,
    pub append_system_prompt: Option<String>,
    #[serde(default, alias = "prompt", skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    /// per-launch YOLO 覆盖：None = 跟随 launch profile 解析值
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yolo_mode: Option<bool>,
    /// per-launch adapter 选项（约定键：effort/extraArgs/verbose/maxTurns），
    /// 与 profile.adapter_options 合并，request 覆盖同名键
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::models::workspace::SshConnectionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WslLaunchInfo>,
}

impl CreateSessionRequest {
    /// 兼容映射：优先使用 cli_tool，fallback 到 launch_claude
    pub fn effective_cli_tool(&self) -> CliTool {
        match self.cli_tool {
            CliTool::None if self.launch_claude => CliTool::Claude,
            other => other,
        }
    }
}

/// 调整终端大小请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// 终端输出事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: String,
}

/// 终端重放快照的屏幕模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalBufferMode {
    Normal,
    Alternate,
}

/// attach-existing 时用于重建当前屏幕状态的原始 VT 快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplaySnapshot {
    pub data: String,
    pub buffer_mode: TerminalBufferMode,
}

/// 终端退出事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: String,
    pub exit_code: i32,
}
