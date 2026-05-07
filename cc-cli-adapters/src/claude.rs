//! Claude Code CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
    ProjectHookDefinition, ProjectHookStatus,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{info, warn};

const HOOK_BINARY_NAME: &str = "cc-panes-cli-hook";
const LEGACY_HOOK_BINARY_NAME: &str = "cc-panes-hook";
const LEGACY_PYTHON_FILES: &[&str] = &["ccpanes-inject.py", "ccpanes-plan-archive.py"];

struct HookDef {
    name: &'static str,
    subcommand: &'static str,
    event: &'static str,
    matcher: &'static str,
    timeout: u32,
    label: &'static str,
}

const HOOK_DEFS: &[HookDef] = &[
    HookDef {
        name: "session-inject",
        subcommand: "session-start",
        event: "SessionStart",
        matcher: "startup",
        timeout: 10,
        label: "Context Inject",
    },
    HookDef {
        name: "plan-archive",
        subcommand: "plan-archive",
        event: "PostToolUse",
        matcher: "",
        timeout: 5,
        label: "Plan Archive",
    },
];

pub struct ClaudeAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "claude".into(),
                display_name: "Claude Code".into(),
                executable: "claude".into(),
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
                compatible_provider_types: vec![
                    "anthropic".into(),
                    "bedrock".into(),
                    "vertex".into(),
                    "proxy".into(),
                    "config_profile".into(),
                ],
            },
        }
    }

    /// 生成 MCP 配置文件，返回路径
    /// 配置 CC-Panes 的 Streamable HTTP MCP 端点 + 用户全局 MCP 服务器
    fn generate_mcp_config(&self, ctx: &CliAdapterContext) -> Option<String> {
        let port = ctx.orchestrator_port?;
        let token = ctx.orchestrator_token.as_ref()?;

        info!(
            "[claude] generate_mcp_config: port={}, shared_mcp={} servers, session={}",
            port,
            ctx.shared_mcp_urls.len(),
            ctx.session_id
        );

        // NOTE: 不做 TCP 健康检查。generate_mcp_config 在 Orchestrator 进程内部调用
        // （create_session → build_command），此时 Orchestrator 必然在运行。
        // 之前的 200ms connect_timeout 在高并发启动时会误判失败，导致 --mcp-config
        // 不被添加到 args，使 Claude CLI 将后续 prompt 位置参数误解为 flag 值。

        // Per-session MCP 配置文件，避免并发写同一文件的竞态
        let file_name = format!("mcp-{}.json", ctx.session_id);
        let config_path = ctx.data_dir.join(&file_name);

        // 清理旧 MCP 配置文件（>1h），防止 per-session 文件随时间积累
        if let Ok(entries) = std::fs::read_dir(&ctx.data_dir) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("mcp-")
                    && name_str.ends_with(".json")
                    && *name_str != file_name
                {
                    if let Ok(meta) = entry.metadata() {
                        if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }

        // token 同时通过 headers 和 URL query 传递（后者为后备方案，
        // 因为 Claude Code 某些版本可能忽略 headers 配置 — Issue #7290）
        let ccpanes_server = serde_json::json!({
            "type": "http",
            "url": format!("http://127.0.0.1:{}/mcp?token={}", port, token),
            "headers": {
                "Authorization": format!("Bearer {}", token)
            }
        });

        let mut mcp_servers = serde_json::Map::new();

        // 合并用户全局 MCP 配置（低优先级）
        // 跳过已在 shared_mcp_urls 中的 server（它们将以 HTTP 模式注入）
        if let Some(serde_json::Value::Object(user_servers)) = Self::read_user_global_mcp_servers()
        {
            let total = user_servers.len();
            let mut merged = 0;
            let mut skipped = 0;
            for (name, config) in user_servers {
                if ctx.shared_mcp_urls.contains_key(&name) {
                    skipped += 1;
                    info!("[claude] Skipping stdio '{}' (shared HTTP available)", name);
                } else {
                    mcp_servers.insert(name, config);
                    merged += 1;
                }
            }
            info!(
                "[claude] User global MCP: {} total, {} merged, {} skipped (shared)",
                total, merged, skipped
            );
        }

        // 注入共享 MCP Server（HTTP 模式）
        for (name, url) in &ctx.shared_mcp_urls {
            let shared_server = serde_json::json!({
                "type": "http",
                "url": url
            });
            mcp_servers.insert(name.clone(), shared_server);
        }
        if !ctx.shared_mcp_urls.is_empty() {
            info!(
                "[claude] Injected {} shared MCP servers (HTTP)",
                ctx.shared_mcp_urls.len()
            );
        }

        // ccpanes 服务器（最高优先级，覆盖同名）
        mcp_servers.insert("ccpanes".to_string(), ccpanes_server);

        let config = serde_json::json!({ "mcpServers": mcp_servers });

        match std::fs::write(
            &config_path,
            serde_json::to_string_pretty(&config).unwrap_or_default(),
        ) {
            Ok(_) => {
                info!(
                    "[claude] MCP config written to {} ({} servers)",
                    config_path.display(),
                    mcp_servers.len()
                );
                Some(config_path.to_string_lossy().into_owned())
            }
            Err(e) => {
                tracing::error!("[claude] Failed to write MCP config: {}", e);
                None
            }
        }
    }

    /// 读取 ~/.claude.json 的 mcpServers
    fn read_user_global_mcp_servers() -> Option<serde_json::Value> {
        let home = dirs::home_dir()?;
        let content = std::fs::read_to_string(home.join(".claude.json")).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
        parsed.get("mcpServers").cloned()
    }

    fn get_settings_path(project_path: &Path) -> PathBuf {
        project_path.join(".claude").join("settings.local.json")
    }

    fn get_legacy_hooks_dir(project_path: &Path) -> PathBuf {
        project_path.join(".claude").join("hooks")
    }

    fn read_settings(settings_path: &Path) -> Result<serde_json::Value> {
        if settings_path.exists() {
            let content = fs::read_to_string(settings_path)?;
            Ok(serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({})))
        } else {
            Ok(serde_json::json!({}))
        }
    }

    fn write_settings(settings_path: &Path, settings: &serde_json::Value) -> Result<()> {
        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(settings_path, serde_json::to_string_pretty(settings)?)?;
        Ok(())
    }

    fn cleanup_legacy_python_scripts(project_path: &Path) {
        let hooks_dir = Self::get_legacy_hooks_dir(project_path);
        for file in LEGACY_PYTHON_FILES {
            let path = hooks_dir.join(file);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn build_hook_command(binary_path: &Path, def: &HookDef) -> String {
        let path_str = binary_path.to_string_lossy().replace('\\', "\\\\");
        format!("\"{}\" {}", path_str, def.subcommand)
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

    fn merge_ccpanes_hook_entry(
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

    fn unregister_ccpanes_hook_entries(
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

    fn hook_enabled_in_settings(settings: &serde_json::Value, def: &HookDef) -> bool {
        let entries = match settings
            .get("hooks")
            .and_then(|hooks| hooks.get(def.event))
            .and_then(|value| value.as_array())
        {
            Some(entries) => entries,
            None => return false,
        };

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
    }

    fn resolve_claude_path() -> Result<PathBuf> {
        #[cfg(not(windows))]
        {
            which::which("claude").map_err(|_| anyhow!("claude CLI not found in PATH"))
        }

        #[cfg(windows)]
        {
            if let Ok(path) = which::which("claude") {
                return Ok(path);
            }

            if let Some(path) = Self::find_windows_claude_path() {
                return Ok(path);
            }

            Err(anyhow!("claude CLI not found in PATH"))
        }
    }

    #[cfg(windows)]
    fn find_windows_claude_path() -> Option<PathBuf> {
        let mut dirs = Vec::new();

        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
            dirs.push(home.join("scoop").join("shims"));
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(app_data).join("npm"));
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }

        if let Ok(scoop_root) = std::env::var("SCOOP") {
            dirs.push(PathBuf::from(scoop_root).join("shims"));
        }

        if let Ok(path_var) = std::env::var("PATH") {
            dirs.extend(std::env::split_paths(&path_var));
        }

        let extensions = Self::windows_executable_extensions();
        Self::find_executable_in_dirs("claude", &dirs, &extensions)
    }

    #[cfg(any(windows, test))]
    fn find_executable_in_dirs(
        executable: &str,
        dirs: &[PathBuf],
        extensions: &[String],
    ) -> Option<PathBuf> {
        let has_extension = Path::new(executable).extension().is_some();
        let mut seen = Vec::new();

        for dir in dirs {
            if dir.as_os_str().is_empty() || !dir.is_dir() {
                continue;
            }

            let normalized = dir.to_string_lossy().to_ascii_lowercase();
            if seen.iter().any(|value| value == &normalized) {
                continue;
            }
            seen.push(normalized);

            let direct = dir.join(executable);
            if direct.is_file() {
                return Some(direct);
            }

            if has_extension {
                continue;
            }

            for extension in extensions {
                let candidate = dir.join(format!("{}{}", executable, extension));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    #[cfg(windows)]
    fn windows_executable_extensions() -> Vec<String> {
        let from_env = std::env::var("PATHEXT")
            .ok()
            .map(|value| {
                value
                    .split(';')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| {
                        if value.starts_with('.') {
                            value.to_ascii_lowercase()
                        } else {
                            format!(".{}", value.to_ascii_lowercase())
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let defaults = [".exe", ".cmd", ".bat", ".com"];
        let mut ordered = Vec::new();
        for value in from_env
            .into_iter()
            .chain(defaults.into_iter().map(str::to_string))
        {
            if !ordered.iter().any(|existing| existing == &value) {
                ordered.push(value);
            }
        }
        ordered
    }

    #[cfg(any(windows, test))]
    fn is_windows_batch_file(path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext = ext.to_ascii_lowercase();
                ext == "cmd" || ext == "bat"
            })
            .unwrap_or(false)
    }

    #[cfg(any(windows, test))]
    fn claude_cli_js_for_npm_shim(shim_path: &Path) -> Option<PathBuf> {
        let dir = shim_path.parent()?;
        let cli_js = dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");

        cli_js.is_file().then_some(cli_js)
    }

    #[cfg(any(windows, test))]
    fn node_for_npm_shim(shim_path: &Path) -> Option<PathBuf> {
        let dir = shim_path.parent()?;
        let adjacent_node = dir.join("node.exe");
        if adjacent_node.is_file() {
            return Some(adjacent_node);
        }

        #[cfg(windows)]
        {
            which::which("node").ok()
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    #[cfg(any(windows, test))]
    fn windows_npm_shim_invocation(path: &Path, args: Vec<String>) -> (String, Vec<String>) {
        if !Self::is_windows_batch_file(path) {
            return (path.to_string_lossy().into_owned(), args);
        }

        match (
            Self::node_for_npm_shim(path),
            Self::claude_cli_js_for_npm_shim(path),
        ) {
            (Some(node), Some(cli_js)) => {
                let mut effective_args = vec![cli_js.to_string_lossy().into_owned()];
                effective_args.extend(args);
                (node.to_string_lossy().into_owned(), effective_args)
            }
            _ => {
                warn!(
                    command = %path.display(),
                    "claude: Windows npm shim detected but node/cli.js could not be resolved; launching shim directly"
                );
                (path.to_string_lossy().into_owned(), args)
            }
        }
    }
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for ClaudeAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn detect(&self) -> CliToolInfo {
        let mut info = self.info().clone();
        match Self::resolve_claude_path() {
            Ok(path) => {
                info.installed = true;
                info.path = Some(path.to_string_lossy().into_owned());
                info.version =
                    crate::run_with_timeout(&path, &info.version_args, Duration::from_secs(5));
            }
            Err(_) => {
                info.installed = false;
            }
        }
        info.capabilities = Some(self.capabilities().clone());
        info
    }

    fn global_commands_dir(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|h| h.join(".claude").join("commands"))
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
        let settings_path = Self::get_settings_path(project_path);
        let settings = Self::read_settings(&settings_path)?;
        Ok(HOOK_DEFS
            .iter()
            .map(|def| ProjectHookStatus {
                name: def.name.to_string(),
                label: def.label.to_string(),
                enabled: Self::hook_enabled_in_settings(&settings, def),
                supported: true,
                reason: None,
            })
            .collect())
    }

    fn sync_project_hooks(
        &self,
        project_path: &Path,
        hook_binary_path: Option<&Path>,
        desired: &HashMap<String, bool>,
    ) -> Result<()> {
        let settings_path = Self::get_settings_path(project_path);
        let mut settings = Self::read_settings(&settings_path)?;

        let hooks = settings
            .as_object_mut()
            .ok_or_else(|| anyhow!("settings.local.json root is not an object"))?
            .entry("hooks")
            .or_insert_with(|| serde_json::json!({}));
        let hooks_obj = hooks
            .as_object_mut()
            .ok_or_else(|| anyhow!("settings.local.json hooks is not an object"))?;

        let any_enabled = HOOK_DEFS
            .iter()
            .any(|def| desired.get(def.name).copied().unwrap_or(true));
        if any_enabled && hook_binary_path.is_none() {
            return Err(anyhow!("cc-panes-cli-hook binary not found"));
        }

        for def in HOOK_DEFS {
            if desired.get(def.name).copied().unwrap_or(true) {
                let command = Self::build_hook_command(
                    hook_binary_path.expect("checked above when any hook enabled"),
                    def,
                );
                let entry = serde_json::json!({
                    "matcher": def.matcher,
                    "hooks": [{
                        "type": "command",
                        "command": command,
                        "timeout": def.timeout,
                        "async": true
                    }]
                });
                Self::merge_ccpanes_hook_entry(hooks_obj, def.event, entry);
            } else {
                Self::unregister_ccpanes_hook_entries(hooks_obj, def.event);
            }
        }

        hooks_obj.retain(|_, value| {
            value
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(true)
        });
        Self::write_settings(&settings_path, &settings)?;
        Self::cleanup_legacy_python_scripts(project_path);
        Ok(())
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = Self::resolve_claude_path()?;
        let mut args = Vec::new();

        // Resume
        if let Some(ref rid) = ctx.resume_id {
            args.push("--resume".to_string());
            args.push(rid.clone());
        }

        // 多目录模式：workspace_path 存在时 project_path 作为 --add-dir
        if ctx.workspace_path.is_some() {
            args.push("--add-dir".to_string());
            args.push(ctx.project_path.clone());
        }

        // MCP 配置注入
        if ctx.skip_mcp {
            info!(
                session_id = %ctx.session_id,
                "claude: skip_mcp=true, skipping MCP config injection"
            );
        } else if let Some(mcp_config_path) = self.generate_mcp_config(ctx) {
            info!(
                session_id = %ctx.session_id,
                mcp_config = %mcp_config_path,
                "claude: MCP config injected"
            );
            args.push("--mcp-config".to_string());
            args.push(mcp_config_path);
        } else {
            warn!(
                session_id = %ctx.session_id,
                "claude: no MCP config generated (orchestrator not running?)"
            );
        }

        // --append-system-prompt
        if let Some(ref prompt) = ctx.append_system_prompt {
            args.push("--append-system-prompt".to_string());
            args.push(prompt.clone());
        }

        // 位置参数：初始用户 prompt（必须在所有 --option 之后）
        // 使用 `--` 分隔符防止 prompt 被误解析为 flag 值
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push("--".to_string());
            args.push(prompt.clone());
        }

        #[cfg(windows)]
        let (command, args) = Self::windows_npm_shim_invocation(&path, args);

        #[cfg(not(windows))]
        let command = path.to_string_lossy().into_owned();

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?args,
            "claude: build_command result"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec!["CLAUDECODE".to_string()],
            env_inject: HashMap::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    #[test]
    fn sync_project_hooks_writes_settings_and_reports_status() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = project_path.join("cc-panes-cli-hook");
        fs::write(&hook_binary, b"hook").unwrap();

        let adapter = ClaudeAdapter::new();
        let desired = HashMap::from([
            ("session-inject".to_string(), true),
            ("plan-archive".to_string(), false),
        ]);

        adapter
            .sync_project_hooks(project_path, Some(&hook_binary), &desired)
            .unwrap();

        let settings_path = project_path.join(".claude").join("settings.local.json");
        let content = fs::read_to_string(settings_path).unwrap();
        assert!(content.contains("session-start"));
        assert!(!content.contains("plan-archive"));

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
        assert!(!plan.enabled);
        assert!(session.supported);
        assert!(plan.supported);
    }

    #[test]
    fn find_executable_in_dirs_uses_extension_candidates() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("claude.cmd");
        fs::write(&executable, "echo hi").unwrap();

        let resolved = ClaudeAdapter::find_executable_in_dirs(
            "claude",
            &[dir.path().to_path_buf()],
            &[String::from(".cmd"), String::from(".exe")],
        );

        assert_eq!(resolved.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn find_executable_in_dirs_skips_duplicate_directories() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("claude.exe");
        fs::write(&executable, "binary").unwrap();

        let dirs = vec![dir.path().to_path_buf(), PathBuf::from(dir.path())];
        let resolved =
            ClaudeAdapter::find_executable_in_dirs("claude", &dirs, &[String::from(".exe")]);

        assert_eq!(resolved.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn find_executable_in_dirs_respects_existing_extension() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("claude.exe");
        fs::write(&executable, "binary").unwrap();

        let resolved = ClaudeAdapter::find_executable_in_dirs(
            "claude.exe",
            &[dir.path().to_path_buf()],
            &[String::from(".cmd")],
        );

        assert_eq!(resolved.as_deref(), Some(executable.as_path()));
    }

    #[test]
    fn windows_npm_shim_invocation_runs_node_directly() {
        let dir = tempdir().unwrap();
        let node_dir = dir.path().join("Program Files").join("nodejs");
        let package_dir = node_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code");
        fs::create_dir_all(&package_dir).unwrap();

        let shim = node_dir.join("claude.cmd");
        let node = node_dir.join("node.exe");
        let cli_js = package_dir.join("cli.js");
        fs::write(&shim, "@echo off").unwrap();
        fs::write(&node, "node").unwrap();
        fs::write(&cli_js, "console.log('claude')").unwrap();

        let (command, args) = ClaudeAdapter::windows_npm_shim_invocation(
            &shim,
            vec!["--resume".into(), "session id with spaces".into()],
        );

        assert_eq!(command, node.to_string_lossy());
        assert_eq!(
            args,
            vec![
                cli_js.to_string_lossy().into_owned(),
                "--resume".to_string(),
                "session id with spaces".to_string()
            ]
        );
    }

    #[test]
    fn windows_npm_shim_invocation_leaves_non_batch_command_unchanged() {
        let command = PathBuf::from(r"C:\Tools\claude.exe");
        let (resolved_command, args) =
            ClaudeAdapter::windows_npm_shim_invocation(&command, vec!["--version".into()]);

        assert_eq!(resolved_command, command.to_string_lossy());
        assert_eq!(args, vec!["--version".to_string()]);
    }
}
