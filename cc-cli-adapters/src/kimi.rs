//! Kimi CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::info;

const DEFAULT_KIMI_BASE_URL: &str = "https://api.moonshot.cn/v1";
const KIMI_CONFIG_MODE_KEY: &str = "kimiConfigMode";
const KIMI_CONFIG_MODE_NATIVE: &str = "native";

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
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: false,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: true,
                supports_project_hooks: false,
                compatible_provider_types: vec!["kimi".into(), "config_profile".into()],
            },
        }
    }

    fn use_native_config(ctx: &CliAdapterContext) -> bool {
        ctx.adapter_options
            .get(KIMI_CONFIG_MODE_KEY)
            .and_then(serde_json::Value::as_str)
            == Some(KIMI_CONFIG_MODE_NATIVE)
    }

    fn write_session_config(&self, ctx: &CliAdapterContext) -> Result<Option<String>> {
        if Self::use_native_config(ctx) {
            return Ok(None);
        }

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

    fn build_env_inject(&self, ctx: &CliAdapterContext) -> Result<HashMap<String, String>> {
        if Self::use_native_config(ctx) {
            return Ok(HashMap::new());
        }

        let share_dir = ctx.data_dir.join("cli-adapters").join("kimi").join("share");
        std::fs::create_dir_all(&share_dir)?;

        Ok(HashMap::from([(
            "KIMI_SHARE_DIR".to_string(),
            share_dir.to_string_lossy().into_owned(),
        )]))
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

        let env_inject = self.build_env_inject(ctx)?;

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
            env_inject,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn context_with_options(
        data_dir: std::path::PathBuf,
        adapter_options: HashMap<String, serde_json::Value>,
    ) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "session-1".to_string(),
            project_path: "C:\\project".to_string(),
            workspace_path: None,
            provider: Some(crate::CliProvider {
                id: "kimi-provider".to_string(),
                name: "Kimi Provider".to_string(),
                provider_type: "kimi".to_string(),
                api_key: Some("test-key".to_string()),
                base_url: None,
                region: None,
                project_id: None,
                aws_profile: None,
                config_dir: None,
                is_default: false,
            }),
            resume_id: None,
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            data_dir,
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            adapter_options,
        }
    }

    #[test]
    fn native_config_mode_does_not_write_generated_provider_config() {
        let dir = tempdir().unwrap();
        let ctx = context_with_options(
            dir.path().to_path_buf(),
            HashMap::from([("kimiConfigMode".to_string(), json!("native"))]),
        );
        let adapter = KimiAdapter::new();

        let config_path = adapter.write_session_config(&ctx).unwrap();

        assert_eq!(config_path, None);
        assert!(!dir
            .path()
            .join("cli-adapters")
            .join("kimi")
            .join("configs")
            .exists());
    }

    #[test]
    fn native_config_mode_does_not_inject_isolated_share_dir() {
        let dir = tempdir().unwrap();
        let ctx = context_with_options(
            dir.path().to_path_buf(),
            HashMap::from([("kimiConfigMode".to_string(), json!("native"))]),
        );
        let adapter = KimiAdapter::new();

        let env_inject = adapter.build_env_inject(&ctx).unwrap();

        assert!(!env_inject.contains_key("KIMI_SHARE_DIR"));
        assert!(!dir
            .path()
            .join("cli-adapters")
            .join("kimi")
            .join("share")
            .exists());
    }

    #[test]
    fn managed_config_mode_keeps_existing_generated_config_and_share_dir() {
        let dir = tempdir().unwrap();
        let ctx = context_with_options(dir.path().to_path_buf(), HashMap::new());
        let adapter = KimiAdapter::new();

        let config_path = adapter.write_session_config(&ctx).unwrap().unwrap();
        let env_inject = adapter.build_env_inject(&ctx).unwrap();

        assert!(config_path.ends_with("session-1.json"));
        assert!(env_inject.contains_key("KIMI_SHARE_DIR"));
        assert!(dir
            .path()
            .join("cli-adapters")
            .join("kimi")
            .join("share")
            .exists());
    }
}
