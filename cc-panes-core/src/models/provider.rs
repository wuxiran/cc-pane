use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    OpenCode,
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
            ProviderType::OpenCode => {
                // OpenCode uses standard OpenAI-compatible variables
                if let Some(ref key) = self.api_key {
                    vars.insert("OPENAI_API_KEY".to_string(), key.clone());
                }
                if let Some(ref url) = self.base_url {
                    vars.insert("OPENAI_BASE_URL".to_string(), url.clone());
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
}
