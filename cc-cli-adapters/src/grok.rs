//! xAI Grok CLI（Grok Build）适配器
//!
//! 实机核对（grok 0.2.101）：
//! - resume：`--resume <id>`；新会话可用 `--session-id <uuid>` 预发确定性 id（同 Claude 模式，
//!   无需 Codex 那套 OSC 标题捕获）。`--session-id` 只用于新会话，与 `--resume` 互斥。
//! - YOLO：`--always-approve`；系统提示词追加：`--rules <RULES>`；初始 prompt 为位置参数。
//! - 模型：`-m, --model <MODEL>`。
//! - per-launch 参数：`--reasoning-effort <EFFORT>`（别名 `--effort`）、`--max-turns <N>`。
//!   **effort 取值枚举未知**：`--help` 未列 possible values，实测传非法值不被 clap 拒绝，
//!   故按自由字符串透传档位名；若日后发现 Grok 只认某个子集，在此收窄。
//!   verbose **无对应 flag**（`--debug`/`--debug-file` 是写日志，语义不同），不映射。
//! - 未映射但存在的能力（按需再接）：`--permission-mode`（六档，比 YOLO 二元更细）、
//!   `--no-plan`（禁用 plan mode）、`-w/--worktree`（原生 worktree）、`--fork-session`。
//! - MCP：无 `--mcp-config` / `-c key=val` 之类 per-launch override（`-c` 是 `--continue`）。
//!   docs/110 批 2 起写**项目级** `.grok/config.toml` 的 `[mcp_servers.<name>]`（收据驱动，见
//!   [`crate::project_mcp`]）：Grok 从 cwd 走到 git 根读每个 `.grok/config.toml`，并在
//!   `url`/`headers`/`env`/`args` 里展开 `${VAR}`（docs.x.ai/build/features/mcp-servers），所以
//!   ccpanes 的端口 / token / launchId 都写成占位符，真实值走本会话环境变量——文件里没有秘密，
//!   并发会话也各带各的身份。`.mcp.json` 等 compat 来源优先级低于 config.toml，故选它。
//!   此前写进用户级 `~/.grok/config.toml` 的旧条目首次启动时清掉（`migrate_legacy_user_mcp`）。

use crate::{
    CcPaneEvent, CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities,
    CliToolInfo, NativeHookBinding, ToolKind, ToolMatcher,
};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item};
use tracing::{info, warn};

const CC_PANE_EVENT_UNSUPPORTED: &str =
    "Grok CLI does not expose a confirmed native hook for this event yet.";

/// Grok 屏幕模式覆盖环境变量（0.2.101 二进制取证：字符串紧邻
/// "Reopening session in X mode"）。与 `--fullscreen`/`--minimal` flag 不同，
/// env 逐进程生效、**不 sticky**——不会把 `screen_mode` 写回用户全局 config.toml。
const GROK_SCREEN_MODE_ENV: &str = "GROK_SCREEN_MODE";

/// `adapterOptions.screenMode` → 屏幕模式。缺省 / 非法值 → `fullscreen`；
/// `inherit` = 不注入（尊重用户自己的环境变量与全局 `[ui] screen_mode` 配置）。
fn screen_mode_from_options(options: &HashMap<String, serde_json::Value>) -> String {
    options
        .get("screenMode")
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "fullscreen" | "minimal" | "inherit"))
        .unwrap_or_else(|| "fullscreen".to_string())
}

