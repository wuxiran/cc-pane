//! xAI Grok CLI（Grok Build）适配器
//!
//! 实机核对（grok 0.2.101）：
//! - resume：`--resume <id>`；新会话可用 `--session-id <uuid>` 预发确定性 id（同 Claude 模式，
//!   无需 Codex 那套 OSC 标题捕获）。`--session-id` 只用于新会话，与 `--resume` 互斥。
//! - YOLO：`--always-approve`；系统提示词追加：`--rules <RULES>`；初始 prompt 为位置参数。
//! - MCP：无 `--mcp-config` / `-c key=val` 之类 per-launch override（`-c` 是 `--continue`），
//!   唯一注入面是 config.toml 的 `[mcp_servers.<name>]`（`url` + `enabled`，HTTP/SSE/stdio）。
//!   本 adapter 写用户级 `~/.grok/config.toml`（尊重 `$GROK_HOME`）：
//!   项目级 `.grok/config.toml` 会把带 token 的 URL 落进用户仓库（git 泄漏风险）；
//!   GROK_HOME 隔离会切断 `auth.json`（OAuth）与 `sessions/`（resume 历史）——见 Codex
//!   隔离方案失败后的 `migrate_legacy_isolated_sessions` 善后，不重蹈。
//!   代价：所有 grok 会话共享同一个 ccpanes entry，URL 不带 per-launch 的 `&launchId=`，
//!   Orchestrator 暂无法自动识别是哪个 grok 会话在调用（可接受的降级）。

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
const MCP_ISOLATION_UNSUPPORTED_LOG: &str =
    "grok: MCP isolation requested but Grok has no per-launch disable channel; \
     user-configured MCP servers are left untouched";

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

    fn ccpanes_mcp_url(ctx: &CliAdapterContext) -> Option<String> {
        let (port, token) = (ctx.orchestrator_port?, ctx.orchestrator_token.as_ref()?);
        // 不附 &launchId=：entry 为全部 grok 会话共享，附上只会让最后一次启动的
        // launchId 冒充所有会话的 caller 身份（见模块头注释）。
        Some(format!("http://127.0.0.1:{}/mcp?token={}", port, token))
    }

    /// 把 ccpanes + 共享 MCP entry 同步进用户级 config.toml。幂等：值未变化时零写入。
    /// best-effort：任何失败只 warn，不阻断启动（MCP 缺失不致命）。
    fn sync_user_config_mcp(ctx: &CliAdapterContext) {
        let Some(path) = Self::user_config_path() else {
            return;
        };
        let Some(ccpanes_url) = Self::ccpanes_mcp_url(ctx) else {
            warn!(
                session_id = %ctx.session_id,
                "grok: orchestrator not running, skipping MCP config sync"
            );
            return;
        };

        match Self::sync_mcp_at(&path, &ccpanes_url, &ctx.shared_mcp_urls) {
            Ok(true) => info!(
                session_id = %ctx.session_id,
                config = %path.display(),
                shared_mcp = ctx.shared_mcp_urls.len(),
                "grok: MCP entries synced into user config"
            ),
            Ok(false) => {}
            Err(error) => warn!(
                session_id = %ctx.session_id,
                config = %path.display(),
                error = %error,
                "grok: failed to sync MCP config; continuing without MCP"
            ),
        }
    }

    /// 在指定 config.toml 中 upsert ccpanes 与共享 MCP entry。返回是否发生写入。
    ///
    /// - `toml_edit` 保留用户注释与格式；仅在序列化结果变化时原子写（temp + rename）。
    /// - 名为 `ccpanes` 但签名不符的用户自定义 entry 保留不动（只 warn）。
    /// - 首次改动前对原文件做 `.bak` 备份。
    fn sync_mcp_at(
        path: &Path,
        ccpanes_url: &str,
        shared_mcp_urls: &HashMap<String, String>,
    ) -> Result<bool> {
        let original = if path.exists() {
            fs::read_to_string(path)
                .with_context(|| format!("failed to read Grok config {}", path.display()))?
        } else {
            String::new()
        };
        let mut document = original
            .parse::<DocumentMut>()
            .with_context(|| format!("failed to parse Grok config {}", path.display()))?;

        let existing_ccpanes = document
            .get("mcp_servers")
            .and_then(|servers| servers.get("ccpanes"));
        let ccpanes_is_foreign = existing_ccpanes
            .map(|entry| !Self::is_ccpanes_managed_entry(entry))
            .unwrap_or(false);
        if ccpanes_is_foreign {
            warn!(
                config = %path.display(),
                "grok: user-defined mcp_servers.ccpanes entry found (signature mismatch), leaving it untouched"
            );
        } else {
            Self::upsert_mcp_entry(&mut document, "ccpanes", ccpanes_url)?;
        }

        for (name, url) in shared_mcp_urls {
            Self::upsert_mcp_entry(&mut document, name, url)?;
        }

        let updated = document.to_string();
        if updated == original {
            return Ok(false);
        }

        if path.exists() {
            let backup_path = Self::sibling_path_with_suffix(path, ".bak");
            fs::copy(path, &backup_path).with_context(|| {
                format!(
                    "failed to write Grok config backup {}",
                    backup_path.display()
                )
            })?;
        } else if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create Grok config dir {}", parent.display())
            })?;
        }

        crate::fs_atomic::write_atomic(path, updated)?;
        Ok(true)
    }

    /// 写 `[mcp_servers.<name>]` 的 `url` + `enabled = true`（保留 entry 其余键）。
    fn upsert_mcp_entry(document: &mut DocumentMut, name: &str, url: &str) -> Result<()> {
        let servers = document
            .entry("mcp_servers")
            .or_insert(Item::Table(toml_edit::Table::new()));
        let servers = servers
            .as_table_like_mut()
            .context("Grok config mcp_servers must be a TOML table")?;
        if servers.get(name).is_none() {
            servers.insert(name, Item::Table(toml_edit::Table::new()));
        }
        let entry = servers
            .get_mut(name)
            .and_then(Item::as_table_like_mut)
            .with_context(|| format!("Grok config mcp_servers.{} must be a TOML table", name))?;
        entry.insert("url", toml_edit::value(url));
        entry.insert("enabled", toml_edit::value(true));
        Ok(())
    }

    /// skip_mcp：把 CC-Panes 管理的 ccpanes entry 移除（签名不符的用户 entry 不动）。
    /// best-effort，失败只 warn。
    fn remove_ccpanes_entry_best_effort(session_id: &str) {
        let Some(path) = Self::user_config_path() else {
            return;
        };
        match Self::remove_ccpanes_entry_at(&path) {
            Ok(true) => info!(
                session_id = %session_id,
                config = %path.display(),
                "grok: skip_mcp=true, removed CC-Panes ccpanes MCP entry"
            ),
            Ok(false) => {}
            Err(error) => warn!(
                session_id = %session_id,
                config = %path.display(),
                error = %error,
                "grok: failed to remove ccpanes MCP entry"
            ),
        }
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

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let mut args = Vec::new();

        // MCP：写用户级 config.toml（无 per-launch override 通道，见模块头注释）
        if ctx.skip_mcp {
            Self::remove_ccpanes_entry_best_effort(&ctx.session_id);
        } else {
            Self::sync_user_config_mcp(ctx);
        }

        // MCP 隔离：Grok 只能持久化改 config，per-launch disable 做不到；
        // 收到隔离请求时降级为不隔离（绝不把 enabled=false 持久化进用户 config，
        // 那会影响用户自己启动的 grok 会话）。
        if ctx.disable_unlisted_mcp_servers {
            warn!(session_id = %ctx.session_id, MCP_ISOLATION_UNSUPPORTED_LOG);
        }

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

        // [PROMPT] 位置参数（必须在所有 --option 之后）
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        let (command, args) = ctx.resolve_launch("grok", args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            resume_id = ?ctx.resume_id,
            issued_session_id = ?ctx.issued_session_id,
            args = ?crate::redact_args_for_log(&args),
            "grok: build_command result"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject: HashMap::new(),
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
            // Notification 的 matcher 取值未实机确认，保守不带 matcher
            CcPaneEvent::WaitingInput => Some(NativeHookBinding::new("Notification", None, 5)),
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
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
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
    fn sync_mcp_at_creates_config_with_ccpanes_entry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let changed = GrokAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret",
            &HashMap::new(),
        )
        .unwrap();

        assert!(changed);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[mcp_servers.ccpanes]"));
        assert!(content.contains("url = \"http://127.0.0.1:37123/mcp?token=secret\""));
        assert!(content.contains("enabled = true"));
    }

    #[test]
    fn sync_mcp_at_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let url = "http://127.0.0.1:37123/mcp?token=secret";

        assert!(GrokAdapter::sync_mcp_at(&path, url, &HashMap::new()).unwrap());
        assert!(!GrokAdapter::sync_mcp_at(&path, url, &HashMap::new()).unwrap());
    }

    #[test]
    fn sync_mcp_at_preserves_user_config_and_backs_up() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"# user comment stays
