//! Gemini CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
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
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: false,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: false,
                supports_project_hooks: false,
                supports_issued_session_id: false,
                supports_rpc: false,
                supports_structured_result: false,
                supports_yolo: false,
                supports_orchestrated_launch: false,
                // build_command 不消费任何 per-launch 参数键
                supports_effort_option: false,
                supports_verbose_option: false,
                supports_max_turns_option: false,
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
        info!(
            session_id = %ctx.session_id,
            "gemini: building command"
        );

        let mut args = Vec::new();

        crate::push_model_arg(&mut args, ctx);

        // [PROMPT] positional argument
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        let (command, args) = ctx.resolve_launch("gemini", args)?;

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject: HashMap::new(),
        })
    }
}
