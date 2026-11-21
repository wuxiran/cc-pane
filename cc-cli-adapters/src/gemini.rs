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

/// 白名单为空时 Gemini 视为不过滤（`mcp-client-manager.ts`：`allowedNames.length > 0` 才生效），
/// 所以「一个都不放行」要传一个不可能存在的名字。
const NO_SERVER_SENTINEL: &str = "__ccpanes_no_mcp__";

/// 隔离白名单：本次写进项目文件的条目 + 启动档显式允许的名字（用户自己配置、被启动档选中的
/// server 照常连接）。逗号分隔——参数本身支持逗号与重复两种写法；server 名经
/// `is_valid_server_name` 校验，不含逗号。
fn allowed_server_names(ctx: &CliAdapterContext, injected: &[String]) -> String {
    let mut names: Vec<&str> = injected
        .iter()
        .chain(&ctx.allowed_mcp_server_ids)
        .map(String::as_str)
        .filter(|name| !name.is_empty() && !name.contains(','))
        .collect();
    names.sort_unstable();
    names.dedup();
    if names.is_empty() {
        return NO_SERVER_SENTINEL.to_string();
    }
    names.join(",")
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
    ///   经 `env` 块转发）；远程 HTTP / SSE 带字面请求头。
    /// - 隔离（批 3）：`--allowed-mcp-server-names` 按次启动白名单，用户 / 扩展 / 项目里的其他
    ///   server 一律不连（gemini-cli `packages/cli/src/config/config.ts`：给了这个参数就覆盖
    ///   `mcp.allowed`，且不再看 `mcp.excluded`）。
    /// - 技能：没有临时挂载参数，也没有提示词通道。WSL / SSH 只能裸启动。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        let mut profile = InjectionProfile::unsupported();
        profile.mcp = project_file_mcp(true, true, vec![McpTransport::Sse]);
        profile.mcp.isolation = McpIsolation::Full;
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

        if ctx.disable_unlisted_mcp_servers {
            // option 必须排在位置参数 prompt 之前
            let at = ctx
                .initial_prompt
                .as_ref()
                .map_or(args.len(), |_| args.len() - 1);
            args.insert(at, "--allowed-mcp-server-names".to_string());
            args.insert(at + 1, allowed_server_names(ctx, &mcp.servers));
        }

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

    /// docs/110 批 3：隔离 = `--allowed-mcp-server-names`（排在 prompt 前）；空白名单用哨兵名。
    #[test]
    fn isolation_passes_allowlist_before_prompt() {
        let adapter = GeminiAdapter::new();
        let plain = adapter.build_command(&context(false)).unwrap().args;
        assert!(!plain.iter().any(|arg| arg == "--allowed-mcp-server-names"));

        let mut ctx = context(false);
        ctx.disable_unlisted_mcp_servers = true;
        let args = adapter.build_command(&ctx).unwrap().args;
        let flag = args
            .iter()
            .position(|arg| arg == "--allowed-mcp-server-names")
            .expect("allowlist flag");
        assert_eq!(args[flag + 1], NO_SERVER_SENTINEL);
        assert_eq!(args.last().map(String::as_str), Some("hi"));

        ctx.allowed_mcp_server_ids = vec!["zeta".to_string(), "alpha".to_string()];
        let names = allowed_server_names(&ctx, &["ccpanes".to_string(), "alpha".to_string()]);
        assert_eq!(names, "alpha,ccpanes,zeta");
    }
}