pub struct GrokAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl GrokAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "grok".into(),
                display_name: "Grok CLI".into(),
                executable: "grok".into(),
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
                // `--rules <RULES>`：追加到 system prompt（实机 --help 确认）
                supports_system_prompt: true,
                supports_workspace: false,
                supports_project_hooks: false,
                supports_issued_session_id: true,
                supports_rpc: false,
                supports_structured_result: false,
                supports_yolo: true,
                supports_orchestrated_launch: true,
                // `--reasoning-effort` / `--max-turns` 实机确认存在；
                // verbose 无对应 flag（`--debug` 是写日志，语义不同）
                supports_effort_option: true,
                supports_verbose_option: false,
                supports_max_turns_option: true,
                compatible_provider_types: vec!["grok".into()],
            },
        }
    }

    /// Grok 主目录：尊重用户自定义 `$GROK_HOME`，否则 `~/.grok`。
    fn real_grok_home() -> Option<PathBuf> {
        env::var_os("GROK_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
    }

    fn user_config_path() -> Option<PathBuf> {
        Self::real_grok_home().map(|home| home.join("config.toml"))
    }

    /// 判断 URL 是否具备 CC-Panes ccpanes MCP 签名：loopback host + `/mcp` 路径 + `token=` query。
    /// 只有匹配签名的 entry 才视为 CC-Panes 所有，允许更新/清除；用户手工配置的同名
    /// entry（签名不符）一律保留不动。
    fn is_ccpanes_mcp_url(url: &str) -> bool {
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
        if host != "localhost" && host != "127.0.0.1" && host != "::1" {
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

    /// entry 是否由 CC-Panes 管理（URL 匹配 ccpanes 签名）。
    fn is_ccpanes_managed_entry(server: &Item) -> bool {
        server
            .get("url")
            .and_then(Item::as_str)
            .map(Self::is_ccpanes_mcp_url)
            .unwrap_or(false)
    }

    /// 一次性迁移（docs/110 批 2）：清掉以前写进用户级 config.toml 的条目——签名匹配的
    /// `ccpanes`，以及与本次共享 MCP 同名、且只剩我们当年写的 `url` + `enabled` 两个键的条目。
    /// 完成后在数据目录落标记，之后不再碰用户级文件。
    fn migrate_legacy_user_mcp(ctx: &CliAdapterContext) {
        if ctx.skip_mcp {
            return;
        }
        let marker = ctx
            .data_dir
            .join("cli-adapters")
            .join("grok")
            .join("user-mcp-migrated-v1");
        if marker.exists() {
            return;
        }
        let Some(path) = Self::user_config_path() else {
            return;
        };
        match Self::remove_legacy_entries_at(&path, &ctx.shared_mcp_urls) {
            Ok(changed) => {
                if changed {
                    info!(config = %path.display(), "grok: removed legacy user-level MCP entries");
                }
                let _ = fs::create_dir_all(marker.parent().unwrap_or(&ctx.data_dir));
                let _ = fs::write(&marker, b"1\n");
            }
            Err(error) => warn!(%error, "grok: failed to migrate legacy user-level MCP entries"),
        }
    }

    fn remove_legacy_entries_at(path: &Path, shared: &HashMap<String, String>) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let original = fs::read_to_string(path)
            .with_context(|| format!("failed to read Grok config {}", path.display()))?;
        let mut document = original
            .parse::<DocumentMut>()
            .with_context(|| format!("failed to parse Grok config {}", path.display()))?;
        let Some(servers) = document
            .get_mut("mcp_servers")
            .and_then(Item::as_table_like_mut)
        else {
            return Ok(false);
        };
        let mut stale: Vec<String> = Vec::new();
        if servers
            .get("ccpanes")
            .is_some_and(Self::is_ccpanes_managed_entry)
        {
            stale.push("ccpanes".to_string());
        }
        for (name, url) in shared {
            let ours = servers
                .get(name)
                .and_then(Item::as_table_like)
                .is_some_and(|entry| {
                    entry.len() == 2
                        && entry.get("url").and_then(Item::as_str) == Some(url.as_str())
                        && entry.get("enabled").and_then(Item::as_bool) == Some(true)
                });
            if ours {
                stale.push(name.clone());
            }
        }
        if stale.is_empty() {
            return Ok(false);
        }
        let mut orphaned_comments = Vec::new();
        for name in &stale {
            if let Some(Item::Table(table)) = servers.remove(name) {
                // 用户写在被删表头上方的注释属于这张表的 decor，删表会把它一起带走
                let prefix = table.decor().prefix().and_then(|raw| raw.as_str());
                if let Some(prefix) = prefix.filter(|text| text.contains('#')) {
                    orphaned_comments.push((table.position(), prefix.to_string()));
                }
            }
        }
        for (position, comment) in orphaned_comments {
            reattach_comment(&mut document, position, &comment);
        }
        let _ = fs::copy(path, Self::sibling_path_with_suffix(path, ".bak"));
        crate::fs_atomic::write_atomic(path, document.to_string())?;
        Ok(true)
    }

    fn remove_ccpanes_entry_at(path: &Path) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let original = fs::read_to_string(path)
            .with_context(|| format!("failed to read Grok config {}", path.display()))?;
        let mut document = original
            .parse::<DocumentMut>()
            .with_context(|| format!("failed to parse Grok config {}", path.display()))?;

        let managed = document
            .get("mcp_servers")
            .and_then(|servers| servers.get("ccpanes"))
            .map(Self::is_ccpanes_managed_entry)
            .unwrap_or(false);
        if !managed {
            return Ok(false);
        }

        if let Some(servers) = document
            .get_mut("mcp_servers")
            .and_then(Item::as_table_like_mut)
        {
            servers.remove("ccpanes");
        }
        crate::fs_atomic::write_atomic(path, document.to_string())?;
        Ok(true)
    }

    fn sibling_path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut file_name = path
            .file_name()
            .unwrap_or_else(|| OsStr::new("config.toml"))
            .to_os_string();
        file_name.push(suffix);
        path.with_file_name(file_name)
    }
}

