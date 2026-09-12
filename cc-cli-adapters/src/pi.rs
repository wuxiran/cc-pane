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
//!
//! MCP（docs/104）：两个 CLI 走完全不同的路——
//! - **omp 原生支持 MCP**（stdio/HTTP/SSE），注入面是项目 `.omp/mcp.json`，
//!   见 [`crate::omp`]。
//! - **pi 上游没有 MCP 客户端**（0.85.x 实机取证：自有代码零 MCP 字符串，
//!   官方立场是用扩展系统替代）。CC-Panes 通过 pi 的扩展机制桥接：启动时写
//!   per-session 配置 `<data_dir>/mcp-pi-<session>.json` + 注入
//!   `CCPANES_MCP_CONFIG` env + 把零依赖桥接扩展
//!   `resources/pi-mcp-bridge.js`（include_str 内嵌）落进 extensions 目录
//!   （托管启动 → `<PI_CODING_AGENT_DIR>/extensions/`，原生启动 →
//!   `~/.pi/agent/extensions/`，内容比对幂等）。扩展把每个 MCP server 的
//!   工具注册成 pi 原生工具（`mcp__<server>__<tool>`）。无 env 时扩展完全
//!   惰性，不影响用户在 CC-Panes 之外手动使用 pi。RPC 模式（`--mode rpc`）
//!   同样加载扩展，但 RPC 启动链固定 skip_mcp=true（v1 不注入）。

use crate::mcp_file_injection::{self, CollectOptions};
use crate::{
    CliAdapterContext, CliCommandResult, CliProvider, CliToolAdapter, CliToolCapabilities,
    CliToolInfo, SkillDeliveryMode,
};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub const PI_TRANSPORT_OPTION: &str = "piTransport";
pub const PI_NATIVE_PROVIDER_OPTION: &str = "piNativeProvider";
pub const PI_NATIVE_MODEL_OPTION: &str = "piNativeModel";
pub const PI_PROJECT_TRUST_OPTION: &str = "piProjectTrust";
pub const PI_SESSION_NAME_OPTION: &str = "piSessionName";
pub const PI_CODING_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
pub const PI_CODING_AGENT_SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";

/// 桥接扩展读取的 per-session MCP 配置路径 env（docs/104）。
pub const CCPANES_MCP_CONFIG_ENV: &str = "CCPANES_MCP_CONFIG";
/// 落进 pi extensions 目录的桥接扩展文件名。
const PI_MCP_EXTENSION_FILE_NAME: &str = "ccpanes-mcp.js";
/// 桥接扩展源码（零依赖单文件，随二进制编译分发——daemon 侧没有资源目录
/// 解析问题，与 claude 的 hook 分发同理）。
const PI_MCP_BRIDGE_SOURCE: &str = include_str!("../resources/pi-mcp-bridge.js");
/// per-session 配置文件名前缀（与 claude.rs 的 `mcp-*.json` 1h GC 循环兼容）。
const PI_MCP_CONFIG_FILE_PREFIX: &str = "mcp-pi-";

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
        // pi 上游无 MCP 客户端；CC-Panes 用自带扩展桥把 MCP 工具注册成 pi
        // 原生工具（CCPANES_MCP_CONFIG + extensions/ccpanes-mcp.js，docs/104）
        supports_mcp: true,
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

// ---------------------------------------------------------------------------
// MCP 扩展桥（docs/104）
// ---------------------------------------------------------------------------

/// 桥接扩展落点：托管启动进隔离 agent root（family 已把
/// `PI_CODING_AGENT_DIR` 写进 env_inject），原生启动进 `~/.pi/agent/extensions`。
/// `home` 参数仅供测试注入，生产传 `dirs::home_dir()`。
fn pi_extension_dir(
    env_inject: &HashMap<String, String>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(managed) = env_inject
        .get(PI_CODING_AGENT_DIR_ENV)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Some(PathBuf::from(managed).join("extensions"));
    }
    home.map(|home| {
        home.join(PI_AGENT_HOME_DIR)
            .join("agent")
            .join("extensions")
    })
}

/// 内容比对幂等落盘：已是最新则零写入（不刷 mtime，避免每次启动都触发
/// pi 的扩展缓存失效/jiti 重编译）。
fn write_pi_mcp_extension(extensions_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(extensions_dir)?;
    let target = extensions_dir.join(PI_MCP_EXTENSION_FILE_NAME);
    if let Ok(existing) = std::fs::read_to_string(&target) {
        if existing == PI_MCP_BRIDGE_SOURCE {
            return Ok(());
        }
    }
    std::fs::write(&target, PI_MCP_BRIDGE_SOURCE)
}

