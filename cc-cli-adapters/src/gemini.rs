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
                // `--approval-mode=yolo`（`--yolo` 已标 deprecated，且两者互斥）
                supports_yolo: true,
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

    /// docs/110 批 0：当前代码不接任何 MCP / 技能注入（WSL / SSH 只能裸启动）。
    fn injection_profile(&self) -> crate::InjectionProfile {
        crate::InjectionProfile::unsupported()
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        info!(
            session_id = %ctx.session_id,
            "gemini: building command"
        );

        let mut args = Vec::new();

        crate::push_model_arg(&mut args, ctx);

        if ctx.yolo_mode {
            args.push("--approval-mode=yolo".to_string());
        }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn context(yolo_mode: bool) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "session-1".to_string(),
            project_path: "/repo".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: Some("gemini-test".to_string()),
            issued_session_id: None,
            yolo_mode,
            launch_id: None,
            resume_id: None,
            skip_mcp: false,
            skip_ccpanes_mcp: false,
            append_system_prompt: None,
            initial_prompt: Some("hi".to_string()),
            orchestrator_port: None,
            orchestrator_token: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            shared_mcp_remote: Default::default(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
            adapter_options: HashMap::new(),
        }
    }

    #[test]
    fn yolo_mode_uses_approval_mode_flag_before_prompt() {
        let adapter = GeminiAdapter::new();
        let plain = adapter.build_command(&context(false)).unwrap().args;
        assert!(!plain.iter().any(|arg| arg.starts_with("--approval-mode")));

        let args = adapter.build_command(&context(true)).unwrap().args;
        let yolo = args
            .iter()
            .position(|arg| arg == "--approval-mode=yolo")
            .expect("approval flag");
        let prompt = args.iter().position(|arg| arg == "hi").expect("prompt");
        assert!(yolo < prompt);
        // `--yolo` 与 `--approval-mode` 互斥，绝不能同时出现
        assert!(!args.iter().any(|arg| arg == "--yolo" || arg == "-y"));
        assert!(adapter.capabilities().supports_yolo);
    }
}
