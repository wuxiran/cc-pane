//! Google Antigravity CLI（`agy`）适配器：检测 + 启动 + 交互会话 + Gemini 类型供应商
//!
//! 事实来源：官方仓库 google-antigravity/antigravity-cli 的 README / install 脚本，以及
//! **2026-11-22 用 agy 1.5.14 实测**（`agy --help`、`agy help acp`、`agy changelog`、安装包内置
//! 的 `builtin/skills/agy-customizations/docs`，临时 HOME / 临时 `--gemini_dir` 下真实启动）：
//! - 安装：Unix 落 `~/.local/bin/agy`（已在 `home_fallback_cli_dirs` 兜底探测）；
//!   Windows 落 `%LOCALAPPDATA%\agy\bin\agy.exe`（见 `windows_user_cli_dirs`）。
//! - `--version` 打印 `1.5.14`；无参 `agy` 直接进 TUI，没登录时停在「Select login method」。
//! - `--dangerously-skip-permissions` → YOLO；`-i, --prompt-interactive <prompt>` 带初始 prompt
//!   进交互会话（`-p` 是 headless print，跑完即退，**不能**当初始 prompt）；
//!   `--conversation <id>` 续接会话（未知 id 只警告 `conversation ... not found` 并照常启动）。
//!   cc-pane 没有 agy 会话 id 的捕获来源，`supports_resume` 保持 false。
//! - `--add-dir <dir>`：把目录加进工作区（日志 `workspaceDirs=[项目, staging]`）。
//! - `--settings <json|文件>`：本次会话的设置，不落盘。
//! - 数据目录：一律 `$HOME/.gemini`（`config/`、`antigravity-cli/` 含会话历史与日志）。
//!   **`GEMINI_HOME`、`ANTIGRAVITY_GEMINI_DIR`、`ANTIGRAVITY_APP_DATA_DIR` 都不认**；能换目录的
//!   只有 `--help` 不列的 `--gemini_dir <目录>`（交互界面和 `agy acp` 都认，下划线写法）。
//! - 登录：`agy acp --login`（顶层 `agy --login` 报 `flags provided but not defined`），打印
//!   Google 登录链接，等用户贴回授权码。带 `SSH_CONNECTION` 时日志为
//!   "Using file-based token storage because SSH session detected"（不进钥匙串）。
//!
//! 供应商（只接 `gemini` 类型）：
//! - 登录账号 → `--gemini_dir <账号目录>`（+ 通用环境变量层的 `SSH_CONNECTION`）。
//! - 密钥账号 → `GEMINI_API_KEY`（通用环境变量层注入）+ `--settings {"modelProvider":"gemini"}`。
//!   只给环境变量不够：agy 仍要求登录（"Auth mode is unspecified"）；加上设置后日志为
//!   "ChainedAuth: authenticated via gemini_api_key"，请求直达 generativelanguage.googleapis.com。
//!   自定义地址用 `GOOGLE_GEMINI_BASE_URL`（CHANGELOG）。
//! - 默认登录 → 不加参数，用 agy 自己在 `~/.gemini` 里的登录。
//!
//! 仍然不接：
//! - `--model` / `--effort`：模型 id 来自 agy 自己的目录（`agy models`），透传不受支持的值可能让
//!   启动直接失败。
//! - 会话历史索引（`<gemini 目录>/antigravity-cli/conversations/<uuid>.db`）、hooks、
//!   `--append-system-prompt` 类能力（agy 无对应 flag）。
//! - MCP：工作区 `.agents/mcp_config.json`（见 build_command；1.5.14 实测会拉起其中的 stdio
//!   server，尽管内置文档只写了 `~/.gemini/config/mcp_config.json` 与插件）。
//! - ACP：agy 原生提供 `agy acp`，已在「对 agent 说」引擎表登记（src-tauri
//!   acp_chat_commands.rs），与本适配器的终端启动面无关。

