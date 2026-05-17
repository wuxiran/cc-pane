use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub adapter_options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub target_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_runtime: Option<String>,
    #[serde(default)]
    pub mcp_policy: LaunchProfileMcpPolicy,
    #[serde(default)]
    pub skill_policy: LaunchProfileSkillPolicy,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub adapter_options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub target_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_runtime: Option<String>,
    #[serde(default)]
    pub mcp_policy: LaunchProfileMcpPolicy,
    #[serde(default)]
    pub skill_policy: LaunchProfileSkillPolicy,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LaunchProfileMcpMode {
    #[default]
    Default,
    Custom,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileMcpPolicy {
    #[serde(default)]
    pub mode: LaunchProfileMcpMode,
    #[serde(default)]
    pub enabled_server_ids: Vec<String>,
    #[serde(default)]
    pub disabled_server_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub include_ccpanes_mcp: bool,
    #[serde(default = "default_true")]
    pub include_shared_mcp: bool,
}

impl Default for LaunchProfileMcpPolicy {
    fn default() -> Self {
        Self {
            mode: LaunchProfileMcpMode::Default,
            enabled_server_ids: Vec::new(),
            disabled_server_ids: Vec::new(),
            include_ccpanes_mcp: true,
            include_shared_mcp: true,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<ResolvedMcpServer>,
    #[serde(default)]
    pub skills: Vec<ResolvedSkill>,
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
