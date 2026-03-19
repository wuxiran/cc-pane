use serde::{Deserialize, Serialize};

/// CLI 工具类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CliTool {
    #[default]
    None,
    Claude,
    Codex,
}

impl CliTool {
    /// 转换为 CLI 适配器注册表的 id 字符串
    pub fn as_id(&self) -> &str {
        match self {
            CliTool::None => "none",
            CliTool::Claude => "claude",
            CliTool::Codex => "codex",
        }
    }
}

/// 创建终端会话请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub project_path: String,
    pub cols: u16,
    pub rows: u16,
    pub workspace_name: Option<String>,
    pub provider_id: Option<String>,
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub launch_claude: bool,
    #[serde(default)]
    pub cli_tool: CliTool,
    pub resume_id: Option<String>,
    #[serde(default)]
    pub skip_mcp: bool,
    pub append_system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::models::workspace::SshConnectionInfo>,
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

/// 终端退出事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: String,
    pub exit_code: i32,
}
