//! Cursor CLI 适配器

use crate::{
    resolve_executable, CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities,
    CliToolInfo,
};
use anyhow::Result;
use std::collections::HashMap;
use tracing::info;

pub struct CursorAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl CursorAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "cursor".into(),
                display_name: "Cursor CLI".into(),
                executable: "cursor-agent".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: true,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: false,
                supports_project_hooks: false,
                compatible_provider_types: vec!["cursor".into()],
            },
        }
    }
}

impl Default for CursorAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for CursorAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = resolve_executable("cursor-agent")?;
        let cursor_cmd = path.to_string_lossy().into_owned();

        let mut args = Vec::new();
        if let Some(resume_id) = ctx.resume_id.as_ref() {
            args.push("--resume".to_string());
            args.push(resume_id.clone());
        }
        if let Some(prompt) = ctx.initial_prompt.as_ref() {
            args.push(prompt.clone());
        }

        let mut env_inject = HashMap::new();
        if let Some(provider) = ctx.provider.as_ref() {
            if provider.provider_type == "cursor" {
                if let Some(api_key) = provider.api_key.as_ref() {
                    env_inject.insert("CURSOR_API_KEY".to_string(), api_key.clone());
                }
            }
        }

        info!(
            session_id = %ctx.session_id,
            command = %cursor_cmd,
            args = ?args,
            "cursor: building command"
        );

        Ok(CliCommandResult {
            command: cursor_cmd,
            args,
            env_remove: vec![],
            env_inject,
        })
    }
}
