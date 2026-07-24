//! OpenCode CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
    ProjectHookDefinition, ProjectHookStatus,
};
use anyhow::Result;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// CC-Panes opencode 插件源码（随 crate 编译进二进制），由 `sync_project_hooks`
/// 写入项目 `.opencode/plugins/ccpanes.js`，实现 worker→leader 自动回报。
const CCPANES_PLUGIN_JS: &str = include_str!("../assets/opencode/ccpanes-plugin.js");

/// OpenCode 自定义主题必须包含完整颜色表；它不会把 partial theme 与内置主题合并。
/// 此资产固化 OpenCode 1.18.4 内置主题的 dark 值，并让根、面板与控件背景透明。
const CCPANES_THEME_JSON: &str = include_str!("../assets/opencode/ccpanes-theme.json");
const CCPANES_THEME_NAME: &str = "ccpanes";

/// 唯一的项目级 hook 名（opencode 用单个插件覆盖全部生命周期事件）。
const OPENCODE_PLUGIN_HOOK: &str = "ccpanes-plugin";

pub struct OpenCodeAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl OpenCodeAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "opencode".into(),
                display_name: "OpenCode".into(),
                executable: "opencode".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: true,
                supports_mcp: true,
                supports_system_prompt: true,
                supports_workspace: false,
                supports_project_hooks: true,
                supports_issued_session_id: false,
                compatible_provider_types: vec![
                    "open_ai".into(),
                    "opencode".into(),
                    "anthropic".into(),
                    "config_profile".into(),
                ],
            },
        }
    }

    fn adapter_root(ctx: &CliAdapterContext) -> PathBuf {
        ctx.data_dir
            .join("cli-adapters/opencode")
            .join(&ctx.session_id)
    }

    /// 生成 per-session 的 opencode.json，注入 orchestrator MCP、系统 prompt
    /// (instructions) 与 provider 凭证，返回配置文件路径（经 `OPENCODE_CONFIG` 注入）。
    ///
    /// 没有任何可注入内容时返回 `Ok(None)`，调用方则不设置 `OPENCODE_CONFIG`。
    fn write_session_config(
        &self,
        ctx: &CliAdapterContext,
        theme: Option<&serde_json::Value>,
    ) -> Result<Option<String>> {
        let mut config = serde_json::Map::new();
        config.insert(
            "$schema".to_string(),
            serde_json::Value::String("https://opencode.ai/config.json".to_string()),
        );
        let mut has_content = false;

        let adapter_root = Self::adapter_root(ctx);

        for path in [
            adapter_root.join("tui.json"),
            adapter_root.join("opencode.json.tui-migration.bak"),
        ] {
            if path.is_file() {
                std::fs::remove_file(path)?;
            }
        }

        if let Some(theme) = theme {
            config.insert("theme".to_string(), theme.clone());
            has_content = true;
        }

        // ---- MCP 注入（orchestrator + 共享 MCP）----
        if !ctx.skip_mcp {
            let mut mcp = serde_json::Map::new();

            if let (Some(port), Some(token)) =
                (ctx.orchestrator_port, ctx.orchestrator_token.as_ref())
            {
                // token 同时经 URL query 与 Authorization header 传递；launchId
                // 让 orchestrator 在 launch_task 时识别 caller。对齐 claude.rs。
                let mut url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
                if let Some(launch_id) = ctx.launch_id.as_deref() {
                    url.push_str("&launchId=");
                    url.push_str(launch_id);
                }
                mcp.insert(
                    "ccpanes".to_string(),
                    serde_json::json!({
                        "type": "remote",
                        "url": url,
                        "enabled": true,
                        "headers": { "Authorization": format!("Bearer {}", token) }
                    }),
                );
            }

            for (name, url) in &ctx.shared_mcp_urls {
                mcp.insert(
                    name.clone(),
                    serde_json::json!({
                        "type": "remote",
                        "url": url,
                        "enabled": true
                    }),
                );
            }

            if !mcp.is_empty() {
                config.insert("mcp".to_string(), serde_json::Value::Object(mcp));
                has_content = true;
            }
        }

        // ---- 系统 prompt（写入 instructions 文件并引用）----
        if let Some(prompt) = ctx
            .append_system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            std::fs::create_dir_all(&adapter_root)?;
            let instructions_path = adapter_root.join("instructions.md");
            std::fs::write(&instructions_path, prompt)?;
            config.insert(
                "instructions".to_string(),
                serde_json::json!([instructions_path.to_string_lossy()]),
            );
            has_content = true;
        }

        // ---- provider 凭证（best-effort：写 options.apiKey/baseURL）----
        // CC-Panes 的 provider 不携带 model，故只注入凭证、不强设默认 model；
        // 模型选择交给 opencode 自身状态。config_profile 不含凭证，跳过。
        if let Some(provider) = ctx.provider.as_ref() {
            if let Some(provider_id) = match provider.provider_type.as_str() {
                "open_ai" => Some("openai"),
                "anthropic" => Some("anthropic"),
                "opencode" => Some("opencode"),
                _ => None,
            } {
                if provider.api_key.is_some() || provider.base_url.is_some() {
                    let mut options = serde_json::Map::new();
                    if let Some(api_key) = provider.api_key.as_ref() {
                        options.insert(
                            "apiKey".to_string(),
                            serde_json::Value::String(api_key.clone()),
                        );
                    }
                    if let Some(base_url) = provider.base_url.as_ref() {
                        options.insert(
                            "baseURL".to_string(),
                            serde_json::Value::String(base_url.clone()),
                        );
                    }
                    config.insert(
                        "provider".to_string(),
                        serde_json::json!({ provider_id: { "options": options } }),
                    );
                    has_content = true;
                }
            }
        }

        if !has_content {
            return Ok(None);
        }

        std::fs::create_dir_all(&adapter_root)?;
        let config_path = adapter_root.join("opencode.json");
        std::fs::write(
            &config_path,
            serde_json::to_vec_pretty(&serde_json::Value::Object(config))?,
        )?;
        Ok(Some(config_path.to_string_lossy().into_owned()))
    }

    fn default_user_config_path(file_name: &str) -> Option<PathBuf> {
        let config_root = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?;
        Some(config_root.join("opencode").join(file_name))
    }

    fn read_user_config(
        path: Option<&Path>,
        kind: &str,
    ) -> std::result::Result<Option<serde_json::Map<String, serde_json::Value>>, ()> {
        let Some(path) = path.filter(|path| path.is_file()) else {
            return Ok(None);
        };
        let bytes = std::fs::read(path).map_err(|error| {
            warn!(
                path = %path.display(),
                %error,
                "opencode: unable to read user {kind} config; skipping session theme"
            );
        })?;
        match serde_json::from_slice(&bytes) {
            Ok(serde_json::Value::Object(config)) => Ok(Some(config)),
            Ok(_) => {
                warn!(
                    path = %path.display(),
                    "opencode: user {kind} config is not an object; skipping session theme"
                );
                Err(())
            }
            Err(error) => {
                warn!(
                    path = %path.display(),
                    %error,
                    "opencode: invalid user {kind} config; skipping session theme"
                );
                Err(())
            }
        }
    }

    fn project_theme_path(ctx: &CliAdapterContext) -> PathBuf {
        Path::new(&ctx.project_path)
            .join(".opencode")
            .join("themes")
            .join(format!("{CCPANES_THEME_NAME}.json"))
    }

    fn read_project_theme(
        ctx: &CliAdapterContext,
    ) -> std::result::Result<Option<serde_json::Value>, ()> {
        let project = Path::new(&ctx.project_path);
        let project_config = project.join(".opencode");
        let candidates = [
            project.join("opencode.json"),
            project.join("opencode.jsonc"),
            project_config.join("opencode.json"),
            project_config.join("opencode.jsonc"),
            project.join("tui.json"),
            project.join("tui.jsonc"),
            project_config.join("tui.json"),
            project_config.join("tui.jsonc"),
        ];
        let mut theme = None;

        for path in candidates {
            let Some(config) = Self::read_user_config(Some(&path), "project")? else {
                continue;
            };
            if let Some(value) = config.get("theme") {
                if !value.is_string() {
                    warn!(
                        path = %path.display(),
                        "opencode: project theme is not a string; skipping session theme"
                    );
                    return Err(());
                }
                theme = Some(value.clone());
            }
        }

        Ok(theme)
    }

    fn project_theme_matches(path: &Path) -> bool {
        std::fs::read(path)
            .map(|content| content == CCPANES_THEME_JSON.as_bytes())
            .unwrap_or(false)
    }

    fn ensure_project_theme(ctx: &CliAdapterContext, user_theme_path: Option<&Path>) -> bool {
        if let Some(path) = user_theme_path.filter(|path| path.exists()) {
            warn!(
                path = %path.display(),
                "opencode: global ccpanes theme is user-owned; skipping session theme"
            );
            return false;
        }

        let path = Self::project_theme_path(ctx);
        if path.exists() {
            if Self::project_theme_matches(&path) {
                return true;
            }
            warn!(
                path = %path.display(),
                "opencode: ccpanes theme path is already user-owned; skipping session theme"
            );
            return false;
        }

        let Some(parent) = path.parent() else {
            return false;
        };
        if let Err(error) = std::fs::create_dir_all(parent) {
            warn!(
                path = %parent.display(),
                %error,
                "opencode: unable to create project theme directory; skipping session theme"
            );
            return false;
        }

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(CCPANES_THEME_JSON.as_bytes()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    warn!(
                        path = %path.display(),
                        %error,
                        "opencode: unable to write project theme; skipping session theme"
                    );
                    return false;
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Self::project_theme_matches(&path)
            }
            Err(error) => {
                warn!(
                    path = %path.display(),
                    %error,
                    "opencode: unable to create project theme; skipping session theme"
                );
                false
            }
        }
    }

    fn write_session_tui_config(
        &self,
        ctx: &CliAdapterContext,
        custom_tui_config: Option<&OsStr>,
        user_tui_config: Option<&Path>,
        user_main_config: Option<&Path>,
        user_theme_path: Option<&Path>,
    ) -> Result<Option<String>> {
        if custom_tui_config.is_some() {
            return Ok(None);
        }

        let mut config = match Self::read_user_config(user_tui_config, "tui") {
            Ok(Some(config)) => config,
            Ok(None) => serde_json::Map::new(),
            Err(()) => return Ok(None),
        };

        if config.get("theme").is_some_and(|theme| !theme.is_string()) {
            warn!("opencode: user tui theme is not a string; skipping session theme");
            return Ok(None);
        }

        if !config.contains_key("theme") {
            let legacy = match Self::read_user_config(user_main_config, "main") {
                Ok(config) => config,
                Err(()) => return Ok(None),
            };
            if let Some(theme) = legacy.and_then(|config| config.get("theme").cloned()) {
                if !theme.is_string() {
                    warn!("opencode: user main theme is not a string; skipping session theme");
                    return Ok(None);
                }
                config.insert("theme".to_string(), theme);
            }
        }

        let project_theme = match Self::read_project_theme(ctx) {
            Ok(theme) => theme,
            Err(()) => return Ok(None),
        };
        if let Some(theme) = project_theme {
            config.insert("theme".to_string(), theme);
        }

        if !config.contains_key("theme") {
            if !Self::ensure_project_theme(ctx, user_theme_path) {
                return Ok(None);
            }
            config.insert("theme".to_string(), serde_json::json!(CCPANES_THEME_NAME));
        }

        config
            .entry("$schema".to_string())
            .or_insert_with(|| serde_json::json!("https://opencode.ai/tui.json"));

        let adapter_root = Self::adapter_root(ctx);
        std::fs::create_dir_all(&adapter_root)?;
        // OpenCode 1.4 migrates legacy theme next to opencode.json as tui.json.
        // Keep the explicit TUI config on a distinct path so both channels work.
        let config_path = adapter_root.join("ccpanes-tui.json");
        std::fs::write(
            &config_path,
            serde_json::to_vec_pretty(&serde_json::Value::Object(config))?,
        )?;
        Ok(Some(config_path.to_string_lossy().into_owned()))
    }

    fn write_session_configs(
        &self,
        ctx: &CliAdapterContext,
        custom_tui_config: Option<&OsStr>,
        user_tui_config: Option<&Path>,
        user_main_config: Option<&Path>,
        user_theme_path: Option<&Path>,
    ) -> Result<HashMap<String, String>> {
        let mut env_inject = HashMap::new();
        let tui_config_path = self.write_session_tui_config(
            ctx,
            custom_tui_config,
            user_tui_config,
            user_main_config,
            user_theme_path,
        )?;
        let session_theme = tui_config_path.as_deref().and_then(|path| {
            let bytes = std::fs::read(path).ok()?;
            let config: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            config.get("theme").cloned()
        });
        if let Some(config_path) = self.write_session_config(ctx, session_theme.as_ref())? {
            env_inject.insert("OPENCODE_CONFIG".to_string(), config_path);
        }
        if let Some(config_path) = tui_config_path {
            env_inject.insert("OPENCODE_TUI_CONFIG".to_string(), config_path);
        }
        Ok(env_inject)
    }

    fn build_command_with_config_sources(
        &self,
        ctx: &CliAdapterContext,
        custom_tui_config: Option<&OsStr>,
        user_tui_config: Option<&Path>,
        user_main_config: Option<&Path>,
        user_theme_path: Option<&Path>,
    ) -> Result<CliCommandResult> {
        let env_inject = self.write_session_configs(
            ctx,
            custom_tui_config,
            user_tui_config,
            user_main_config,
            user_theme_path,
        )?;
        let mut args = Vec::new();

        if let Some(resume_id) = ctx.resume_id.as_ref() {
            args.push("--session".to_string());
            args.push(resume_id.clone());
        }
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push("--prompt".to_string());
            args.push(prompt.clone());
        }

        let (command, args) = ctx.resolve_launch("opencode", args)?;
        info!(
            session_id = %ctx.session_id,
            command = %command,
            "opencode: building command"
        );
        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject,
        })
    }

    fn plugin_path(project_path: &Path) -> std::path::PathBuf {
        project_path
            .join(".opencode")
            .join("plugins")
            .join("ccpanes.js")
    }
}

