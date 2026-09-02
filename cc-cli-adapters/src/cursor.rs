//! Cursor Agent CLI 适配器
//!
//! 实机核对（cursor-agent 2026.08.25-3e8eec8）：
//! - 可执行：`cursor-agent` / `agent`；Windows 安装在
//!   `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd`（经 PS1 找到
//!   `versions/<ver>/node.exe` + `index.js`）。`resolve_launch` 对非 npm 的
//!   `.cmd` 会回退 `cmd.exe /c`，PTY 可启动。
//! - 初始 prompt：位置参数 `agent [options] [prompt...]`（必须排在所有 flag 之后）。
//! - resume：`--resume [chatId]`；无 id 时进入选择 UI；`agent resume` 恢复最近一次。
//! - YOLO：`-f/--force` 与 `--yolo` 等价（Run Everything，跳过 shell 审批）。
//! - trust：`--trust` 跳过 Workspace Trust 提示——编排启动**始终**加上，否则
//!   会卡在「按 a Trust」无人值守派工永久阻塞。
//! - model：`--model <id>`（如 `claude-fable-5-high`）。
//! - workspace：`--workspace <path>`（默认 cwd）；另有 `--add-dir`。
//! - print 模式：`adapterOptions.print=true` → `-p --output-format text`（无交互 worker）。
//! - MCP：读/写 `~/.cursor/mcp.json`；启动时 upsert `ccpanes` HTTP entry（同 grok
//!   用户级注入）；`--approve-mcps` 跳过确认。多并发会话共享同一 entry——最后一次
//!   启动的 URL（可带 launchId）生效，与 grok 同形降级。

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub struct CursorAdapter {
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl CursorAdapter {
    pub fn new() -> Self {
        Self {
            info: CliToolInfo {
                id: "cursor".into(),
                display_name: "Cursor CLI".into(),
                executable: "cursor-agent".into(),
                version_args: vec!["--version".into()],
                installed: false,
                version: None,
                path: None,
                capabilities: None,
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: true,
                // 用户级 ~/.cursor/mcp.json 注入 ccpanes（无 per-launch 隔离）
                supports_mcp: true,
                supports_system_prompt: false,
                supports_workspace: true,
                supports_project_hooks: false,
                supports_issued_session_id: false,
                supports_rpc: false,
                supports_structured_result: false,
                supports_yolo: true,
                supports_orchestrated_launch: true,
                supports_effort_option: false,
                supports_verbose_option: false,
                supports_max_turns_option: false,
                compatible_provider_types: vec!["cursor".into()],
            },
        }
    }

    fn user_mcp_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".cursor").join("mcp.json"))
    }

    fn ccpanes_mcp_url(ctx: &CliAdapterContext) -> Option<String> {
        let (port, token) = (ctx.orchestrator_port?, ctx.orchestrator_token.as_ref()?);
        let mut url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
        // 与 Claude 对齐：带 launchId 让 orchestrator 识别 caller。
        // 代价：用户级单 entry，多并发 cursor 会话最后一次启动覆盖（文档已说明）。
        if let Some(launch_id) = ctx
            .launch_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            url.push_str("&launchId=");
            url.push_str(launch_id);
        }
        Some(url)
    }

    /// URL 是否具备 CC-Panes 签名：loopback + `/mcp` + `token=`。
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

    fn is_ccpanes_managed_server(value: &serde_json::Value) -> bool {
        value
            .get("url")
            .and_then(|u| u.as_str())
            .map(Self::is_ccpanes_mcp_url)
            .unwrap_or(false)
    }

    /// upsert `mcpServers.ccpanes` + 共享 MCP；幂等；签名不符的用户 entry 不动。
    fn sync_mcp_at(
        path: &Path,
        ccpanes_url: &str,
        shared_mcp_urls: &HashMap<String, String>,
    ) -> Result<bool> {
        let original = if path.exists() {
            fs::read_to_string(path)
                .with_context(|| format!("failed to read Cursor mcp.json {}", path.display()))?
        } else {
            String::new()
        };
        let mut root: serde_json::Value = if original.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&original)
                .with_context(|| format!("failed to parse Cursor mcp.json {}", path.display()))?
        };
        let servers = root
            .as_object_mut()
            .context("Cursor mcp.json root must be an object")?
            .entry("mcpServers".to_string())
            .or_insert_with(|| serde_json::json!({}));
        let servers = servers
            .as_object_mut()
            .context("Cursor mcp.json mcpServers must be an object")?;

        let mut changed = false;

        let foreign_ccpanes = servers
            .get("ccpanes")
            .map(|entry| !Self::is_ccpanes_managed_server(entry))
            .unwrap_or(false);
        if foreign_ccpanes {
            warn!(
                config = %path.display(),
                "cursor: user-defined mcpServers.ccpanes (signature mismatch), leaving untouched"
            );
        } else {
            let entry = serde_json::json!({ "url": ccpanes_url });
            if servers.get("ccpanes") != Some(&entry) {
                servers.insert("ccpanes".to_string(), entry);
                changed = true;
            }
        }

        for (name, url) in shared_mcp_urls {
            let foreign = servers
                .get(name)
                .map(|entry| !Self::is_ccpanes_managed_server(entry))
                .unwrap_or(false);
            if foreign {
                warn!(
                    config = %path.display(),
                    name,
                    "cursor: user-defined shared MCP entry (signature mismatch), leaving untouched"
                );
                continue;
            }
            let entry = serde_json::json!({ "url": url });
            if servers.get(name) != Some(&entry) {
                servers.insert(name.clone(), entry);
                changed = true;
            }
        }

        if !changed {
            return Ok(false);
        }

        if path.exists() {
            let backup = path.with_extension("json.bak");
            let _ = fs::copy(path, &backup);
        } else if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let pretty = serde_json::to_string_pretty(&root)?;
        crate::fs_atomic::write_atomic(path, pretty)?;
        Ok(true)
    }

    fn remove_ccpanes_entry_at(path: &Path) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let original = fs::read_to_string(path)?;
        let mut root: serde_json::Value = serde_json::from_str(&original)?;
        let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let managed = servers
            .get("ccpanes")
            .map(Self::is_ccpanes_managed_server)
            .unwrap_or(false);
        if !managed {
            return Ok(false);
        }
        servers.remove("ccpanes");
        crate::fs_atomic::write_atomic(path, serde_json::to_string_pretty(&root)?)?;
        Ok(true)
    }

    fn sync_user_mcp(ctx: &CliAdapterContext) {
        let Some(path) = Self::user_mcp_path() else {
            return;
        };
        if ctx.skip_mcp {
            match Self::remove_ccpanes_entry_at(&path) {
                Ok(true) => info!(
                    session_id = %ctx.session_id,
                    "cursor: skip_mcp, removed ccpanes entry"
                ),
                Ok(false) => {}
                Err(error) => warn!(
                    session_id = %ctx.session_id,
                    error = %error,
                    "cursor: failed to remove ccpanes MCP entry"
                ),
            }
            return;
        }
        let Some(url) = Self::ccpanes_mcp_url(ctx) else {
            warn!(
                session_id = %ctx.session_id,
                "cursor: orchestrator not running, skipping MCP config sync"
            );
            return;
        };
        match Self::sync_mcp_at(&path, &url, &ctx.shared_mcp_urls) {
            Ok(true) => info!(
                session_id = %ctx.session_id,
                config = %path.display(),
                "cursor: MCP entries synced into user mcp.json"
            ),
            Ok(false) => {}
            Err(error) => warn!(
                session_id = %ctx.session_id,
                error = %error,
                "cursor: failed to sync MCP config; continuing without MCP"
            ),
        }
    }

    fn print_mode_enabled(ctx: &CliAdapterContext) -> bool {
        ctx.adapter_options
            .get("print")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || ctx
                .adapter_options
                .get("headless")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
    }
}

