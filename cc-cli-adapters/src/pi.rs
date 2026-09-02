//! Pi-family coding agent CLI adapters.
//!
//! Pi keeps authentication and custom-provider configuration under `~/.pi`.
//! Managed CC-Panes providers isolate that state per launch so a native
//! `auth.json` cannot override the Provider selected by CC-Panes. Native mode
//! intentionally does not redirect or mutate user-owned Pi state.
//!
//! Oh My Pi (`omp`) is a fork of Pi: identical CLI surface, environment
//! variables (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`), provider
//! names, and JSONL session format, but its state lives under `~/.omp` and it
//! has no `--name` or project-trust flags. Both adapters share the launch
//! core below; per-tool differences are declared in `PiFamilyConfig`.

use crate::{
    CliAdapterContext, CliCommandResult, CliProvider, CliToolAdapter, CliToolCapabilities,
    CliToolInfo, SkillDeliveryMode,
};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::info;

pub const PI_TRANSPORT_OPTION: &str = "piTransport";
pub const PI_NATIVE_PROVIDER_OPTION: &str = "piNativeProvider";
pub const PI_NATIVE_MODEL_OPTION: &str = "piNativeModel";
pub const PI_PROJECT_TRUST_OPTION: &str = "piProjectTrust";
pub const PI_SESSION_NAME_OPTION: &str = "piSessionName";
pub const PI_CODING_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
pub const PI_CODING_AGENT_SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";

const MANAGED_PI_RUNS_DIR_NAME: &str = "runs";
const MANAGED_PI_SESSIONS_DIR_NAME: &str = "ccpanes-managed";

/// Managed-state directory names under the CC-Panes data root. Exported so
/// cleanup descriptors in cc-panes-core can address the same per-launch state.
pub const PI_MANAGED_STATE_DIR_NAME: &str = "pi-managed";
pub const OMP_MANAGED_STATE_DIR_NAME: &str = "omp-managed";
/// Home-relative agent roots for the Pi family, shared with the WSL prelude
/// builders in cc-panes-core.
pub const PI_AGENT_HOME_DIR: &str = ".pi";
pub const OMP_AGENT_HOME_DIR: &str = ".omp";

/// Static launch-surface differences between the Pi-family CLIs. Everything
/// not listed here (flags, env contract, provider mapping) is shared.
pub(crate) struct PiFamilyConfig {
    pub(crate) id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) executable: &'static str,
    /// Home-relative agent directory (`.pi` / `.omp`).
    pub(crate) agent_home_dir: &'static str,
    /// Data-root child isolating managed state (`pi-managed` / `omp-managed`).
    pub(crate) managed_state_dir_name: &'static str,
    pub(crate) supports_transport_option: bool,
    pub(crate) supports_native_provider_options: bool,
    pub(crate) supports_session_name: bool,
    pub(crate) supports_project_trust: bool,
}

pub(crate) const PI_FAMILY_CONFIG: PiFamilyConfig = PiFamilyConfig {
    id: "pi",
    display_name: "Pi Coding Agent",
    executable: "pi",
    agent_home_dir: ".pi",
    managed_state_dir_name: PI_MANAGED_STATE_DIR_NAME,
    supports_transport_option: true,
    supports_native_provider_options: true,
    supports_session_name: true,
    supports_project_trust: true,
};

pub(crate) const OMP_FAMILY_CONFIG: PiFamilyConfig = PiFamilyConfig {
    id: "omp",
    display_name: "Oh My Pi",
    executable: "omp",
    agent_home_dir: ".omp",
    managed_state_dir_name: OMP_MANAGED_STATE_DIR_NAME,
    supports_transport_option: false,
    supports_native_provider_options: false,
    supports_session_name: false,
    supports_project_trust: false,
};

/// Produce a path-safe, deterministic component for a CC-Panes launch id.
/// The full id contributes to the suffix, while the bounded hex prefix keeps
/// Windows path components below their filesystem limit.
pub fn pi_managed_state_key(session_id: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in session_id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let prefix = session_id
        .bytes()
        .take(48)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("session-{prefix}-{hash:016x}")
}

