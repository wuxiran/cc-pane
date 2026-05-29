//! Codex CLI 适配器

use crate::{
    CcPaneEvent, CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities,
    CliToolInfo, NativeHookBinding, ProjectHookDefinition, ProjectHookStatus, ToolKind,
    ToolMatcher,
};
use anyhow::{anyhow, Result};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::{env, fs};
use tracing::info;

const HOOK_BINARY_NAME: &str = "cc-panes-cli-hook";
const LEGACY_HOOK_BINARY_NAME: &str = "cc-panes-hook";
const TOOL_UNSUPPORTED_ON_WINDOWS: &str = "Codex project hooks are not supported on Windows.";
const DOT_CODEX_FILE_CONFLICT: &str =
    "Project root contains a file named .codex, so Codex project hooks cannot be configured.";
const PLAN_ARCHIVE_UNSUPPORTED: &str =
    "Codex does not support CC-Panes plan archive yet; only session-start is available.";
const CC_PANE_EVENT_UNSUPPORTED: &str =
    "Codex CLI does not expose this hook event yet. Only SessionStart and PostToolUse are usable.";

struct HookDef {
    name: &'static str,
    subcommand: &'static str,
    event: &'static str,
    matcher: &'static str,
    timeout: u32,
    label: &'static str,
    supported: bool,
    reason: Option<&'static str>,
}

const HOOK_DEFS: &[HookDef] = &[
    HookDef {
        name: "session-inject",
        subcommand: "session-init",
        event: "SessionStart",
        matcher: "startup|resume",
        timeout: 10,
        label: "Context Inject",
        supported: true,
        reason: None,
    },
    HookDef {
        name: "plan-archive",
        subcommand: "tool-after",
        event: "PostToolUse",
        matcher: "Bash",
        timeout: 5,
        label: "Plan Archive",
        supported: false,
        reason: Some(PLAN_ARCHIVE_UNSUPPORTED),
    },
];