fn read_only_from_options(options: &HashMap<String, serde_json::Value>) -> bool {
    options
        .get("readOnly")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// `readOnly` 强制 `--mode ask`，并丢掉 extraArgs 里已有的 `--mode`，避免双 mode。
/// 这不是沙箱：CLI 若不认该 flag，仍靠 prompt 契约。
fn extra_args_with_read_only(options: &HashMap<String, serde_json::Value>) -> Vec<String> {
    let extra = crate::extra_args_from_options(options);
    if !read_only_from_options(options) {
        return extra;
    }
    let mut stripped = Vec::new();
    let mut skip_next = false;
    for arg in extra {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--mode" {
            skip_next = true;
            continue;
        }
        if let Some(rest) = arg.strip_prefix("--mode=") {
            if !rest.is_empty() {
                continue;
            }
        }
        stripped.push(arg);
    }
    let mut args = vec!["--mode".to_string(), "ask".to_string()];
    args.extend(stripped);
    args
}

impl Default for CursorAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliToolAdapter for CursorAdapter {
    fn info(&self) -> &CliToolInfo {
        &self.info
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    fn cleanup_user_injections(&self) -> Result<Vec<PathBuf>> {
        let Some(path) = Self::user_mcp_path() else {
            return Ok(Vec::new());
        };
        if Self::remove_ccpanes_entry_at(&path)? {
            Ok(vec![path])
        } else {
            Ok(Vec::new())
        }
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        Self::sync_user_mcp(ctx);

        let mut args = Vec::new();

        crate::push_model_arg(&mut args, ctx);

        // 编排启动始终跳过 Workspace Trust
        args.push("--trust".to_string());

        let project_path = ctx.project_path.trim();
        if !project_path.is_empty() {
            args.push("--workspace".to_string());
            args.push(project_path.to_string());
        }

        if let Some(workspace) = ctx
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            if !project_path.is_empty() && !paths_equal_loose(workspace, project_path) {
                args.push("--add-dir".to_string());
                args.push(workspace.to_string());
            }
        }

        if let Some(resume_id) = ctx
            .resume_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }

