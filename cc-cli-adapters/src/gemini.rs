//! Gemini CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
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
                // 项目 `.gemini/settings.json` 收据驱动注入（docs/110 批 2）
                supports_mcp: true,
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

    /// docs/110：
    /// - MCP（批 2）：项目 `.gemini/settings.json`，同项目会话共享；ccpanes 经 ctl stdio 代理（launchId
    ///   经 `env` 块转发）；远程 HTTP / SSE 带字面请求头；隔离只能声明（批 3 接 `--allowed-mcp-server-names`）。
    /// - 技能：没有临时挂载参数，也没有提示词通道。WSL / SSH 只能裸启动。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        let mut profile = InjectionProfile::unsupported();
        profile.mcp = project_file_mcp(true, true, vec![McpTransport::Sse]);
        profile
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

        // MCP（docs/110 批 2，低优先）：项目 `.gemini/settings.json` 的 `mcpServers`
        // （google-gemini/gemini-cli docs/tools/mcp-server.md）：`httpUrl` = HTTP、`url` = SSE。
        // Gemini 只在 `env` 块里展开 `$VAR`，并会清洗 stdio 子进程的敏感环境变量，所以 ccpanes
        // 走 ctl stdio 代理并在 `env` 里显式转发实例与 launchId。项目设置只在受信任文件夹生效。
        let mcp = crate::project_mcp::sync_for_launch(
            ctx,
            &crate::project_mcp_dialects::GEMINI,
            &crate::project_mcp::ccpanes_proxy_or_http(ctx),
        );

        let (command, args) = ctx.resolve_launch("gemini", args)?;

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject: mcp.env,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