permission_mode = "ask"

[model.my-model]
model = "grok-4.5"

[mcp_servers.fetch]
url = "http://127.0.0.1:3000/mcp"
"#,
        )
        .unwrap();

        let changed = GrokAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret",
            &HashMap::from([(
                "shared-docs".to_string(),
                "http://127.0.0.1:4100/mcp?token=shared".to_string(),
            )]),
        )
        .unwrap();

        assert!(changed);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("# user comment stays"));
        assert!(content.contains("permission_mode = \"ask\""));
        assert!(content.contains("[model.my-model]"));
        assert!(content.contains("[mcp_servers.fetch]"));
        assert!(content.contains("[mcp_servers.ccpanes]"));
        assert!(content.contains("[mcp_servers.shared-docs]"));

        let backup =
            fs::read_to_string(GrokAdapter::sibling_path_with_suffix(&path, ".bak")).unwrap();
        assert!(backup.contains("# user comment stays"));
        assert!(!backup.contains("[mcp_servers.ccpanes]"));
    }

    #[test]
    fn sync_mcp_at_updates_stale_ccpanes_url() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"[mcp_servers.ccpanes]
url = "http://127.0.0.1:11111/mcp?token=old"
enabled = true
"#,
        )
        .unwrap();

        let changed = GrokAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=new",
            &HashMap::new(),
        )
        .unwrap();

        assert!(changed);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("token=new"));
        assert!(!content.contains("token=old"));
    }

    #[test]
    fn sync_mcp_at_leaves_foreign_ccpanes_entry_untouched() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"[mcp_servers.ccpanes]
url = "https://example.com/mcp"
"#,
        )
        .unwrap();

        let changed = GrokAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret",
            &HashMap::new(),
        )
        .unwrap();

        assert!(!changed);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("https://example.com/mcp"));
        assert!(!content.contains("token=secret"));
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

    #[test]
    fn ccpanes_mcp_url_omits_launch_id() {
        let mut ctx = test_context(None);
        ctx.orchestrator_port = Some(37123);
        ctx.orchestrator_token = Some("secret".to_string());
        ctx.launch_id = Some("launch-1".to_string());

        let url = GrokAdapter::ccpanes_mcp_url(&ctx).unwrap();
        assert_eq!(url, "http://127.0.0.1:37123/mcp?token=secret");
        assert!(!url.contains("launchId"));
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
