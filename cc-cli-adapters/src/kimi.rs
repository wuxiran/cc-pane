//! Kimi CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: false,
                // 项目级 `.kimi-code/mcp.json` 收据驱动注入（docs/110 批 2）
                supports_mcp: true,
                supports_system_prompt: false,
                supports_workspace: true,
                supports_project_hooks: false,
                supports_issued_session_id: false,
                supports_rpc: false,
                supports_structured_result: false,
                // `--yolo`：老 kimi-cli = 全部自动批准；Kimi Code = Ask When Needed
                // （例行操作自动，危险命令仍确认）。Kimi Code 的全自动是 `--auto`
                // （0.5.0+），老版没有该 flag，传了会启动失败，故统一用 `--yolo`。
                supports_yolo: true,
                supports_orchestrated_launch: false,
                // build_command 不消费任何 per-launch 参数键
                supports_effort_option: false,
                supports_verbose_option: false,
                supports_max_turns_option: false,
                compatible_provider_types: vec!["kimi".into()],
            },
        }
    }

    /// 托管 Provider（Kimi Code，moonshotai.github.io/kimi-code/en/configuration/env-vars）：
    /// `KIMI_MODEL_NAME` 设了就在内存里合成一个临时 provider + 模型别名，不写回 `config.toml`，
    /// 优先级高于 `default_model`。这是 Kimi Code 唯一按次启动指定凭证的通道——它没有
    /// `--config-file`（那是已归档的 Python 版 kimi-cli 的参数，传给 Kimi Code 会直接报错退出），
    /// 普通 `KIMI_API_KEY` 也不会被读（overrides.md「Provider credentials」）。
    ///
    /// `KIMI_MODEL_NAME` 是必填的开关，所以托管模式必须选了模型；没选就拒绝启动并说明原因，
    /// 不静默退回用户自己的登录态（那会让会话用错账号）。
    fn managed_provider_env(ctx: &CliAdapterContext) -> Result<Option<HashMap<String, String>>> {
        let Some(provider) = ctx.provider.as_ref() else {
            return Ok(None);
        };
        if provider.provider_type != "kimi" {
            return Ok(None);
        }
        let Some(api_key) = provider
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        else {
            return Ok(None);
        };
        let Some(model) = ctx.model_id() else {
            return Err(anyhow!(
                "Kimi Code needs a model for a managed Provider (KIMI_MODEL_NAME); choose a model in the launch profile"
            ));
        };
        let base_url = provider
            .base_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or(DEFAULT_KIMI_BASE_URL);
        Ok(Some(HashMap::from([
            ("KIMI_MODEL_NAME".to_string(), model.to_string()),
            ("KIMI_MODEL_API_KEY".to_string(), api_key.to_string()),
            ("KIMI_MODEL_PROVIDER_TYPE".to_string(), "kimi".to_string()),
            ("KIMI_MODEL_BASE_URL".to_string(), base_url.to_string()),
        ])))
    }
}

/// 技能挂载（docs/110 批 1）。Kimi Code `--skills-dir <dir>` 可重复，但会**替换**自动发现的
/// 用户级与项目级目录（moonshotai.github.io/kimi-code/en/reference/kimi-command）。所以有挂载时
/// 把它本来会扫的默认目录（存在的）连同挂载目录一起显式传入：项目级 `.kimi-code/skills`、
/// `.agents/skills`（项目根 = 向上最近的含 `.git` 的目录），用户级 `$KIMI_CODE_HOME/skills`
/// （默认 `~/.kimi-code/skills`）、`~/.agents/skills`（kimi-code/en/customization/skills）。
fn push_skills_dir_args(args: &mut Vec<String>, ctx: &CliAdapterContext) {
    let mounts = crate::skill_mounts::mount_skill_roots(&ctx.skill_mount_paths);
    if mounts.is_empty() {
        return;
    }
    let mut dirs = kimi_default_skill_dirs(Path::new(ctx.project_path.trim()));
    for mount in mounts {
        if !dirs.contains(&mount) {
            dirs.push(mount);
        }
    }
    for dir in dirs {
        args.push("--skills-dir".to_string());
        args.push(dir.to_string_lossy().into_owned());
    }
}

