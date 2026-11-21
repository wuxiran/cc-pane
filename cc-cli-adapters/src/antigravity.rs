//! Google Antigravity CLI（`agy`）适配器 —— v1 最小接入：检测 + 启动 + 交互会话
//!
//! 事实来源（2026-11 核对官方仓库 google-antigravity/antigravity-cli 的 README /
//! CHANGELOG 1.5.14、install.sh / install.ps1 与 antigravity.google/docs/cli）：
//! - 安装：Unix 落 `~/.local/bin/agy`（已在 `home_fallback_cli_dirs` 兜底探测）；
//!   Windows 落 `%LOCALAPPDATA%\agy\bin\agy.exe`（见 `windows_user_cli_dirs`）。
//! - 无参 `agy` 直接进 TUI 交互会话；认证走系统 keyring / Google 登录（CLI 自管）。
//! - `--dangerously-skip-permissions`：自动批准全部工具权限请求 → YOLO。
//! - `-i, --prompt-interactive <prompt>`：带初始 prompt 进入交互会话（不退出）。
//!   注意 `-p` 是 headless print 模式，跑完即退，**不能**拿来当初始 prompt。
//! - `--conversation <id>`：按 id 续接历史会话。flag 已接线，但 cc-pane 没有
//!   agy 会话 id 的捕获来源，`supports_resume` 保持 false。
//! - 版本参数：官方文档未列出 `--version`，沿用通用 `--version` 探测；探测失败
//!   只会让版本号显示为空，不影响「已安装」判定（`detect` 只看可执行解析）。
//!
//! v1 有意不接（后续需实机验证再放开）：
//! - Provider 注入：agy 只认 Google 账号 / `GEMINI_API_KEY`（配合 settings.json 的
//!   `modelProvider`）/ ADC，与 CC-Panes Provider 模型没有稳定映射。
//! - `--model` / `--effort`：模型 id 来自 agy 自己的目录（`agy models`），effort
//!   档位「按模型而定」，透传不受支持的档位可能让启动直接失败。
//! - MCP 注入：agy 有自己的 MCP 管理（`/mcp`、插件 `mcp.json`），未接注入链。
//! - 会话历史 / resume id 捕获、hooks、技能目录、`--append-system-prompt` 类能力
//!   （agy 无对应 flag）。
//! - ACP：agy 原生提供 `agy acp`，已在「对 agent 说」引擎表登记（src-tauri
//!   acp_chat_commands.rs），与本适配器的终端启动面无关。

use crate::{
    extra_args_from_options, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
use std::collections::HashMap;
use tracing::info;

/// 可执行文件名（官方安装器的落盘名，Windows 为 `agy.exe`）。
pub const ANTIGRAVITY_EXECUTABLE: &str = "agy";
/// YOLO：自动批准全部工具权限请求（官方 CLI reference 的 command-line flags）。
pub const ANTIGRAVITY_YOLO_FLAG: &str = "--dangerously-skip-permissions";
/// 带初始 prompt 的交互启动（`-i` 的长写法）。
pub const ANTIGRAVITY_INITIAL_PROMPT_FLAG: &str = "--prompt-interactive";
/// 按 id 续接会话。
pub const ANTIGRAVITY_RESUME_FLAG: &str = "--conversation";

pub struct AntigravityAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl AntigravityAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "antigravity".into(),
                display_name: "Antigravity".into(),
                executable: ANTIGRAVITY_EXECUTABLE.into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                // v1 不接 Provider（见模块头）
                supports_provider: false,
                // --conversation 已接线，但没有 resume id 来源
                supports_resume: false,
                // v1 不接 MCP 注入
                supports_mcp: false,
                // agy 无 --append-system-prompt 类 flag
                supports_system_prompt: false,
                supports_workspace: false,
                supports_project_hooks: false,
                supports_issued_session_id: false,
                supports_rpc: false,
                supports_structured_result: false,
                // --dangerously-skip-permissions（官方文档明确）
                supports_yolo: true,
                // 编排启动链路未实机验证
                supports_orchestrated_launch: false,
                // --effort 档位按模型而定，v1 不透传（见模块头）
                supports_effort_option: false,
                supports_verbose_option: false,
                supports_max_turns_option: false,
                compatible_provider_types: Vec::new(),
            },
        }
    }
}

impl Default for AntigravityAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for AntigravityAdapter {
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
        let mut args = Vec::new();