fn pi_family_managed_state_dir(
    data_dir: &Path,
    session_id: &str,
    managed_dir_name: &str,
) -> PathBuf {
    data_dir
        .join(managed_dir_name)
        .join(MANAGED_PI_RUNS_DIR_NAME)
        .join(pi_managed_state_key(session_id))
}

/// Per-launch Pi state for a managed Provider. It deliberately excludes the
/// native Pi config directory, whose `auth.json` has higher precedence than
/// environment credentials.
pub fn pi_managed_state_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    pi_family_managed_state_dir(data_dir, session_id, PI_MANAGED_STATE_DIR_NAME)
}

fn pi_family_managed_sessions_dir(agent_home_dir: &str) -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join(agent_home_dir)
            .join("agent")
            .join("sessions")
            .join(MANAGED_PI_SESSIONS_DIR_NAME)
    })
}

/// Keep managed launches below Pi's ordinary session tree so CC-Panes can
/// index and restore their JSONL conversations without mixing them with native
/// Pi launches.
pub fn pi_managed_sessions_dir() -> Option<PathBuf> {
    pi_family_managed_sessions_dir(PI_FAMILY_CONFIG.agent_home_dir)
}

/// Remove an isolated managed state directory after its process exits. The
/// component is derived internally and cannot escape the supplied data root.
pub fn cleanup_pi_family_managed_state(
    data_dir: &Path,
    session_id: &str,
    managed_dir_name: &str,
) -> std::io::Result<()> {
    let state_dir = pi_family_managed_state_dir(data_dir, session_id, managed_dir_name);
    let metadata = match std::fs::symlink_metadata(&state_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // Never recursively follow a link or remove an unexpected file planted at
    // the run path. Both are harmless to leave for a later manual cleanup.
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(state_dir)
}

pub fn cleanup_pi_managed_state(data_dir: &Path, session_id: &str) -> std::io::Result<()> {
    cleanup_pi_family_managed_state(data_dir, session_id, PI_MANAGED_STATE_DIR_NAME)
}

pub fn cleanup_omp_managed_state(data_dir: &Path, session_id: &str) -> std::io::Result<()> {
    cleanup_pi_family_managed_state(data_dir, session_id, OMP_MANAGED_STATE_DIR_NAME)
}

/// Pi's launch transport. PTY remains the default user-facing experience;
/// RPC is reserved for the structured/background service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PiTransport {
    #[default]
    Pty,
    Rpc,
}

/// Project-resource trust is distinct from CC-Panes YOLO mode. Pi's
/// `--approve` only controls whether project-local resources are trusted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PiProjectTrust {
    #[default]
    Inherit,
    Approve,
    Deny,
}

/// Typed view over Pi-specific launch options stored in `adapter_options`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PiAdapterOptions {
    pub transport: PiTransport,
    pub native_provider: Option<String>,
    pub native_model: Option<String>,
    pub project_trust: PiProjectTrust,
    pub session_name: Option<String>,
}

impl PiAdapterOptions {
    pub fn from_adapter_options(options: &HashMap<String, Value>) -> Result<Self> {
        Ok(Self {
            transport: parse_transport(options.get(PI_TRANSPORT_OPTION))?,
            native_provider: parse_optional_string(options.get(PI_NATIVE_PROVIDER_OPTION))?,
            native_model: parse_optional_string(options.get(PI_NATIVE_MODEL_OPTION))?,
            project_trust: parse_project_trust(options.get(PI_PROJECT_TRUST_OPTION))?,
            session_name: parse_optional_string(options.get(PI_SESSION_NAME_OPTION))?,
        })
    }

    pub fn from_context(ctx: &CliAdapterContext) -> Result<Self> {
        Self::from_adapter_options(&ctx.adapter_options)
    }
}

fn parse_optional_string(value: Option<&Value>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("Pi adapter option must be a string"))?
        .trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

fn parse_transport(value: Option<&Value>) -> Result<PiTransport> {
    let Some(value) = value else {
        return Ok(PiTransport::Pty);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("{PI_TRANSPORT_OPTION} must be 'pty' or 'rpc'"))?
        .trim()
        .to_ascii_lowercase();
    match value.as_str() {
        "" | "pty" => Ok(PiTransport::Pty),
        "rpc" => Ok(PiTransport::Rpc),
        _ => Err(anyhow!("{PI_TRANSPORT_OPTION} must be 'pty' or 'rpc'")),
    }
}

