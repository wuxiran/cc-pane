use serde::{Deserialize, Serialize};

/// 持久化的 AI 面板。
///
/// `format` 存字符串而不是枚举：带 `schemars::JsonSchema` 的 `AiPanelFormat` 定义在
/// `src-tauri`（core 不依赖 schemars），这里只做存储，不做协议校验。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAiPanel {
    pub panel_id: String,
    /// 面板归属的工作空间。会话没有 TaskBinding 时为 `None`（历史列表里归入「未归类」）。
    pub workspace_name: Option<String>,
    pub project_path: Option<String>,
    pub title: String,
    pub format: String,
    pub content: String,
    pub driver_name: String,
    /// 当前持有者会话。`None` = 无人持有，可被任意会话认领。
    pub owner_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 历史列表项：**不含 content**。
///
/// 单个面板内容上限 256 KiB，历史又不自动清理；列表若带上 content，
/// 一次 `list` 就可能拉回几十 MB 并卡住 IPC。内容按需单独取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPanelSummary {
    pub panel_id: String,
    pub workspace_name: Option<String>,
    pub project_path: Option<String>,
    pub title: String,
    pub format: String,
    pub driver_name: String,
    pub owner_session_id: Option<String>,
    /// 内容字节数，供 UI 展示体积、也让用户判断该不该删。
    pub content_bytes: i64,
    pub created_at: String,
    pub updated_at: String,
}
