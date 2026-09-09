//! Jcode CLI 适配器
//!
//! Jcode 是 Rust 编写的客户端-服务器架构编码代理：`jcode` 直接进 TUI，会话由
//! 后台 daemon 持有。启动面要点（v0.84.0 实机验证）：
//! - `--provider anthropic-api` 把 jcode 钉在 env 凭证驱动的 Anthropic 直连
//!   通道上，避免 auto-detect 偏向用户自己的订阅 OAuth。凭证由启动核心统一
//!   注入通用 Provider env（`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`，
//!   jcode 原生读取），适配器只负责钉通道，绝不把密钥放进命令行。
//! - `--no-update` 默认注入：jcode 的自动更新会触发 daemon 重载二进制
//!   （`auto_server_reload`），面板启动要求确定性。
//! - TUI **不接受位置参数 prompt**（clap 会报 unrecognized subcommand），
//!   也没有 yolo / `--append-system-prompt` / `--mcp-config` flag。对应的
//!   启动输入在此显式忽略；MCP 由 jcode 原生读取项目 `.mcp.json` /
//!   `.jcode/mcp.json`，无需启动期注入。
//! - effort 走 env：`JCODE_ANTHROPIC_REASONING_EFFORT` /
//!   `JCODE_OPENAI_REASONING_EFFORT`。jcode 档位 `none|minimal|low|medium|
//!   high|xhigh|max` 完整覆盖 cc-pane 六档，直接透传。
//! - `--resume <ID|名字>` flag 已接线，但 `supports_resume` 暂为 false：
//!   jcode 会话落盘在 `~/.jcode/sessions/`（含 sessions-index.json），
//!   cc-pane 尚无对应 session index parser，没有 resume id 来源。

use crate::{
    effort_from_options, extra_args_from_options, push_model_arg, CliAdapterContext,
    CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
use std::collections::HashMap;
use tracing::info;

/// effort 档位透传的 env（anthropic 通道与 openai 通道各一个，jcode 按
/// 当前 provider 家族取用；同时注入两个避免 managed provider 切换时漏配）。
const JCODE_ANTHROPIC_EFFORT_ENV: &str = "JCODE_ANTHROPIC_REASONING_EFFORT";
const JCODE_OPENAI_EFFORT_ENV: &str = "JCODE_OPENAI_REASONING_EFFORT";

pub struct JcodeAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl JcodeAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "jcode".into(),
                display_name: "Jcode".into(),
                executable: "jcode".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                // flag 已接线但没有 resume id 来源（会话索引未接入，见模块头）
                supports_resume: false,
                // jcode 原生读项目 .mcp.json / .jcode/mcp.json，但无 per-launch
                // 注入 flag；cc-pane 的启动期 MCP 注入面暂不可用
                supports_mcp: false,
                // 无 --append-system-prompt；jcode 的项目指令机制是 AGENTS.md
                supports_system_prompt: false,
                supports_workspace: false,
                // JCODE_HOOK_SESSION_START/END、TURN_START/END、PRE/POST_TOOL
                // env 钩子存在，是后续接入状态跟踪/通知的通道，本期未接
                supports_project_hooks: false,
                supports_issued_session_id: false,
                // jcode 有 `jcode acp`（Agent Client Protocol 适配），但
                // cc-pane 的结构化 RPC 服务目前只接了 Pi
                supports_rpc: false,
                supports_structured_result: false,
                // jcode 没有 yolo/跳过权限模式（二进制中不存在该概念）
                supports_yolo: false,
                supports_orchestrated_launch: false,
                supports_effort_option: true,
                // --trace 是 stderr 调试日志，会污染 TUI 面板，不作为 verbose 映射
                supports_verbose_option: false,
                supports_max_turns_option: false,
                // anthropic 直连（ANTHROPIC_API_KEY）与中转（+ANTHROPIC_BASE_URL）
                // 均由通用 Provider env 覆盖，jcode 原生读取
                compatible_provider_types: vec!["anthropic".into(), "proxy".into()],
            },
        }
    }

    /// managed anthropic/proxy Provider 需要钉 `--provider anthropic-api`。
    fn pins_anthropic_api(provider: Option<&crate::CliProvider>) -> bool {
        provider.is_some_and(|provider| {
            matches!(provider.provider_type.as_str(), "anthropic" | "proxy")
        })
    }
}