use crate::{
    extra_args_from_options, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
use tracing::info;

/// 可执行文件名（官方安装器的落盘名，Windows 为 `agy.exe`）。
pub const ANTIGRAVITY_EXECUTABLE: &str = "agy";
/// YOLO：自动批准全部工具权限请求（官方 CLI reference 的 command-line flags）。
pub const ANTIGRAVITY_YOLO_FLAG: &str = "--dangerously-skip-permissions";
/// 带初始 prompt 的交互启动（`-i` 的长写法）。
pub const ANTIGRAVITY_INITIAL_PROMPT_FLAG: &str = "--prompt-interactive";
/// 按 id 续接会话。
pub const ANTIGRAVITY_RESUME_FLAG: &str = "--conversation";
/// 换掉 `~/.gemini`（整套设置、登录凭据、会话历史）的目录。`--help` 里不列，但交互界面和
/// `agy acp` 都认（1.5.14 实测：只有下划线写法，`--gemini-dir` 在顶层报未定义）。
/// `GEMINI_HOME` / `ANTIGRAVITY_GEMINI_DIR` 等环境变量 agy 都不读。
pub const ANTIGRAVITY_GEMINI_DIR_FLAG: &str = "--gemini_dir";
/// 本次会话的临时设置（不落盘）。
pub const ANTIGRAVITY_SETTINGS_FLAG: &str = "--settings";
/// 密钥账号：agy 只有在 `modelProvider = "gemini"` 时才用 `GEMINI_API_KEY`（CHANGELOG：
/// "Set `modelProvider: \"gemini\"` in settings.json, export `GEMINI_API_KEY`"）；只设环境变量
/// 会停在登录方式选择页（1.5.14 实测）。经 `--settings` 传，不改用户的 settings.json。
pub const ANTIGRAVITY_API_KEY_SETTINGS: &str = r#"{"modelProvider":"gemini"}"#;

/// 供应商账号对应的 agy 参数（本机与 WSL 启动共用）：
/// - 登录账号（`config_dir` 有值）→ `--gemini_dir <账号目录>`；
/// - 密钥账号（有 `api_key`）→ `--settings {"modelProvider":"gemini"}`，密钥本身由通用环境变量层
///   以 `GEMINI_API_KEY` 注入；
/// - 默认登录 / 没有供应商 → 不加参数，用 agy 自己的登录。
pub fn antigravity_provider_args(provider: Option<&crate::CliProvider>) -> Vec<String> {
    let Some(provider) = provider else {
        return Vec::new();
    };
    if let Some(dir) = provider
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty() && !std::path::Path::new(dir).is_file())
    {
        return vec![ANTIGRAVITY_GEMINI_DIR_FLAG.to_string(), dir.to_string()];
    }
    if provider
        .api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty())
    {
        return vec![
            ANTIGRAVITY_SETTINGS_FLAG.to_string(),
            ANTIGRAVITY_API_KEY_SETTINGS.to_string(),
        ];
    }
    Vec::new()
}

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
                // 只接 Gemini 类型供应商（见模块头）：登录账号 `--gemini_dir`，
                // 密钥账号 `GEMINI_API_KEY` + `--settings {"modelProvider":"gemini"}`。
                supports_provider: true,
                // --conversation 已接线，但没有 resume id 来源
                supports_resume: false,
                // 工作区 `.agents/mcp_config.json` 收据驱动注入（docs/110 批 2）
                supports_mcp: true,
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
                compatible_provider_types: vec!["gemini".into()],
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

    /// docs/110：
    /// - MCP（批 2）：工作区 `.agents/mcp_config.json`，同项目会话共享；ccpanes 经 ctl stdio 代理
    ///   （launchId 来自各会话环境变量）；远程只有 Streamable HTTP（`serverUrl`），请求头为字面值；
    ///   隔离只能声明。
    /// - 技能（批 1）：每会话 staging 的 `--add-dir`；没有会话提示词通道。WSL / SSH 只能裸启动。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        let mut profile = InjectionProfile::unsupported();
        profile.mcp = project_file_mcp(true, true, vec![]);
        profile.skills.mount = SkillMount::AddDir;
        profile
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let mut args = Vec::new();

        // 供应商账号：登录账号换 `~/.gemini`，密钥账号打开 Gemini API 直连（见上）。
        args.extend(antigravity_provider_args(ctx.provider.as_ref()));

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

        // 技能挂载（docs/110 批 1）：`--add-dir` 把目录加进工作区（antigravity.google/docs/cli/
        // reference），agy 读每个工作区根下的 `.agents/skills/<name>/`（docs/skills），故 staging
        // 里摆一份 `.agents/skills`。
        let layout = crate::skill_mounts::StagingLayout {
            cursor_plugin: false,
            agents_skills: true,
        };
        if let Some(staging) = crate::skill_mounts::stage_session_skills(
            &ctx.data_dir,
            &ctx.session_id,
            &ctx.skill_mount_paths,
            layout,
        ) {
            args.push("--add-dir".to_string());
            args.push(staging.to_string_lossy().into_owned());
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

        // model / effort / append_system_prompt 有意不消费（见模块头），
        // 静默忽略好过拼出 agy 不认的参数导致启动即崩。

        // MCP（docs/110 批 2）：工作区 `.agents/mcp_config.json`（antigravity.google/docs/mcp），
        // 远程用 `serverUrl`、不支持 SSE；文档未写环境变量展开，ccpanes 走 ctl stdio 代理。
        let mcp = crate::project_mcp::sync_for_launch(
            ctx,
            &crate::project_mcp_dialects::ANTIGRAVITY,
            &crate::project_mcp::ccpanes_proxy_or_http(ctx),
        );

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
            env_inject: mcp.env,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

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
            hub_covered_mcp_servers: Vec::new(),
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

    fn gemini_provider(config_dir: Option<&str>) -> crate::CliProvider {
        crate::CliProvider {
            id: "p-gemini".to_string(),
            name: "Gemini".to_string(),
            provider_type: "gemini".to_string(),
            api_key: config_dir.is_none().then(|| "AIza-test".to_string()),
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: config_dir.map(str::to_string),
            codex_wire_api: None,
            is_default: false,
        }
    }

    #[test]
    fn login_account_points_agy_at_its_directory_with_gemini_dir_flag() {
        let dir = tempfile::tempdir().unwrap();
        let account_dir = dir.path().to_string_lossy().into_owned();
        let mut ctx = context();
        ctx.provider = Some(gemini_provider(Some(&account_dir)));
        ctx.yolo_mode = true;

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec![
                "--gemini_dir".to_string(),
                account_dir,
                "--dangerously-skip-permissions".to_string()
            ]
        );
    }

    /// 密钥账号：`GEMINI_API_KEY` 由通用环境变量层注入，适配器只打开 Gemini API 直连。
    #[test]
    fn key_account_switches_model_provider_to_gemini_for_this_session() {
        let mut ctx = context();
        ctx.provider = Some(gemini_provider(None));

        let result = AntigravityAdapter::new().build_command(&ctx).unwrap();

        assert_eq!(
            result.args,
            vec!["--settings", r#"{"modelProvider":"gemini"}"#]
        );
        assert!(result.env_inject.is_empty());
    }

    /// 默认登录（没有目录、没有密钥）：不加参数，用 agy 自己的登录。
    #[test]
    fn default_login_adds_no_args() {
        let mut provider = gemini_provider(None);
        provider.api_key = None;
        assert!(antigravity_provider_args(Some(&provider)).is_empty());
        assert!(antigravity_provider_args(None).is_empty());
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
        assert!(caps.supports_provider);
        assert!(!caps.supports_resume);
        // docs/110 批 2：工作区 `.agents/mcp_config.json` 注入
        assert!(caps.supports_mcp);
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
        assert_eq!(caps.compatible_provider_types, vec!["gemini".to_string()]);
        // 拿到了 ccpanes MCP（项目文件），可以回报结果
        assert!(adapter.can_report_task_result());
        assert!(adapter.global_skills_dir().is_none());
    }
}
