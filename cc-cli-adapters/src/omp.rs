//! Oh My Pi (`omp`) CLI adapter.
//!
//! Oh My Pi is a fork of Pi with an identical command-line surface: the same
//! `--provider`/`--model`/`--session`/`--thinking` flags, the same
//! `PI_CODING_AGENT_DIR` environment contract, and the same JSONL session
//! format. Differences that matter for launches: state lives under `~/.omp`
//! instead of `~/.pi`, and there are no `--name` or project-trust flags. The
//! shared Pi-family launch core in [`crate::pi`] owns the details; this module
//! only declares the Oh My Pi surface and capabilities.
//!
//! MCP（docs/104）：与上游 Pi 不同，omp **原生支持 MCP**（stdio/HTTP/SSE，
//! `@oh-my-pi/pi-coding-agent` ≥17 实机取证：`src/config/mcp-schema.json`，
//! 与 Claude 同形 `{"mcpServers":{...}}`）。没有 per-launch flag，注入面是
//! 它原生读取的项目级 `.omp/mcp.json`（`mcp.enableProjectConfig` 默认 true），
//! 由 [`crate::mcp_file_injection`] 收据驱动同步，用户自有条目永不覆盖。
//! 隔离模式（disable_unlisted）v1 不支持：omp 还会从 .claude/.cursor 等
//! 外部配置导入 server，没有逐源禁用通道，与 grok 同款 warn 降级。

use crate::mcp_file_injection::{self, CollectOptions};
use crate::pi::{PiFamilyAdapter, OMP_FAMILY_CONFIG};
use crate::{
    CliAdapterContext, CliCommandResult, CliToolAdapter, CliToolCapabilities, CliToolInfo,
    SkillDeliveryMode,
};
use anyhow::Result;
use std::path::PathBuf;

pub struct OmpAdapter {
    family: PiFamilyAdapter,
}

impl OmpAdapter {
    pub fn new() -> Self {
        Self {
            family: PiFamilyAdapter::new(OMP_FAMILY_CONFIG, omp_capabilities()),
        }
    }
}

impl Default for OmpAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// Oh My Pi's RPC transport exists upstream, but CC-Panes' structured RPC
/// service is wired to Pi only. Structured-result reporting therefore stays
/// off until the RPC service learns the omp executable.
fn omp_capabilities() -> CliToolCapabilities {
    CliToolCapabilities {
        supports_provider: true,
        supports_resume: true,
        // omp 原生读项目 .omp/mcp.json（stdio/HTTP/SSE 全支持），启动期同步注入
        supports_mcp: true,
        supports_system_prompt: true,
        supports_workspace: false,
        supports_project_hooks: false,
        supports_issued_session_id: false,
        supports_rpc: false,
        supports_structured_result: false,
        supports_yolo: false,
        supports_orchestrated_launch: false,
        supports_effort_option: false,
        supports_verbose_option: false,
        supports_max_turns_option: false,
        compatible_provider_types: crate::pi::pi_family_compatible_provider_types(),
    }
}

impl CliToolAdapter for OmpAdapter {
    fn info(&self) -> &CliToolInfo {
        self.family.info()
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        self.family.capabilities()
    }

    /// Oh My Pi reads Agent Skills from `~/.omp/agent/skills` using the same
    /// SKILL.md layout as Pi, so the Pi skill bundle is directly compatible.
    fn global_skills_dir(&self) -> Option<PathBuf> {
        self.family.global_skills_dir()
    }

    fn skill_delivery_modes(&self) -> Vec<SkillDeliveryMode> {
        vec![SkillDeliveryMode::PiSkill]
    }

    fn can_report_task_result(&self) -> bool {
        self.family.capabilities().supports_structured_result
    }

    fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        // MCP 注入（docs/104）：omp 启动时原生读取 <项目>/.omp/mcp.json，
        // 这里在拼命令前把有效集合同步进去。ccpanes 内置走 HTTP 直连
        // （omp 原生支持 headers，能带 Authorization；不附 launchId，
        // 项目级文件被同项目所有会话共享，见 ccpanes_http_entry 注释）。
        let ccpanes_entry = ctx
            .orchestrator_port
            .zip(ctx.orchestrator_token.as_deref())
            .map(|(port, token)| mcp_file_injection::ccpanes_http_entry(port, token));
        mcp_file_injection::sync_adapter_project_mcp(
            "omp",
            &[".omp", "mcp.json"],
            ctx,
            &CollectOptions {
                stdio_only: false,
                ccpanes_entry,
            },
        );
        self.family.build_command(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi::{
        cleanup_omp_managed_state, pi_managed_state_key, PiAdapterOptions, PI_CODING_AGENT_DIR_ENV,
        PI_CODING_AGENT_SESSION_DIR_ENV, PI_MANAGED_STATE_DIR_NAME, PI_NATIVE_PROVIDER_OPTION,
        PI_SESSION_NAME_OPTION, PI_TRANSPORT_OPTION,
    };
    use crate::CliProvider;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::path::PathBuf;

    fn context(managed_provider: Option<CliProvider>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "pane-session".to_string(),
            project_path: "/repo".to_string(),
            workspace_path: None,
            provider: managed_provider,
            executable_override: Some("omp-test".to_string()),
            adapter_options: HashMap::new(),
            resume_id: None,
            issued_session_id: None,
            skip_mcp: false,
            yolo_mode: false,
            append_system_prompt: None,
            initial_prompt: None,
            orchestrator_port: None,
            orchestrator_token: None,
            launch_id: None,
            data_dir: std::env::temp_dir(),
            shared_mcp_urls: HashMap::new(),
            shared_mcp_stdio: Default::default(),
            allowed_mcp_server_ids: Vec::new(),
            disable_unlisted_mcp_servers: false,
            skill_mount_paths: Vec::new(),
            workspace_mcp_servers: Default::default(),
        }
    }