/// 把被删表头上方的注释挂到文档顺序里的下一张表上（没有就放到文件末尾）。
fn reattach_comment(document: &mut DocumentMut, position: Option<usize>, comment: &str) {
    fn collect(
        table: &toml_edit::Table,
        path: &mut Vec<String>,
        out: &mut Vec<(usize, Vec<String>)>,
    ) {
        for (key, item) in table.iter() {
            if let Item::Table(child) = item {
                path.push(key.to_string());
                if let (Some(pos), false) = (child.position(), child.is_implicit()) {
                    out.push((pos, path.clone()));
                }
                collect(child, path, out);
                path.pop();
            }
        }
    }
    let after = position.unwrap_or(0);
    let mut candidates = Vec::new();
    collect(document.as_table(), &mut Vec::new(), &mut candidates);
    let next = candidates
        .into_iter()
        .filter(|(pos, _)| *pos > after)
        .min_by_key(|(pos, _)| *pos)
        .map(|(_, path)| path);
    let target = next.and_then(|path| {
        let mut table = document.as_table_mut();
        for key in &path {
            table = table.get_mut(key)?.as_table_mut()?;
        }
        Some(table)
    });
    match target {
        Some(table) => {
            let existing = table
                .decor()
                .prefix()
                .and_then(|raw| raw.as_str())
                .unwrap_or("")
                .to_string();
            table.decor_mut().set_prefix(format!("{comment}{existing}"));
        }
        None => {
            let trailing = document.trailing().as_str().unwrap_or("").to_string();
            document.set_trailing(format!("{trailing}{comment}"));
        }
    }
}

