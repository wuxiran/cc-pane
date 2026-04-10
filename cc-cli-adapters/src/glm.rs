//! GLM CLI 适配器（底层执行 crush）

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::info;

pub struct GlmAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl GlmAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "glm".into(),
                display_name: "GLM CLI".into(),
                executable: "crush".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: false,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: true,
                compatible_provider_types: vec!["glm".into()],
            },
        }
    }
}

impl Default for GlmAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for GlmAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("crush").map_err(|_| anyhow!("crush CLI not found in PATH"))?;
        let crush_cmd = path.to_string_lossy().into_owned();
        let adapter_root = ctx.data_dir.join("cli-adapters").join("glm");
        let config_path = adapter_root.join("crush.json");
        let data_path = adapter_root.join("data");

        std::fs::create_dir_all(&data_path)?;
        if !config_path.exists() {
            std::fs::write(&config_path, b"{}\n")?;
        }

        let mut env_inject = HashMap::from([
            (
                "CRUSH_GLOBAL_CONFIG".to_string(),
                config_path.to_string_lossy().into_owned(),
            ),
            (
                "CRUSH_GLOBAL_DATA".to_string(),
                data_path.to_string_lossy().into_owned(),
            ),
        ]);

        if let Some(provider) = ctx.provider.as_ref() {
            if provider.provider_type == "glm" {
                if let Some(api_key) = provider.api_key.as_ref() {
                    env_inject.insert("ZAI_API_KEY".to_string(), api_key.clone());
                }
                if let Some(base_url) = provider.base_url.as_ref() {
                    env_inject.insert("ZAI_BASE_URL".to_string(), base_url.clone());
                }
            }
        }

        info!(
            session_id = %ctx.session_id,
            command = %crush_cmd,
            "glm: building command"
        );

        Ok(CliCommandResult {
            command: crush_cmd,
            args: vec![],
            env_remove: vec![],
            env_inject,
        })
    }
}