    fn provider(provider_type: &str) -> CliProvider {
        CliProvider {
            id: "managed-provider".to_string(),
            name: "Managed Provider".to_string(),
            provider_type: provider_type.to_string(),
            api_key: Some("managed-secret".to_string()),
            base_url: None,
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            codex_wire_api: None,
            is_default: false,
        }
    }

    #[test]
    fn native_command_omits_pi_only_flags_and_ignores_stale_pi_options() {
        let mut ctx = context(None);
        // Launch profiles shared across tools can carry leftover Pi keys; omp
        // must not consume or reject them.
        ctx.adapter_options = HashMap::from([
            (PI_TRANSPORT_OPTION.to_string(), json!("rpc")),
            (PI_NATIVE_PROVIDER_OPTION.to_string(), json!("openai-codex")),
            (PI_SESSION_NAME_OPTION.to_string(), json!("Research")),
            ("effort".to_string(), json!("xhigh")),
            ("extraArgs".to_string(), json!(["--flag"])),
        ]);
        ctx.resume_id = Some("omp-session-id".to_string());
        ctx.append_system_prompt = Some("Follow the repository instructions".to_string());
        ctx.initial_prompt = Some("Inspect the issue".to_string());

        let result = OmpAdapter::new().build_command(&ctx).unwrap();
        assert_eq!(result.command, "omp-test");
        assert_eq!(
            result.args,
            vec![
                "--thinking",
                "xhigh",
                "--append-system-prompt",
                "Follow the repository instructions",
                "--session",
                "omp-session-id",
                "--flag",
                "Inspect the issue",
            ]
        );
        assert!(result.env_inject.is_empty());
        assert!(result.env_remove.is_empty());
    }

    #[test]
    fn managed_provider_uses_omp_state_dirs_and_environment_credentials() {
        let mut ctx = context(Some(provider("anthropic")));
        ctx.adapter_options
            .insert("__ccpanesModelId".to_string(), json!("claude-sonnet-4"));
        ctx.initial_prompt = Some("Review this change".to_string());

        let result = OmpAdapter::new().build_command(&ctx).unwrap();
        assert_eq!(
            result.args,
            vec![
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet-4",
                "Review this change"
            ]
        );
        assert_eq!(
            result
                .env_inject
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("managed-secret")
        );
        let state_dir = result
            .env_inject
            .get(PI_CODING_AGENT_DIR_ENV)
            .expect("managed omp state directory");
        let expected_state_dir = ctx
            .data_dir
            .join("omp-managed")
            .join("runs")
            .join(pi_managed_state_key(&ctx.session_id));
        assert_eq!(PathBuf::from(state_dir), expected_state_dir);
        assert!(PathBuf::from(state_dir).starts_with(ctx.data_dir.join("omp-managed")));
        assert!(result
            .env_inject
            .get(PI_CODING_AGENT_SESSION_DIR_ENV)
            .is_some_and(
                |path| path.ends_with(".omp\\agent\\sessions\\ccpanes-managed")
                    || path.ends_with(".omp/agent/sessions/ccpanes-managed")
            ));
        assert!(!result.args.iter().any(|arg| arg.contains("managed-secret")));
    }

    #[test]
    fn omp_state_cleanup_is_isolated_from_pi_state() {
        let data_dir = std::env::temp_dir();
        let session_id = format!("omp-cleanup-{}", std::process::id());
        let omp_dir = data_dir
            .join("omp-managed")
            .join("runs")
            .join(pi_managed_state_key(&session_id));
        let pi_dir = data_dir
            .join(PI_MANAGED_STATE_DIR_NAME)
            .join("runs")
            .join(pi_managed_state_key(&session_id));
        std::fs::create_dir_all(&omp_dir).expect("create omp state dir");
        std::fs::create_dir_all(&pi_dir).expect("create pi state dir");
        std::fs::write(omp_dir.join("state.json"), "test").expect("seed omp state");

        cleanup_omp_managed_state(&data_dir, &session_id).expect("cleanup omp state");

        assert!(!omp_dir.exists());
        assert!(pi_dir.exists(), "omp cleanup must not touch pi state");
        std::fs::remove_dir_all(&pi_dir).ok();
    }