        if let Some(resume_id) = ctx
            .resume_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push(ANTIGRAVITY_RESUME_FLAG.to_string());
            args.push(resume_id.to_string());
        }

        if ctx.yolo_mode {
            args.push(ANTIGRAVITY_YOLO_FLAG.to_string());
        }

        args.extend(extra_args_from_options(&ctx.adapter_options));

        if let Some(prompt) = ctx
            .initial_prompt
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push(ANTIGRAVITY_INITIAL_PROMPT_FLAG.to_string());
            args.push(prompt.to_string());
        }

        // provider / model / effort / append_system_prompt / MCP 有意不消费：
        // v1 未接（见模块头），静默忽略好过拼出 agy 不认的参数导致启动即崩。

        let (command, args) = ctx.resolve_launch(ANTIGRAVITY_EXECUTABLE, args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "antigravity: building command"
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
            project_path: "C:\\project".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: Some("agy-test".to_string()),
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: false,
            skip_ccpanes_mcp: false,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            shared_mcp_remote: Default::default(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
        }
    }

    #[test]
    fn bare_launch_enters_interactive_tui_without_args() {
        let result = AntigravityAdapter::new().build_command(&context()).unwrap();

        assert_eq!(result.command, "agy-test");
        assert!(result.args.is_empty());
        assert!(result.env_inject.is_empty());
        assert!(result.env_remove.is_empty());
    }

    #[test]
    fn yolo_maps_to_dangerously_skip_permissions() {
        let mut ctx = context();
        ctx.yolo_mode = true;

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(result.args, vec!["--dangerously-skip-permissions"]);
    }

    #[test]
    fn initial_prompt_uses_interactive_flag_not_headless_print() {
        let mut ctx = context();
        ctx.initial_prompt = Some("Inspect the issue".to_string());

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec!["--prompt-interactive", "Inspect the issue"]
        );
        assert!(
            !result
                .args
                .iter()
                .any(|arg| arg == "-p" || arg == "--print"),
            "-p is headless print mode and exits after one turn"
        );
    }

    #[test]
    fn blank_initial_prompt_is_ignored() {
        let mut ctx = context();
        ctx.initial_prompt = Some("   ".to_string());

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert!(result.args.is_empty());
    }

    #[test]
    fn unsupported_inputs_are_ignored() {
        let mut ctx = context();
        ctx.append_system_prompt = Some("Follow the repository instructions".to_string());
        ctx.adapter_options
            .insert("effort".to_string(), json!("high"));
        ctx.adapter_options
            .insert("__ccpanesModelId".to_string(), json!("some-model"));

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert!(result.args.is_empty());
        assert!(result.env_inject.is_empty());
    }

    #[test]
    fn resume_yolo_extra_args_and_prompt_keep_flag_order() {
        let mut ctx = context();
        ctx.resume_id = Some("conv-123".to_string());
        ctx.yolo_mode = true;
        ctx.initial_prompt = Some("continue".to_string());
        ctx.adapter_options
            .insert("extraArgs".to_string(), json!(["--sandbox"]));

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec![
                "--conversation",
                "conv-123",
                "--dangerously-skip-permissions",
                "--sandbox",
                "--prompt-interactive",
                "continue"
            ]
        );
    }

    #[test]
    fn blank_resume_id_is_ignored() {
        let mut ctx = context();
        ctx.resume_id = Some("   ".to_string());

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert!(result.args.is_empty());
    }

    #[test]
    fn capabilities_match_v1_integration_surface() {
        let adapter = AntigravityAdapter::new();
        let info = adapter.info();
        assert_eq!(info.id, "antigravity");
        assert_eq!(info.display_name, "Antigravity");
        assert_eq!(info.executable, "agy");
        assert_eq!(info.version_args, vec!["--version".to_string()]);

        let caps = adapter.capabilities();
        assert!(caps.supports_yolo);
        assert!(!caps.supports_provider);
        assert!(!caps.supports_resume);
        assert!(!caps.supports_mcp);
        assert!(!caps.supports_system_prompt);
        assert!(!caps.supports_workspace);
        assert!(!caps.supports_project_hooks);
        assert!(!caps.supports_issued_session_id);
        assert!(!caps.supports_rpc);
        assert!(!caps.supports_structured_result);
        assert!(!caps.supports_orchestrated_launch);
        assert!(!caps.supports_effort_option);
        assert!(!caps.supports_verbose_option);
        assert!(!caps.supports_max_turns_option);
        assert!(caps.compatible_provider_types.is_empty());
        assert!(!adapter.can_report_task_result());
        assert!(adapter.global_skills_dir().is_none());
    }
}
