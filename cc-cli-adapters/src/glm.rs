//! GLM CLI 适配器（底层执行 crush）

use crate::{
    atomic_file::write_atomic_if_absent, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
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
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: false,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: true,
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
        let launch_cwd = ctx
            .workspace_path
            .clone()
            .unwrap_or_else(|| ctx.project_path.clone());
        let mut env_inject = HashMap::new();
        let mut managed_data_path = None;
        if let Some(provider) = ctx.provider.as_ref() {
            let adapter_root = ctx.data_dir.join("cli-adapters").join("glm");
            let config_path = adapter_root.join("crush.json");
            let data_path = adapter_root.join("data");
            std::fs::create_dir_all(&data_path)?;
            write_atomic_if_absent(&config_path, b"{}\n")?;
            env_inject.insert(
                "CRUSH_GLOBAL_CONFIG".to_string(),
                config_path.to_string_lossy().into_owned(),
            );
            env_inject.insert(
                "CRUSH_GLOBAL_DATA".to_string(),
                data_path.to_string_lossy().into_owned(),
            );
            managed_data_path = Some(data_path);
            if provider.provider_type == "glm" {
                if let Some(api_key) = provider.api_key.as_ref() {
                    env_inject.insert("ZAI_API_KEY".to_string(), api_key.clone());
                }
                if let Some(base_url) = provider.base_url.as_ref() {
                    env_inject.insert("ZAI_BASE_URL".to_string(), base_url.clone());
                }
            }
        }

        let mut args = vec!["--cwd".to_string(), launch_cwd];
        if let Some(data_path) = managed_data_path {
            args.push("--data-dir".to_string());
            args.push(data_path.to_string_lossy().into_owned());
        }

        crate::push_model_arg(&mut args, ctx);

        if let Some(resume_id) = ctx.resume_id.as_ref() {
            args.push("--session".to_string());
            args.push(resume_id.clone());
        }

        if let Some(prompt) = ctx.initial_prompt.as_ref() {
            args.push("run".to_string());
            args.push(prompt.clone());
        }

        let (command, args) = ctx.resolve_launch("crush", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "glm: building command"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn context(data_dir: std::path::PathBuf, managed: bool) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "session-1".into(),
            project_path: "C:\\project".into(),
            workspace_path: None,
            provider: managed.then(|| crate::CliProvider {
                id: "glm-provider".into(),
                name: "GLM".into(),
                provider_type: "glm".into(),
                api_key: Some("test-secret".into()),
                base_url: Some("https://example.test".into()),
                region: None,
                project_id: None,
                aws_profile: None,
                config_dir: None,
                is_default: false,
            }),
            executable_override: Some("crush-test".into()),
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: true,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir,
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
        }
    }

    #[test]
    fn native_mode_does_not_redirect_crush_provider_config_or_data() {
        let dir = tempdir().unwrap();
        let result = GlmAdapter::new()
            .build_command(&context(dir.path().to_path_buf(), false))
            .unwrap();

        assert!(!result.args.iter().any(|arg| arg == "--data-dir"));
        assert!(!result.env_inject.contains_key("CRUSH_GLOBAL_CONFIG"));
        assert!(!result.env_inject.contains_key("CRUSH_GLOBAL_DATA"));
        assert!(!result.env_inject.contains_key("ZAI_API_KEY"));
    }

    #[test]
    fn managed_mode_uses_session_owned_crush_config_without_secret_args() {
        let dir = tempdir().unwrap();
        let result = GlmAdapter::new()
            .build_command(&context(dir.path().to_path_buf(), true))
            .unwrap();

        assert!(result.args.iter().any(|arg| arg == "--data-dir"));
        assert!(result.env_inject.contains_key("CRUSH_GLOBAL_CONFIG"));
        assert_eq!(
            result.env_inject.get("ZAI_API_KEY").map(String::as_str),
            Some("test-secret")
        );
        assert!(!result.args.iter().any(|arg| arg.contains("test-secret")));
    }
}
