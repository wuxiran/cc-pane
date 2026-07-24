//! Claude Code CLI 适配器

use crate::{
    build_guarded_hook_command, is_guarded_hook_command, resolve_executable, CcPaneEvent,
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
    HookCommandShell, NativeHookBinding, ProjectHookDefinition, ProjectHookStatus, ToolKind,
    ToolMatcher,
};
use anyhow::{anyhow, Context, Result};
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
    // 阶段 2.5：subcommand 改用 cc-pane 事件名。
    // 旧二进制（不识别 cc-pane 事件子命令）会因 clap 报错而 exit 1，
    // 但 hook 配置里的 timeout 兜底；新二进制走 dispatch_with_business
    // → 上报状态机 + 调旧业务逻辑（context 注入 / plan 归档）。
    HookDef {
        name: "session-inject",
        subcommand: "session-init",
        event: "SessionStart",
        matcher: "startup",
        timeout: 10,
        label: "Context Inject (Init)",
    },
    HookDef {
        name: "session-resume-inject",
        subcommand: "session-resume",
        event: "SessionStart",
        matcher: "resume|compact",
        timeout: 10,
        label: "Context Inject (Resume)",
    },
    HookDef {
        name: "plan-archive",
        subcommand: "tool-after",
        event: "PostToolUse",
        matcher: "",
        timeout: 5,
        label: "Plan Archive",
    },
    // ============ 阶段 2 状态机驱动 hook ============
    HookDef {
        name: "state-prompt-before",
        subcommand: "prompt-before",
        event: "UserPromptSubmit",
        matcher: "",
        timeout: 10,
        label: "State: prompt before",
    },
    HookDef {
        name: "state-tool-before",
        subcommand: "tool-before",
        event: "PreToolUse",
        matcher: "",
        timeout: 60,
        label: "State: tool before",
    },
    HookDef {
        name: "state-turn-end",
        subcommand: "turn-end",
        event: "Stop",
        matcher: "",
        timeout: 10,
        label: "State: turn end",
    },
    HookDef {
        name: "state-before-compact",
        subcommand: "before-compact",
        event: "PreCompact",
        matcher: "manual|auto",
        timeout: 15,
        label: "State: before compact",
    },
    HookDef {
        name: "state-waiting-input",
        subcommand: "waiting-input",
        event: "Notification",
        matcher: "permission_prompt|elicitation_dialog|elicitation_complete|elicitation_response|idle_prompt",
        timeout: 5,
        label: "State: waiting input",
    },
    HookDef {
        name: "state-error",
        subcommand: "error",
        event: "StopFailure",
        matcher: "",
        timeout: 5,
        label: "State: error",
    },
    HookDef {
        name: "state-session-end",
        subcommand: "session-end",
        event: "SessionEnd",
        matcher: "",
        timeout: 5,
        label: "State: session end",
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
                supports_issued_session_id: true,
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

    fn push_yolo_mode_arg(args: &mut Vec<String>) {
        args.push("--dangerously-skip-permissions".to_string());
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
        // launchId 用于让 Orchestrator 在 launch_task 时识别 caller，
        // 自动推导 parent_tab_id。
        let mut mcp_url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
        if let Some(launch_id) = ctx.launch_id.as_deref() {
            mcp_url.push_str("&launchId=");
            mcp_url.push_str(launch_id);
        }
        let ccpanes_server = serde_json::json!({
            "type": "http",
            "url": mcp_url,
            "headers": {
                "Authorization": format!("Bearer {}", token)
            }
        });

        let mut mcp_servers = serde_json::Map::new();
        Self::cleanup_legacy_global_mcp_servers();

        // 合并用户全局 MCP 配置（低优先级）
        // 跳过已在 shared_mcp_urls 中的 server（它们将以 HTTP 模式注入）
        if let Some(serde_json::Value::Object(user_servers)) = Self::read_user_global_mcp_servers()
        {
            let total = user_servers.len();
            let mut merged = 0;
            let mut skipped = 0;
            for (name, config) in user_servers {
                if Self::should_skip_user_global_mcp_server(&name, &config) {
                    skipped += 1;
                    info!("[claude] Skipping legacy or managed MCP '{}'", name);
                } else if ctx.shared_mcp_urls.contains_key(&name) {
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
        let path = Self::global_claude_config_path()?;
        Self::read_user_global_mcp_servers_at(&path)
    }

    fn global_claude_config_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".claude.json"))
    }

    fn read_user_global_mcp_servers_at(path: &Path) -> Option<serde_json::Value> {
        let content = std::fs::read_to_string(path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
        parsed.get("mcpServers").cloned()
    }

    fn cleanup_legacy_global_mcp_servers() {
        let Some(path) = Self::global_claude_config_path() else {
            return;
        };
        match Self::cleanup_legacy_global_mcp_servers_at(&path) {
            Ok(true) => info!(
                config = %path.display(),
                "claude: removed legacy global ccpanes MCP entries"
            ),
            Ok(false) => {}
            Err(error) => warn!(
                config = %path.display(),
                error = %error,
                "claude: failed to clean legacy global ccpanes MCP entries"
            ),
        }
    }

    fn cleanup_legacy_global_mcp_servers_at(path: &Path) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let content = fs::read_to_string(path)?;
        let mut parsed: serde_json::Value = serde_json::from_str(&content)?;
        let Some(servers) = parsed
            .get_mut("mcpServers")
            .and_then(|value| value.as_object_mut())
        else {
            return Ok(false);
        };
        let original_len = servers.len();
        servers.retain(|name, config| !Self::is_legacy_global_ccpanes_mcp_server(name, config));
        if servers.len() == original_len {
            return Ok(false);
        }
        // ~/.claude.json 存有 Claude Code 全部全局状态（项目列表 / oauth / 历史）。
        // 改写前先备份，再走 temp+fsync+rename 原子写，杜绝崩溃/断电截断丢数据。
        let backup_path = {
            let mut name = path
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| std::ffi::OsString::from(".claude.json"));
            name.push(".ccpanes.bak");
            path.with_file_name(name)
        };
        fs::copy(path, &backup_path).with_context(|| {
            format!(
                "failed to back up Claude config to {}",
                backup_path.display()
            )
        })?;
        crate::fs_atomic::write_atomic(path, serde_json::to_string_pretty(&parsed)?)?;
        Ok(true)
    }

    fn should_skip_user_global_mcp_server(name: &str, config: &serde_json::Value) -> bool {
        name == "ccpanes" || Self::is_legacy_global_ccpanes_mcp_server(name, config)
    }

    fn is_legacy_global_ccpanes_mcp_server(name: &str, config: &serde_json::Value) -> bool {
        name == "ccpanes-fixed" || Self::mcp_command_references_ccpanes_proxy(config)
    }

    fn mcp_command_references_ccpanes_proxy(config: &serde_json::Value) -> bool {
        config
            .get("command")
            .and_then(|command| command.as_str())
            .map(|command| command.contains("ccpanes-proxy"))
            .unwrap_or(false)
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
        let shell = if cfg!(windows) {
            HookCommandShell::Windows
        } else {
            HookCommandShell::Posix
        };
        build_guarded_hook_command(binary_path, def.subcommand, shell)
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
                            cmd.contains(HOOK_BINARY_NAME) || cmd.contains(LEGACY_HOOK_BINARY_NAME)
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    fn merge_ccpanes_hook_entry(
        hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
        def: &HookDef,
        entry: serde_json::Value,
    ) {
        // 提取本次 entry 的 (matcher, subcommand) 作为去重 key。
        // 同一 event 下允许多个 ccpanes hook 共存（matcher 或 subcommand 不同）；
        // 仅当 matcher 与 subcommand 都匹配时才视为重复，覆盖之。
        if let Some(entries) = hooks_obj
            .entry(def.event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
        {
            entries.retain(|existing| !Self::ccpanes_hook_entry_matches_def(existing, def));
            entries.push(entry);
        }
    }

    fn ccpanes_hook_entry_matches_def(entry: &serde_json::Value, def: &HookDef) -> bool {
        if !Self::is_ccpanes_hook_entry(entry) {
            return false;
        }
        let matcher = entry.get("matcher").and_then(|v| v.as_str()).unwrap_or("");
        if matcher != def.matcher && !Self::legacy_matchers_for_def(def).contains(&matcher) {
            return false;
        }
        let command = entry
            .get("hooks")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|h| h.get("command"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        std::iter::once(def.subcommand)
            .chain(Self::legacy_subcommands_for_def(def).iter().copied())
            .any(|subcommand| command.contains(subcommand))
    }

    fn legacy_subcommands_for_def(def: &HookDef) -> &'static [&'static str] {
        match def.name {
            "session-inject" => &["session-start"],
            "plan-archive" => &["plan-archive"],
            _ => &[],
        }
    }

    fn legacy_matchers_for_def(def: &HookDef) -> &'static [&'static str] {
        match def.name {
            "session-inject" => &["startup|resume"],
            _ => &[],
        }
    }

    fn unregister_ccpanes_hook_entries_for_def(
        hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
        def: &HookDef,
    ) {
        // 仅剔除与该 def 完全对应的 ccpanes hook entry（matcher + subcommand 都匹配）。
        if let Some(entries) = hooks_obj
            .get_mut(def.event)
            .and_then(|value| value.as_array_mut())
        {
            entries.retain(|entry| !Self::ccpanes_hook_entry_matches_def(entry, def));
        }
    }

    #[allow(dead_code)]
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
            resolve_executable("claude")
        }

        #[cfg(windows)]
        {
            if let Ok(path) = resolve_executable("claude") {
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
    fn claude_native_binary_for_npm_shim(shim_path: &Path) -> Option<PathBuf> {
        let dir = shim_path.parent()?;
        let exe = dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude.exe");

        exe.is_file().then_some(exe)
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

        if let Some(exe) = Self::claude_native_binary_for_npm_shim(path) {
            info!(
                shim = %path.display(),
                command = %exe.display(),
                "claude: Windows npm shim resolved to packaged native binary"
            );
            return (exe.to_string_lossy().into_owned(), args);
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

    fn global_skills_dir(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|h| h.join(".claude").join("skills"))
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
                Self::merge_ccpanes_hook_entry(hooks_obj, def, entry);
            } else {
                // 仅精确剔除该 def 对应的 ccpanes hook entry，保留同 event 其他 ccpanes hook
                Self::unregister_ccpanes_hook_entries_for_def(hooks_obj, def);
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

    fn project_hooks_need_command_upgrade(&self, project_path: &Path) -> Result<bool> {
        let settings_path = Self::get_settings_path(project_path);
        if !settings_path.exists() {
            return Ok(false);
        }

        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(settings_path)?)?;
        Ok(settings
            .get("hooks")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flat_map(|hooks| hooks.values())
            .filter_map(serde_json::Value::as_array)
            .flatten()
            .filter_map(|entry| entry.get("hooks").and_then(serde_json::Value::as_array))
            .flatten()
            .filter_map(|hook| hook.get("command").and_then(serde_json::Value::as_str))
            .any(|command| {
                (command.contains(HOOK_BINARY_NAME) || command.contains(LEGACY_HOOK_BINARY_NAME))
                    && !is_guarded_hook_command(command)
            }))
    }

    fn cleanup_project_hooks(&self, project_path: &Path) -> Result<Vec<PathBuf>> {
        let settings_path = Self::get_settings_path(project_path);
        if !settings_path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&settings_path)?;
        let mut settings: serde_json::Value = serde_json::from_str(&content)?;
        let Some(hooks_obj) = settings
            .as_object_mut()
            .and_then(|root| root.get_mut("hooks"))
            .and_then(serde_json::Value::as_object_mut)
        else {
            return Ok(Vec::new());
        };

        let mut changed = false;
        for entries in hooks_obj
            .values_mut()
            .filter_map(serde_json::Value::as_array_mut)
        {
            let old_len = entries.len();
            entries.retain(|entry| !Self::is_ccpanes_hook_entry(entry));
            changed |= entries.len() != old_len;
        }
        hooks_obj.retain(|_, value| {
            value
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(true)
        });

        if !changed {
            return Ok(Vec::new());
        }
        Self::write_settings(&settings_path, &settings)?;
        Ok(vec![settings_path])
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let mut args = Vec::new();

        // Resume（claude --resume 复用原会话 id，无需重新发号/捕获）
        if let Some(ref rid) = ctx.resume_id {
            args.push("--resume".to_string());
            args.push(rid.clone());
        } else if let Some(ref issued) = ctx.issued_session_id {
            // 新会话由 CC-Panes 发号，启动前即确定 resume id
            args.push("--session-id".to_string());
            args.push(issued.clone());
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

        if ctx.yolo_mode {
            Self::push_yolo_mode_arg(&mut args);
        }

        // adapter_options：verbose / maxTurns / extraArgs（effort 走 env 注入，见下）
        if crate::verbose_from_options(&ctx.adapter_options) {
            args.push("--verbose".to_string());
        }
        if let Some(max_turns) = crate::max_turns_from_options(&ctx.adapter_options) {
            args.push("--max-turns".to_string());
            args.push(max_turns.to_string());
        }
        // extraArgs 必须插在 `--` 分隔符之前，否则会被当作 prompt 文本
        args.extend(crate::extra_args_from_options(&ctx.adapter_options));

        // 位置参数：初始用户 prompt（必须在所有 --option 之后）
        // 使用 `--` 分隔符防止 prompt 被误解析为 flag 值
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push("--".to_string());
            args.push(prompt.clone());
        }

        // effort → 思考预算：Claude 无 --effort flag，经 MAX_THINKING_TOKENS 注入
        let mut env_inject = HashMap::new();
        if let Some(tokens) = crate::effort_from_options(&ctx.adapter_options)
            .and_then(|effort| crate::claude_max_thinking_tokens(&effort))
        {
            env_inject.insert("MAX_THINKING_TOKENS".to_string(), tokens.to_string());
        }

        let command;
        #[cfg(windows)]
        let args = if let Some(override_command) = ctx.command_override() {
            command = override_command.to_string();
            args
        } else {
            let path = Self::resolve_claude_path()?;
            let (resolved_command, resolved_args) = Self::windows_npm_shim_invocation(&path, args);
            command = resolved_command;
            resolved_args
        };

        #[cfg(not(windows))]
        {
            command = ctx.resolve_command("claude")?;
        }

        info!(
            session_id = %ctx.session_id,
            command = %command,
            args = ?crate::redact_args_for_log(&args),
            "claude: build_command result"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec!["CLAUDECODE".to_string()],
            env_inject,
        })
    }

    // ============ cc-pane 抽象事件映射 ============
    //
    // Claude Code 几乎覆盖所有 cc-pane 事件（约 100% 继承），只 InstructionsLoaded /
    // PostToolBatch 等少数无对应。这里只声明 cc-pane 关心的 10 个事件。

    fn map_cc_pane_event(&self, event: &CcPaneEvent) -> Option<NativeHookBinding> {
        match event {
            CcPaneEvent::SessionInit => Some(NativeHookBinding::new("SessionStart", Some("startup"), 10)),
            CcPaneEvent::SessionResume => Some(NativeHookBinding::new(
                "SessionStart",
                Some("resume|compact"),
                10,
            )),
            CcPaneEvent::SessionEnd => Some(NativeHookBinding::new("SessionEnd", None, 5)),
            CcPaneEvent::PromptBefore => {
                Some(NativeHookBinding::new("UserPromptSubmit", None, 10))
            }
            CcPaneEvent::ToolBefore(matcher) => Some(NativeHookBinding::new(
                "PreToolUse",
                self.render_cc_pane_tool_matcher(matcher).as_deref(),
                60,
            )),
            CcPaneEvent::ToolAfter(matcher) => Some(NativeHookBinding::new(
                "PostToolUse",
                self.render_cc_pane_tool_matcher(matcher).as_deref(),
                5,
            )),
            CcPaneEvent::TurnEnd => Some(NativeHookBinding::new("Stop", None, 10)),
            CcPaneEvent::BeforeCompact => Some(NativeHookBinding::new(
                "PreCompact",
                Some("manual|auto"),
                15,
            )),
            CcPaneEvent::WaitingInput => Some(NativeHookBinding::new(
                "Notification",
                Some("permission_prompt|elicitation_dialog|elicitation_complete|elicitation_response|idle_prompt"),
                5,
            )),
            CcPaneEvent::Error => Some(NativeHookBinding::new("StopFailure", None, 5)),
        }
    }

    fn render_cc_pane_tool_matcher(&self, matcher: &ToolMatcher) -> Option<String> {
        // Claude Code 的 matcher 语义：
        //   - 仅含字母数字/_/| 的字符串走精确匹配（如 "Bash" 或 "Edit|Write"）
        //   - 其他字符当 JS 正则
        //   - hook handler 的 `if` 字段支持 permission 规则语法（如 "Bash(rm -rf*)"），
        //     但 hook 配置里的 matcher 不支持。这里只渲染 tool_name 维度，
        //     path_glob / bash_cmd_prefix 留给 hook 子命令在 stdin 解析时自己判断。
        let tool_str = match matcher.tool {
            ToolKind::Any => return None, // None = 匹配全部
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
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn test_context(executable_override: Option<&str>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "test-session".to_string(),
            project_path: "/tmp/project".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: executable_override.map(str::to_string),
            adapter_options: Default::default(),
            resume_id: None,
            issued_session_id: Some("issued-session".to_string()),
            skip_mcp: true,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: Some("hello".to_string()),
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
        }
    }

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
            // 阶段 2 新 hook 默认在 sync 中视为 enabled（HOOK_DEFS::iter 默认 true）；
            // 这里显式列出仅为可读性
            ("session-resume-inject".to_string(), true),
            ("state-prompt-before".to_string(), false),
            ("state-tool-before".to_string(), false),
            ("state-turn-end".to_string(), false),
            ("state-before-compact".to_string(), false),
            ("state-waiting-input".to_string(), false),
            ("state-error".to_string(), false),
            ("state-session-end".to_string(), false),
        ]);

        adapter
            .sync_project_hooks(project_path, Some(&hook_binary), &desired)
            .unwrap();

        let settings_path = project_path.join(".claude").join("settings.local.json");
        let content = fs::read_to_string(settings_path).unwrap();
        // session-init / session-resume 子命令出现
        assert!(content.contains("session-init"));
        assert!(content.contains("session-resume"));
        // 存在性守卫按宿主平台生成:Windows 是 cmd.exe if exist,Unix 是 if [ -x
        if cfg!(windows) {
            assert!(content.contains("if exist"));
        } else {
            assert!(content.contains("if [ -x"));
        }
        // tool-after（旧 plan-archive 重命名）不出现，因为被 desired 关闭
        assert!(!content.contains("tool-after"));

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
    fn sync_project_hooks_upgrades_legacy_command_and_preserves_user_hook() {
        let dir = tempdir().unwrap();
        let project_path = dir.path();
        let hook_binary = project_path.join("cc-panes-cli-hook");
        fs::write(&hook_binary, b"hook").unwrap();
        let settings_path = project_path.join(".claude").join("settings.local.json");
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "hooks": {
                    "SessionStart": [
                        {
                            "matcher": "startup|resume",
                            "hooks": [{
                                "type": "command",
                                "command": format!("\"{}\" session-init", hook_binary.display())
                            }]
                        },
                        {
                            "matcher": "startup",
                            "hooks": [{"type": "command", "command": "user-context-hook"}]
                        }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut desired = HOOK_DEFS
            .iter()
            .map(|def| (def.name.to_string(), false))
            .collect::<HashMap<_, _>>();
        desired.insert("session-inject".to_string(), true);
        ClaudeAdapter::new()
            .sync_project_hooks(project_path, Some(&hook_binary), &desired)
            .unwrap();

        let content = fs::read_to_string(settings_path).unwrap();
        if cfg!(windows) {
            assert!(content.contains("if exist"));
        } else {
            assert!(content.contains("if [ -x"));
        }
        assert!(content.contains("user-context-hook"));
        let settings: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            settings["hooks"]["SessionStart"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn cleanup_project_hooks_removes_only_ccpanes_entries() {
        let dir = tempdir().unwrap();
        let settings_path = dir.path().join(".claude").join("settings.local.json");
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "hooks": {
                    "SessionStart": [
                        {
                            "matcher": "startup|resume",
                            "hooks": [{"type": "command", "command": "\"/opt/cc-panes-cli-hook\" session-init"}]
                        },
                        {
                            "matcher": "startup",
                            "hooks": [{"type": "command", "command": "user-context-hook"}]
                        }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let changed = ClaudeAdapter::new()
            .cleanup_project_hooks(dir.path())
            .unwrap();

        assert_eq!(changed, vec![settings_path.clone()]);
        let content = fs::read_to_string(settings_path).unwrap();
        assert!(!content.contains("cc-panes-cli-hook"));
        assert!(content.contains("user-context-hook"));
    }

    #[test]
    fn build_command_uses_executable_override_without_resolving_claude() {
        let adapter = ClaudeAdapter::new();
        let ctx = test_context(Some(r"C:\Tools\reclaude.exe"));

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(result.command, r"C:\Tools\reclaude.exe");
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--session-id" && pair[1] == "issued-session"));
        assert_eq!(
            &result.args[result.args.len() - 2..],
            ["--".to_string(), "hello".to_string()]
        );
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
    fn windows_npm_shim_invocation_prefers_packaged_native_binary() {
        let dir = tempdir().unwrap();
        let node_dir = dir.path().join("Program Files").join("nodejs");
        let package_dir = node_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code");
        let bin_dir = package_dir.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let shim = node_dir.join("claude.cmd");
        let exe = bin_dir.join("claude.exe");
        fs::write(&shim, "@echo off").unwrap();
        fs::write(&exe, "binary").unwrap();

        let (command, args) = ClaudeAdapter::windows_npm_shim_invocation(
            &shim,
            vec!["--resume".into(), "session-id".into()],
        );

        assert_eq!(command, exe.to_string_lossy());
        assert_eq!(args, vec!["--resume".to_string(), "session-id".to_string()]);
    }

    #[test]
    fn windows_npm_shim_invocation_leaves_non_batch_command_unchanged() {
        let command = PathBuf::from(r"C:\Tools\claude.exe");
        let (resolved_command, args) =
            ClaudeAdapter::windows_npm_shim_invocation(&command, vec!["--version".into()]);

        assert_eq!(resolved_command, command.to_string_lossy());
        assert_eq!(args, vec!["--version".to_string()]);
    }

    #[test]
    fn build_command_injects_max_thinking_tokens_for_effort() {
        let adapter = ClaudeAdapter::new();
        let mut ctx = test_context(Some(r"C:\Tools\claude.exe"));
        ctx.adapter_options
            .insert("effort".to_string(), serde_json::json!("low"));

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(
            result
                .env_inject
                .get("MAX_THINKING_TOKENS")
                .map(String::as_str),
            Some("4096")
        );

        ctx.adapter_options
            .insert("effort".to_string(), serde_json::json!("max"));
        let result = adapter.build_command(&ctx).unwrap();
        assert_eq!(
            result
                .env_inject
                .get("MAX_THINKING_TOKENS")
                .map(String::as_str),
            Some("63999")
        );
    }

    #[test]
    fn build_command_skips_thinking_tokens_without_valid_effort() {
        let adapter = ClaudeAdapter::new();
        let mut ctx = test_context(Some(r"C:\Tools\claude.exe"));

        let result = adapter.build_command(&ctx).unwrap();
        assert!(result.env_inject.is_empty());

        ctx.adapter_options
            .insert("effort".to_string(), serde_json::json!("default"));
        let result = adapter.build_command(&ctx).unwrap();
        assert!(result.env_inject.is_empty());
    }

    #[test]
    fn build_command_places_extra_args_before_prompt_separator() {
        let adapter = ClaudeAdapter::new();
        let mut ctx = test_context(Some(r"C:\Tools\claude.exe"));
        ctx.adapter_options
            .insert("extraArgs".to_string(), serde_json::json!(["--foo"]));
        ctx.adapter_options
            .insert("verbose".to_string(), serde_json::json!(true));
        ctx.adapter_options
            .insert("maxTurns".to_string(), serde_json::json!(12));

        let result = adapter.build_command(&ctx).unwrap();

        assert!(result.args.iter().any(|arg| arg == "--verbose"));
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--max-turns" && pair[1] == "12"));
        let foo_pos = result
            .args
            .iter()
            .position(|arg| arg == "--foo")
            .expect("extra arg present");
        let sep_pos = result
            .args
            .iter()
            .position(|arg| arg == "--")
            .expect("prompt separator present");
        assert!(foo_pos < sep_pos, "extraArgs must precede `--` separator");
        assert_eq!(
            &result.args[result.args.len() - 2..],
            ["--".to_string(), "hello".to_string()]
        );
    }

    #[test]
    fn yolo_mode_arg_uses_claude_skip_permissions_flag() {
        let mut args = Vec::new();

        ClaudeAdapter::push_yolo_mode_arg(&mut args);

        assert_eq!(args, vec!["--dangerously-skip-permissions".to_string()]);
    }

    #[test]
    fn cleanup_legacy_global_mcp_servers_removes_only_legacy_entries() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".claude.json");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": {
                    "ccpanes": {
                        "type": "http",
                        "url": "http://127.0.0.1:37123/mcp?token=redacted"
                    },
                    "ccpanes-fixed": {
                        "command": "node",
                        "args": ["ccpanes-proxy.mjs"]
                    },
                    "old-proxy": {
                        "command": "/tmp/ccpanes-proxy.mjs"
                    },
                    "fetch": {
                        "command": "fetch-mcp"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(ClaudeAdapter::cleanup_legacy_global_mcp_servers_at(&config_path).unwrap());

        let servers = ClaudeAdapter::read_user_global_mcp_servers_at(&config_path).unwrap();
        let servers = servers.as_object().unwrap();
        assert!(servers.contains_key("ccpanes"));
        assert!(servers.contains_key("fetch"));
        assert!(!servers.contains_key("ccpanes-fixed"));
        assert!(!servers.contains_key("old-proxy"));
    }

    #[test]
    fn user_global_mcp_filter_skips_managed_and_legacy_ccpanes_entries() {
        assert!(ClaudeAdapter::should_skip_user_global_mcp_server(
            "ccpanes",
            &serde_json::json!({"type": "http"})
        ));
        assert!(ClaudeAdapter::should_skip_user_global_mcp_server(
            "ccpanes-fixed",
            &serde_json::json!({"command": "node"})
        ));
        assert!(ClaudeAdapter::should_skip_user_global_mcp_server(
            "custom",
            &serde_json::json!({"command": "/tmp/ccpanes-proxy.mjs"})
        ));
        assert!(!ClaudeAdapter::should_skip_user_global_mcp_server(
            "fetch",
            &serde_json::json!({"command": "fetch-mcp"})
        ));
    }

    // ============ cc-pane 抽象事件映射测试 ============

    #[test]
    fn map_cc_pane_event_covers_all_10_events() {
        let a = ClaudeAdapter::new();
        // 10 个 cc-pane 事件，Claude 应当全部支持（≈100% 继承）
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionInit).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionResume).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::SessionEnd).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::PromptBefore).is_some());
        assert!(a
            .map_cc_pane_event(&CcPaneEvent::ToolBefore(ToolMatcher::any()))
            .is_some());
        assert!(a
            .map_cc_pane_event(&CcPaneEvent::ToolAfter(ToolMatcher::any()))
            .is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::TurnEnd).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::BeforeCompact).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::WaitingInput).is_some());
        assert!(a.map_cc_pane_event(&CcPaneEvent::Error).is_some());
    }

    #[test]
    fn map_cc_pane_event_matchers_match_expectations() {
        let a = ClaudeAdapter::new();
        let b = a.map_cc_pane_event(&CcPaneEvent::SessionResume).unwrap();
        assert_eq!(b.event, "SessionStart");
        assert_eq!(b.matcher.as_deref(), Some("resume|compact"));

        let b = a.map_cc_pane_event(&CcPaneEvent::BeforeCompact).unwrap();
        assert_eq!(b.event, "PreCompact");
        assert_eq!(b.matcher.as_deref(), Some("manual|auto"));

        let b = a.map_cc_pane_event(&CcPaneEvent::WaitingInput).unwrap();
        assert_eq!(b.event, "Notification");
        // WaitingInput 匹配多种通知类型
        assert!(b.matcher.as_deref().unwrap().contains("permission_prompt"));
    }

    #[test]
    fn render_cc_pane_tool_matcher_translates_tool_kinds() {
        let a = ClaudeAdapter::new();
        assert_eq!(a.render_cc_pane_tool_matcher(&ToolMatcher::any()), None);
        let m = ToolMatcher {
            tool: ToolKind::Bash,
            path_glob: None,
            bash_cmd_prefix: Some("rm -rf".into()),
        };
        assert_eq!(a.render_cc_pane_tool_matcher(&m).as_deref(), Some("Bash"));
        let m = ToolMatcher {
            tool: ToolKind::Write,
            path_glob: Some(".claude/**".into()),
            bash_cmd_prefix: None,
        };
        assert_eq!(a.render_cc_pane_tool_matcher(&m).as_deref(), Some("Write"));
    }
}