        if ctx.yolo_mode {
            args.push("--force".to_string());
        }

        // 自动批准用户 mcp.json（含我们注入的 ccpanes）
        args.push("--approve-mcps".to_string());

        // 无交互 worker：print 模式（输出纯文本，适合 dispatch 轮询）
        if Self::print_mode_enabled(ctx) {
            args.push("--print".to_string());
            args.push("--output-format".to_string());
            args.push("text".to_string());
        }

        args.extend(extra_args_with_read_only(&ctx.adapter_options));

        if let Some(prompt) = ctx
            .initial_prompt
            .as_deref()
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
        {
            args.push(prompt.to_string());
        }

        let mut env_inject = HashMap::new();
        if let Some(provider) = ctx.provider.as_ref() {
            if provider.provider_type == "cursor" {
                if let Some(api_key) = provider
                    .api_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                {
                    env_inject.insert("CURSOR_API_KEY".to_string(), api_key.to_string());
                }
            }
        }

        let (command, args) = ctx.resolve_launch_first_of(&["cursor-agent", "agent"], args)?;

        info!(
            session_id = %ctx.session_id,
            command = %command,
            resume_id = ?ctx.resume_id,
            yolo = ctx.yolo_mode,
            print = Self::print_mode_enabled(ctx),
            args = ?crate::redact_args_for_log(&args),
            "cursor: build_command result"
        );

        Ok(CliCommandResult {
            command,
            args,
            env_remove: vec![],
            env_inject,
        })
    }
}

