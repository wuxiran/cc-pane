//! Kimi CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::info;

const DEFAULT_KIMI_BASE_URL: &str = "https://api.moonshot.cn/v1";

pub struct KimiAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl KimiAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "kimi".into(),
                display_name: "Kimi CLI".into(),
                executable: "kimi".into(),
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
                compatible_provider_types: vec!["kimi".into()],
            },
        }
    }

    fn write_session_config(&self, ctx: &CliAdapterContext) -> Result<Option<String>> {
        let Some(provider) = ctx.provider.as_ref() else {
            return Ok(None);
        };
        if provider.provider_type != "kimi" {
            return Ok(None);
        }
        let Some(api_key) = provider.api_key.as_ref() else {
            return Ok(None);
        };

        let adapter_root = ctx.data_dir.join("cli-adapters").join("kimi");
        let config_dir = adapter_root.join("configs");
        std::fs::create_dir_all(&config_dir)?;

        let config_path = config_dir.join(format!("{}.json", ctx.session_id));
        let config = serde_json::json!({
            "providers": {
                "ccpanes": {
                    "type": "kimi",
                    "api_key": api_key,
                    "base_url": provider.base_url.as_deref().unwrap_or(DEFAULT_KIMI_BASE_URL),
                }
            }
        });

        std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
        Ok(Some(config_path.to_string_lossy().into_owned()))
    }
}

impl Default for KimiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for KimiAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("kimi").map_err(|_| anyhow!("kimi CLI not found in PATH"))?;
        let kimi_cmd = path.to_string_lossy().into_owned();
        let mut args = Vec::new();

        if let Some(config_path) = self.write_session_config(ctx)? {
            args.push("--config-file".to_string());
            args.push(config_path);
        }

        if let Some(workspace_path) = ctx.workspace_path.as_deref() {
            if workspace_path != ctx.project_path {
                args.push("--add-dir".to_string());
                args.push(ctx.project_path.clone());
            }
        }

        if let Some(prompt) = ctx.initial_prompt.as_ref() {
            args.push(prompt.clone());
        }

        let share_dir = ctx.data_dir.join("cli-adapters").join("kimi").join("share");
        std::fs::create_dir_all(&share_dir)?;

        info!(
            session_id = %ctx.session_id,
            command = %kimi_cmd,
            args = ?args,
            "kimi: building command"
        );

        Ok(CliCommandResult {
            command: kimi_cmd,
            args,
            env_remove: vec![],
            env_inject: HashMap::from([(
                "KIMI_SHARE_DIR".to_string(),
                share_dir.to_string_lossy().into_owned(),
            )]),
        })
    }
}