impl Default for GrokAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for GrokAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    /// docs/110 当前注入面，守卫见 tests/injection_profile_honesty.rs。
    /// - MCP（批 2）：项目级 `.grok/config.toml`（同项目会话共享），ccpanes 与远程请求头都用
    ///   `${VAR}` 占位符，各会话展开成自己的端口 / token / launchId；没有 SSE；隔离只能声明。
    /// - 技能（批 1）：挂载根经 `--plugin-dir`（Claude 插件布局）；`--rules` 是提示词通道。WSL 不经
    ///   adapter、不传挂载，技能只靠提示词回退（Partial），MCP 只有 ccpanes（Partial）。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        InjectionProfile {
            mcp: project_file_mcp(false, true, vec![]),
            skills: SkillsInjection {
                mount: SkillMount::PluginDir,
                prompt_fallback: true,
                native_sources: vec![],
            },
            runtimes: InjectionRuntimes {
                wsl: RuntimeInjection {
                    launch: true,
                    mcp: RuntimeSupport::Partial,
                    skills: RuntimeSupport::Partial,
                },
                ssh: RuntimeInjection::launch_only(),
            },
        }
    }

    fn cleanup_user_injections(&self) -> Result<Vec<PathBuf>> {
        let Some(path) = Self::user_config_path() else {
            return Ok(Vec::new());
        };
        if Self::remove_ccpanes_entry_at(&path)? {
            Ok(vec![path])
        } else {
            Ok(Vec::new())
        }
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        // Wallpaper transparency is handled by the terminal renderer; keep
        // Grok's native full TUI behavior.
        let mut args = Vec::new();

        crate::push_model_arg(&mut args, ctx);

        // MCP：项目级 `.grok/config.toml`（见模块头）。隔离请求只能声明：per-launch disable
        // 做不到，写进项目文件的 enabled=false 会影响同项目的其他会话（由写入器统一 warn）。
        Self::migrate_legacy_user_mcp(ctx);
        let mcp = crate::project_mcp::sync_for_launch(
            ctx,
            &crate::project_mcp_dialects::GROK,
            &crate::project_mcp::ccpanes_http(ctx),
        );

        // Resume 优先；新会话由 CC-Panes 预发确定性 id（同 Claude 模式）
        if let Some(ref rid) = ctx.resume_id {
            args.push("--resume".to_string());
            args.push(rid.clone());
        } else if let Some(ref issued) = ctx.issued_session_id {
            args.push("--session-id".to_string());
            args.push(issued.clone());
        }

        if ctx.yolo_mode {
            args.push("--always-approve".to_string());
        }

        // `--rules`：追加到 system prompt（Grok 的 --append-system-prompt 等价物）
        if let Some(prompt) = ctx
            .append_system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
        {
            args.push("--rules".to_string());
            args.push(prompt.to_string());
        }

        // 技能挂载（docs/110 批 1）：Grok 原生兼容 Claude 插件布局，`--plugin-dir <PATH>`
        // 可重复（docs.x.ai/build/features/skills-plugins-marketplaces），挂载根直接传。
        for plugin_dir in &ctx.skill_mount_paths {
            if Path::new(plugin_dir).is_dir() {
                args.push("--plugin-dir".to_string());
                args.push(plugin_dir.clone());
            }
        }

        // effort → `--reasoning-effort <v>`（实机 --help 确认该 flag 存在，别名 --effort）。
        // 与 codex 不同：Grok 未在 --help 里声明取值枚举，实测传非法值也不被 clap 拒绝
        // （先撞的是未登录错误），故按自由字符串透传 CC-Panes 的档位名，不做映射收窄。
        if let Some(effort) = crate::effort_from_options(&ctx.adapter_options) {
            args.push("--reasoning-effort".to_string());
            args.push(effort);
        }

        // maxTurns → `--max-turns <N>`（实机 --help 确认）
        if let Some(max_turns) = crate::max_turns_from_options(&ctx.adapter_options) {
            args.push("--max-turns".to_string());
            args.push(max_turns.to_string());
        }

        // verbose 无对应 flag（Grok 只有 --debug / --debug-file，语义是写调试日志而非
        // 终端详细输出），故不映射；能力位 supports_verbose_flag=false 让前端置灰。

        // extraArgs 追加在位置参数 prompt 之前（逃生阀：用户可自行补任何 flag）
        args.extend(crate::extra_args_from_options(&ctx.adapter_options));

        // [PROMPT] 位置参数（必须在所有 --option 之后）
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        let (command, args) = ctx.resolve_launch("grok", args)?;

        // Grok 的托管会话默认使用 fullscreen；滚轮是否可用由终端的
        // alternate-buffer / mouse-report / viewport 链路独立决定。
        let mut env_inject = mcp.env;
        let screen_mode = screen_mode_from_options(&ctx.adapter_options);
        if screen_mode != "inherit" {
            env_inject.insert(GROK_SCREEN_MODE_ENV.to_string(), screen_mode);
        }

        info!(
            session_id = %ctx.session_id,
            command = %command,
            resume_id = ?ctx.resume_id,
            issued_session_id = ?ctx.issued_session_id,
            screen_mode_env = ?env_inject.get(GROK_SCREEN_MODE_ENV),
            args = ?crate::redact_args_for_log(&args),
            "grok: build_command result"
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
    // Grok Build 的 hook 事件名与 Claude 高度同构（SessionStart / PostToolUse /
    // UserPromptSubmit / Stop / Notification 等）。此层是纯映射，不依赖 hooks
    // 配置文件位置；`supports_project_hooks` 待实机确认配置面后再开启。

    fn map_cc_pane_event(&self, event: &CcPaneEvent) -> Option<NativeHookBinding> {
        match event {
            CcPaneEvent::SessionInit => {
                Some(NativeHookBinding::new("SessionStart", Some("startup"), 10))
            }
            CcPaneEvent::SessionResume => {
                Some(NativeHookBinding::new("SessionStart", Some("resume"), 10))
            }
            CcPaneEvent::SessionEnd => Some(NativeHookBinding::new("SessionEnd", None, 5)),
            CcPaneEvent::PromptBefore => Some(NativeHookBinding::new("UserPromptSubmit", None, 10)),
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
            // 与 Claude 同口径收窄到两类：grok 每个工具前都会发例行
            // permission_prompt 通知（bypass 模式也发），无 matcher 会把
            // 「正在跑工具」全判成 waiting——cli-hook 侧另有例行文案丢弃兜底。
            CcPaneEvent::WaitingInput => Some(NativeHookBinding::new(
                "Notification",
                Some("permission_prompt|elicitation_dialog"),
                5,
            )),
            // Grok 有 PreCompact / StopFailure 事件的文档线索但未实机确认，先不映射
            CcPaneEvent::BeforeCompact | CcPaneEvent::Error => None,
        }
    }

    fn unsupported_cc_pane_event_reason(&self, event: &CcPaneEvent) -> Option<&'static str> {
        match event {
            CcPaneEvent::BeforeCompact | CcPaneEvent::Error => Some(CC_PANE_EVENT_UNSUPPORTED),
            _ => None,
        }
    }

    fn render_cc_pane_tool_matcher(&self, matcher: &ToolMatcher) -> Option<String> {
        // Grok matcher 与 Claude 同形（精确名 / `|` 分隔）；path_glob / bash_cmd_prefix
        // 细粒度判断留给 hook 子命令在 stdin 解析阶段完成。
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
            resume_id: None,
            issued_session_id: None,
            skip_mcp: true,
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
    fn build_command_injects_fullscreen_screen_mode_by_default() {
        let adapter = GrokAdapter::new();
        let ctx = test_context(Some("/opt/grok/bin/grok"));

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(
            result
                .env_inject
                .get(GROK_SCREEN_MODE_ENV)
                .map(String::as_str),
            Some("fullscreen"),
        );
    }

    #[test]
    fn build_command_screen_mode_option_overrides_default() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.adapter_options
            .insert("screenMode".into(), "minimal".into());

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(
            result
                .env_inject
                .get(GROK_SCREEN_MODE_ENV)
                .map(String::as_str),
            Some("minimal"),
        );
    }

    #[test]
    fn build_command_screen_mode_inherit_skips_injection() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.adapter_options
            .insert("screenMode".into(), "inherit".into());

        let result = adapter.build_command(&ctx).unwrap();

        assert!(!result.env_inject.contains_key(GROK_SCREEN_MODE_ENV));
    }

    #[test]
    fn build_command_invalid_screen_mode_falls_back_to_fullscreen() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.adapter_options
            .insert("screenMode".into(), "bogus".into());

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(
            result
                .env_inject
                .get(GROK_SCREEN_MODE_ENV)
                .map(String::as_str),
            Some("fullscreen"),
        );
    }

    #[test]
    fn build_command_resume_takes_priority_over_issued_id() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.resume_id = Some("session-abc".to_string());
        ctx.issued_session_id = Some("issued-should-be-ignored".to_string());
        ctx.initial_prompt = Some("hello".to_string());

        let result = adapter.build_command(&ctx).unwrap();

        assert_eq!(result.command, "/opt/grok/bin/grok");
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--resume" && pair[1] == "session-abc"));
        assert!(!result.args.iter().any(|arg| arg == "--session-id"));
        assert_eq!(result.args.last().map(String::as_str), Some("hello"));
    }

    #[test]
    fn build_command_maps_per_launch_effort_and_max_turns() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.adapter_options.insert("effort".into(), "high".into());
        ctx.adapter_options
            .insert("maxTurns".into(), serde_json::json!(12));
        ctx.adapter_options
            .insert("extraArgs".into(), serde_json::json!(["--no-memory"]));
        ctx.initial_prompt = Some("do the thing".to_string());

        let result = adapter.build_command(&ctx).unwrap();

        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--reasoning-effort" && pair[1] == "high"));
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--max-turns" && pair[1] == "12"));
        assert!(result.args.iter().any(|arg| arg == "--no-memory"));
        // 位置参数 prompt 必须排在所有 option 之后，否则 Grok 会把后续 flag 当 prompt 的一部分。
        assert_eq!(result.args.last().map(String::as_str), Some("do the thing"));
    }

    #[test]
    fn build_command_skips_unset_and_invalid_per_launch_options() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        // "default"/未知档不是合法 effort，不得注入空 flag。
        ctx.adapter_options
            .insert("effort".into(), "default".into());
        // verbose 在 Grok 上无对应 flag，即使传了也不能凭空造一个。
        ctx.adapter_options
            .insert("verbose".into(), serde_json::json!(true));

        let result = adapter.build_command(&ctx).unwrap();

        assert!(!result.args.iter().any(|arg| arg == "--reasoning-effort"));
        assert!(!result.args.iter().any(|arg| arg == "--max-turns"));
        assert!(!result.args.iter().any(|arg| arg == "--verbose"));
        assert!(!result.args.iter().any(|arg| arg == "--debug"));
    }

    #[test]
    fn build_command_new_session_uses_issued_session_id() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.issued_session_id = Some("11111111-2222-3333-4444-555555555555".to_string());

        let result = adapter.build_command(&ctx).unwrap();

        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--session-id"
                && pair[1] == "11111111-2222-3333-4444-555555555555"));
        assert!(!result.args.iter().any(|arg| arg == "--resume"));
    }

    #[test]
    fn build_command_keeps_full_tui() {
        let adapter = GrokAdapter::new();
        let ctx = test_context(Some("/opt/grok/bin/grok"));

        let result = adapter.build_command(&ctx).unwrap();

        assert!(!result.args.iter().any(|arg| arg == "--mini"));
        assert!(!result.args.iter().any(|arg| arg == "--minimal"));
    }

    #[test]
    fn yolo_mode_appends_always_approve() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.yolo_mode = true;

        let result = adapter.build_command(&ctx).unwrap();

        assert!(result.args.iter().any(|arg| arg == "--always-approve"));
    }

    #[test]
    fn append_system_prompt_uses_rules_flag() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.append_system_prompt = Some("CC-Panes launch profile skill".to_string());

        let result = adapter.build_command(&ctx).unwrap();

        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--rules" && pair[1] == "CC-Panes launch profile skill"));
    }

    #[test]
    fn blank_system_prompt_is_skipped() {
        let adapter = GrokAdapter::new();
        let mut ctx = test_context(Some("/opt/grok/bin/grok"));
        ctx.append_system_prompt = Some("   ".to_string());

        let result = adapter.build_command(&ctx).unwrap();

        assert!(!result.args.iter().any(|arg| arg == "--rules"));
    }

    #[test]
    fn legacy_user_entries_are_removed_but_user_servers_survive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"# my grok config