fn parse_project_trust(value: Option<&Value>) -> Result<PiProjectTrust> {
    let Some(value) = value else {
        return Ok(PiProjectTrust::Inherit);
    };
    let value = value
        .as_str()
        .ok_or_else(|| {
            anyhow!("{PI_PROJECT_TRUST_OPTION} must be 'inherit', 'approve', or 'deny'")
        })?
        .trim()
        .to_ascii_lowercase();
    match value.as_str() {
        "" | "inherit" => Ok(PiProjectTrust::Inherit),
        "approve" => Ok(PiProjectTrust::Approve),
        "deny" => Ok(PiProjectTrust::Deny),
        _ => Err(anyhow!(
            "{PI_PROJECT_TRUST_OPTION} must be 'inherit', 'approve', or 'deny'"
        )),
    }
}

fn pi_thinking_from_options(
    options: &HashMap<String, Value>,
    display_name: &str,
) -> Result<Option<String>> {
    let Some(value) = options.get("effort") else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow!("{display_name} thinking level must be a string"))?
        .trim()
        .to_ascii_lowercase();
    if value.is_empty() || value == "default" {
        return Ok(None);
    }
    if matches!(
        value.as_str(),
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        return Ok(Some(value));
    }
    Err(anyhow!(
        "{display_name} thinking level must be one of off, minimal, low, medium, high, xhigh, or max"
    ))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn ensure_supported_base_url(
    provider: &CliProvider,
    expected: &str,
    display_name: &str,
) -> Result<()> {
    let Some(base_url) = nonempty(provider.base_url.as_deref()) else {
        return Ok(());
    };
    if base_url.trim_end_matches('/') == expected.trim_end_matches('/') {
        return Ok(());
    }
    Err(anyhow!(
        "{display_name} cannot apply the managed base URL for provider '{}'; select {} native auth/configuration for custom endpoints",
        provider.name,
        display_name
    ))
}

fn require_api_key<'a>(provider: &'a CliProvider, display_name: &str) -> Result<&'a str> {
    nonempty(provider.api_key.as_deref()).ok_or_else(|| {
        anyhow!(
            "{display_name} managed provider '{}' requires an API key; select {} native auth for subscription credentials",
            provider.name,
            display_name
        )
    })
}

fn push_env_if_nonempty(env: &mut HashMap<String, String>, key: &str, value: Option<&str>) {
    if let Some(value) = nonempty(value) {
        env.insert(key.to_string(), value.to_string());
    }
}

/// Build the Pi-native provider selection and environment for a managed
/// CC-Panes Provider. No API key is ever put in the command line.
fn managed_provider_plan(
    provider: &CliProvider,
    display_name: &str,
) -> Result<(&'static str, HashMap<String, String>)> {
    let mut env = HashMap::new();
    let pi_provider = match provider.provider_type.as_str() {
        "anthropic" => {
            ensure_supported_base_url(provider, "https://api.anthropic.com", display_name)?;
            env.insert(
                "ANTHROPIC_API_KEY".to_string(),
                require_api_key(provider, display_name)?.to_string(),
            );
            "anthropic"
        }
        "open_ai" => {
            ensure_supported_base_url(provider, "https://api.openai.com/v1", display_name)?;
            env.insert(
                "OPENAI_API_KEY".to_string(),
                require_api_key(provider, display_name)?.to_string(),
            );
            "openai"
        }
        "gemini" => {
            ensure_supported_base_url(
                provider,
                "https://generativelanguage.googleapis.com/v1beta",
                display_name,
            )?;
            env.insert(
                "GEMINI_API_KEY".to_string(),
                require_api_key(provider, display_name)?.to_string(),
            );
            "google"
        }
        "grok" => {
            ensure_supported_base_url(provider, "https://api.x.ai/v1", display_name)?;
            env.insert(
                "XAI_API_KEY".to_string(),
                require_api_key(provider, display_name)?.to_string(),
            );
            "xai"
        }
        "bedrock" => {
            push_env_if_nonempty(&mut env, "AWS_REGION", provider.region.as_deref());
            push_env_if_nonempty(&mut env, "AWS_PROFILE", provider.aws_profile.as_deref());
            "amazon-bedrock"
        }
        "vertex" => {
            push_env_if_nonempty(
                &mut env,
                "GOOGLE_CLOUD_API_KEY",
                provider.api_key.as_deref(),
            );
            push_env_if_nonempty(
                &mut env,
                "GOOGLE_CLOUD_PROJECT",
                provider.project_id.as_deref(),
            );
            push_env_if_nonempty(
                &mut env,
                "GOOGLE_CLOUD_LOCATION",
                provider.region.as_deref(),
            );
            "google-vertex"
        }
        unsupported => {
            return Err(anyhow!(
                "CC-Panes Provider type '{unsupported}' is not mapped to a {display_name} built-in provider; select {display_name} native auth/configuration instead"
            ));
        }
    };
    Ok((pi_provider, env))
}

