//! Codex CLI 适配器

use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
    ProjectHookDefinition, ProjectHookStatus,
};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

const HOOK_BINARY_NAME: &str = "cc-panes-cli-hook";
const LEGACY_HOOK_BINARY_NAME: &str = "cc-panes-hook";
const TOOL_UNSUPPORTED_ON_WINDOWS: &str = "Codex project hooks are not supported on Windows.";
const DOT_CODEX_FILE_CONFLICT: &str =
    "Project root contains a file named .codex, so Codex project hooks cannot be configured.";
const PLAN_ARCHIVE_UNSUPPORTED: &str =
    "Codex does not support CC-Panes plan archive yet; only session-start is available.";

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
        subcommand: "session-start",
        event: "SessionStart",
        matcher: "startup|resume",
        timeout: 10,
        label: "Context Inject",
        supported: true,
        reason: None,
    },
    HookDef {
        name: "plan-archive",
        subcommand: "plan-archive",
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

    fn project_codex_dir(project_path: &Path) -> PathBuf {
        project_path.join(".codex")
    }

    fn config_path(project_path: &Path) -> PathBuf {
        Self::project_codex_dir(project_path).join("config.toml")
    }

    fn hooks_path(project_path: &Path) -> PathBuf {
        Self::project_codex_dir(project_path).join("hooks.json")
    }

    fn project_unsupported_reason(project_path: &Path) -> Option<String> {
        if cfg!(windows) {
            return Some(TOOL_UNSUPPORTED_ON_WINDOWS.to_string());
        }

        let codex_path = project_path.join(".codex");
        if codex_path.is_file() {
            return Some(DOT_CODEX_FILE_CONFLICT.to_string());
        }

        None
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

    fn ensure_codex_hooks_feature(project_path: &Path) -> Result<()> {
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
        features_table.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
        Self::write_config_toml(project_path, &config)
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
        if let Some(reason) = Self::project_unsupported_reason(project_path) {
            return Err(anyhow!(reason));
        }

        let session_enabled = desired.get("session-inject").copied().unwrap_or(true);
        if session_enabled && hook_binary_path.is_none() {
            return Err(anyhow!("cc-panes-cli-hook binary not found"));
        }

        Self::ensure_codex_hooks_feature(project_path)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

        assert!(config.contains("codex_hooks = true"));
        assert!(hooks.contains("SessionStart"));
        assert!(hooks.contains("session-start"));

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
}
