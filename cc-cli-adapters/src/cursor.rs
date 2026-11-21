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
//! - MCP（docs/110 批 2）：写**项目级** `.cursor/mcp.json`（收据驱动，见
//!   [`crate::project_mcp`]）；`--approve-mcps` 跳过确认。Cursor 在 `url`/`headers` 里展开
//!   `${env:NAME}`（cursor.com/docs/mcp），所以 ccpanes 的端口 / token / launchId 都是占位符、
//!   真实值走本会话环境变量——同项目并发会话共用一份文件也各带各的身份。此前写用户级
//!   `~/.cursor/mcp.json` 的旧条目在首次启动时清掉（[`CursorAdapter::migrate_legacy_user_mcp`]）。

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::Result;
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
                // 项目级 .cursor/mcp.json 收据驱动注入（docs/110 批 2，无 per-launch 隔离）
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

    /// 一次性迁移（docs/110 批 2）：清掉以前写进用户级 `~/.cursor/mcp.json` 的条目——
    /// 签名匹配的 `ccpanes`，以及与本次共享 MCP 同名且值仍是我们当年写的 `{"url": …}` 的条目。
    /// 用户自己的条目一律不动。完成后在数据目录落标记，之后不再碰用户级文件。
    fn migrate_legacy_user_mcp(ctx: &CliAdapterContext) {
        if ctx.skip_mcp {
            return;
        }
        let marker = ctx
            .data_dir
            .join("cli-adapters")
            .join("cursor")
            .join("user-mcp-migrated-v1");
        if marker.exists() {
            return;
        }
        let Some(path) = Self::user_mcp_path() else {
            return;
        };
        match Self::remove_legacy_entries_at(&path, &ctx.shared_mcp_urls) {
            Ok(changed) => {
                if changed {
                    info!(config = %path.display(), "cursor: removed legacy user-level MCP entries");
                }
                let _ = fs::create_dir_all(marker.parent().unwrap_or(&ctx.data_dir));
                let _ = fs::write(&marker, b"1\n");
            }
            Err(error) => warn!(%error, "cursor: failed to migrate legacy user-level MCP entries"),
        }
    }

    fn remove_legacy_entries_at(path: &Path, shared: &HashMap<String, String>) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let original = fs::read_to_string(path)?;
        let mut root: serde_json::Value = serde_json::from_str(&original)?;
        let Some(servers) = root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let mut changed = false;
        if servers
            .get("ccpanes")
            .is_some_and(Self::is_ccpanes_managed_server)
        {
            servers.remove("ccpanes");
            changed = true;
        }
        for (name, url) in shared {
            if servers.get(name) == Some(&serde_json::json!({ "url": url })) {
                servers.remove(name);
                changed = true;
            }
        }
        if changed {
            let _ = fs::copy(path, path.with_extension("json.bak"));
            crate::fs_atomic::write_atomic(path, serde_json::to_string_pretty(&root)?)?;
        }
        Ok(changed)
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

    /// docs/110 当前注入面，守卫见 tests/injection_profile_honesty.rs。
    /// - MCP（批 2）：项目级 `.cursor/mcp.json`（同项目会话共享），ccpanes 用 `${env:…}` 占位符、
    ///   各会话展开成自己的端口 / token / launchId；远程 HTTP / SSE 的请求头同样走占位符；隔离只能声明。
    /// - 技能（批 1）：挂载根拼成每会话 staging（Cursor 插件清单）后经 `--plugin-dir`；没有提示词通道。
    fn injection_profile(&self) -> crate::InjectionProfile {
        use crate::injection_profile::*;
        InjectionProfile {
            mcp: project_file_mcp(false, true, vec![McpTransport::Sse]),
            skills: SkillsInjection {
                mount: SkillMount::PluginDir,
                prompt_fallback: false,
                native_sources: vec![],
            },
            runtimes: InjectionRuntimes {
                wsl: RuntimeInjection::launch_only(),
                ssh: RuntimeInjection::launch_only(),
            },
        }
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
        Self::migrate_legacy_user_mcp(ctx);
        let mcp = crate::project_mcp::sync_for_launch(
            ctx,
            &crate::project_mcp_dialects::CURSOR,
            &crate::project_mcp::ccpanes_http(ctx),
        );

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

        // 自动批准项目 / 用户 mcp.json（含我们注入的 ccpanes）
        args.push("--approve-mcps".to_string());

        // 技能挂载（docs/110 批 1）：`--plugin-dir <path>` 可重复（cursor.com/docs/cli/reference/
        // parameters）。Cursor 插件按清单位置识别（`.cursor-plugin/plugin.json`，skills/ 默认发现，
        // cursor.com/docs/reference/plugins），我们的挂载根是 Claude 插件布局，故先拼 staging。
        let layout = crate::skill_mounts::StagingLayout {
            cursor_plugin: true,
            agents_skills: false,
        };
        if let Some(staging) = crate::skill_mounts::stage_session_skills(
            &ctx.data_dir,
            &ctx.session_id,
            &ctx.skill_mount_paths,
            layout,
        ) {
            args.push("--plugin-dir".to_string());
            args.push(staging.to_string_lossy().into_owned());
        }

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

        let mut env_inject = mcp.env;
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
    fn legacy_user_entries_are_removed_but_user_servers_survive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{
                "ccpanes":{"url":"http://127.0.0.1:9/mcp?token=x&launchId=l1"},
                "shared-a":{"url":"http://127.0.0.1:41000/mcp"},
                "shared-b":{"url":"http://127.0.0.1:41001/mcp","headers":{"A":"b"}},
                "context7":{"url":"https://mcp.context7.com/mcp"}
            }}"#,
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
        assert!(CursorAdapter::remove_legacy_entries_at(&path, &shared).unwrap());
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let servers = value["mcpServers"].as_object().unwrap();
        assert!(!servers.contains_key("ccpanes"));
        assert!(!servers.contains_key("shared-a"));
        // 被用户改过（加了 headers）的同名条目不是我们写的原样，保留
        assert!(servers.contains_key("shared-b"));
        assert!(servers.contains_key("context7"));
        assert!(!CursorAdapter::remove_legacy_entries_at(&path, &shared).unwrap());
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