fn paths_equal_loose(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .trim_end_matches(['/', '\\'])
            .replace('\\', "/")
            .to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn test_context(executable_override: Option<&str>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "test-session".to_string(),
            project_path: r"D:\work\demo".to_string(),
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
            skill_mount_paths: Vec::new(),
        }
    }

    #[test]
    fn capabilities_enable_orchestrated_launch_mcp_and_yolo() {
        let caps = CursorAdapter::new().capabilities().clone();
        assert!(caps.supports_orchestrated_launch);
        assert!(caps.supports_yolo);
        assert!(caps.supports_resume);
        assert!(caps.supports_workspace);
        assert!(caps.supports_mcp);
    }

    #[test]
    fn build_command_always_trusts_and_binds_workspace() {
        let adapter = CursorAdapter::new();
        let ctx = test_context(Some(r"C:\tools\cursor-agent.cmd"));
        let result = adapter.build_command(&ctx).unwrap();
        assert!(result.args.iter().any(|arg| arg == "--trust"));
        assert!(result.args.iter().any(|arg| arg == "--approve-mcps"));
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--workspace" && pair[1] == r"D:\work\demo"));
        assert!(!result.args.iter().any(|arg| arg == "--force"));
        assert!(!result.args.iter().any(|arg| arg == "--print"));
    }

    #[test]
    fn build_command_yolo_and_print_mode() {
        let adapter = CursorAdapter::new();
        let mut ctx = test_context(Some(r"C:\tools\cursor-agent.cmd"));
        ctx.yolo_mode = true;
        ctx.adapter_options
            .insert("print".into(), serde_json::json!(true));
        let result = adapter.build_command(&ctx).unwrap();
        assert!(result.args.iter().any(|arg| arg == "--force"));
        assert!(result.args.iter().any(|arg| arg == "--print"));
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--output-format" && pair[1] == "text"));
    }

    #[test]
    fn build_command_readonly_forces_mode_ask_once() {
        let adapter = CursorAdapter::new();
        let mut ctx = test_context(Some(r"C:\tools\cursor-agent.cmd"));
        ctx.adapter_options
            .insert("readOnly".into(), serde_json::json!(true));
        ctx.adapter_options
            .insert("extraArgs".into(), serde_json::json!(["--mode", "agent"]));
        let result = adapter.build_command(&ctx).unwrap();
        let mode_flags = result
            .args
            .windows(2)
            .filter(|pair| pair[0] == "--mode")
            .collect::<Vec<_>>();
        assert_eq!(mode_flags.len(), 1);
        assert_eq!(mode_flags[0][1], "ask");
        assert!(!result.args.iter().any(|arg| arg == "agent"));
    }

    #[test]
    fn build_command_model_resume_prompt_order() {
        let adapter = CursorAdapter::new();
        let mut ctx = test_context(Some(r"C:\tools\cursor-agent.cmd"));
        ctx.adapter_options.insert(
            "__ccpanesModelId".into(),
            serde_json::Value::String("claude-fable-5-high".into()),
        );
        ctx.resume_id = Some("chat-abc".into());
        ctx.initial_prompt = Some("只回复 cursor-cli-ok，不改文件".into());
        ctx.adapter_options
            .insert("extraArgs".into(), serde_json::json!(["--mode", "ask"]));

        let result = adapter.build_command(&ctx).unwrap();
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "claude-fable-5-high"));
        assert!(result
            .args
            .windows(2)
            .any(|pair| pair[0] == "--resume" && pair[1] == "chat-abc"));
        assert_eq!(
            result.args.last().map(String::as_str),
            Some("只回复 cursor-cli-ok，不改文件")
        );
    }

    #[test]
    fn sync_mcp_at_creates_ccpanes_and_preserves_user_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{
  "mcpServers": {
    "context7": { "url": "https://mcp.context7.com/mcp" }
  }
}"#,
        )
        .unwrap();

        let changed = CursorAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret&launchId=l1",
            &HashMap::new(),
        )
        .unwrap();
        assert!(changed);
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("ccpanes"));
        assert!(content.contains("token=secret"));
        assert!(content.contains("context7"));
        // 幂等
        assert!(!CursorAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret&launchId=l1",
            &HashMap::new(),
        )
        .unwrap());
    }

    #[test]
    fn sync_mcp_at_leaves_foreign_ccpanes_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"ccpanes":{"url":"https://example.com/mcp"}}}"#,
        )
        .unwrap();
        let changed = CursorAdapter::sync_mcp_at(
            &path,
            "http://127.0.0.1:37123/mcp?token=secret",
            &HashMap::new(),
        )
        .unwrap();
        assert!(!changed);
        assert!(fs::read_to_string(&path).unwrap().contains("example.com"));
    }

    #[test]
    fn remove_ccpanes_only_managed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"ccpanes":{"url":"http://127.0.0.1:9/mcp?token=x"},"other":{"url":"https://x"}}}"#,
        )
        .unwrap();
        assert!(CursorAdapter::remove_ccpanes_entry_at(&path).unwrap());
        let content = fs::read_to_string(&path).unwrap();
        assert!(!content.contains("ccpanes"));
        assert!(content.contains("other"));
    }

    #[test]
    fn is_ccpanes_url_signature() {
        assert!(CursorAdapter::is_ccpanes_mcp_url(
            "http://127.0.0.1:1/mcp?token=a"
        ));
        assert!(!CursorAdapter::is_ccpanes_mcp_url(
            "https://example.com/mcp"
        ));
    }

    #[test]
    #[cfg(windows)]
    fn build_command_windows_cmd_override_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("cursor-agent.cmd");
        fs::write(&shim, "@echo off\r\necho stub\r\n").unwrap();
        let adapter = CursorAdapter::new();
        let ctx = test_context(Some(shim.to_str().unwrap()));
        let result = adapter.build_command(&ctx).unwrap();
        assert_eq!(result.command, "cmd.exe");
        assert_eq!(result.args.first().map(String::as_str), Some("/c"));
        assert!(result.args.iter().any(|arg| arg == "--trust"));
    }
}