impl Default for JcodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for JcodeAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    /// jcode 的全局技能目录，SKILL.md 布局与 Claude 一致（实机确认
    /// `~/.jcode/skills/<name>/SKILL.md`），默认投递模式即 NativeSkill。
    fn global_skills_dir(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|home| home.join(".jcode").join("skills"))
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let mut args = vec!["--no-update".to_string()];

        if Self::pins_anthropic_api(ctx.provider.as_ref()) {
            args.push("--provider".to_string());
            args.push("anthropic-api".to_string());
        }

        if let Some(resume_id) = ctx
            .resume_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }

        push_model_arg(&mut args, ctx);

        // effort → jcode 推理档位 env（六档取值与 jcode 档位一一同名）
        let mut env_inject = HashMap::new();
        if let Some(effort) = effort_from_options(&ctx.adapter_options) {
            env_inject.insert(JCODE_ANTHROPIC_EFFORT_ENV.to_string(), effort.clone());
            env_inject.insert(JCODE_OPENAI_EFFORT_ENV.to_string(), effort);
        }

        args.extend(extra_args_from_options(&ctx.adapter_options));

        // initial_prompt / append_system_prompt / yolo_mode 有意不消费：
        // jcode TUI 没有对应的启动面（见模块头），静默丢弃好过启动即崩。

        let (command, args) = ctx.resolve_launch("jcode", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "jcode: building command"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: Vec::new(),
            env_inject,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context(provider: Option<crate::CliProvider>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "session-1".to_string(),
            project_path: "C:\\project".to_string(),
            workspace_path: None,
            provider,
            executable_override: Some("jcode-test".to_string()),
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: false,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
        }
    }

    fn provider(provider_type: &str) -> crate::CliProvider {
        crate::CliProvider {
            id: "managed-provider".to_string(),
            name: "Managed Provider".to_string(),
            provider_type: provider_type.to_string(),
            api_key: Some("managed-secret".to_string()),
            base_url: Some("https://gateway.example.com/anthropic".to_string()),
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            codex_wire_api: None,
            is_default: false,
        }
    }

    #[test]
    fn native_launch_only_pins_no_update_and_ignores_unsupported_inputs() {
        let mut ctx = context(None);
        ctx.yolo_mode = true;
        ctx.append_system_prompt = Some("Follow the repository instructions".to_string());
        ctx.initial_prompt = Some("Inspect the issue".to_string());

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.command, "jcode-test");
        // TUI 不接受位置参数 prompt / system prompt / yolo，全部静默忽略
        assert_eq!(result.args, vec!["--no-update"]);
        assert!(result.env_inject.is_empty());
        assert!(result.env_remove.is_empty());
    }

    #[test]
    fn managed_anthropic_provider_pins_api_channel_without_leaking_credentials() {
        let mut ctx = context(Some(provider("anthropic")));
        ctx.adapter_options
            .insert("__ccpanesModelId".to_string(), json!("claude-sonnet-4-6"));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec![
                "--no-update",
                "--provider",
                "anthropic-api",
                "--model",
                "claude-sonnet-4-6"
            ]
        );
        // 凭证由启动核心的通用 Provider env 注入，适配器不得重复注入，
        // 更不能出现在命令行
        assert!(!result.env_inject.contains_key("ANTHROPIC_API_KEY"));
        assert!(!result.args.iter().any(|arg| arg.contains("managed-secret")));
    }

    #[test]
    fn proxy_provider_also_pins_anthropic_api_channel() {
        let ctx = context(Some(provider("proxy")));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert!(result
            .args
            .windows(2)
            .any(|pair| pair == ["--provider", "anthropic-api"]));
    }

    #[test]
    fn unrelated_provider_type_does_not_pin_channel() {
        let ctx = context(Some(provider("open_ai")));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.args, vec!["--no-update"]);
    }

    #[test]
    fn effort_option_maps_to_reasoning_effort_env() {
        let mut ctx = context(None);
        ctx.adapter_options
            .insert("effort".to_string(), json!("xhigh"));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result
                .env_inject
                .get(JCODE_ANTHROPIC_EFFORT_ENV)
                .map(String::as_str),
            Some("xhigh")
        );
        assert_eq!(
            result
                .env_inject
                .get(JCODE_OPENAI_EFFORT_ENV)
                .map(String::as_str),
            Some("xhigh")
        );
    }

    #[test]
    fn invalid_effort_value_is_dropped() {
        let mut ctx = context(None);
        ctx.adapter_options
            .insert("effort".to_string(), json!("turbo"));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert!(result.env_inject.is_empty());
    }

    #[test]
    fn resume_id_and_extra_args_pass_through() {
        let mut ctx = context(None);
        ctx.resume_id = Some("session_fox_123_abc".to_string());
        ctx.adapter_options
            .insert("extraArgs".to_string(), json!(["--quiet"]));

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec!["--no-update", "--resume", "session_fox_123_abc", "--quiet"]
        );
    }

    #[test]
    fn blank_resume_id_is_ignored() {
        let mut ctx = context(None);
        ctx.resume_id = Some("   ".to_string());

        let result = JcodeAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.args, vec!["--no-update"]);
    }

    #[test]
    fn capabilities_match_current_integration_surface() {
        let adapter = JcodeAdapter::new();
        let info = adapter.info();
        assert_eq!(info.id, "jcode");
        assert_eq!(info.executable, "jcode");
        assert_eq!(info.version_args, vec!["--version".to_string()]);

        let caps = adapter.capabilities();
        assert!(caps.supports_provider);
        assert!(caps.supports_effort_option);
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
        assert!(!caps.supports_verbose_option);
        assert!(!caps.supports_max_turns_option);
        assert!(!adapter.can_report_task_result());
        assert_eq!(caps.compatible_provider_types, vec!["anthropic", "proxy"]);
    }

    #[test]
    fn skills_land_in_jcode_home_with_native_skill_mode() {
        let adapter = JcodeAdapter::new();
        assert_eq!(
            adapter.global_skills_dir(),
            dirs::home_dir().map(|home| home.join(".jcode").join("skills"))
        );
        assert_eq!(
            adapter.skill_delivery_modes(),
            vec![crate::SkillDeliveryMode::NativeSkill]
        );
        assert!(adapter.global_commands_dir().is_none());
    }
}
