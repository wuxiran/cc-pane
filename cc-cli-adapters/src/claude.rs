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

        // 健康检查：验证 Orchestrator 端口是否真正在监听
        let check_addr = format!("127.0.0.1:{}", port);
        if std::net::TcpStream::connect_timeout(
            &check_addr.parse().ok()?,
            std::time::Duration::from_millis(200),
        )
        .is_err()
        {
            warn!(
                "[claude] Orchestrator not reachable at {}, skipping MCP config",
                check_addr
            );
            return None;
        }

        let config_path = ctx.data_dir.join("mcp-orchestrator.json");

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
        if let Some(serde_json::Value::Object(user_servers)) = Self::read_user_global_mcp_servers()
        {
            let count = user_servers.len();
            for (name, config) in user_servers {
                mcp_servers.insert(name, config);
            }
            info!("[claude] Merged {} user global MCP servers", count);
        }

        // ccpanes 服务器（高优先级，覆盖同名）
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
        if let Some(ref prompt) = ctx.initial_prompt {
            args.push(prompt.clone());
        }

        Ok(CliCommandResult {
            command: path.to_string_lossy().into_owned(),
            args,
            env_remove: vec!["CLAUDECODE".to_string()],
            env_inject: HashMap::new(),
        })
    }
}
