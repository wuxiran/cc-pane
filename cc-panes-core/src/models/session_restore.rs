use serde::{Deserialize, Serialize};

/// Daemon-issued immutable evidence for one PTY birth.
///
/// Layout anchors live in `terminal_sessions` and may evolve as the user moves tabs. These
/// fields must not: startup adoption only trusts a saved anchor when it can join it back to the
/// exact daemon generation and birth nonce that created the live PTY.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionProvenance {
    pub session_id: String,
    pub daemon_generation: u64,
    pub birth_nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_layout_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_terminal_pane_id: Option<String>,
    pub project_path: String,
    pub runtime_kind: String,
    pub cli_tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    pub created_at_ms: u64,
}

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
    /// 终端 tab 内的分屏 leaf ID。终端 tab 可含多个 leaf，各自持有独立 PTY；
    /// 只按 tab_id 挂载会把会话接到错误的分屏格子（docs/61 阶段 1）。
    #[serde(default)]
    pub terminal_pane_id: Option<String>,
    /// 所属布局 ID，与 tab_id + terminal_pane_id 共同构成精确挂载锚点
    #[serde(default)]
    pub layout_id: Option<String>,
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
    /// WSL 启动配置 JSON（distro + remotePath）。缺失时接管后的重建会落到本地错误目录。
    #[serde(default)]
    pub wsl_config: Option<String>,
    /// SSH 机器名（与 ssh_config 互补，用于展示与配置回查）
    #[serde(default)]
    pub machine_name: Option<String>,
    /// App instance that currently owns this mutable layout observation. Provenance is stored in
    /// a separate immutable table; this field prevents another new client from overwriting the
    /// anchor without first winning the daemon claim and transferring observation ownership.
    #[serde(default)]
    pub observer_instance_id: Option<String>,
    /// Joined immutable daemon birth evidence. Missing means legacy data and is manual-adopt only.
    #[serde(default)]
    pub daemon_generation: Option<u64>,
    #[serde(default)]
    pub birth_nonce: Option<String>,
    #[serde(default)]
    pub origin_instance_id: Option<String>,
    /// 自定义标题
    pub custom_title: Option<String>,
    /// 会话创建时间 (ISO 8601)
    pub created_at: String,
    /// 保存时间 (ISO 8601)
    pub saved_at: String,
    /// 是否有对应的输出文件
    pub has_output: bool,
}

impl SavedSession {
    /// Build the first mutable observation from daemon-issued immutable provenance. Sessions
    /// created outside a concrete UI leaf intentionally return None and remain manual-adopt only.
    pub fn from_creation(
        request: &crate::models::CreateSessionRequest,
        provenance: &TerminalSessionProvenance,
    ) -> Option<Self> {
        let layout_id = provenance.origin_layout_id.clone()?;
        let tab_id = provenance.origin_tab_id.clone()?;
        let terminal_pane_id = provenance.origin_terminal_pane_id.clone()?;
        let now = chrono::Utc::now().to_rfc3339();
        let provider_selection = serde_json::to_value(request.provider_selection)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string));
        Some(Self {
            workspace_snapshot_id: request.workspace_snapshot_id.clone(),
            session_id: provenance.session_id.clone(),
            tab_id,
            pane_id: terminal_pane_id.clone(),
            terminal_pane_id: Some(terminal_pane_id),
            layout_id: Some(layout_id),
            project_path: provenance.project_path.clone(),
            workspace_name: request.workspace_name.clone(),
            workspace_path: request.workspace_path.clone(),
            provider_id: request.provider_id.clone(),
            provider_selection,
            launch_profile_id: request.launch_profile_id.clone(),
            cli_tool: provenance.cli_tool.clone(),
            runtime_kind: Some(provenance.runtime_kind.clone()),
            resume_id: provenance.resume_id.clone(),
            ssh_config: request
                .ssh
                .as_ref()
                .and_then(|value| serde_json::to_string(value).ok()),
            wsl_config: request
                .wsl
                .as_ref()
                .and_then(|value| serde_json::to_string(value).ok()),
            machine_name: None,
            observer_instance_id: provenance.origin_instance_id.clone(),
            daemon_generation: Some(provenance.daemon_generation),
            birth_nonce: Some(provenance.birth_nonce.clone()),
            origin_instance_id: provenance.origin_instance_id.clone(),
            custom_title: None,
            created_at: now.clone(),
            saved_at: now,
            has_output: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CreateSessionRequest, LaunchProviderSelection};

    fn provenance() -> TerminalSessionProvenance {
        TerminalSessionProvenance {
            session_id: "session-1".to_string(),
            daemon_generation: 42,
            birth_nonce: "birth-1".to_string(),
            origin_instance_id: Some("app-a".to_string()),
            origin_layout_id: Some("layout-1".to_string()),
            origin_tab_id: Some("tab-1".to_string()),
            origin_terminal_pane_id: Some("leaf-1".to_string()),
            project_path: "/repo".to_string(),
            runtime_kind: "local".to_string(),
            cli_tool: "codex".to_string(),
            resume_id: Some("resume-1".to_string()),
            created_at_ms: 1,
        }
    }

    #[test]
    fn from_creation_preserves_provider_selection_and_birth_evidence() {
        let request: CreateSessionRequest = serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24,
            "providerSelection": "explicit"
        }))
        .expect("create request");
        assert_eq!(
            request.provider_selection,
            LaunchProviderSelection::Explicit
        );

        let saved = SavedSession::from_creation(&request, &provenance()).expect("saved session");

        assert_eq!(saved.provider_selection.as_deref(), Some("explicit"));
        assert_eq!(saved.daemon_generation, Some(42));
        assert_eq!(saved.birth_nonce.as_deref(), Some("birth-1"));
        assert_eq!(saved.layout_id.as_deref(), Some("layout-1"));
        assert_eq!(saved.terminal_pane_id.as_deref(), Some("leaf-1"));
    }

    #[test]
    fn from_creation_requires_a_complete_origin_leaf_anchor() {
        let request: CreateSessionRequest = serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24
        }))
        .expect("create request");
        let mut incomplete = provenance();
        incomplete.origin_terminal_pane_id = None;

        assert!(SavedSession::from_creation(&request, &incomplete).is_none());
    }
}
