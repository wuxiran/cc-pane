use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 合成「系统环境变量」Provider 的固定 id。
///
/// 这是一个**不落盘**的虚拟条目：选中它表示 CC-Panes 不注入任何 Provider 环境变量，
/// 让子进程继承宿主环境 / 让 CLI 读自己的配置（如 cc-switch 写的 `~/.claude/settings.json`）。
/// 语义上等价于 `LaunchProviderSelection::None`，但以显式 id 的形式在列表里可选/可展示。
pub const SYSTEM_PROVIDER_ID: &str = "__system__";

/// Provider 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    #[default]
    Anthropic,
    Bedrock,
    Vertex,
    Proxy,
    ConfigProfile,
    OpenAI,
    Gemini,
    Kimi,
    Glm,
    Cursor,
    #[serde(rename = "opencode", alias = "open_code")]
    OpenCode,
    Grok,
}

/// Provider 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub provider_type: ProviderType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aws_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

impl Provider {
    /// 根据 provider_type 生成对应的环境变量
    pub fn to_env_vars(&self) -> HashMap<String, String> {
        let mut vars = HashMap::new();

        match self.provider_type {
            ProviderType::Anthropic => {
                if let Some(ref key) = self.api_key {
                    vars.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("ANTHROPIC_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::Bedrock => {
                vars.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
                if let Some(ref region) = self.region {
                    vars.insert("AWS_REGION".to_string(), region.clone());
                }
                if let Some(ref profile) = self.aws_profile {
                    vars.insert("AWS_PROFILE".to_string(), profile.clone());
                }
            }
            ProviderType::Vertex => {
                vars.insert("CLAUDE_CODE_USE_VERTEX".to_string(), "1".to_string());
                if let Some(ref region) = self.region {
                    vars.insert("CLOUD_ML_REGION".to_string(), region.clone());
                }
                if let Some(ref pid) = self.project_id {
                    vars.insert("ANTHROPIC_VERTEX_PROJECT_ID".to_string(), pid.clone());
                }
            }
            ProviderType::Proxy => {
                if let Some(ref key) = self.api_key {
                    vars.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("ANTHROPIC_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::ConfigProfile => {
                if let Some(ref dir) = self.config_dir {
                    vars.insert("CLAUDE_CONFIG_DIR".to_string(), dir.clone());
                }
            }
            ProviderType::OpenAI => {
                if let Some(ref key) = self.api_key {
                    vars.insert("CODEX_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("OPENAI_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::Gemini => {
                if let Some(ref key) = self.api_key {
                    vars.insert("GEMINI_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("GEMINI_API_BASE".to_string(), url.clone());
                }
            }
            ProviderType::Kimi => {
                if let Some(ref key) = self.api_key {
                    vars.insert("KIMI_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("KIMI_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::Glm => {
                if let Some(ref key) = self.api_key {
                    vars.insert("ZAI_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("ZAI_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::Cursor => {
                if let Some(ref key) = self.api_key {
                    vars.insert("CURSOR_API_KEY".to_string(), key.clone());
                }
            }
            ProviderType::OpenCode => {
                // OpenCode uses standard OpenAI-compatible variables
                if let Some(ref key) = self.api_key {
                    vars.insert("OPENAI_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("OPENAI_BASE_URL".to_string(), url.clone());
                }
            }
            ProviderType::Grok => {
                if let Some(ref key) = self.api_key {
                    vars.insert("XAI_API_KEY".to_string(), key.clone());
                }
                // XAI_BASE_URL 为前瞻性注入：Grok CLI 官方确认的 base_url 生效路径是
                // ~/.grok/config.toml 的 per-model 配置，CC-Panes 不代写（写错会破坏
                // 用户模型配置）；若 CLI 未来识别该环境变量则自动生效。
                if let Some(ref url) = self.base_url {
                    vars.insert("XAI_BASE_URL".to_string(), url.clone());
                }
            }
        }

        vars
    }
}

/// Provider 配置文件
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(default)]
    pub providers: Vec<Provider>,
    /// 「系统环境变量」（`SYSTEM_PROVIDER_ID`）被显式设为默认。
    ///
    /// 该伪条目不落入 `providers`，故无法用 `is_default` 表达；用这个独立标记持久化。
    /// 与任一 provider 的 `is_default` 互斥：设置其一即清空另一方。
    #[serde(default)]
    pub default_is_system: bool,
}

/// 「系统环境变量」条目的探测结果。
///
/// `active` 与旧版 `detect_system_provider` 的布尔返回值语义一致；其余字段供 UI 展示
/// 「探测到了什么」以及「用户是否已把系统条目设为默认」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProviderInfo {
    /// 探测到 cc-switch 或宿主 Anthropic 凭证之一。
    pub active: bool,
    /// 探测到 `~/.cc-switch/cc-switch.db`。
    pub cc_switch: bool,
    /// 宿主进程中命中的 Anthropic 环境变量名（**只有键名，不含值**）。
    pub env_keys: Vec<String>,
    /// 用户已把「系统环境变量」设为默认凭证（持久化状态）。
    pub default_is_system: bool,
}