    #[test]
    fn omp_capabilities_match_current_integration_surface() {
        let adapter = OmpAdapter::new();
        let info = adapter.info();
        assert_eq!(info.id, "omp");
        assert_eq!(info.executable, "omp");
        let caps = adapter.capabilities();
        assert!(!caps.supports_rpc);
        assert!(!caps.supports_structured_result);
        assert!(!adapter.can_report_task_result());
        assert!(
            caps.supports_mcp,
            "omp natively reads .omp/mcp.json (docs/104)"
        );
        assert!(!caps.supports_yolo);
        assert!(!caps.supports_orchestrated_launch);
        assert!(!caps.supports_effort_option);
        assert!(!caps.supports_verbose_option);
        assert!(!caps.supports_max_turns_option);
        assert_eq!(
            adapter.skill_delivery_modes(),
            vec![SkillDeliveryMode::PiSkill]
        );
        assert_eq!(
            adapter.global_skills_dir(),
            dirs::home_dir().map(|home| home.join(".omp").join("agent").join("skills"))
        );
    }

    #[test]
    fn pi_only_options_do_not_surface_in_omp_errors() {
        // Invalid Pi-specific values must be ignored rather than rejected,
        // because omp never consumes those option keys.
        let mut ctx = context(None);
        ctx.adapter_options
            .insert(PI_TRANSPORT_OPTION.to_string(), json!("invalid-transport"));
        assert!(OmpAdapter::new().build_command(&ctx).is_ok());
        assert!(
            PiAdapterOptions::from_adapter_options(&ctx.adapter_options).is_err(),
            "the same payload must still be invalid for the Pi adapter"
        );
    }

    #[test]
    fn mcp_sync_writes_project_omp_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = context(None);
        ctx.project_path = dir.path().to_string_lossy().into_owned();
        ctx.orchestrator_port = Some(3100);
        ctx.orchestrator_token = Some("tok".to_string());
        ctx.workspace_mcp_servers = BTreeMap::from([
            (
                "layer-stdio".to_string(),
                json!({"command":"npx","args":["-y","ctx7"],"env":{}}),
            ),
            (
                "layer-http".to_string(),
                json!({"type":"http","url":"https://remote/mcp"}),
            ),
        ]);
        ctx.shared_mcp_urls = HashMap::from([(
            "shared1".to_string(),
            "http://127.0.0.1:3101/mcp".to_string(),
        )]);

        OmpAdapter::new().build_command(&ctx).unwrap();

        let target = dir.path().join(".omp").join("mcp.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        // 层条目 stdio + http 原样进（omp 全支持）
        assert_eq!(value["mcpServers"]["layer-stdio"]["command"], "npx");
        assert_eq!(
            value["mcpServers"]["layer-http"]["url"],
            "https://remote/mcp"
        );
        // 共享 MCP 走 HTTP 桥 URL
        assert_eq!(value["mcpServers"]["shared1"]["type"], "http");
        // ccpanes 内置：HTTP + Authorization header，不带 launchId
        assert_eq!(
            value["mcpServers"]["ccpanes"]["url"],
            "http://127.0.0.1:3100/mcp?token=tok"
        );
        assert_eq!(
            value["mcpServers"]["ccpanes"]["headers"]["Authorization"],
            "Bearer tok"
        );
        // token 守卫：.omp/.gitignore 覆盖 mcp.json
        let guard = std::fs::read_to_string(dir.path().join(".omp").join(".gitignore")).unwrap();
        assert!(guard.contains("mcp.json"));
    }

    #[test]
    fn skip_mcp_removes_previously_injected_entries() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = context(None);
        ctx.project_path = dir.path().to_string_lossy().into_owned();
        ctx.workspace_mcp_servers =
            BTreeMap::from([("ctx7".to_string(), json!({"command":"npx"}))]);
        OmpAdapter::new().build_command(&ctx).unwrap();
        assert!(dir.path().join(".omp").join("mcp.json").exists());

        ctx.skip_mcp = true;
        OmpAdapter::new().build_command(&ctx).unwrap();

        let target = dir.path().join(".omp").join("mcp.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(
            value["mcpServers"].as_object().unwrap().len(),
            0,
            "skip_mcp must clear managed entries (omp reads the file live)"
        );
    }

    #[test]
    fn user_owned_entry_with_same_name_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let tool_dir = dir.path().join(".omp");
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(
            tool_dir.join("mcp.json"),
            json!({"mcpServers":{"ctx7":{"command":"user-own"}}}).to_string(),
        )
        .unwrap();
        let mut ctx = context(None);
        ctx.project_path = dir.path().to_string_lossy().into_owned();
        ctx.workspace_mcp_servers =
            BTreeMap::from([("ctx7".to_string(), json!({"command":"ccpanes-version"}))]);

        OmpAdapter::new().build_command(&ctx).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tool_dir.join("mcp.json")).unwrap())
                .unwrap();
        assert_eq!(value["mcpServers"]["ctx7"]["command"], "user-own");
    }
}