fn validate_extra_args(
    options: &HashMap<String, Value>,
    managed_provider: bool,
    display_name: &str,
) -> Result<Vec<String>> {
    let args = crate::extra_args_from_options(options);
    if args
        .iter()
        .any(|arg| arg == "--api-key" || arg.starts_with("--api-key="))
    {
        return Err(anyhow!(
            "{display_name} API keys must be supplied through the process environment, not extraArgs"
        ));
    }
    if managed_provider
        && args.iter().any(|arg| {
            arg == "--session-dir" || arg.starts_with("--session-dir=") || arg == "--no-session"
        })
    {
        return Err(anyhow!(
            "Managed {display_name} launches keep sessions in CC-Panes storage; --session-dir and --no-session are not allowed in extraArgs"
        ));
    }
    Ok(args)
}

/// Shared launch core for the Pi family. `PiAdapter` and `OmpAdapter` are thin
/// wrappers that only differ in `PiFamilyConfig` and capability flags.
pub(crate) struct PiFamilyAdapter {
    config: PiFamilyConfig,
    info: CliToolInfo,
    caps: CliToolCapabilities,
}

impl PiFamilyAdapter {
    pub(crate) fn new(config: PiFamilyConfig, caps: CliToolCapabilities) -> Self {
        let info = CliToolInfo {
            id: config.id.into(),
            display_name: config.display_name.into(),
            executable: config.executable.into(),
            version_args: vec!["--version".into()],
            installed: false,
            version: None,
            path: None,
            capabilities: None,
        };
        Self { config, info, caps }
    }

    pub(crate) fn info(&self) -> &CliToolInfo {
        &self.info
    }

    pub(crate) fn capabilities(&self) -> &CliToolCapabilities {
        &self.caps
    }

