use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 供应商下的账号；不指定时用供应商的默认账号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub adapter_options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub target_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_runtime: Option<String>,
    #[serde(default)]
    pub yolo_mode: bool,
    #[serde(default)]
    pub mcp_policy: LaunchProfileMcpPolicy,
    #[serde(default)]
    pub skill_policy: LaunchProfileSkillPolicy,
    /// 原生 CLI 配置覆盖片段：CLI id（`codex` / `claude`）→ 原文（Codex 为 TOML、Claude 为 JSON）。
    /// 叠在中转站片段之上、CC-Panes 显式字段之下，见 `services::native_config`。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub native_overrides: BTreeMap<String, String>,
    #[serde(default)]
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 供应商下的账号；不指定时用供应商的默认账号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub adapter_options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub target_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_runtime: Option<String>,
    #[serde(default)]
    pub yolo_mode: bool,
    #[serde(default)]
    pub mcp_policy: LaunchProfileMcpPolicy,
    #[serde(default)]
    pub skill_policy: LaunchProfileSkillPolicy,
    /// `None` = 不改动已保存的片段（旧调用方不带这个字段时不会把它清空）；`Some` = 整体替换。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_overrides: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LaunchProviderSelection {
    #[default]
    Inherit,
    Explicit,
    None,
}

impl LaunchProviderSelection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Explicit => "explicit",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LaunchProfileMcpMode {
    #[default]
    Default,
    Custom,
    Disabled,
}

/// 共享 MCP 以什么形态交给会话（docs/113）。与 [`LaunchProfileMcpMode`] 正交：
/// mode 管「给哪些」，delivery 管「怎么给」。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum McpDelivery {
    /// 每台共享服务器各一条条目（旧行为）。
    #[default]
    Direct,
    /// 只给一条 `ccpanes-hub`，agent 经 `search_tools` / `call_tool` 按需使用。
    /// 这个 CLI / 运行时 / 服务器不支持时自动回退为直连。
    Hub,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", from = "LaunchProfileMcpPolicyWire")]
pub struct LaunchProfileMcpPolicy {
    pub mode: LaunchProfileMcpMode,
    pub enabled_server_ids: Vec<String>,
    pub disabled_server_ids: Vec<String>,
    pub include_ccpanes_mcp: bool,
    pub include_shared_mcp: bool,
    pub delivery: McpDelivery,
}

/// 读取形态：在正式字段之外兼容 feat/mcp-hub 早期写下的 `useMcpHub: true`（→ `delivery: hub`）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchProfileMcpPolicyWire {
    #[serde(default)]
    mode: LaunchProfileMcpMode,
    #[serde(default)]
    enabled_server_ids: Vec<String>,
    #[serde(default)]
    disabled_server_ids: Vec<String>,
    #[serde(default = "default_true")]
    include_ccpanes_mcp: bool,
    #[serde(default = "default_true")]
    include_shared_mcp: bool,
    #[serde(default)]
    delivery: Option<McpDelivery>,
    #[serde(default)]
    use_mcp_hub: bool,
}

impl From<LaunchProfileMcpPolicyWire> for LaunchProfileMcpPolicy {
    fn from(wire: LaunchProfileMcpPolicyWire) -> Self {
        let delivery = wire.delivery.unwrap_or(if wire.use_mcp_hub {
            McpDelivery::Hub
        } else {
            McpDelivery::Direct
        });
        Self {
            mode: wire.mode,
            enabled_server_ids: wire.enabled_server_ids,
            disabled_server_ids: wire.disabled_server_ids,
            include_ccpanes_mcp: wire.include_ccpanes_mcp,
            include_shared_mcp: wire.include_shared_mcp,
            delivery,
        }
    }
}

