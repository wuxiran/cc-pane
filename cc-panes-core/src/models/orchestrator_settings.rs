//! Orchestrator（HTTP+MCP server）相关设置。
//!
//! 从 `models::settings` 拆出：settings.rs 已触到行数棘轮上限
//! （`cc-panes-core/tests/line_ratchet.rs`），新增设置项一律往外拆而不是继续堆。
//! 仍由 `models::settings` 重导出，调用方 import 路径不变。

use serde::{Deserialize, Serialize};

/// Orchestrator（HTTP+MCP server）网络绑定与 agent 行为设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSettings {
    /// "auto"：默认只绑回环，检测到 WSL 使用信号时绑全网卡（WSL 内 CLI 需回连宿主）
    /// "loopback"：始终 127.0.0.1；"all"：始终 0.0.0.0
    #[serde(default = "default_orchestrator_bind_mode")]
    pub bind_mode: String,
    /// 允许 MCP agent 创建、绑定或显式启动带危险权限参数的 YOLO profile。
    /// 默认关闭，避免老配置升级后扩大 agent 权限面。
    #[serde(default)]
    pub allow_mcp_yolo_profiles: bool,
    /// agent（leader）启动任务时，界面是否跟随跳到目标布局。
    ///
    /// 默认关闭：leader 每派一个 worker 就把用户从当前布局弹回去是最招人烦的行为。
    /// 关闭时 worker 仍正常建在目标布局，只是不抢当前视图（前端改发一条可跳转的提示，
    /// 见 `web/hooks/useOrchestratorListener.ts`）。
    #[serde(default)]
    pub follow_agent_launch: bool,
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            bind_mode: default_orchestrator_bind_mode(),
            allow_mcp_yolo_profiles: false,
            follow_agent_launch: false,
        }
    }
}

impl OrchestratorSettings {
    pub fn merge_missing_defaults(&mut self) {
        if !matches!(self.bind_mode.as_str(), "auto" | "loopback" | "all") {
            self.bind_mode = default_orchestrator_bind_mode();
        }
    }
}

fn default_orchestrator_bind_mode() -> String {
    "auto".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // 老配置文件不含这些键，反序列化必须整体回落默认而不是失败
        let parsed: OrchestratorSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.bind_mode, "auto");
        assert!(!parsed.allow_mcp_yolo_profiles);
        assert!(!parsed.follow_agent_launch);
    }

    #[test]
    fn follow_agent_launch_defaults_off_and_round_trips() {
        assert!(!OrchestratorSettings::default().follow_agent_launch);

        let parsed: OrchestratorSettings =
            serde_json::from_str(r#"{"followAgentLaunch":true}"#).unwrap();
        assert!(parsed.follow_agent_launch);

        let json = serde_json::to_string(&parsed).unwrap();
        assert!(json.contains("followAgentLaunch"));
    }

    #[test]
    fn invalid_bind_mode_is_repaired() {
        let mut settings = OrchestratorSettings {
            bind_mode: "nonsense".to_string(),
            ..Default::default()
        };
        settings.merge_missing_defaults();
        assert_eq!(settings.bind_mode, "auto");
    }
}
