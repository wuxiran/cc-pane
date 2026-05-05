use serde::{Deserialize, Serialize};

/// 保存的终端会话元数据（用于关闭后恢复）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    /// Workspace Session ID owned by CC-Panes.
    #[serde(default)]
    pub workspace_snapshot_id: Option<String>,
    /// 原始 PTY session ID
    pub session_id: String,
    /// 前端 Tab ID
    pub tab_id: String,
    /// 前端 Pane ID
    pub pane_id: String,
    /// 项目路径
    pub project_path: String,
    /// 工作空间名称
    pub workspace_name: Option<String>,
    /// 工作空间路径
    pub workspace_path: Option<String>,
    /// Provider ID
    pub provider_id: Option<String>,
    /// Provider selection mode: inherit / explicit / none
    #[serde(default)]
    pub provider_selection: Option<String>,
    /// Launch Profile ID
    #[serde(default)]
    pub launch_profile_id: Option<String>,
    /// CLI 工具类型: "none" | "claude" | "codex" | ...
    pub cli_tool: String,
    /// 运行环境: "local" | "wsl" | "ssh"
    pub runtime_kind: Option<String>,
    /// Tab 持久化的 resume ID
    pub resume_id: Option<String>,
    /// SSH 连接配置 JSON
    pub ssh_config: Option<String>,
    /// 自定义标题
    pub custom_title: Option<String>,
    /// 会话创建时间 (ISO 8601)
    pub created_at: String,
    /// 保存时间 (ISO 8601)
    pub saved_at: String,
    /// 是否有对应的输出文件
    pub has_output: bool,
}