impl Default for LaunchProfileMcpPolicy {
    fn default() -> Self {
        Self {
            mode: LaunchProfileMcpMode::Default,
            enabled_server_ids: Vec::new(),
            disabled_server_ids: Vec::new(),
            include_ccpanes_mcp: true,
            include_shared_mcp: true,
            delivery: McpDelivery::Direct,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LaunchProfileSkillMode {
    #[default]
    Core,
    Custom,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileSkillPolicy {
    #[serde(default)]
    pub mode: LaunchProfileSkillMode,
    #[serde(default)]
    pub enabled_skill_ids: Vec<String>,
    #[serde(default)]
    pub disabled_skill_ids: Vec<String>,
    #[serde(default)]
    pub profile_skills: Vec<LaunchProfileSkill>,
    #[serde(default = "default_true")]
    pub include_project_skills: bool,
    /// Mount the workspace's own skill folder (`<workspace>/skills`) into the session.
    #[serde(default = "default_true")]
    pub include_workspace_skills: bool,
    #[serde(default = "default_true")]
    pub include_external_claude_skills: bool,
    #[serde(default = "default_true")]
    pub include_external_codex_skills: bool,
    #[serde(default = "default_true")]
    pub include_external_plugin_skills: bool,
    #[serde(default = "default_skill_target")]
    pub target: String,
}

impl Default for LaunchProfileSkillPolicy {
    fn default() -> Self {
        Self {
            mode: LaunchProfileSkillMode::Core,
            enabled_skill_ids: Vec::new(),
            disabled_skill_ids: Vec::new(),
            profile_skills: Vec::new(),
            include_project_skills: true,
            include_workspace_skills: true,
            include_external_claude_skills: true,
            include_external_codex_skills: true,
            include_external_plugin_skills: true,
            target: default_skill_target(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileSkill {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub profiles: Vec<LaunchProfile>,
}

impl Default for LaunchProfileConfig {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfilePreviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub use_system_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 供应商下的账号；不指定时用供应商的默认账号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub provider_selection: LaunchProviderSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileResolution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// 供应商下的账号；不指定时用供应商的默认账号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_source: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<ResolvedMcpServer>,
    #[serde(default)]
    pub skills: Vec<ResolvedSkill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_compatibility: Option<SkillCompatibility>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMcpServer {
    pub id: String,
    pub name: String,
    pub source: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSkill {
    pub id: String,
    pub name: String,
    pub source: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Portable Skill and orchestration support for the CLI selected by a preview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillCompatibility {
    pub cli_tool: String,
    #[serde(default)]
    pub delivery_modes: Vec<cc_cli_adapters::SkillDeliveryMode>,
    #[serde(default)]
    pub can_use_portable_skills: bool,
    #[serde(default)]
    pub can_control_orchestration: bool,
    #[serde(default)]
    pub can_report_result: bool,
    /// Stable reason code when a complete portable-Skill workflow is unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub type SharedMcpUrls = HashMap<String, String>;

fn default_true() -> bool {
    true
}

fn default_skill_target() -> String {
    "session".to_string()
}

fn default_schema_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_delivery_defaults_to_direct_and_reads_legacy_flag() {
        let old: LaunchProfileMcpPolicy = serde_json::from_str(r#"{"mode":"default"}"#).unwrap();
        assert_eq!(old.delivery, McpDelivery::Direct);
        assert!(old.include_shared_mcp);

        let legacy: LaunchProfileMcpPolicy = serde_json::from_str(r#"{"useMcpHub":true}"#).unwrap();
        assert_eq!(legacy.delivery, McpDelivery::Hub);

        // 显式 delivery 优先于旧字段
        let both: LaunchProfileMcpPolicy =
            serde_json::from_str(r#"{"useMcpHub":true,"delivery":"direct"}"#).unwrap();
        assert_eq!(both.delivery, McpDelivery::Direct);

        // 写回时只有 delivery，旧字段随之消失
        let json = serde_json::to_value(&legacy).unwrap();
        assert_eq!(json["delivery"], "hub");
        assert!(json.get("useMcpHub").is_none());
    }
}