pub struct CodexAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "codex".into(),
                display_name: "Codex CLI".into(),
                executable: "codex".into(),
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
                supports_workspace: true,
                supports_project_hooks: true,
                compatible_provider_types: vec!["open_ai".into(), "config_profile".into()],
            },
        }
    }

    fn is_simple_toml_key_segment(segment: &str) -> bool {
        !segment.is_empty()
            && segment
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    }

    fn format_toml_key_segment_for_cli(segment: &str) -> String {
        if Self::is_simple_toml_key_segment(segment) {
            segment.to_string()
        } else {
            serde_json::to_string(segment).unwrap_or_else(|_| {
                format!("\"{}\"", segment.replace('\\', "\\\\").replace('"', "\\\""))
            })
        }
    }

    fn format_toml_string_for_cli(value: &str) -> String {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
    }

    fn push_mcp_url_override(args: &mut Vec<String>, name: &str, url: &str) {
        args.push("-c".to_string());
        args.push(format!(
            "mcp_servers.{}.url={}",
            Self::format_toml_key_segment_for_cli(name),
            Self::format_toml_string_for_cli(url)
        ));
    }

    fn push_mcp_bearer_env_override(args: &mut Vec<String>, name: &str, env_var: &str) {
        args.push("-c".to_string());
        args.push(format!(
            "mcp_servers.{}.bearer_token_env_var={}",
            Self::format_toml_key_segment_for_cli(name),
            Self::format_toml_string_for_cli(env_var)
        ));
    }

    fn push_mcp_enabled_override(args: &mut Vec<String>, name: &str, enabled: bool) {
        args.push("-c".to_string());
        args.push(format!(
            "mcp_servers.{}.enabled={}",
            Self::format_toml_key_segment_for_cli(name),
            enabled
        ));
    }

    fn push_developer_instructions_override(args: &mut Vec<String>, prompt: &str) {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return;
        }
        args.push("-c".to_string());
        args.push(format!(
            "developer_instructions={}",
            Self::format_toml_string_for_cli(prompt)
        ));
    }

    fn push_yolo_mode_arg(args: &mut Vec<String>) {
        args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
    }

    fn push_mcp_overrides(&self, args: &mut Vec<String>, ctx: &CliAdapterContext) {
        if let (Some(port), Some(token)) = (ctx.orchestrator_port, ctx.orchestrator_token.as_ref())
        {
            let mut url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
            if let Some(launch_id) = ctx.launch_id.as_deref() {
                url.push_str("&launchId=");
                url.push_str(launch_id);
            }
            Self::push_mcp_url_override(args, "ccpanes", &url);
            Self::push_mcp_bearer_env_override(args, "ccpanes", "CC_PANES_API_TOKEN");
            Self::push_mcp_enabled_override(args, "ccpanes", true);
        }

        for (name, url) in &ctx.shared_mcp_urls {
            Self::push_mcp_url_override(args, name, url);
        }

        info!(
            session_id = %ctx.session_id,
            shared_mcp = ctx.shared_mcp_urls.len(),
            "codex: MCP configured via per-launch CLI overrides"
        );
    }

    fn configured_mcp_server_names_from_config_path(path: &Path) -> BTreeSet<String> {
        let Ok(content) = fs::read_to_string(path) else {
            return BTreeSet::new();
        };
        let Ok(root) = content.parse::<toml::Value>() else {
            return BTreeSet::new();
        };
        root.get("mcp_servers")
            .and_then(toml::Value::as_table)
            .map(|servers| servers.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn configured_mcp_server_names() -> BTreeSet<String> {
        let Some(home) = dirs::home_dir() else {
            return BTreeSet::new();
        };
        Self::configured_mcp_server_names_from_config_path(&home.join(".codex").join("config.toml"))
    }

    fn real_codex_home() -> Option<PathBuf> {
        env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
    }

    fn isolated_codex_home(session_id: &str) -> Option<PathBuf> {
        dirs::home_dir().map(|home| {
            home.join(".cache")
                .join("cc-panes")
                .join("codex-home")
                .join(session_id)
        })
    }

    fn sanitized_config_toml(content: &str) -> String {
        let Ok(toml::Value::Table(mut table)) = content.parse::<toml::Value>() else {
            return String::new();
        };
        table.remove("mcp_servers");
        table.remove("plugins");
        table.remove("marketplaces");
        toml::to_string_pretty(&toml::Value::Table(table)).unwrap_or_default()
    }

    fn copy_file_if_exists(src: &Path, dst: &Path) -> Result<()> {
        if !src.is_file() {
            return Ok(());
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        Ok(())
    }

    fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
        if !src.is_dir() {
            return Ok(());
        }
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let child_src = entry.path();
            let child_dst = dst.join(entry.file_name());
            if file_type.is_dir() {
                Self::copy_dir_recursive(&child_src, &child_dst)?;
            } else if file_type.is_file() {
                fs::copy(&child_src, &child_dst)?;
            }
        }
        Ok(())
    }

    fn prepare_isolated_codex_home(ctx: &CliAdapterContext) -> Result<Option<PathBuf>> {
        let Some(real_home) = Self::real_codex_home() else {
            return Ok(None);
        };
        let Some(isolated_home) = Self::isolated_codex_home(&ctx.session_id) else {
            return Ok(None);
        };

        if isolated_home.exists() {
            fs::remove_dir_all(&isolated_home)?;
        }
        fs::create_dir_all(&isolated_home)?;

        let real_config = real_home.join("config.toml");
        let isolated_config = isolated_home.join("config.toml");
        if let Ok(content) = fs::read_to_string(&real_config) {
            fs::write(&isolated_config, Self::sanitized_config_toml(&content))?;
        } else {
            fs::write(&isolated_config, "")?;
        }

        for file_name in ["auth.json", "AGENTS.md"] {
            Self::copy_file_if_exists(&real_home.join(file_name), &isolated_home.join(file_name))?;
        }
        for dir_name in ["prompts", "rules", "skills"] {
            Self::copy_dir_recursive(&real_home.join(dir_name), &isolated_home.join(dir_name))?;
        }

        Ok(Some(isolated_home))
    }

    fn push_mcp_isolation_overrides_for_names(
        args: &mut Vec<String>,
        allowed_server_ids: &[String],
        configured_server_names: BTreeSet<String>,
    ) {
        let allowed = allowed_server_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut server_names = configured_server_names;
        server_names.extend(allowed_server_ids.iter().cloned());
        server_names.insert("ccpanes".to_string());

        for name in server_names {
            if !allowed.contains(name.as_str()) {
                Self::push_mcp_enabled_override(args, &name, false);
            }
        }
    }

    fn push_mcp_isolation_overrides(args: &mut Vec<String>, ctx: &CliAdapterContext) {
        if !ctx.disable_unlisted_mcp_servers {
            return;
        }
        Self::push_mcp_isolation_overrides_for_names(
            args,
            &ctx.allowed_mcp_server_ids,
            Self::configured_mcp_server_names(),
        );
    }

    fn project_codex_dir(project_path: &Path) -> PathBuf {
        project_path.join(".codex")
    }

    fn config_path(project_path: &Path) -> PathBuf {
        Self::project_codex_dir(project_path).join("config.toml")
    }

    fn hooks_path(project_path: &Path) -> PathBuf {
        Self::project_codex_dir(project_path).join("hooks.json")
    }

    fn project_path_conflict_reason(project_path: &Path) -> Option<String> {
        let codex_path = project_path.join(".codex");
        if codex_path.is_file() {
            return Some(DOT_CODEX_FILE_CONFLICT.to_string());
        }

        None
    }

    fn project_unsupported_reason(project_path: &Path) -> Option<String> {
        if cfg!(windows) {
            return Some(TOOL_UNSUPPORTED_ON_WINDOWS.to_string());
        }

        Self::project_path_conflict_reason(project_path)
    }

    fn build_hook_command(binary_path: &Path, def: &HookDef) -> String {
        let path_str = binary_path.to_string_lossy().replace('\\', "\\\\");
        format!("\"{}\" {}", path_str, def.subcommand)
    }

    fn unsupported_statuses(reason: &str) -> Vec<ProjectHookStatus> {
        HOOK_DEFS
            .iter()
            .map(|def| ProjectHookStatus {
                name: def.name.to_string(),
                label: def.label.to_string(),
                enabled: false,
                supported: false,
                reason: Some(reason.to_string()),
            })
            .collect()
    }

    fn read_hooks_json(project_path: &Path) -> Result<serde_json::Value> {
        let path = Self::hooks_path(project_path);
        if !path.exists() {
            return Ok(serde_json::json!({}));
        }
        let content = fs::read_to_string(path)?;
        Ok(serde_json::from_str(&content)?)
    }

    fn write_hooks_json(project_path: &Path, value: &serde_json::Value) -> Result<()> {
        let codex_dir = Self::project_codex_dir(project_path);
        fs::create_dir_all(&codex_dir)?;
        fs::write(
            Self::hooks_path(project_path),
            serde_json::to_string_pretty(value)?,
        )?;
        Ok(())
    }

    fn hook_enabled_in_json(hooks_json: &serde_json::Value, def: &HookDef) -> bool {
        hooks_json
            .get("hooks")
            .and_then(|hooks| hooks.get(def.event))
            .and_then(|entries| entries.as_array())
            .map(|entries| {
                entries.iter().any(|entry| {
                    entry
                        .get("hooks")
                        .and_then(|hooks| hooks.as_array())
                        .map(|items| {
                            items.iter().any(|hook| {
                                hook.get("command")
                                    .and_then(|cmd| cmd.as_str())
                                    .map(|cmd| {
                                        (cmd.contains(HOOK_BINARY_NAME)
                                            || cmd.contains(LEGACY_HOOK_BINARY_NAME))
                                            && cmd.contains(def.subcommand)
                                    })
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    fn is_ccpanes_hook_entry(entry: &serde_json::Value) -> bool {
        entry
            .get("hooks")
            .and_then(|hooks| hooks.as_array())
            .map(|items| {
                items.iter().any(|hook| {
                    hook.get("command")
                        .and_then(|cmd| cmd.as_str())
                        .map(|cmd| {
                            cmd.contains(HOOK_BINARY_NAME)
                                || cmd.contains(LEGACY_HOOK_BINARY_NAME)
                                || cmd.contains("ccpanes")
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    fn merge_hook_entry(
        hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
        event: &str,
        entry: serde_json::Value,
    ) {
        if let Some(entries) = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
        {
            entries.retain(|existing| !Self::is_ccpanes_hook_entry(existing));
            entries.push(entry);
        }
    }

    fn remove_hook_entries(
        hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
        event: &str,
    ) {
        if let Some(entries) = hooks_obj
            .get_mut(event)
            .and_then(|value| value.as_array_mut())
        {
            entries.retain(|entry| !Self::is_ccpanes_hook_entry(entry));
        }
    }

    fn read_config_toml(project_path: &Path) -> Result<toml::Value> {
        let path = Self::config_path(project_path);
        if !path.exists() {
            return Ok(toml::Value::Table(Default::default()));
        }
        let content = fs::read_to_string(path)?;
        Ok(toml::from_str(&content)?)
    }

    fn write_config_toml(project_path: &Path, value: &toml::Value) -> Result<()> {
        let codex_dir = Self::project_codex_dir(project_path);
        fs::create_dir_all(&codex_dir)?;
        fs::write(
            Self::config_path(project_path),
            toml::to_string_pretty(value)?,
        )?;
        Ok(())
    }

    fn ensure_hooks_feature(project_path: &Path) -> Result<()> {
        let mut config = Self::read_config_toml(project_path)?;
        let table = config
            .as_table_mut()
            .ok_or_else(|| anyhow!("Codex config root must be a TOML table"))?;
        let features = table
            .entry("features")
            .or_insert_with(|| toml::Value::Table(Default::default()));
        let features_table = features
            .as_table_mut()
            .ok_or_else(|| anyhow!("Codex config [features] must be a TOML table"))?;
        // Dual-write both the new `hooks` key and the legacy `codex_hooks` key.
        // Codex >= 0.135 reads `hooks`; older builds still read `codex_hooks`.
        // Writing both keeps hooks firing across supported Codex versions until a
        // minimum Codex version is enforced (neither key is rejected by --strict-config).
        features_table.insert("hooks".to_string(), toml::Value::Boolean(true));
        features_table.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
        Self::write_config_toml(project_path, &config)
    }

    fn sync_project_hooks_inner(
        &self,
        project_path: &Path,
        hook_binary_path: Option<&Path>,
        desired: &HashMap<String, bool>,
        allow_windows_host: bool,
    ) -> Result<()> {
        let unsupported = if allow_windows_host {
            Self::project_path_conflict_reason(project_path)
        } else {
            Self::project_unsupported_reason(project_path)
        };
        if let Some(reason) = unsupported {
            return Err(anyhow!(reason));
        }

        let session_enabled = desired.get("session-inject").copied().unwrap_or(true);
        if session_enabled && hook_binary_path.is_none() {
            return Err(anyhow!("cc-panes-cli-hook binary not found"));
        }

        Self::ensure_hooks_feature(project_path)?;

        let mut hooks_json = Self::read_hooks_json(project_path)?;
        let hooks_root = hooks_json
            .as_object_mut()
            .ok_or_else(|| anyhow!("Codex hooks.json root must be a JSON object"))?
            .entry("hooks")
            .or_insert_with(|| serde_json::json!({}));
        let hooks_obj = hooks_root
            .as_object_mut()
            .ok_or_else(|| anyhow!("Codex hooks field must be a JSON object"))?;

        for def in HOOK_DEFS {
            if !def.supported {
                Self::remove_hook_entries(hooks_obj, def.event);
                continue;
            }

            if desired.get(def.name).copied().unwrap_or(true) {
                let command = Self::build_hook_command(
                    hook_binary_path.expect("checked above when session hook enabled"),
                    def,
                );
                let entry = serde_json::json!({
                    "matcher": def.matcher,
                    "hooks": [{
                        "type": "command",
                        "command": command,
                        "timeout": def.timeout,
                        "statusMessage": "Loading CC-Panes context"
                    }]
                });
                Self::merge_hook_entry(hooks_obj, def.event, entry);
            } else {
                Self::remove_hook_entries(hooks_obj, def.event);
            }
        }

        hooks_obj.retain(|_, value| {
            value
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(true)
        });
        Self::write_hooks_json(project_path, &hooks_json)
    }

    /// Sync hooks for a Codex process that will run inside WSL while the
    /// CC-Panes host is Windows. The project path is still written by the host,
    /// but the hook command itself must be executable from WSL.
    pub fn sync_project_hooks_for_wsl_launch(
        &self,
        project_path: &Path,
        hook_binary_path: &Path,
        desired: &HashMap<String, bool>,
    ) -> Result<()> {
        self.sync_project_hooks_inner(project_path, Some(hook_binary_path), desired, true)
    }
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for CodexAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn global_skills_dir(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|h| h.join(".codex").join("skills"))
    }

    fn project_hooks(&self) -> Vec<ProjectHookDefinition> {
        HOOK_DEFS
            .iter()
            .map(|def| ProjectHookDefinition {
                name: def.name.to_string(),
                label: def.label.to_string(),
            })
            .collect()
    }

    fn get_project_hook_statuses(&self, project_path: &Path) -> Result<Vec<ProjectHookStatus>> {
        if let Some(reason) = Self::project_unsupported_reason(project_path) {
            return Ok(Self::unsupported_statuses(&reason));
        }

        let hooks_json = Self::read_hooks_json(project_path)?;
        Ok(HOOK_DEFS
            .iter()
            .map(|def| ProjectHookStatus {
                name: def.name.to_string(),
                label: def.label.to_string(),
                enabled: if def.supported {
                    Self::hook_enabled_in_json(&hooks_json, def)
                } else {
                    false
                },
                supported: def.supported,
                reason: def.reason.map(ToOwned::to_owned),
            })
            .collect())
    }

    fn sync_project_hooks(
        &self,
        project_path: &Path,
        hook_binary_path: Option<&Path>,
        desired: &HashMap<String, bool>,
    ) -> Result<()> {
        self.sync_project_hooks_inner(project_path, hook_binary_path, desired, false)
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("codex").map_err(|_| anyhow!("codex CLI not found in PATH"))?;
        let codex_cmd = path.to_string_lossy().into_owned();

        let mut args = Vec::new();
        let mut env_inject = HashMap::new();

        // Keep every CC-Panes local Codex PTY isolated from the global TUI state.
        // We copy auth/config basics but intentionally do not copy sessions, so a new
        // launch cannot replay an old queued prompt from the same project directory.
        if let Some(codex_home) = Self::prepare_isolated_codex_home(ctx)? {
            env_inject.insert(
                "CODEX_HOME".to_string(),
                codex_home.to_string_lossy().into_owned(),
            );
        }

        // MCP 注入使用 Codex 的 per-launch -c override，避免写入用户全局 config.toml。
        if ctx.skip_mcp {
            info!(
                session_id = %ctx.session_id,
                "codex: skip_mcp=true, skipping Codex MCP overrides"
            );
            Self::push_mcp_enabled_override(&mut args, "ccpanes", false);
        } else {
            self.push_mcp_overrides(&mut args, ctx);
        }

        if let Some(ref prompt) = ctx.append_system_prompt {
            Self::push_developer_instructions_override(&mut args, prompt);
        }

        Self::push_mcp_isolation_overrides(&mut args, ctx);

        if ctx.yolo_mode {
            Self::push_yolo_mode_arg(&mut args);
        }

        // Resume: codex resume <id>
        if let Some(ref rid) = ctx.resume_id {
            args.push("resume".to_string());
            args.push(rid.clone());
        }

        // [PROMPT] 位置参数（必须在所有 --option 之后）
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        Ok(CliCommandResult {
            command: codex_cmd,
            args,
            env_remove: vec![],
            env_inject,
        })
    }

    // ============ cc-pane 抽象事件映射 ============
    //
    // Codex 目前只暴露 SessionStart / PostToolUse 两个事件，其余 cc-pane 事件
    // 一律返回 None，由前端展示 unsupported_reason。

    fn map_cc_pane_event(&self, event: &CcPaneEvent) -> Option<NativeHookBinding> {
        match event {
            CcPaneEvent::SessionInit => {
                Some(NativeHookBinding::new("SessionStart", Some("startup"), 10))
            }
            CcPaneEvent::SessionResume => {
                Some(NativeHookBinding::new("SessionStart", Some("resume"), 10))
            }
            CcPaneEvent::ToolAfter(matcher) => Some(NativeHookBinding::new(
                "PostToolUse",
                self.render_cc_pane_tool_matcher(matcher).as_deref(),
                5,
            )),
            _ => None,
        }
    }

    fn unsupported_cc_pane_event_reason(&self, event: &CcPaneEvent) -> Option<&'static str> {
        match event {
            CcPaneEvent::SessionInit | CcPaneEvent::SessionResume | CcPaneEvent::ToolAfter(_) => {
                None
            }
            _ => Some(CC_PANE_EVENT_UNSUPPORTED),
        }
    }

    fn render_cc_pane_tool_matcher(&self, matcher: &ToolMatcher) -> Option<String> {
        // Codex matcher 与 Claude 类似（精确匹配 / `|` 分隔），细粒度 path_glob /
        // bash_cmd_prefix 留给 hook 子命令在 stdin 解析阶段判断。
        let tool_str = match matcher.tool {
            ToolKind::Any => return None,
            ToolKind::Bash => "Bash",
            ToolKind::Write => "Write",
            ToolKind::Edit => "Edit",
            ToolKind::Read => "Read",
            ToolKind::Custom => return None,
        };
        Some(tool_str.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(not(windows))]
    #[test]
    fn sync_project_hooks_writes_codex_config_and_reports_degraded_status() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = project_path.join("cc-panes-cli-hook");
        fs::write(&hook_binary, b"hook").unwrap();

        let adapter = CodexAdapter::new();
        let desired = HashMap::from([("session-inject".to_string(), true)]);

        adapter
            .sync_project_hooks(project_path, Some(&hook_binary), &desired)
            .unwrap();

        let config = fs::read_to_string(project_path.join(".codex").join("config.toml")).unwrap();
        let hooks = fs::read_to_string(project_path.join(".codex").join("hooks.json")).unwrap();

        assert!(config.contains("hooks = true"));
        assert!(config.contains("codex_hooks = true"));
        assert!(hooks.contains("SessionStart"));
        assert!(hooks.contains("session-init"));

        let statuses = adapter.get_project_hook_statuses(project_path).unwrap();
        let session = statuses
            .iter()
            .find(|status| status.name == "session-inject")
            .unwrap();
        let plan = statuses
            .iter()
            .find(|status| status.name == "plan-archive")
            .unwrap();
        assert!(session.enabled);
        assert!(session.supported);
        assert!(!plan.supported);
        assert_eq!(plan.reason.as_deref(), Some(PLAN_ARCHIVE_UNSUPPORTED));
    }

    #[test]
    fn sync_project_hooks_for_wsl_launch_writes_wsl_command() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = PathBuf::from(
            "/mnt/c/Users/wuxiran/AppData/Local/cc-panes/binaries/cc-panes-cli-hook.exe",
        );

        let adapter = CodexAdapter::new();
        let desired = HashMap::from([("session-inject".to_string(), true)]);

        adapter
            .sync_project_hooks_for_wsl_launch(project_path, &hook_binary, &desired)
            .unwrap();

        let config = fs::read_to_string(project_path.join(".codex").join("config.toml")).unwrap();
        let hooks = fs::read_to_string(project_path.join(".codex").join("hooks.json")).unwrap();

        assert!(config.contains("hooks = true"));
        assert!(config.contains("codex_hooks = true"));
        assert!(hooks.contains("/mnt/c/Users/wuxiran"));
        assert!(hooks.contains("session-init"));
    }

    #[test]
    fn sync_project_hooks_dual_writes_hooks_and_legacy_codex_hooks_feature() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = PathBuf::from(
            "/mnt/c/Users/wuxiran/AppData/Local/cc-panes/binaries/cc-panes-cli-hook.exe",
        );
        let codex_dir = project_path.join(".codex");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("config.toml"),
            "[features]\ncodex_hooks = true\n",
        )
        .unwrap();

        let adapter = CodexAdapter::new();
        let desired = HashMap::from([("session-inject".to_string(), true)]);

        adapter
            .sync_project_hooks_for_wsl_launch(project_path, &hook_binary, &desired)
            .unwrap();

        let config = fs::read_to_string(codex_dir.join("config.toml")).unwrap();
        // Dual-write: keep the legacy codex_hooks key and add the new hooks key,
        // so hooks fire on both current and older Codex CLIs.
        assert!(config.contains("hooks = true"));
        assert!(config.contains("codex_hooks = true"));
    }

    #[cfg(windows)]
    #[test]
    fn project_hooks_report_windows_unsupported_reason() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = project_path.join("cc-panes-cli-hook");
        fs::write(&hook_binary, b"hook").unwrap();

        let adapter = CodexAdapter::new();
        let desired = HashMap::from([("session-inject".to_string(), true)]);

        let err = adapter
            .sync_project_hooks(project_path, Some(&hook_binary), &desired)
            .unwrap_err();
        assert_eq!(err.to_string(), TOOL_UNSUPPORTED_ON_WINDOWS);

        let statuses = adapter.get_project_hook_statuses(project_path).unwrap();
        assert!(statuses.iter().all(|status| !status.enabled));
        assert!(statuses.iter().all(|status| !status.supported));
        assert!(statuses
            .iter()
            .all(|status| status.reason.as_deref() == Some(TOOL_UNSUPPORTED_ON_WINDOWS)));
    }

    #[cfg(not(windows))]
    #[test]
    fn get_project_hook_statuses_reports_dot_codex_file_conflict() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        fs::write(project_path.join(".codex"), b"conflict").unwrap();

        let adapter = CodexAdapter::new();
        let statuses = adapter.get_project_hook_statuses(project_path).unwrap();

        assert!(statuses.iter().all(|status| !status.supported));
        assert!(statuses
            .iter()
            .all(|status| status.reason.as_deref() == Some(DOT_CODEX_FILE_CONFLICT)));
    }

    #[test]
    fn mcp_overrides_use_codex_toml_dotted_keys() {
        let mut args = Vec::new();

        CodexAdapter::push_mcp_url_override(&mut args, "context 7", "http://127.0.0.1:3100/mcp");
        CodexAdapter::push_mcp_bearer_env_override(&mut args, "ccpanes", "CC_PANES_API_TOKEN");
        CodexAdapter::push_mcp_enabled_override(&mut args, "ccpanes", false);

        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.\"context 7\".url=\"http://127.0.0.1:3100/mcp\"",
                "-c",
                "mcp_servers.ccpanes.bearer_token_env_var=\"CC_PANES_API_TOKEN\"",
                "-c",
                "mcp_servers.ccpanes.enabled=false",
            ]
        );
    }

    #[test]
    fn developer_instructions_override_uses_codex_cli_config() {
        let mut args = Vec::new();

        CodexAdapter::push_developer_instructions_override(
            &mut args,
            "CC-Panes launch profile skill",
        );

        assert_eq!(
            args,
            vec![
                "-c",
                "developer_instructions=\"CC-Panes launch profile skill\""
            ]
        );
    }

    #[test]
    fn yolo_mode_arg_uses_codex_bypass_flag() {
        let mut args = Vec::new();

        CodexAdapter::push_yolo_mode_arg(&mut args);

        assert_eq!(
            args,
            vec!["--dangerously-bypass-approvals-and-sandbox".to_string()]
        );
    }

    #[test]
    fn sanitized_config_removes_runtime_mcp_sections() {
        let sanitized = CodexAdapter::sanitized_config_toml(
            r#"
model = "gpt-5"

[model_providers.local]
name = "local"

[mcp_servers.fetch]
command = "npx"

[plugins.example]
enabled = true

[marketplaces.default]
url = "https://example.com"
"#,
        );

        assert!(sanitized.contains("model = \"gpt-5\""));
        assert!(sanitized.contains("[model_providers.local]"));
        assert!(!sanitized.contains("mcp_servers"));
        assert!(!sanitized.contains("plugins"));
        assert!(!sanitized.contains("marketplaces"));
    }

    #[test]
    fn isolated_codex_home_copy_skips_sessions() {
        let real = tempdir().unwrap();
        let isolated = tempdir().unwrap();
        fs::write(real.path().join("auth.json"), "{}").unwrap();
        fs::create_dir_all(real.path().join("skills").join("tool")).unwrap();
        fs::write(
            real.path().join("skills").join("tool").join("SKILL.md"),
            "skill",
        )
        .unwrap();
        fs::create_dir_all(real.path().join("sessions")).unwrap();
        fs::write(real.path().join("sessions").join("old.jsonl"), "old").unwrap();

        CodexAdapter::copy_file_if_exists(
            &real.path().join("auth.json"),
            &isolated.path().join("auth.json"),
        )
        .unwrap();
        CodexAdapter::copy_dir_recursive(
            &real.path().join("skills"),
            &isolated.path().join("skills"),
        )
        .unwrap();

        assert!(isolated.path().join("auth.json").is_file());
        assert!(isolated
            .path()
            .join("skills")
            .join("tool")
            .join("SKILL.md")
            .is_file());
        assert!(!isolated.path().join("sessions").exists());
    }

    #[test]
    fn mcp_isolation_disables_configured_servers_outside_allowlist() {
        let mut args = Vec::new();
        let configured = BTreeSet::from([
            "ccpanes".to_string(),
            "fetch".to_string(),
            "chrome-devtools-windows".to_string(),
            "Desktop Commander".to_string(),
        ]);

        CodexAdapter::push_mcp_isolation_overrides_for_names(
            &mut args,
            &["ccpanes".to_string(), "fetch".to_string()],
            configured,
        );

        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.\"Desktop Commander\".enabled=false",
                "-c",
                "mcp_servers.chrome-devtools-windows.enabled=false",
            ]
        );
    }

    // ============ cc-pane 抽象事件映射测试 ============

    #[test]
    fn map_cc_pane_event_only_supports_session_and_tool_after() {
        let a = CodexAdapter::new();
        // 支持的事件
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionInit).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionResume).is_some());
        assert!(a
            .map_cc_pane_event(&CcPaneEvent::ToolAfter(ToolMatcher::any()))
            .is_some());

        // 不支持的事件应返回 None
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionEnd).is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::PromptBefore).is_none());
        assert!(a
            .map_cc_pane_event(&CcPaneEvent::ToolBefore(ToolMatcher::any()))
            .is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::TurnEnd).is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::BeforeCompact).is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::WaitingInput).is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::Error).is_none());
    }

    #[test]
    fn unsupported_cc_pane_event_reason_nonempty_for_unsupported() {
        let a = CodexAdapter::new();
        // 支持的事件 reason 应为 None
        assert!(a
            .unsupported_cc_pane_event_reason(&CcPaneEvent::SessionInit)
            .is_none());
        // 不支持的事件 reason 应非空
        let reason = a.unsupported_cc_pane_event_reason(&CcPaneEvent::TurnEnd);
        assert!(reason.is_some() && !reason.unwrap().is_empty());
    }
}
