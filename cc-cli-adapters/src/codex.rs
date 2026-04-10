//! Codex CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::{info, warn};

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
            },
            caps: CliToolCapabilities {
                supports_provider: true,
                supports_resume: true,
                supports_mcp: true,
                supports_system_prompt: true,
                supports_workspace: true,
                compatible_provider_types: vec!["openai".into(), "custom".into()],
            },
        }
    }

    /// 注册 CC-Panes MCP 服务器到 Codex 全局配置（幂等：已存在则覆盖）
    fn register_codex_mcp(&self, ctx: &CliAdapterContext, codex_cmd: &str) {
        let port = match ctx.orchestrator_port {
            Some(p) => p,
            None => {
                warn!(
                    session_id = %ctx.session_id,
                    "[codex] No orchestrator info, skipping MCP"
                );
                return;
            }
        };
        let token = match ctx.orchestrator_token.as_ref() {
            Some(t) => t,
            None => {
                warn!(
                    session_id = %ctx.session_id,
                    "[codex] No orchestrator token, skipping MCP"
                );
                return;
            }
        };

        // 健康检查
        let check_addr = format!("127.0.0.1:{}", port);
        if let Ok(addr) = check_addr.parse() {
            if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200))
                .is_err()
            {
                warn!(
                    session_id = %ctx.session_id,
                    "[codex] Orchestrator not reachable at {}, skipping MCP",
                    check_addr
                );
                return;
            }
        } else {
            warn!(
                session_id = %ctx.session_id,
                "[codex] Invalid address: {}, skipping MCP",
                check_addr
            );
            return;
        }

        // 注册（已存在则覆盖，天然幂等）
        let url = format!("http://127.0.0.1:{}/mcp?token={}", port, token);
        match crate::no_window_command(codex_cmd)
            .args([
                "mcp",
                "add",
                "ccpanes",
                "--url",
                &url,
                "--bearer-token-env-var",
                "CC_PANES_API_TOKEN",
            ])
            .output()
        {
            Ok(output) if output.status.success() => {
                info!(
                    session_id = %ctx.session_id,
                    "[codex] Registered ccpanes MCP: port={}",
                    port
                );
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                warn!(
                    session_id = %ctx.session_id,
                    "[codex] codex mcp add failed: {}",
                    stderr
                );
            }
            Err(e) => {
                warn!(
                    session_id = %ctx.session_id,
                    "[codex] Failed to run codex mcp add: {}",
                    e
                );
            }
        }
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

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let path = which::which("codex").map_err(|_| anyhow!("codex CLI not found in PATH"))?;
        let codex_cmd = path.to_string_lossy().into_owned();

        // MCP 注入（失败不阻塞启动）
        if ctx.skip_mcp {
            info!(
                session_id = %ctx.session_id,
                "codex: skip_mcp=true, skipping Codex MCP registration"
            );
        } else {
            self.register_codex_mcp(ctx, &codex_cmd);
        }

        let mut args = Vec::new();

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
            env_inject: HashMap::new(),
        })
    }
}
