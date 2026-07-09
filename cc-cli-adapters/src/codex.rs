//! Codex CLI 适配器

use crate::{
    resolve_executable, CcPaneEvent, CliAdapterContext, CliCommandResult, CliToolAdapter,
    CliToolCapabilities, CliToolInfo, NativeHookBinding, ProjectHookDefinition, ProjectHookStatus,
    ToolKind, ToolMatcher,
};
use anyhow::{anyhow, Context, Result};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::{env, fs};
use toml_edit::{DocumentMut, Item};
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

    /// 注入 `tui.terminal_title`：让 Codex 把会话 thread-id 写进终端标题（OSC 序列），
    /// CC-Panes 从 PTY 输出中解析它获得确定性 resume id（替代扫目录猜测）。
    /// 保留默认观感项（activity + project），thread-id 追加在末尾。
    /// 注意：`-c` 是整体覆盖，会暂时盖掉用户自定义的 terminal_title items，
    /// 仅影响 CC-Panes 启动的会话的窗口标题显示。
    pub(crate) fn push_terminal_title_override(args: &mut Vec<String>) {
        args.push("-c".to_string());
        args.push(r#"tui.terminal_title=["activity","project","thread-id"]"#.to_string());
    }

    fn push_mcp_overrides(&self, args: &mut Vec<String>, ctx: &CliAdapterContext) {
        if let (Some(port), Some(token)) = (ctx.orchestrator_port, ctx.orchestrator_token.as_ref())
        {
            let mut url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
            if let Some(launch_id) = ctx.launch_id.as_deref() {
                url.push_str("&launchId=");
                url.push_str(launch_id);
            }
            // token 通过 url 的 ?token= 传（orchestrator 鉴权中间件认 query token）。
            // 不再注入 bearer_token_env_var：Codex 的 dotted -c 只覆盖 .url，覆盖不掉
            // 全局 config.toml 里旧的 .bearer_token_env_var，缺 CC_PANES_API_TOKEN 环境
            // 变量时会启动失败（见 docs/18）。去掉对环境变量的依赖。
            Self::push_mcp_url_override(args, "ccpanes", &url);
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
        // 用 effective CODEX_HOME（尊重用户自定义 CODEX_HOME 环境变量），而非硬编码 ~/.codex，
        // 确保禁用列表枚举的是 Codex 实际加载的 config。
        let Some(home) = Self::real_codex_home() else {
            return BTreeSet::new();
        };
        Self::configured_mcp_server_names_from_config_path(&home.join("config.toml"))
    }

    fn real_codex_home() -> Option<PathBuf> {
        env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
    }

    fn migrate_stale_global_ccpanes_mcp_config() {
        #[cfg(test)]
        {
            return;
        }

        #[cfg(not(test))]
        {
            let Some(home) = Self::real_codex_home() else {
                return;
            };
            let path = home.join("config.toml");
            match Self::migrate_stale_global_ccpanes_mcp_config_at(&path) {
                Ok(true) => info!(
                    config = %path.display(),
                    "codex: removed stale global ccpanes MCP config"
                ),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    config = %path.display(),
                    error = %error,
                    "codex: failed to migrate stale global ccpanes MCP config"
                ),
            }
        }
    }

    fn migrate_stale_global_ccpanes_mcp_config_at(path: &Path) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }

        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read Codex config {}", path.display()))?;
        let mut document = content
            .parse::<DocumentMut>()
            .with_context(|| format!("failed to parse Codex config {}", path.display()))?;

        let should_remove = document
            .get("mcp_servers")
            .and_then(|servers| servers.get("ccpanes"))
            .map(Self::is_stale_global_ccpanes_mcp_config)
            .unwrap_or(false);

        if !should_remove {
            return Ok(false);
        }

        let backup_path = Self::sibling_path_with_suffix(path, ".bak");
        fs::copy(path, &backup_path).with_context(|| {
            format!(
                "failed to write Codex config backup {}",
                backup_path.display()
            )
        })?;

        if let Some(servers) = document
            .get_mut("mcp_servers")
            .and_then(Item::as_table_like_mut)
        {
            servers.remove("ccpanes");
        }

        Self::write_file_via_temp_rename(path, &document.to_string())?;
        Ok(true)
    }

    /// WSL 版 stale ccpanes 迁移：清掉 **WSL 内** `~/.codex/config.toml`（或 `$CODEX_HOME`）里
    /// 残留的旧 CC-Panes ccpanes 段——WSL codex 读的是 Linux 侧这份配置，本地迁移够不到它。
    /// 复用与本地完全相同的签名匹配 + 备份 + 原子写，只是文件经 `wsl.exe wslpath -w` 定位为
    /// Windows UNC 路径。best-effort，失败不阻断启动。
    #[cfg(windows)]
    pub fn migrate_stale_wsl_ccpanes_mcp_config(wsl_path: &Path, distro: &str) {
        let Some(win_path) = Self::resolve_wsl_codex_config_windows_path(wsl_path, distro) else {
            return;
        };
        match Self::migrate_stale_global_ccpanes_mcp_config_at(&win_path) {
            Ok(true) => info!(
                config = %win_path.display(),
                distro,
                "codex(wsl): removed stale global ccpanes MCP config"
            ),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                config = %win_path.display(),
                distro,
                error = %error,
                "codex(wsl): failed to migrate stale global ccpanes MCP config"
            ),
        }
    }

    #[cfg(not(windows))]
    pub fn migrate_stale_wsl_ccpanes_mcp_config(_wsl_path: &Path, _distro: &str) {}

    /// 在 WSL 内解析 codex config 路径（`$CODEX_HOME/config.toml`，否则 `$HOME/.codex/config.toml`），
    /// 存在则 `wslpath -w` 转成 Windows 可访问路径（UNC）。文件不存在 / 解析失败 → None。
    #[cfg(windows)]
    fn resolve_wsl_codex_config_windows_path(wsl_path: &Path, distro: &str) -> Option<PathBuf> {
        let script = r#"cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"; [ -f "$cfg" ] || exit 0; wslpath -w "$cfg""#;
        let output = crate::no_window_command(&wsl_path.to_string_lossy())
            .args(["-d", distro, "bash", "-lc", script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let win = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if win.is_empty() {
            None
        } else {
            Some(PathBuf::from(win))
        }
    }

    fn is_stale_global_ccpanes_mcp_config(server: &Item) -> bool {
        let old_url_signature = server
            .get("url")
            .and_then(Item::as_str)
            .map(Self::is_old_ccpanes_mcp_url)
            .unwrap_or(false);
        let old_bearer_env =
            server.get("bearer_token_env_var").and_then(Item::as_str) == Some("CC_PANES_API_TOKEN");
        old_url_signature || old_bearer_env
    }

    fn is_old_ccpanes_mcp_url(url: &str) -> bool {
        let Some(after_scheme) = url
            .strip_prefix("http://")
            .or_else(|| url.strip_prefix("https://"))
        else {
            return false;
        };

        let authority_end = after_scheme
            .find(['/', '?', '#'])
            .unwrap_or(after_scheme.len());
        let authority = after_scheme[..authority_end]
            .rsplit('@')
            .next()
            .unwrap_or_default();
        let host = if let Some(rest) = authority.strip_prefix('[') {
            rest.split(']').next().unwrap_or_default()
        } else {
            authority.split(':').next().unwrap_or_default()
        };
        let host = host.to_ascii_lowercase();
        let is_loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
        if !is_loopback {
            return false;
        }

        let path_and_after = &after_scheme[authority_end..];
        let path = path_and_after.split(['?', '#']).next().unwrap_or_default();
        if !path.starts_with("/mcp") {
            return false;
        }

        let query = path_and_after
            .split_once('?')
            .map(|(_, query)| query.split('#').next().unwrap_or_default())
            .unwrap_or_default();
        query
            .split('&')
            .filter(|part| !part.is_empty())
            .any(|part| part.split('=').next() == Some("token"))
    }

    fn sibling_path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut file_name = path
            .file_name()
            .unwrap_or_else(|| OsStr::new("config.toml"))
            .to_os_string();
        file_name.push(suffix);
        path.with_file_name(file_name)
    }

    fn write_file_via_temp_rename(path: &Path, content: &str) -> Result<()> {
        // 复用共享的加固原子写（temp + fsync + 带重试的 rename），避免各处重复实现，
        // 也修掉旧版 remove-then-rename 在第二步失败时目标文件消失的窗口。
        crate::fs_atomic::write_atomic(path, content)
    }

    /// 旧隔离目录根：历史上 CC-Panes 把 Codex 关进 `~/.cache/cc-panes/codex-home/{sessionId}`，
    /// 现已去隔离（直用真实 ~/.codex），此根仅用于一次性迁移旧会话历史。
    fn legacy_isolated_home_root() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".cache").join("cc-panes").join("codex-home"))
    }

    /// 一次性把旧隔离目录里的会话历史救回真实 ~/.codex/sessions，让旧对话能 resume。
    ///
    /// 旧隔离目录结构为 `<root>/<sessionId>/sessions/YYYY/MM/DD/rollout-*.jsonl`。
    /// 按原相对路径补齐到真实 home 的 sessions 下（目标已存在则跳过，绝不覆盖）。
    /// best-effort：任何步骤失败都不阻断启动；用 marker 文件避免每次启动重扫。
    fn migrate_legacy_isolated_sessions() {
        let Some(root) = Self::legacy_isolated_home_root() else {
            return;
        };
        let marker = root.parent().map(|p| p.join(".codex-home-migrated"));
        if let Some(ref m) = marker {
            if m.exists() {
                return;
            }
        }
        let Some(real_home) = Self::real_codex_home() else {
            return;
        };
        let real_sessions = real_home.join("sessions");

        let Ok(entries) = fs::read_dir(&root) else {
            // 根不存在（从未隔离过）也算"已迁移"，写 marker 避免反复 read_dir。
            if let Some(ref m) = marker {
                let _ = fs::write(m, "");
            }
            return;
        };

        for entry in entries.flatten() {
            let src_sessions = entry.path().join("sessions");
            if !src_sessions.is_dir() {
                continue;
            }
            Self::copy_sessions_tree(&src_sessions, &real_sessions);
        }

        if let Some(ref m) = marker {
            let _ = fs::write(m, "");
        }
    }

    /// 递归拷贝 sessions 子树，目标已存在的文件跳过（不覆盖真实历史）。best-effort。
    fn copy_sessions_tree(src: &Path, dst: &Path) {
        let Ok(entries) = fs::read_dir(src) else {
            return;
        };
        if fs::create_dir_all(dst).is_err() {
            return;
        }
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let child_src = entry.path();
            let child_dst = dst.join(entry.file_name());
            if file_type.is_dir() {
                Self::copy_sessions_tree(&child_src, &child_dst);
            } else if file_type.is_file() && !child_dst.exists() {
                let _ = fs::copy(&child_src, &child_dst);
            }
        }
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
        Self::apply_hooks_feature_keys(features_table, Self::codex_uses_hooks_key_only());
        Self::write_config_toml(project_path, &config)
    }

    /// 按 `hooks_only` 写 `[features]` 下的 hooks 相关键（纯函数，便于确定性单测）：
    /// - `hooks_only=true`（Codex >= 0.135）：只写新 `hooks`，并清除已废弃的 `codex_hooks`，
    ///   避免 0.136 的 deprecated 警告。
    /// - `hooks_only=false`（旧版 / 版本探测失败）：双写 `hooks` + `codex_hooks`，确保旧版
    ///   Codex 仍能识别 hook（保守、不丢功能）。
    fn apply_hooks_feature_keys(features_table: &mut toml::value::Table, hooks_only: bool) {
        features_table.insert("hooks".to_string(), toml::Value::Boolean(true));
        if hooks_only {
            features_table.remove("codex_hooks");
        } else {
            features_table.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
        }
    }

    /// 是否采用「仅新 hooks 键」写法：探测 host `codex --version` 是否 >= 0.135，
    /// 进程内缓存只跑一次。探测失败 / 无法解析版本 → false（保守双写）。
    /// 注：WSL 启动写的 config 由 WSL 内 codex 读取，此处以 host codex 版本近似（host 与
    /// WSL 的 codex 通常同源）；探测失败回退双写对两侧都安全，不会让旧版丢 hook。
    fn codex_uses_hooks_key_only() -> bool {
        use std::sync::OnceLock;
        static CACHE: OnceLock<bool> = OnceLock::new();
        *CACHE.get_or_init(|| {
            Self::detect_host_codex_version()
                .map(|(major, minor)| (major, minor) >= (0, 135))
                .unwrap_or(false)
        })
    }

    /// 跑 host `codex --version` 并解析 `(major, minor)`；失败返回 None。
    fn detect_host_codex_version() -> Option<(u32, u32)> {
        let path = resolve_executable("codex").ok()?;
        let mut cmd = std::process::Command::new(path);
        cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        Self::parse_codex_version(&String::from_utf8_lossy(&output.stdout))
    }

    /// 从 `codex-cli 0.136.0` 之类文本中解析首个 `X.Y` 版本号。
    fn parse_codex_version(text: &str) -> Option<(u32, u32)> {
        for token in text.split_whitespace() {
            let cleaned = token.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            let mut parts = cleaned.split('.');
            if let (Some(major), Some(minor)) = (parts.next(), parts.next()) {
                if let (Ok(major), Ok(minor)) = (major.parse::<u32>(), minor.parse::<u32>()) {
                    return Some((major, minor));
                }
            }
        }
        None
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
        let mut args = Vec::new();
        let env_inject = HashMap::new();

        // 不隔离 CODEX_HOME：Codex 直接使用真实 ~/.codex（与 Claude 一致），
        // 这样 `codex resume <id>` 能命中真实 sessions、ccswitch 换 provider 后历史不丢。
        // MCP 隔离改由 per-launch `-c` override 完成（见下），无需复制/sanitize home。
        // 一次性把历史遗留的隔离会话救回真实 home（带 marker，幂等、best-effort）。
        Self::migrate_legacy_isolated_sessions();
        Self::migrate_stale_global_ccpanes_mcp_config();

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

        // 标题带 thread-id：resume 与新会话都注入（resume 后活跃线程 id 同样经标题回报）
        Self::push_terminal_title_override(&mut args);

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

        let (command, args) = ctx.resolve_launch("codex", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            resume_id = ?ctx.resume_id,
            args = ?crate::redact_args_for_log(&args),
            "codex: build_command result"
        );

        Ok(CliCommandResult {
            command,
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

    fn test_context(executable_override: Option<&str>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "test-session".to_string(),
            project_path: "/tmp/project".to_string(),
            workspace_path: None,
            provider: None,
            executable_override: executable_override.map(str::to_string),
            adapter_options: Default::default(),
            resume_id: Some("thread-123".to_string()),
            issued_session_id: None,
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

        // codex_hooks 是否写入取决于 host codex 版本（版本门控）；integration 测试只断言
        // 版本无关的 hooks=true，版本门控行为由 apply_hooks_feature_keys 单测覆盖。
        assert!(config.contains("hooks = true"));
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
    fn build_command_uses_executable_override() {
        let adapter = CodexAdapter::new();
        let ctx = test_context(Some("/opt/codex-next/bin/codex"));

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(result.command, "/opt/codex-next/bin/codex");
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "resume" && pair[1] == "thread-123"));
        assert_eq!(result.args.last().map(String::as_str), Some("hello"));
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

        // 见上：codex_hooks 受 host codex 版本门控，integration 测试只断言 hooks=true。
        assert!(config.contains("hooks = true"));
        assert!(hooks.contains("/mnt/c/Users/wuxiran"));
        assert!(hooks.contains("session-init"));
    }

    #[test]
    fn apply_hooks_feature_keys_version_gated() {
        // hooks_only=true（Codex >= 0.135）：写新 hooks 键并清除已废弃的 codex_hooks。
        let mut table = toml::value::Table::new();
        table.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
        CodexAdapter::apply_hooks_feature_keys(&mut table, true);
        assert_eq!(table.get("hooks"), Some(&toml::Value::Boolean(true)));
        assert!(
            table.get("codex_hooks").is_none(),
            "legacy codex_hooks must be cleared on Codex >= 0.135"
        );

        // hooks_only=false（旧版 / 版本探测失败）：双写，旧 Codex 不丢 hook。
        let mut table = toml::value::Table::new();
        CodexAdapter::apply_hooks_feature_keys(&mut table, false);
        assert_eq!(table.get("hooks"), Some(&toml::Value::Boolean(true)));
        assert_eq!(table.get("codex_hooks"), Some(&toml::Value::Boolean(true)));
    }

    #[test]
    fn parse_codex_version_extracts_major_minor() {
        assert_eq!(
            CodexAdapter::parse_codex_version("codex-cli 0.136.0"),
            Some((0, 136))
        );
        assert_eq!(
            CodexAdapter::parse_codex_version("codex 0.135.0\n"),
            Some((0, 135))
        );
        assert_eq!(
            CodexAdapter::parse_codex_version("0.134.2 (build abc)"),
            Some((0, 134))
        );
        assert_eq!(CodexAdapter::parse_codex_version("no version here"), None);
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
        CodexAdapter::push_mcp_enabled_override(&mut args, "ccpanes", false);

        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.\"context 7\".url=\"http://127.0.0.1:3100/mcp\"",
                "-c",
                "mcp_servers.ccpanes.enabled=false",
            ]
        );
    }

    #[test]
    fn ccpanes_mcp_overrides_omit_bearer_env_var() {
        let adapter = CodexAdapter::new();
        let mut ctx = test_context(Some("/opt/codex"));
        ctx.skip_mcp = false;
        ctx.resume_id = None;
        ctx.orchestrator_port = Some(37123);
        ctx.orchestrator_token = Some("secret-token".to_string());
        ctx.launch_id = Some("launch-1".to_string());

        let mut args = Vec::new();
        adapter.push_mcp_overrides(&mut args, &ctx);

        assert!(args.iter().any(|arg| arg
            == "mcp_servers.ccpanes.url=\"http://127.0.0.1:37123/mcp?token=secret-token&launchId=launch-1\""));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.ccpanes.enabled=true"));
        assert!(!args.iter().any(|arg| arg.contains("bearer_token_env_var")));
    }

    #[test]
    fn stale_global_ccpanes_config_is_removed_with_backup() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(
            &config_path,
            r#"# keep root comment
model = "gpt-5"

[mcp_servers.fetch]
url = "http://127.0.0.1:3000/mcp"

# stale CC-Panes entry
[mcp_servers.ccpanes]
bearer_token_env_var = "CC_PANES_API_TOKEN"
url = "http://127.0.0.1:37123/mcp?token=redacted"
"#,
        )
        .unwrap();

        assert!(CodexAdapter::migrate_stale_global_ccpanes_mcp_config_at(&config_path).unwrap());

        let migrated = fs::read_to_string(&config_path).unwrap();
        assert!(migrated.contains("# keep root comment"));
        assert!(migrated.contains("[mcp_servers.fetch]"));
        assert!(!migrated.contains("[mcp_servers.ccpanes]"));
        assert!(!migrated.contains("CC_PANES_API_TOKEN"));

        let backup_path = CodexAdapter::sibling_path_with_suffix(&config_path, ".bak");
        let backup = fs::read_to_string(backup_path).unwrap();
        assert!(backup.contains("[mcp_servers.ccpanes]"));
        assert!(backup.contains("CC_PANES_API_TOKEN"));
    }

    #[test]
    fn non_matching_global_ccpanes_config_is_preserved() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(
            &config_path,
            r#"[mcp_servers.ccpanes]
url = "https://example.com/mcp"
bearer_token_env_var = "USER_TOKEN"
"#,
        )
        .unwrap();

        assert!(!CodexAdapter::migrate_stale_global_ccpanes_mcp_config_at(&config_path).unwrap());

        let migrated = fs::read_to_string(&config_path).unwrap();
        assert!(migrated.contains("[mcp_servers.ccpanes]"));
        assert!(migrated.contains("USER_TOKEN"));
        assert!(!CodexAdapter::sibling_path_with_suffix(&config_path, ".bak").exists());
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
    fn copy_sessions_tree_migrates_by_relative_path_and_skips_existing() {
        let legacy = tempdir().unwrap();
        let real = tempdir().unwrap();

        // 旧隔离目录的 sessions 子树：sessions/2026/05/30/rollout-a.jsonl
        let leg_day = legacy.path().join("2026").join("05").join("30");
        fs::create_dir_all(&leg_day).unwrap();
        fs::write(leg_day.join("rollout-a.jsonl"), "legacy-a").unwrap();
        fs::write(leg_day.join("rollout-b.jsonl"), "legacy-b").unwrap();

        // 真实 home 已存在同相对路径的 rollout-b（内容不同），迁移须跳过、不覆盖
        let real_day = real.path().join("2026").join("05").join("30");
        fs::create_dir_all(&real_day).unwrap();
        fs::write(real_day.join("rollout-b.jsonl"), "REAL-b").unwrap();

        CodexAdapter::copy_sessions_tree(legacy.path(), real.path());

        // 新文件按原相对路径补齐
        assert_eq!(
            fs::read_to_string(real_day.join("rollout-a.jsonl")).unwrap(),
            "legacy-a"
        );
        // 已存在的不被覆盖
        assert_eq!(
            fs::read_to_string(real_day.join("rollout-b.jsonl")).unwrap(),
            "REAL-b"
        );
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