    pub(crate) fn global_skills_dir(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|home| {
            home.join(self.config.agent_home_dir)
                .join("agent")
                .join("skills")
        })
    }

    pub(crate) fn build_command(&self, ctx: &CliAdapterContext) -> Result<CliCommandResult> {
        let config = &self.config;
        let uses_pi_options = config.supports_transport_option
            || config.supports_native_provider_options
            || config.supports_session_name
            || config.supports_project_trust;
        let options = uses_pi_options
            .then(|| PiAdapterOptions::from_context(ctx))
            .transpose()?;

        let mut args = Vec::new();
        let mut env_inject = HashMap::new();
        let mut env_remove = Vec::new();

        if options
            .as_ref()
            .is_some_and(|options| options.transport == PiTransport::Rpc)
        {
            args.push("--mode".to_string());
            args.push("rpc".to_string());
        }

        if let Some(provider) = ctx.provider.as_ref() {
            let (pi_provider, provider_env) = managed_provider_plan(provider, config.display_name)?;
            args.push("--provider".to_string());
            args.push(pi_provider.to_string());
            env_inject.extend(provider_env);
            let state_dir = pi_family_managed_state_dir(
                &ctx.data_dir,
                &ctx.session_id,
                config.managed_state_dir_name,
            );
            env_inject.insert(
                PI_CODING_AGENT_DIR_ENV.to_string(),
                state_dir.to_string_lossy().into_owned(),
            );
            if let Some(session_dir) = pi_family_managed_sessions_dir(config.agent_home_dir) {
                env_inject.insert(
                    PI_CODING_AGENT_SESSION_DIR_ENV.to_string(),
                    session_dir.to_string_lossy().into_owned(),
                );
            }
            env_remove.push(PI_CODING_AGENT_DIR_ENV.to_string());
            env_remove.push(PI_CODING_AGENT_SESSION_DIR_ENV.to_string());
            if let Some(model_id) = ctx.model_id() {
                args.push("--model".to_string());
                args.push(model_id.to_string());
            }
        } else if config.supports_native_provider_options {
            if let Some(options) = options.as_ref() {
                if let Some(provider) = options.native_provider.as_ref() {
                    args.push("--provider".to_string());
                    args.push(provider.clone());
                }
                if let Some(model) = options.native_model.as_ref() {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }
            }
        }

        if let Some(thinking) = pi_thinking_from_options(&ctx.adapter_options, config.display_name)?
        {
            args.push("--thinking".to_string());
            args.push(thinking);
        }
        if let Some(system_prompt) = ctx.append_system_prompt.as_ref() {
            args.push("--append-system-prompt".to_string());
            args.push(system_prompt.clone());
        }
        if let Some(resume_id) = ctx.resume_id.as_ref() {
            args.push("--session".to_string());
            args.push(resume_id.clone());
        }
        if config.supports_session_name {
            if let Some(session_name) = options
                .as_ref()
                .and_then(|options| options.session_name.clone())
            {
                args.push("--name".to_string());
                args.push(session_name);
            }
        }
        if config.supports_project_trust {
            match options
                .as_ref()
                .map(|options| options.project_trust)
                .unwrap_or_default()
            {
                PiProjectTrust::Inherit => {}
                PiProjectTrust::Approve => args.push("--approve".to_string()),
                PiProjectTrust::Deny => args.push("--no-approve".to_string()),
            }
        }

        args.extend(validate_extra_args(
            &ctx.adapter_options,
            ctx.provider.is_some(),
            config.display_name,
        )?);

        // Pi 0.84 does not support a `--` end-of-options delimiter. Its parser
        // treats that token as an unknown extension flag, so the prompt must be
        // passed directly after the documented options.
        if let Some(initial_prompt) = ctx.initial_prompt.as_ref() {
            args.push(initial_prompt.clone());
        }

        let (command, args) = ctx.resolve_launch(config.executable, args)?;
        info!(
            session_id = %ctx.session_id,
            command = %command,
            resume_id = ?ctx.resume_id,
            args = ?crate::redact_args_for_log(&args),
            "pi-family {}: build_command result",
            config.id
        );
        Ok(CliCommandResult {
            command,
            args,
            env_remove,
            env_inject,
        })
    }
}

pub struct PiAdapter {
    family: PiFamilyAdapter,
}

impl PiAdapter {
    pub fn new() -> Self {
        Self {
            family: PiFamilyAdapter::new(PI_FAMILY_CONFIG, pi_capabilities()),
        }
    }
}

impl Default for PiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn pi_capabilities() -> CliToolCapabilities {
    CliToolCapabilities {
        supports_provider: true,
        supports_resume: true,
        supports_mcp: false,
        supports_system_prompt: true,
        supports_workspace: false,
        supports_project_hooks: false,
        supports_issued_session_id: false,
        supports_rpc: true,
        supports_structured_result: true,
        supports_yolo: false,
        supports_orchestrated_launch: true,
        supports_effort_option: false,
        supports_verbose_option: false,
        supports_max_turns_option: false,
        compatible_provider_types: pi_family_compatible_provider_types(),
    }
}

pub(crate) fn pi_family_compatible_provider_types() -> Vec<String> {
    vec![
        "anthropic".into(),
        "bedrock".into(),
        "vertex".into(),
        "open_ai".into(),
        "gemini".into(),
        "grok".into(),
    ]
}

impl CliToolAdapter for PiAdapter {
    fn info(&self) -> &CliToolInfo {
        self.family.info()
    }

    fn capabilities(&self) -> &CliToolCapabilities {
        self.family.capabilities()
    }

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
    use serde_json::json;