[mcp_servers.ccpanes]
url = "http://127.0.0.1:37123/mcp?token=secret"
enabled = true

[mcp_servers.shared-a]
url = "http://127.0.0.1:41000/mcp"
enabled = true

[mcp_servers.shared-b]
url = "http://127.0.0.1:41001/mcp"
enabled = true
startup_timeout_sec = 60

[mcp_servers.fetch]
url = "http://127.0.0.1:3000/mcp"
"#,
        )
        .unwrap();
        let shared = HashMap::from([
            (
                "shared-a".to_string(),
                "http://127.0.0.1:41000/mcp".to_string(),
            ),
            (
                "shared-b".to_string(),
                "http://127.0.0.1:41001/mcp".to_string(),
            ),
        ]);
        assert!(GrokAdapter::remove_legacy_entries_at(&path, &shared).unwrap());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("# my grok config"));
        assert!(!content.contains("[mcp_servers.ccpanes]"));
        assert!(!content.contains("[mcp_servers.shared-a]"));
        // 用户改过（多了键）的同名条目不是我们写的原样，保留
        assert!(content.contains("[mcp_servers.shared-b]"));
        assert!(content.contains("[mcp_servers.fetch]"));
        assert!(!GrokAdapter::remove_legacy_entries_at(&path, &shared).unwrap());
    }

    #[test]
    fn remove_ccpanes_entry_only_removes_managed_entry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"[mcp_servers.fetch]