/// 清理 >1h 的旧 per-session 配置（claude.rs 同款 GC 语义；文件名前缀
/// `mcp-pi-` 同时落在 claude 的 `mcp-*.json` 清理循环里，双保险）。
fn gc_stale_pi_mcp_configs(data_dir: &Path, current_file: &str) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(PI_MCP_CONFIG_FILE_PREFIX)
            && name_str.ends_with(".json")
            && *name_str != *current_file
        {
            if let Ok(meta) = entry.metadata() {
                if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Pi MCP 桥接注入：per-session 配置 + `CCPANES_MCP_CONFIG` env + 扩展落盘。
/// best-effort——任何失败只 warn 不阻断启动（MCP 缺失不致命）。
///
/// skip_mcp / 空集合：只 env_remove（扩展没有 env 即完全惰性），并清掉本
/// 会话可能残留的配置文件；不落扩展文件（已存在的旧扩展无害）。
fn inject_pi_mcp_bridge(ctx: &CliAdapterContext, result: &mut CliCommandResult) {
    // 用户环境里可能残留旧值：先无条件摘除，激活时再注入
    result.env_remove.push(CCPANES_MCP_CONFIG_ENV.to_string());

    let ccpanes_entry = ctx
        .orchestrator_port
        .zip(ctx.orchestrator_token.as_deref())
        .map(|(port, token)| mcp_file_injection::ccpanes_http_entry(port, token));
    let collected = mcp_file_injection::collect_mcp_servers(
        ctx,
        &CollectOptions {
            // pi 桥扩展同时会说 stdio 与 Streamable HTTP，http/sse 层条目直传；
            // 共享 MCP 用 HTTP 桥 URL（桥进程已在跑，比每会话再拉一份 stdio 省资源）
            stdio_only: false,
            ccpanes_entry,
        },
    );
    for name in &collected.skipped_invalid_names {
        warn!(server = %name, "pi: invalid MCP server name skipped");
    }
    if collected.servers.is_empty() {
        return;
    }
    if ctx.disable_unlisted_mcp_servers {
        warn!(
            "pi: MCP isolation only narrows the CC-Panes managed set; pi has no channel to \
             disable servers the user installed into their own pi config"
        );
    }

    // 1) per-session 配置（扩展启动时读一次）
    let file_name = format!("{PI_MCP_CONFIG_FILE_PREFIX}{}.json", ctx.session_id);
    let config_path = ctx.data_dir.join(&file_name);
    gc_stale_pi_mcp_configs(&ctx.data_dir, &file_name);
    let config = serde_json::json!({ "mcpServers": collected.servers });
    if let Err(error) = std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap_or_default(),
    ) {
        warn!(
            session_id = %ctx.session_id,
            %error,
            "pi: failed to write MCP bridge config; extension stays inert"
        );
        return;
    }
    result.env_inject.insert(
        CCPANES_MCP_CONFIG_ENV.to_string(),
        config_path.to_string_lossy().into_owned(),
    );

    // 2) 桥接扩展落进 pi 的 extensions 发现目录
    let Some(extensions_dir) = pi_extension_dir(&result.env_inject, dirs::home_dir()) else {
        warn!(
            session_id = %ctx.session_id,
            "pi: no agent home resolvable; MCP bridge extension not installed"
        );
        return;
    };
    match write_pi_mcp_extension(&extensions_dir) {
        Ok(()) => info!(
            session_id = %ctx.session_id,
            extensions_dir = %extensions_dir.display(),
            servers = collected.servers.len(),
            "pi: MCP bridge extension + per-session config ready"
        ),
        Err(error) => warn!(
            session_id = %ctx.session_id,
            extensions_dir = %extensions_dir.display(),
            %error,
            "pi: failed to install MCP bridge extension; config written but tools will not appear"
        ),
    }
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
        let mut result = self.family.build_command(ctx)?;
        // family 已决定是否托管（env_inject 里的 PI_CODING_AGENT_DIR），
        // 桥接注入依赖该结果选扩展落点，必须放在其后。
        inject_pi_mcp_bridge(ctx, &mut result);
        Ok(result)
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
        // 无 MCP 注入时只留下休眠守卫：摘除环境里可能残留的桥配置路径
        assert_eq!(result.env_remove, vec![CCPANES_MCP_CONFIG_ENV.to_string()]);
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
        assert!(
            caps.supports_mcp,
            "pi gets MCP through the CC-Panes extension bridge (docs/104)"
        );
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

    fn mcp_context(dir: &Path, managed_provider: Option<CliProvider>) -> CliAdapterContext {
        let mut ctx = context(managed_provider);
        ctx.session_id = "mcp-bridge-session".to_string();
        ctx.data_dir = dir.to_path_buf();
        ctx.orchestrator_port = Some(3100);
        ctx.orchestrator_token = Some("tok".to_string());
        ctx
    }

    #[test]
    fn managed_launch_writes_bridge_config_and_extension_into_isolated_agent_root() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = mcp_context(dir.path(), Some(provider("anthropic")));
        ctx.workspace_mcp_servers = std::collections::BTreeMap::from([(
            "ctx7".to_string(),
            json!({"command":"npx","args":["-y","ctx7"],"env":{}}),
        )]);

        let result = PiAdapter::new().build_command(&ctx).unwrap();

        // env：CCPANES_MCP_CONFIG 指向 per-session 配置
        let config_env = result
            .env_inject
            .get(CCPANES_MCP_CONFIG_ENV)
            .expect("bridge config env");
        let config_path = PathBuf::from(config_env);
        assert_eq!(
            config_path,
            dir.path().join("mcp-pi-mcp-bridge-session.json")
        );
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        // 层条目 + ccpanes HTTP（带 Authorization，不带 launchId）
        assert_eq!(config["mcpServers"]["ctx7"]["command"], "npx");
        assert_eq!(
            config["mcpServers"]["ccpanes"]["url"],
            "http://127.0.0.1:3100/mcp?token=tok"
        );
        assert_eq!(
            config["mcpServers"]["ccpanes"]["headers"]["Authorization"],
            "Bearer tok"
        );
        // 扩展落进隔离 agent root（PI_CODING_AGENT_DIR/extensions）
        let managed_dir = result
            .env_inject
            .get(PI_CODING_AGENT_DIR_ENV)
            .expect("managed agent dir");
        let extension = PathBuf::from(managed_dir)
            .join("extensions")
            .join("ccpanes-mcp.js");
        let source = std::fs::read_to_string(&extension).expect("extension installed");
        assert!(source.contains("CCPANES_MCP_CONFIG"));
        assert!(source.contains("registerTool"));
    }

    #[test]
    fn skip_mcp_keeps_bridge_inert() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = mcp_context(dir.path(), Some(provider("anthropic")));
        ctx.skip_mcp = true;
        ctx.workspace_mcp_servers =
            std::collections::BTreeMap::from([("ctx7".to_string(), json!({"command":"npx"}))]);

        let result = PiAdapter::new().build_command(&ctx).unwrap();

        assert!(
            !result.env_inject.contains_key(CCPANES_MCP_CONFIG_ENV),
            "skip_mcp must not activate the bridge"
        );
        assert!(result
            .env_remove
            .contains(&CCPANES_MCP_CONFIG_ENV.to_string()));
        assert!(!dir.path().join("mcp-pi-mcp-bridge-session.json").exists());
    }

    #[test]
    fn dormant_without_any_mcp_source() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = mcp_context(dir.path(), None);
        ctx.orchestrator_port = None;
        ctx.orchestrator_token = None;

        let result = PiAdapter::new().build_command(&ctx).unwrap();

        // 无任何 MCP 源：不写配置、不落扩展（原生启动的扩展落点是真实
        // ~/.pi，测试绝不能触碰；落点解析由 extension_dir_* 单测覆盖）
        assert!(!result.env_inject.contains_key(CCPANES_MCP_CONFIG_ENV));
        assert_eq!(result.env_remove, vec![CCPANES_MCP_CONFIG_ENV.to_string()]);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "data dir must stay clean when the bridge is dormant"
        );
    }

    #[test]
    fn gc_removes_stale_pi_configs_only() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("mcp-pi-old-session.json");
        std::fs::write(&stale, "{}").unwrap();
        filetime_set_two_hours_ago(&stale);
        let fresh = dir.path().join("mcp-pi-new-session.json");
        std::fs::write(&fresh, "{}").unwrap();
        let unrelated = dir.path().join("other.json");
        std::fs::write(&unrelated, "{}").unwrap();

        gc_stale_pi_mcp_configs(dir.path(), "mcp-pi-current.json");

        assert!(!stale.exists(), "stale pi config must be collected");
        assert!(fresh.exists(), "fresh pi config must survive");
        assert!(unrelated.exists(), "unrelated files must not be touched");
    }

    /// `std::fs::FileTimes`（Rust 1.75+ 稳定）：跨平台把 mtime 拨回 2 小时前。
    fn filetime_set_two_hours_ago(path: &Path) {
        use std::fs::FileTimes;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open for time travel");
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        file.set_times(FileTimes::new().set_modified(mtime))
            .expect("set mtime");
    }

    #[test]
    fn extension_dir_prefers_managed_agent_root_over_home() {
        let mut env_inject = HashMap::new();
        env_inject.insert(
            PI_CODING_AGENT_DIR_ENV.to_string(),
            "/managed/root".to_string(),
        );
        let managed = pi_extension_dir(&env_inject, Some(PathBuf::from("/home/user")));
        assert_eq!(managed, Some(PathBuf::from("/managed/root/extensions")));

        let native = pi_extension_dir(&HashMap::new(), Some(PathBuf::from("/home/user")));
        assert_eq!(
            native,
            Some(PathBuf::from("/home/user/.pi/agent/extensions"))
        );

        let headless = pi_extension_dir(&HashMap::new(), None);
        assert_eq!(headless, None);
    }
}
