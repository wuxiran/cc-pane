//! Kimi CLI 适配器

use crate::{
    atomic_file::write_atomic, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
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
                supports_mcp: false,
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

    fn write_session_config(&self, ctx: &CliAdapterContext) -> Result<Option<String>> {
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

        write_atomic(&config_path, serde_json::to_vec_pretty(&config)?)?;
        Ok(Some(config_path.to_string_lossy().into_owned()))
    }

    fn build_env_inject(&self, ctx: &CliAdapterContext) -> Result<HashMap<String, String>> {
        if ctx.provider.is_none() {
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

    /// docs/110：技能挂载经 `--skills-dir`（批 1）；没有会话提示词通道。WSL / SSH 只能裸启动。
    fn injection_profile(&self) -> crate::InjectionProfile {
        let mut profile = crate::InjectionProfile::unsupported();
        profile.skills.mount = crate::SkillMount::SkillsDir;
        profile
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
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

        crate::push_model_arg(&mut args, ctx);

        if ctx.yolo_mode {
            args.push("--yolo".to_string());
        }
        push_skills_dir_args(&mut args, ctx);

        if let Some(prompt) = ctx.initial_prompt.as_ref() {
            args.push(prompt.clone());
        }

        let env_inject = self.build_env_inject(ctx)?;

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

    #[test]
    fn native_provider_mode_does_not_write_generated_provider_config() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(dir.path().to_path_buf(), HashMap::new());
        ctx.provider = None;
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
    fn native_provider_mode_does_not_inject_isolated_share_dir() {
        let dir = tempdir().unwrap();
        let mut ctx = context_with_options(dir.path().to_path_buf(), HashMap::new());
        ctx.provider = None;
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

    #[test]
    fn explicit_managed_provider_wins_over_legacy_native_option() {
        let dir = tempdir().unwrap();
        let ctx = context_with_options(
            dir.path().to_path_buf(),
            HashMap::from([("kimiConfigMode".to_string(), json!("native"))]),
        );
        let adapter = KimiAdapter::new();

        assert!(adapter.write_session_config(&ctx).unwrap().is_some());
        assert!(adapter
            .build_env_inject(&ctx)
            .unwrap()
            .contains_key("KIMI_SHARE_DIR"));
    }
}
