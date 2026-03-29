//! Claude Code CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::{info, warn};

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
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: true,
                supports_mcp: true,
                supports_system_prompt: true,
                supports_workspace: true,
                compatible_provider_types: vec![
                    "anthropic".into(),
                    "openrouter".into(),
                    "custom".into(),
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

    fn global_commands_dir(&self) -> Option<std::path::PathBuf> {
        dirs::home_dir().map(|h| h.join(".claude").join("commands"))
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("claude").map_err(|_| anyhow!("claude CLI not found in PATH"))?;
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

        info!(
            session_id = %ctx.session_id,
            command = %path.display(),
            args = ?args,
            "claude: build_command result"
        );

        Ok(CliCommandResult {
            command: path.to_string_lossy().into_owned(),
            args,
            env_remove: vec!["CLAUDECODE".to_string()],
            env_inject: HashMap::new(),
        })
    }
}
