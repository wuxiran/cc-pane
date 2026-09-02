//! Oh My Pi (`omp`) CLI adapter.
//!
//! Oh My Pi is a fork of Pi with an identical command-line surface: the same
//! `--provider`/`--model`/`--session`/`--thinking` flags, the same
//! `PI_CODING_AGENT_DIR` environment contract, and the same JSONL session
//! format. Differences that matter for launches: state lives under `~/.omp`
//! instead of `~/.pi`, and there are no `--name` or project-trust flags. The
//! shared Pi-family launch core in [`crate::pi`] owns the details; this module
//! only declares the Oh My Pi surface and capabilities.

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
        supports_mcp: false,
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
    use std::collections::HashMap;
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
        assert!(!caps.supports_mcp);
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
}
