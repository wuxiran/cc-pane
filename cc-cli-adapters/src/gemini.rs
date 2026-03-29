//! Gemini CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::info;

pub struct GeminiAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl GeminiAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "gemini".into(),
                display_name: "Gemini CLI".into(),
                executable: "gemini".into(),
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
                supports_workspace: false,
                compatible_provider_types: vec!["gemini".into()],
            },
        }
    }
}

impl Default for GeminiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for GeminiAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("gemini").map_err(|_| anyhow!("gemini CLI not found in PATH"))?;
        let gemini_cmd = path.to_string_lossy().into_owned();

        info!(
            session_id = %ctx.session_id,
            "gemini: building command"
        );

        let mut args = Vec::new();

        // [PROMPT] positional argument
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        Ok(CliCommandResult {
            command: gemini_cmd,
            args,
            env_remove: vec![],
            env_inject: HashMap::new(),
        })
    }
}