fn kimi_default_skill_dirs(project_path: &Path) -> Vec<PathBuf> {
    let project_root = project_path
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(project_path);
    let kimi_home = std::env::var_os("KIMI_CODE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".kimi-code")));
    let mut candidates = Vec::new();
    if !project_root.as_os_str().is_empty() {
        candidates.push(project_root.join(".kimi-code").join("skills"));
        candidates.push(project_root.join(".agents").join("skills"));
    }
    candidates.extend(kimi_home.map(|home| home.join("skills")));
    candidates.extend(dirs::home_dir().map(|home| home.join(".agents").join("skills")));
    candidates.into_iter().filter(|dir| dir.is_dir()).collect()
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

    /// docs/110：
    /// - MCP（批 2）：项目级 `.kimi-code/mcp.json`，同项目会话共享；ccpanes 经 ctl stdio 代理，
    ///   launchId 来自各会话自己的环境变量（文件里没有身份也没有 token）；远程 HTTP / SSE 带请求头
    ///   （请求头是字面值，文件已排除出 git）；隔离只能声明。
    /// - 技能（批 1）：`--skills-dir`；没有会话提示词通道。WSL / SSH 只能裸启动。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        let mut profile = InjectionProfile::unsupported();
        profile.mcp = project_file_mcp(true, true, vec![McpTransport::Sse]);
        profile.skills.mount = SkillMount::SkillsDir;
        profile
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let mut args = Vec::new();
        let managed_env = Self::managed_provider_env(ctx)?;

        if let Some(workspace_path) = ctx.workspace_path.as_deref() {
            if workspace_path != ctx.project_path {
                args.push("--add-dir".to_string());
                args.push(ctx.project_path.clone());
            }
        }

        // 托管时模型已由 `KIMI_MODEL_NAME` 合成为临时别名；`-m` 优先级更高，再传会去找一个
        // 用户 config 里未必存在的别名。
        if managed_env.is_none() {
            crate::push_model_arg(&mut args, ctx);
        }

        if ctx.yolo_mode {
            args.push("--yolo".to_string());
        }
        push_skills_dir_args(&mut args, ctx);

        if let Some(prompt) = ctx.initial_prompt.as_ref() {
            args.push(prompt.clone());
        }

        let mut env_inject = managed_env.unwrap_or_default();
        // MCP（docs/110 批 2）：Kimi Code 没有按次启动的 MCP 参数，项目级 `.kimi-code/mcp.json`
        // 是唯一注入面（kimi-code/en/customization/mcp）。ccpanes 走 ctl stdio 代理（不展开环境
        // 变量，代理从继承的环境里拿实例与 launchId），代理不可用时 HTTP + `bearerTokenEnvVar`。
        let mcp = crate::project_mcp::sync_for_launch(
            ctx,
            &crate::project_mcp_dialects::KIMI,
            &crate::project_mcp::ccpanes_proxy_or_http(ctx),
        );
        if mcp.active {
            // 未信任的文件夹里项目级 MCP 不启用；`KIMI_CODE_TRUST_WORKSPACE=1` 让本进程信任工作区
            // （官方文档给 headless 用的开关）。与 cursor 适配器始终加 `--trust` 同口径。
            env_inject.insert("KIMI_CODE_TRUST_WORKSPACE".to_string(), "1".to_string());
        }
        env_inject.extend(mcp.env);

        let (command, args) = ctx.resolve_launch("kimi", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "kimi: building command"
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
                codex_wire_api: None,
                is_default: false,
            }),
            executable_override: None,
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
            data_dir,
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            shared_mcp_remote: Default::default(),
            hub_covered_mcp_servers: Vec::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
            adapter_options,
        }
    }

    #[test]
    fn yolo_mode_adds_kimi_yolo_flag_before_prompt() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(dir.path().to_path_buf(), HashMap::new());
        ctx.provider = None;
        ctx.executable_override = Some("kimi-test".to_string());
        ctx.initial_prompt = Some("hi".to_string());
        let adapter = KimiAdapter::new();
        assert!(!adapter
            .build_command(&ctx)
            .unwrap()
            .args
            .contains(&"--yolo".to_string()));

        ctx.yolo_mode = true;
        let args = adapter.build_command(&ctx).unwrap().args;
        let yolo = args.iter().position(|arg| arg == "--yolo").expect("--yolo");
        let prompt = args.iter().position(|arg| arg == "hi").expect("prompt");
        assert!(yolo < prompt);
        assert!(adapter.capabilities().supports_yolo);
    }

    fn env_of(ctx: &CliAdapterContext) -> HashMap<String, String> {
        KimiAdapter::new().build_command(ctx).unwrap().env_inject
    }

    /// Kimi Code 没有 `--config-file`；托管 Provider 走文档里的 `KIMI_MODEL_*`，不写配置文件、
    /// 不注入旧 CLI 的 `KIMI_SHARE_DIR`，也不再传 `--model`。
    #[test]
    fn managed_provider_uses_kimi_model_env_instead_of_config_file() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(
            dir.path().to_path_buf(),
            HashMap::from([("__ccpanesModelId".to_string(), json!("kimi-for-coding"))]),
        );
        ctx.executable_override = Some("kimi-test".to_string());
        let result = KimiAdapter::new().build_command(&ctx).unwrap();
        assert!(!result.args.iter().any(|arg| arg == "--config-file"));
        assert!(!result.args.iter().any(|arg| arg == "--model"));
        assert_eq!(result.env_inject["KIMI_MODEL_NAME"], "kimi-for-coding");
        assert_eq!(result.env_inject["KIMI_MODEL_API_KEY"], "test-key");
        assert_eq!(result.env_inject["KIMI_MODEL_PROVIDER_TYPE"], "kimi");
        assert_eq!(
            result.env_inject["KIMI_MODEL_BASE_URL"],
            DEFAULT_KIMI_BASE_URL
        );
        assert!(!result.env_inject.contains_key("KIMI_SHARE_DIR"));
        assert!(!result.args.iter().any(|arg| arg.contains("test-key")));
        assert!(!dir.path().join("cli-adapters").join("kimi").exists());
    }

    #[test]
    fn managed_provider_without_model_refuses_to_launch() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(dir.path().to_path_buf(), HashMap::new());
        ctx.executable_override = Some("kimi-test".to_string());
        let error = KimiAdapter::new().build_command(&ctx).err().expect("error");
        assert!(error.to_string().contains("KIMI_MODEL_NAME"));
    }

    #[test]
    fn native_provider_mode_injects_no_provider_env_and_keeps_model_flag() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(
            dir.path().to_path_buf(),
            HashMap::from([("__ccpanesModelId".to_string(), json!("my-alias"))]),
        );
        ctx.provider = None;
        ctx.executable_override = Some("kimi-test".to_string());
        let result = KimiAdapter::new().build_command(&ctx).unwrap();
        assert!(!env_of(&ctx)
            .keys()
            .any(|key| key.starts_with("KIMI_MODEL_")));
        let model = result
            .args
            .iter()
            .position(|arg| arg == "--model")
            .expect("--model");
        assert_eq!(result.args[model + 1], "my-alias");
    }
}