    fn context(managed_provider: Option<CliProvider>) -> CliAdapterContext {
        CliAdapterContext {
            session_id: "pane-session".to_string(),
            project_path: "/repo".to_string(),
            workspace_path: None,
            provider: managed_provider,
            executable_override: Some("pi-test".to_string()),
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
    fn typed_options_parse_defaults_and_reject_invalid_values() {
        assert_eq!(
            PiAdapterOptions::from_adapter_options(&HashMap::new()).unwrap(),
            PiAdapterOptions::default()
        );
        let invalid = HashMap::from([(
            PI_TRANSPORT_OPTION.to_string(),
            Value::String("background".to_string()),
        )]);
        assert!(PiAdapterOptions::from_adapter_options(&invalid).is_err());
        let invalid = HashMap::from([(
            PI_PROJECT_TRUST_OPTION.to_string(),
            Value::String("yes".to_string()),
        )]);
        assert!(PiAdapterOptions::from_adapter_options(&invalid).is_err());
    }

    #[test]
    fn native_command_uses_pi_options_without_touching_native_auth() {
        let mut ctx = context(None);
        ctx.adapter_options = HashMap::from([
            (PI_TRANSPORT_OPTION.to_string(), json!("rpc")),
            (PI_NATIVE_PROVIDER_OPTION.to_string(), json!("openai-codex")),
            (PI_NATIVE_MODEL_OPTION.to_string(), json!("gpt-5")),
            (PI_PROJECT_TRUST_OPTION.to_string(), json!("deny")),
            (PI_SESSION_NAME_OPTION.to_string(), json!("Research")),
            ("effort".to_string(), json!("high")),
        ]);
        ctx.resume_id = Some("pi-session-id".to_string());
        ctx.append_system_prompt = Some("Follow the repository instructions".to_string());
        ctx.initial_prompt = Some("Inspect the issue".to_string());

        let result = PiAdapter::new().build_command(&ctx).unwrap();
        assert_eq!(result.command, "pi-test");
        assert_eq!(
            result.args,
            vec![
                "--mode",
                "rpc",
                "--provider",
                "openai-codex",
                "--model",
                "gpt-5",
                "--thinking",
                "high",
                "--append-system-prompt",
                "Follow the repository instructions",
                "--session",
                "pi-session-id",
                "--name",
                "Research",
                "--no-approve",
                "Inspect the issue",
            ]
        );
        assert!(result.env_inject.is_empty());
        assert!(result.env_remove.is_empty());
    }

    #[test]
    fn managed_openai_uses_environment_never_api_key_argument() {
        let mut ctx = context(Some(provider("open_ai")));
        ctx.adapter_options
            .insert("__ccpanesModelId".to_string(), json!("gpt-5"));
        ctx.initial_prompt = Some("Review this change".to_string());

        let result = PiAdapter::new().build_command(&ctx).unwrap();
        assert_eq!(
            result.args,
            vec![
                "--provider",
                "openai",
                "--model",
                "gpt-5",
                "Review this change"
            ]
        );
        assert_eq!(
            result.env_inject.get("OPENAI_API_KEY").map(String::as_str),
            Some("managed-secret")
        );
        let state_dir = result
            .env_inject
            .get(PI_CODING_AGENT_DIR_ENV)
            .expect("managed Pi state directory");
        assert_eq!(
            PathBuf::from(state_dir),
            pi_managed_state_dir(&ctx.data_dir, &ctx.session_id)
        );
        assert_ne!(
            PathBuf::from(state_dir),
            dirs::home_dir()
                .expect("home directory")
                .join(".pi")
                .join("agent")
        );
        assert_eq!(
            result
                .env_inject
                .get(PI_CODING_AGENT_SESSION_DIR_ENV)
                .map(PathBuf::from),
            pi_managed_sessions_dir()
        );
        assert!(result
            .env_remove
            .iter()
            .any(|key| key == PI_CODING_AGENT_DIR_ENV));
        assert!(result
            .env_remove
            .iter()
            .any(|key| key == PI_CODING_AGENT_SESSION_DIR_ENV));
        assert!(!result.args.iter().any(|arg| arg.contains("managed-secret")));
        assert!(!result.args.iter().any(|arg| arg == "--api-key"));
    }

    #[test]
    fn managed_launches_use_distinct_state_dirs_but_share_a_stable_session_root() {
        let mut first_context = context(Some(provider("open_ai")));
        first_context.session_id = "managed-first".to_string();
        let mut second_context = first_context.clone();
        second_context.session_id = "managed-second".to_string();

        let first = PiAdapter::new().build_command(&first_context).unwrap();
        let second = PiAdapter::new().build_command(&second_context).unwrap();

        assert_ne!(
            first.env_inject.get(PI_CODING_AGENT_DIR_ENV),
            second.env_inject.get(PI_CODING_AGENT_DIR_ENV)
        );
        assert_eq!(
            first.env_inject.get(PI_CODING_AGENT_SESSION_DIR_ENV),
            second.env_inject.get(PI_CODING_AGENT_SESSION_DIR_ENV)
        );
        assert!(first
            .env_inject
            .get(PI_CODING_AGENT_SESSION_DIR_ENV)
            .is_some_and(
                |path| path.ends_with(".pi\\agent\\sessions\\ccpanes-managed")
                    || path.ends_with(".pi/agent/sessions/ccpanes-managed")
            ));
    }

    #[test]
    fn managed_provider_rejects_unmapped_type_and_custom_base_url() {
        let error = match PiAdapter::new().build_command(&context(Some(provider("proxy")))) {
            Ok(_) => panic!("an unmapped provider must be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("not mapped"));

        let mut custom = provider("open_ai");
        custom.base_url = Some("https://gateway.example/v1".to_string());
        let error = match PiAdapter::new().build_command(&context(Some(custom))) {
            Ok(_) => panic!("a custom managed endpoint must be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("custom endpoints"));
    }

    #[test]
    fn yolo_mode_never_implies_project_trust() {
        let mut ctx = context(None);
        ctx.yolo_mode = true;
        let result = PiAdapter::new().build_command(&ctx).unwrap();
        assert!(!result.args.iter().any(|arg| arg == "--approve"));
        assert!(!result.args.iter().any(|arg| arg == "--no-approve"));

        ctx.adapter_options
            .insert(PI_PROJECT_TRUST_OPTION.to_string(), json!("approve"));
        let result = PiAdapter::new().build_command(&ctx).unwrap();
        assert!(result.args.iter().any(|arg| arg == "--approve"));
    }

    #[test]
    fn extra_args_cannot_supply_api_keys() {
        let mut ctx = context(None);
        ctx.adapter_options
            .insert("extraArgs".to_string(), json!(["--api-key", "not-allowed"]));
        let error = match PiAdapter::new().build_command(&ctx) {
            Ok(_) => panic!("extraArgs must not accept an API key"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("process environment"));
    }

    #[test]
    fn managed_extra_args_cannot_override_ccpanes_session_storage() {
        for extra_arg in ["--session-dir", "--session-dir=custom", "--no-session"] {
            let mut ctx = context(Some(provider("open_ai")));
            ctx.adapter_options
                .insert("extraArgs".to_string(), json!([extra_arg]));

            let error = match PiAdapter::new().build_command(&ctx) {
                Ok(_) => panic!("managed Pi must retain its session storage"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("CC-Panes storage"));
        }

        let mut native = context(None);
        native
            .adapter_options
            .insert("extraArgs".to_string(), json!(["--session-dir=custom"]));
        assert!(PiAdapter::new().build_command(&native).is_ok());
    }

    #[test]
    fn pi_capabilities_match_actual_integration_surface() {
        let adapter = PiAdapter::new();
        let caps = adapter.capabilities();
        assert!(caps.supports_rpc);
        assert!(caps.supports_structured_result);
        assert!(!caps.supports_mcp);
        assert!(!caps.supports_project_hooks);
        assert!(!caps.supports_issued_session_id);
        assert!(!caps.supports_yolo);
        assert!(caps.supports_orchestrated_launch);
        assert!(!caps.supports_effort_option);
        assert!(!caps.supports_verbose_option);
        assert!(!caps.supports_max_turns_option);
        assert_eq!(
            adapter.skill_delivery_modes(),
            vec![SkillDeliveryMode::PiSkill]
        );
    }
}