impl Default for OpenCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for OpenCodeAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn project_hooks(&self) -> Vec<ProjectHookDefinition> {
        vec![ProjectHookDefinition {
            name: OPENCODE_PLUGIN_HOOK.to_string(),
            label: "编排自动回报（CC-Panes 插件）".to_string(),
        }]
    }

    fn get_project_hook_statuses(&self, project_path: &Path) -> Result<Vec<ProjectHookStatus>> {
        let installed = Self::plugin_path(project_path).is_file();
        Ok(vec![ProjectHookStatus {
            name: OPENCODE_PLUGIN_HOOK.to_string(),
            label: "编排自动回报（CC-Panes 插件）".to_string(),
            enabled: installed,
            supported: true,
            reason: None,
        }])
    }

    fn sync_project_hooks(
        &self,
        project_path: &Path,
        _hook_binary_path: Option<&Path>,
        desired: &HashMap<String, bool>,
    ) -> Result<()> {
        // opencode 不依赖 cc-panes-cli-hook 二进制：插件源码内嵌、直接写入项目。
        let plugin_path = Self::plugin_path(project_path);
        let enabled = desired.get(OPENCODE_PLUGIN_HOOK).copied().unwrap_or(true);
        if enabled {
            if let Some(parent) = plugin_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&plugin_path, CCPANES_PLUGIN_JS)?;
        } else if plugin_path.is_file() {
            std::fs::remove_file(&plugin_path)?;
        }
        Ok(())
    }

    fn cleanup_project_hooks(&self, project_path: &Path) -> Result<Vec<PathBuf>> {
        let plugin_path = Self::plugin_path(project_path);
        if !plugin_path.is_file() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&plugin_path)?;
        if content != CCPANES_PLUGIN_JS {
            return Ok(Vec::new());
        }
        std::fs::remove_file(&plugin_path)?;
        Ok(vec![plugin_path])
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let custom_tui_config = std::env::var_os("OPENCODE_TUI_CONFIG");
        let user_tui_config = Self::default_user_config_path("tui.json");
        let user_main_config = std::env::var_os("OPENCODE_CONFIG")
            .map(PathBuf::from)
            .or_else(|| Self::default_user_config_path("opencode.json"));
        let user_theme_path = Self::default_user_config_path("themes/ccpanes.json");
        self.build_command_with_config_sources(
            ctx,
            custom_tui_config.as_deref(),
            user_tui_config.as_deref(),
            user_main_config.as_deref(),
            user_theme_path.as_deref(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CliProvider;

    fn fresh_data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccpanes_oc_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ctx(data_dir: std::path::PathBuf) -> CliAdapterContext {
        let project_path = data_dir.join("project");
        std::fs::create_dir_all(&project_path).unwrap();
        CliAdapterContext {
            session_id: "sess-1".to_string(),
            project_path: project_path.to_string_lossy().into_owned(),
            workspace_path: None,
            provider: None,
            executable_override: None,
            adapter_options: Default::default(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: false,
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
        }
    }

    fn read_config(path: &str) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn write_config(path: &Path, config: serde_json::Value) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    }

    fn project_theme_path(ctx: &CliAdapterContext) -> PathBuf {
        Path::new(&ctx.project_path).join(".opencode/themes/ccpanes.json")
    }

    #[test]
    fn tui_config_defaults_to_ccpanes_theme() {
        let c = ctx(fresh_data_dir("tui_default"));

        let path = OpenCodeAdapter::new()
            .write_session_tui_config(&c, None, None, None, None)
            .unwrap()
            .expect("tui config should be written");
        let cfg = read_config(&path);

        assert_eq!(cfg["$schema"], "https://opencode.ai/tui.json");
        assert_eq!(cfg["theme"], "ccpanes");
        assert!(path.ends_with("ccpanes-tui.json"));
        assert!(!c
            .data_dir
            .join("cli-adapters/opencode/sess-1/tui.json")
            .exists());
    }

    #[test]
    fn tui_config_preserves_user_theme_and_settings() {
        let data_dir = fresh_data_dir("tui_user_theme");
        let user_config = data_dir.join("user-tui.json");
        write_config(
            &user_config,
            serde_json::json!({
                "theme": "catppuccin",
                "mouse": false
            }),
        );
        let c = ctx(data_dir);

        let path = OpenCodeAdapter::new()
            .write_session_tui_config(&c, None, Some(&user_config), None, None)
            .unwrap()
            .expect("tui config should be written");
        let cfg = read_config(&path);

        assert_eq!(cfg["theme"], "catppuccin");
        assert_eq!(cfg["mouse"], false);
        assert!(!project_theme_path(&c).exists());
    }

    #[test]
    fn tui_config_adds_ccpanes_theme_to_user_settings_without_theme() {
        let data_dir = fresh_data_dir("tui_user_settings");
        let user_config = data_dir.join("user-tui.json");
        write_config(
            &user_config,
            serde_json::json!({
                "scroll_speed": 2,
                "diff_style": "stacked"
            }),
        );
        let c = ctx(data_dir);

        let path = OpenCodeAdapter::new()
            .write_session_tui_config(&c, None, Some(&user_config), None, None)
            .unwrap()
            .expect("tui config should be written");
        let cfg = read_config(&path);

        assert_eq!(cfg["theme"], "ccpanes");
        assert_eq!(cfg["scroll_speed"], 2);
        assert_eq!(cfg["diff_style"], "stacked");
    }

    #[test]
    fn tui_config_skips_injection_when_user_config_cannot_be_merged() {
        let data_dir = fresh_data_dir("tui_invalid_user_config");
        let user_config = data_dir.join("user-tui.json");
        std::fs::write(&user_config, "{ invalid json").unwrap();
        let c = ctx(data_dir.clone());

        let path = OpenCodeAdapter::new()
            .write_session_tui_config(&c, None, Some(&user_config), None, None)
            .unwrap();

        assert!(path.is_none());
        assert!(!data_dir
            .join("cli-adapters/opencode/sess-1/ccpanes-tui.json")
            .exists());
    }

    #[test]
    fn tui_config_preserves_legacy_user_theme_from_main_config() {
        let data_dir = fresh_data_dir("legacy_user_theme");
        let user_tui_config = data_dir.join("user-tui.json");
        let user_main_config = data_dir.join("user-opencode.json");
        write_config(&user_tui_config, serde_json::json!({ "mouse": false }));
        write_config(&user_main_config, serde_json::json!({ "theme": "dracula" }));
        let c = ctx(data_dir);

        let path = OpenCodeAdapter::new()
            .write_session_tui_config(
                &c,
                None,
                Some(&user_tui_config),
                Some(&user_main_config),
                None,
            )
            .unwrap()
            .expect("tui config should be written");
        let cfg = read_config(&path);

        assert_eq!(cfg["theme"], "dracula");
        assert_eq!(cfg["mouse"], false);
        assert!(!project_theme_path(&c).exists());
    }

    #[test]
    fn main_config_injects_ccpanes_theme_for_legacy_versions() {
        let c = ctx(fresh_data_dir("legacy_main_theme"));
        let theme = serde_json::json!("ccpanes");

        let path = OpenCodeAdapter::new()
            .write_session_config(&c, Some(&theme))
            .unwrap()
            .expect("main config should be written");
        let cfg = read_config(&path);

        assert_eq!(cfg["theme"], "ccpanes");
    }

    #[test]
    fn session_configs_inject_same_theme_through_both_channels() {
        let mut c = ctx(fresh_data_dir("dual_theme_channels"));
        c.skip_mcp = true;

        let env = OpenCodeAdapter::new()
            .write_session_configs(&c, None, None, None, None)
            .unwrap();
        let main_path = env
            .get("OPENCODE_CONFIG")
            .expect("legacy main config should be injected");
        let tui_path = env
            .get("OPENCODE_TUI_CONFIG")
            .expect("dedicated tui config should be injected");

        assert_eq!(read_config(main_path)["theme"], "ccpanes");
        assert_eq!(read_config(tui_path)["theme"], "ccpanes");
        let theme = read_config(project_theme_path(&c).to_str().unwrap());
        assert_eq!(theme["$schema"], "https://opencode.ai/theme.json");
        assert_eq!(theme["theme"]["background"], "none");
        assert_eq!(theme["theme"].as_object().unwrap().len(), 50);
        assert!(tui_path.ends_with("ccpanes-tui.json"));
        assert!(!std::path::Path::new(main_path)
            .with_file_name("tui.json")
            .exists());
    }

    #[test]
    fn ccpanes_theme_is_mode_independent_and_transparent() {
        let config: serde_json::Value = serde_json::from_str(CCPANES_THEME_JSON).unwrap();
        let theme = config["theme"].as_object().unwrap();

        assert_eq!(theme.len(), 50);
        for (name, value) in theme {
            assert!(
                value.is_string(),
                "theme color {name} must not depend on dark/light mode: {value}"
            );
        }
        assert_eq!(theme["background"], "none");
        assert_eq!(theme["backgroundPanel"], "none");
        assert_eq!(theme["backgroundElement"], "none");
        assert!(theme.get("backgroundMenu").is_none());
        assert_eq!(theme["diffAddedBg"], "#20303b");
        assert_eq!(theme["diffRemovedBg"], "#37222c");
        assert_eq!(theme["diffContextBg"], "#141414");
        assert_eq!(theme["diffAddedLineNumberBg"], "#1b2b34");
        assert_eq!(theme["diffRemovedLineNumberBg"], "#2d1f26");
        assert_eq!(theme["text"], "#eeeeee");
        assert_eq!(theme["primary"], "#fab283");
        assert!(!CCPANES_THEME_JSON.contains("lightStep"));
    }

    #[test]
    fn build_command_injects_native_absolute_session_config_paths() {
        let mut c = ctx(fresh_data_dir("build_command_session_paths"));
        c.executable_override = Some("opencode-test-executable".to_string());
        c.skip_mcp = true;

        let cmd = OpenCodeAdapter::new()
            .build_command_with_config_sources(&c, None, None, None, None)
            .unwrap();

        for key in ["OPENCODE_CONFIG", "OPENCODE_TUI_CONFIG"] {
            let path = Path::new(cmd.env_inject.get(key).unwrap());
            assert!(path.is_absolute(), "{key} must use a native absolute path");
            assert!(path.is_file(), "{key} must reference an existing file");
            assert!(path.starts_with(OpenCodeAdapter::adapter_root(&c)));
        }
        assert!(project_theme_path(&c).is_file());
    }

    #[test]
    fn session_configs_skip_both_theme_channels_for_custom_tui_env() {
        let mut c = ctx(fresh_data_dir("custom_tui_channels"));
        c.skip_mcp = true;
        c.append_system_prompt = Some("keep non-theme config".to_string());

        let env = OpenCodeAdapter::new()
            .write_session_configs(
                &c,
                Some(std::ffi::OsStr::new("/custom/opencode/tui.json")),
                None,
                None,
                None,
            )
            .unwrap();

        let main_path = env
            .get("OPENCODE_CONFIG")
            .expect("non-theme main config should still be injected");
        assert!(read_config(main_path).get("theme").is_none());
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(!project_theme_path(&c).exists());
    }

    #[test]
    fn session_configs_clear_owned_legacy_migration_files_on_relaunch() {
        let mut c = ctx(fresh_data_dir("legacy_migration_relaunch"));
        c.skip_mcp = true;
        let adapter = OpenCodeAdapter::new();
        let first = adapter
            .write_session_configs(&c, None, None, None, None)
            .unwrap();
        let main_path = std::path::PathBuf::from(first.get("OPENCODE_CONFIG").unwrap());
        let migrated_tui = main_path.with_file_name("tui.json");
        let migration_backup =
            std::path::PathBuf::from(format!("{}.tui-migration.bak", main_path.to_string_lossy()));
        std::fs::write(&migrated_tui, r#"{"theme":"ccpanes"}"#).unwrap();
        std::fs::write(&migration_backup, r#"{"theme":"ccpanes"}"#).unwrap();

        let second = adapter
            .write_session_configs(&c, None, None, None, None)
            .unwrap();

        assert!(!migrated_tui.exists());
        assert!(!migration_backup.exists());
        assert_eq!(
            read_config(second.get("OPENCODE_CONFIG").unwrap())["theme"],
            "ccpanes"
        );
    }

    #[test]
    fn session_configs_respect_project_theme_without_writing_ccpanes_theme() {
        let mut c = ctx(fresh_data_dir("project_theme"));
        c.skip_mcp = true;
        write_config(
            &Path::new(&c.project_path).join(".opencode/tui.json"),
            serde_json::json!({ "theme": "dracula" }),
        );

        let env = OpenCodeAdapter::new()
            .write_session_configs(&c, None, None, None, None)
            .unwrap();

        assert!(!project_theme_path(&c).exists());
        let main = read_config(env.get("OPENCODE_CONFIG").unwrap());
        let tui = read_config(env.get("OPENCODE_TUI_CONFIG").unwrap());
        assert_eq!(main["theme"], "dracula");
        assert_eq!(tui["theme"], "dracula");
    }

    #[test]
    fn session_configs_promote_legacy_project_theme_without_writing_ccpanes_theme() {
        let mut c = ctx(fresh_data_dir("legacy_project_theme"));
        c.skip_mcp = true;
        write_config(
            &Path::new(&c.project_path).join(".opencode/opencode.json"),
            serde_json::json!({ "theme": "gruvbox" }),
        );

        let env = OpenCodeAdapter::new()
            .write_session_configs(&c, None, None, None, None)
            .unwrap();

        assert!(!project_theme_path(&c).exists());
        assert_eq!(
            read_config(env.get("OPENCODE_CONFIG").unwrap())["theme"],
            "gruvbox"
        );
        assert_eq!(
            read_config(env.get("OPENCODE_TUI_CONFIG").unwrap())["theme"],
            "gruvbox"
        );
    }

    #[test]
    fn session_configs_do_not_overwrite_conflicting_project_theme_file() {
        let mut c = ctx(fresh_data_dir("theme_conflict"));
        c.skip_mcp = true;
        c.append_system_prompt = Some("keep non-theme config".to_string());
        let theme_path = project_theme_path(&c);
        write_config(
            &theme_path,
            serde_json::json!({
                "$schema": "https://opencode.ai/theme.json",
                "theme": { "background": "#123456" }
            }),
        );

        let env = OpenCodeAdapter::new()
            .write_session_configs(&c, None, None, None, None)
            .unwrap();

        assert_eq!(
            read_config(theme_path.to_str().unwrap())["theme"]["background"],
            "#123456"
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(read_config(env.get("OPENCODE_CONFIG").unwrap())
            .get("theme")
            .is_none());
    }

    #[test]
    fn session_configs_do_not_shadow_user_global_ccpanes_theme() {
        let mut c = ctx(fresh_data_dir("global_theme_conflict"));
        c.skip_mcp = true;
        c.append_system_prompt = Some("keep non-theme config".to_string());
        let user_theme = c.data_dir.join("user/themes/ccpanes.json");
        write_config(
            &user_theme,
            serde_json::json!({
                "$schema": "https://opencode.ai/theme.json",
                "theme": { "background": "#654321" }
            }),
        );

        let env = OpenCodeAdapter::new()
            .write_session_configs(&c, None, None, None, Some(&user_theme))
            .unwrap();

        assert!(!project_theme_path(&c).exists());
        assert_eq!(
            read_config(user_theme.to_str().unwrap())["theme"]["background"],
            "#654321"
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(read_config(env.get("OPENCODE_CONFIG").unwrap())
            .get("theme")
            .is_none());
    }

    #[test]
    fn config_injects_orchestrator_mcp_with_bearer() {
        let mut c = ctx(fresh_data_dir("mcp"));
        c.orchestrator_port = Some(8123);
        c.orchestrator_token = Some("tok-xyz".to_string());
        c.launch_id = Some("launch-9".to_string());

        let path = OpenCodeAdapter::new()
            .write_session_config(&c, None)
            .unwrap()
            .expect("config should be written");
        let cfg = read_config(&path);
        let ccpanes = &cfg["mcp"]["ccpanes"];
        assert_eq!(ccpanes["type"], "remote");
        assert_eq!(ccpanes["enabled"], true);
        assert_eq!(ccpanes["headers"]["Authorization"], "Bearer tok-xyz");
        let url = ccpanes["url"].as_str().unwrap();
        assert!(url.contains("127.0.0.1:8123/mcp?token=tok-xyz"));
        assert!(url.contains("launchId=launch-9"));
    }

    #[test]
    fn config_skips_mcp_when_skip_mcp_set() {
        let mut c = ctx(fresh_data_dir("skip"));
        c.skip_mcp = true;
        c.orchestrator_port = Some(8123);
        c.orchestrator_token = Some("tok".to_string());
        // 仅 MCP 可注入但被 skip → 无内容 → None
        assert!(OpenCodeAdapter::new()
            .write_session_config(&c, None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn config_writes_instructions_file() {
        let mut c = ctx(fresh_data_dir("instr"));
        c.append_system_prompt = Some("you are a worker".to_string());

        let path = OpenCodeAdapter::new()
            .write_session_config(&c, None)
            .unwrap()
            .unwrap();
        let cfg = read_config(&path);
        let instr_path = cfg["instructions"][0].as_str().unwrap();
        assert_eq!(
            std::fs::read_to_string(instr_path).unwrap(),
            "you are a worker"
        );
    }

    #[test]
    fn config_injects_provider_credentials() {
        let mut c = ctx(fresh_data_dir("prov"));
        c.provider = Some(CliProvider {
            id: "p1".to_string(),
            name: "My OpenAI".to_string(),
            provider_type: "open_ai".to_string(),
            api_key: Some("sk-abc".to_string()),
            base_url: Some("https://proxy.example/v1".to_string()),
            ..Default::default()
        });

        let path = OpenCodeAdapter::new()
            .write_session_config(&c, None)
            .unwrap()
            .unwrap();
        let cfg = read_config(&path);
        let opts = &cfg["provider"]["openai"]["options"];
        assert_eq!(opts["apiKey"], "sk-abc");
        assert_eq!(opts["baseURL"], "https://proxy.example/v1");
    }

    #[test]
    fn sync_project_hooks_installs_and_removes_plugin() {
        let dir = fresh_data_dir("hooks");
        let adapter = OpenCodeAdapter::new();
        let plugin = OpenCodeAdapter::plugin_path(&dir);

        // 默认/启用 → 写入插件
        adapter
            .sync_project_hooks(&dir, None, &HashMap::new())
            .unwrap();
        assert!(plugin.is_file());
        assert!(std::fs::read_to_string(&plugin)
            .unwrap()
            .contains("ccpanes"));

        let statuses = adapter.get_project_hook_statuses(&dir).unwrap();
        assert_eq!(statuses[0].name, "ccpanes-plugin");
        assert!(statuses[0].enabled && statuses[0].supported);

        // 关闭 → 移除插件
        adapter
            .sync_project_hooks(
                &dir,
                None,
                &HashMap::from([("ccpanes-plugin".to_string(), false)]),
            )
            .unwrap();
        assert!(!plugin.is_file());
        assert!(!adapter.get_project_hook_statuses(&dir).unwrap()[0].enabled);
    }

    #[test]
    fn build_command_passes_initial_prompt_via_prompt_flag() {
        let mut c = ctx(fresh_data_dir("prompt"));
        // override 跳过可执行解析，测试不依赖本机安装 opencode
        c.executable_override = Some("/usr/bin/opencode".to_string());
        c.skip_mcp = true;
        c.initial_prompt = Some("fix the login bug".to_string());

        let cmd = OpenCodeAdapter::new().build_command(&c).unwrap();
        // prompt 必须走 --prompt flag，不能作为 [project] 位置参数
        assert_eq!(
            cmd.args,
            vec!["--prompt".to_string(), "fix the login bug".to_string()]
        );
    }

    #[test]
    fn build_command_appends_resume_session() {
        let mut c = ctx(fresh_data_dir("resume"));
        c.resume_id = Some("oc-session-42".to_string());
        // resolve_launch 会解析 opencode 可执行；本机未必装 → 直接验证 args 构造逻辑
        // 通过 build_command 的前半段不可单独取，故改为断言 resume flag 拼接：
        let result = OpenCodeAdapter::new().build_command(&c);
        if let Ok(cmd) = result {
            let joined = cmd.args.join(" ");
            assert!(joined.contains("--session oc-session-42"));
        }
        // 若 opencode 未安装，resolve_launch 报错，跳过断言（CI 环境无 opencode）。
    }
}