url = "http://127.0.0.1:3000/mcp"

[mcp_servers.ccpanes]
url = "http://127.0.0.1:37123/mcp?token=secret"
enabled = true
"#,
        )
        .unwrap();

        assert!(GrokAdapter::remove_ccpanes_entry_at(&path).unwrap());
        let content = fs::read_to_string(&path).unwrap();
        assert!(!content.contains("ccpanes"));
        assert!(content.contains("[mcp_servers.fetch]"));

        // 用户自定义（签名不符）的 ccpanes 不被移除
        fs::write(
            &path,
            r#"[mcp_servers.ccpanes]
url = "https://example.com/mcp"
"#,
        )
        .unwrap();
        assert!(!GrokAdapter::remove_ccpanes_entry_at(&path).unwrap());
        assert!(fs::read_to_string(&path).unwrap().contains("example.com"));
    }

    #[test]
    fn ccpanes_url_signature_detection() {
        assert!(GrokAdapter::is_ccpanes_mcp_url(
            "http://127.0.0.1:37123/mcp?token=abc"
        ));
        assert!(GrokAdapter::is_ccpanes_mcp_url(
            "http://localhost:9000/mcp?token=abc&launchId=x"
        ));
        assert!(!GrokAdapter::is_ccpanes_mcp_url("https://example.com/mcp"));
        assert!(!GrokAdapter::is_ccpanes_mcp_url(
            "http://127.0.0.1:9000/other?token=abc"
        ));
        assert!(!GrokAdapter::is_ccpanes_mcp_url(
            "http://127.0.0.1:9000/mcp"
        ));
    }

    // ============ cc-pane 抽象事件映射测试 ============

    #[test]
    fn map_cc_pane_event_coverage() {
        let a = GrokAdapter::new();

        let init = a.map_cc_pane_event(&CcPaneEvent::SessionInit).unwrap();
        assert_eq!(init.event, "SessionStart");
        assert_eq!(init.matcher.as_deref(), Some("startup"));

        let resume = a.map_cc_pane_event(&CcPaneEvent::SessionResume).unwrap();
        assert_eq!(resume.matcher.as_deref(), Some("resume"));

        assert_eq!(
            a.map_cc_pane_event(&CcPaneEvent::SessionEnd).unwrap().event,
            "SessionEnd"
        );
        assert_eq!(
            a.map_cc_pane_event(&CcPaneEvent::PromptBefore)
                .unwrap()
                .event,
            "UserPromptSubmit"
        );
        assert_eq!(
            a.map_cc_pane_event(&CcPaneEvent::TurnEnd).unwrap().event,
            "Stop"
        );
        assert_eq!(
            a.map_cc_pane_event(&CcPaneEvent::WaitingInput)
                .unwrap()
                .event,
            "Notification"
        );

        let tool_after = a
            .map_cc_pane_event(&CcPaneEvent::ToolAfter(ToolMatcher {
                tool: ToolKind::Bash,
                path_glob: None,
                bash_cmd_prefix: None,
            }))
            .unwrap();
        assert_eq!(tool_after.event, "PostToolUse");
        assert_eq!(tool_after.matcher.as_deref(), Some("Bash"));

        // 未确认事件不映射，且有原因
        assert!(a.map_cc_pane_event(&CcPaneEvent::BeforeCompact).is_none());
        assert!(a.map_cc_pane_event(&CcPaneEvent::Error).is_none());
        assert!(a
            .unsupported_cc_pane_event_reason(&CcPaneEvent::BeforeCompact)
            .is_some());
        assert!(a
            .unsupported_cc_pane_event_reason(&CcPaneEvent::TurnEnd)
            .is_none());
    }
}
