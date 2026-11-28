//! Kiro CLI 适配器
//!
//! 文档：<https://kiro.dev/docs/cli/>、<https://kiro.dev/docs/reference/cli-commands/>
//! - 安装：`curl -fsSL https://cli.kiro.dev/install | bash`（落 `~/.local/bin/kiro-cli`）；
//!   登录 `kiro-cli login`，headless 场景可用 `KIRO_API_KEY`。
//! - 裸 `kiro-cli` 等价于 `kiro-cli chat`（交互会话）。官方文档列出
//!   `kiro-cli chat [INPUT]` 的位置参数作为首个问题——initial_prompt 走这条：
//!   有 prompt 时显式加 `chat` 子命令再追加 INPUT，无 prompt 时保持裸启动。
//! - `chat` 另有 `--resume/--resume-id`、`--trust-all-tools`、`--model`，但 cc-pane
//!   尚无 Kiro 会话索引（没有 resume id 来源），YOLO 也未实机验证，本期不接。
//!
//! 本机未安装、未实机验证；能力位一律按「查不到官方依据即 false」保守声明：
//! 无托管 Provider（凭证走 CLI 自己的登录态 / 环境变量）、无 resume 会话来源、
//! 无 MCP / 系统提示 / YOLO 注入面。只做裸启动 + 用户显式填写的 `extraArgs` 透传。

use crate::{
    extra_args_from_options, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
use std::collections::HashMap;
use tracing::info;

pub struct KiroAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl KiroAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "kiro".into(),
                display_name: "Kiro CLI".into(),
                executable: "kiro-cli".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                // 凭证由 CLI 自身登录态 / 环境变量提供（见模块头），不接托管 Provider
                supports_provider: false,
                // `kiro-cli chat --resume-id` 存在，但 cc-pane 无 Kiro 会话索引，没有 resume id 来源
                supports_resume: false,
                supports_mcp: false,
                supports_system_prompt: false,
                supports_workspace: false,
                supports_project_hooks: false,
                supports_issued_session_id: false,
                supports_rpc: false,
                supports_structured_result: false,
                // `chat --trust-all-tools` 存在但未实机验证，暂不放开
                supports_yolo: false,
                supports_orchestrated_launch: false,
                // build_command 不消费任何 per-launch 参数键
                supports_effort_option: false,
                supports_verbose_option: false,
                supports_max_turns_option: false,
                compatible_provider_types: Vec::new(),
            },
        }
    }
}

impl Default for KiroAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for KiroAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    /// 不注入 MCP / 技能；本机与 WSL 裸启动，SSH 启动面未实机验证，不放开
    /// （前端启动菜单 / 启动器读 `runtimes.ssh.launch` 判定）。
    fn injection_profile(&self) -> crate::InjectionProfile {
        let mut profile = crate::InjectionProfile::unsupported();
        profile.runtimes.ssh = crate::RuntimeInjection::unavailable();
        profile
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let initial_prompt = ctx
            .initial_prompt
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut args = Vec::new();
        if initial_prompt.is_some() {
            // 位置参数 INPUT 属于 `chat` 子命令（官方 CLI 命令参考）
            args.push("chat".to_string());
        }
        args.extend(extra_args_from_options(&ctx.adapter_options));
        if let Some(prompt) = initial_prompt {
            args.push(prompt.to_string());
        }

        let (command, args) = ctx.resolve_launch("kiro-cli", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "kiro: building command"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: Vec::new(),
            env_inject: HashMap::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> CliAdapterContext {
        CliAdapterContext {
            session_id: "session-1".to_string(),
            project_path: "/project".to_string(),
            workspace_path: Some("/workspace".to_string()),
            provider: None,
            executable_override: Some("kiro-cli-test".to_string()),
            issued_session_id: None,
            yolo_mode: false,
            launch_id: None,
            resume_id: None,
            skip_mcp: false,
            skip_ccpanes_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            shared_mcp_remote: Default::default(),
            hub_covered_mcp_servers: Vec::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
            adapter_options: HashMap::new(),
        }
    }

    #[test]
    fn bare_launch_ignores_unsupported_inputs() {
        let mut ctx = context();
        ctx.yolo_mode = true;
        ctx.resume_id = Some("previous-session".to_string());
        ctx.append_system_prompt = Some("Follow the repository instructions".to_string());
        ctx.adapter_options
            .insert("effort".to_string(), json!("high"));

        let result = KiroAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.command, "kiro-cli-test");
        assert!(result.args.is_empty(), "unexpected args: {:?}", result.args);
        assert!(result.env_inject.is_empty());
        assert!(result.env_remove.is_empty());
    }

    #[test]
    fn initial_prompt_uses_documented_entry() {
        let mut ctx = context();
        ctx.initial_prompt = Some("  Inspect the issue  ".to_string());

        let result = KiroAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.args, vec!["chat", "Inspect the issue"]);

        ctx.initial_prompt = Some("   ".to_string());
        let blank = KiroAdapter::new().build_command(&ctx).unwrap();
        assert!(blank.args.is_empty());
    }

    #[test]
    fn extra_args_pass_through() {
        let mut ctx = context();
        ctx.adapter_options
            .insert("extraArgs".to_string(), json!(["--foo", " ", "bar"]));

        let result = KiroAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.args, vec!["--foo", "bar"]);
    }

    #[test]
    fn capabilities_are_conservative() {
        let adapter = KiroAdapter::new();
        let info = adapter.info();
        assert_eq!(info.id, "kiro");
        assert_eq!(info.executable, "kiro-cli");

        let caps = adapter.capabilities();
        assert!(!caps.supports_provider);
        assert!(!caps.supports_resume);
        assert!(!caps.supports_mcp);
        assert!(!caps.supports_system_prompt);
        assert!(!caps.supports_workspace);
        assert!(!caps.supports_project_hooks);
        assert!(!caps.supports_issued_session_id);
        assert!(!caps.supports_rpc);
        assert!(!caps.supports_structured_result);
        assert!(!caps.supports_yolo);
        assert!(!caps.supports_orchestrated_launch);
        assert!(!caps.supports_effort_option);
        assert!(!caps.supports_verbose_option);
        assert!(!caps.supports_max_turns_option);
        assert!(caps.compatible_provider_types.is_empty());
        assert!(!adapter.can_report_task_result());
        let profile = adapter.injection_profile();
        assert!(profile.runtimes.wsl.launch);
        assert!(!profile.runtimes.ssh.launch);
        assert!(!profile.mcp.shared);
        assert!(adapter.skill_delivery_modes().is_empty());
    }
}
