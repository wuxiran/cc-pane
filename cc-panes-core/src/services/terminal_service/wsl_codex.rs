#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use super::cached_which;
use super::TerminalService;
use crate::models::WslLaunchInfo;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(windows)]
use tracing::{info, warn};

pub(super) const WSL_ERROR_CODE_CODEX_NOT_FOUND: &str = "WSL_CODEX_NOT_FOUND";
pub(super) const WSL_ERROR_CODE_CODEX_WINDOWS_SHIM: &str = "WSL_CODEX_WINDOWS_SHIM";
pub(super) const WSL_ERROR_CODE_NODE_NOT_FOUND: &str = "WSL_NODE_NOT_FOUND";
pub(super) const WSL_ERROR_CODE_HOST_UNRESOLVED: &str = "WSL_HOST_UNRESOLVED";
pub(super) const WSL_BASH_EVAL_FLAG: &str = "-lic";
pub(super) const WSL_PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SensitiveEnvVarSummary {
    pub(super) present: bool,
    pub(super) len: usize,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedWslLaunch {
    pub(super) wsl_path: PathBuf,
    pub(super) distro: String,
    pub(super) remote_path: String,
    pub(super) windows_host: Option<String>,
    pub(super) native_codex_path: Option<String>,
    pub(super) native_node_path: Option<String>,
}

fn is_wsl_proxy_env_key(key: &str) -> bool {
    WSL_PROXY_ENV_KEYS
        .iter()
        .any(|candidate| key.eq_ignore_ascii_case(candidate))
}

pub(super) fn strip_wsl_proxy_env_vars(env_vars: &mut HashMap<String, String>) {
    env_vars.retain(|key, _| !is_wsl_proxy_env_key(key));
}

pub(super) fn summarize_sensitive_env_var(
    env_vars: &HashMap<String, String>,
    key: &str,
) -> SensitiveEnvVarSummary {
    match env_vars.get(key) {
        Some(value) => SensitiveEnvVarSummary {
            present: true,
            len: value.len(),
        },
        None => SensitiveEnvVarSummary {
            present: false,
            len: 0,
        },
    }
}

pub(super) fn collect_env_key_names(env_vars: &HashMap<String, String>) -> Vec<String> {
    let mut keys: Vec<String> = env_vars.keys().cloned().collect();
    keys.sort();
    keys
}

pub(super) fn is_wsl_windows_shim_path(path: &str) -> bool {
    let lowered = path.trim().to_ascii_lowercase();
    lowered.starts_with("/mnt/")
        || lowered.ends_with(".cmd")
        || lowered.ends_with(".ps1")
        || lowered.ends_with(".exe")
}

pub(super) fn build_wsl_mcp_url(windows_host: &str, port: &str, token: &str) -> String {
    format!("http://{}:{}/mcp?token={}", windows_host, port, token)
}

fn append_codex_resume_args(
    codex_args: &mut Vec<String>,
    resume_id: Option<&str>,
    initial_prompt: Option<&str>,
) {
    if let Some(resume_id) = resume_id {
        codex_args.push("resume".to_string());
        codex_args.push(resume_id.to_string());
    }

    if let Some(initial_prompt) = initial_prompt {
        codex_args.push(initial_prompt.to_string());
    }
}

fn is_wsl_home_path(path: &str) -> bool {
    matches!(path.trim(), "~" | "~/")
}

fn extract_ipv4_from_text(text: &str) -> Option<std::net::Ipv4Addr> {
    text.split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .find_map(|part| part.parse::<std::net::Ipv4Addr>().ok())
}

fn is_valid_wsl_host_candidate(candidate: std::net::Ipv4Addr) -> bool {
    !candidate.is_loopback() && !candidate.is_unspecified()
}

pub(super) fn resolve_wsl_host_candidate_from_output(
    text: &str,
    require_private: bool,
) -> Option<std::net::Ipv4Addr> {
    let candidate = extract_ipv4_from_text(text)?;
    if !is_valid_wsl_host_candidate(candidate) {
        return None;
    }
    if require_private && !candidate.is_private() {
        return None;
    }
    Some(candidate)
}

#[cfg(windows)]
pub(super) fn windows_path_to_wsl(path: &std::path::Path) -> Option<String> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let bytes = normalized.as_bytes();
    if normalized.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }

    let mut suffix = normalized[2..].trim_start_matches('/').to_string();
    if suffix.is_empty() {
        return Some(format!("/mnt/{}", (bytes[0] as char).to_ascii_lowercase()));
    }

    suffix = suffix.replace('\\', "/");
    Some(format!(
        "/mnt/{}/{}",
        (bytes[0] as char).to_ascii_lowercase(),
        suffix
    ))
}

#[cfg(windows)]
fn rewrite_windows_path_string_for_wsl(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let looks_windows_path = input.starts_with("\\\\?\\")
        || (input.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'));
    if !looks_windows_path {
        return None;
    }

    windows_path_to_wsl(std::path::Path::new(input))
}

#[cfg(windows)]
fn rewrite_toml_value_for_wsl(value: toml::Value) -> toml::Value {
    match value {
        toml::Value::String(text) => rewrite_windows_path_string_for_wsl(&text)
            .map(toml::Value::String)
            .unwrap_or(toml::Value::String(text)),
        toml::Value::Array(items) => {
            toml::Value::Array(items.into_iter().map(rewrite_toml_value_for_wsl).collect())
        }
        toml::Value::Table(table) => toml::Value::Table(
            table
                .into_iter()
                .map(|(key, value)| (key, rewrite_toml_value_for_wsl(value)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(windows)]
fn is_wsl_compatible_mcp_command(command: &str) -> bool {
    let lowered = command.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return false;
    }

    !(lowered == "cmd"
        || lowered == "cmd.exe"
        || lowered == "powershell"
        || lowered == "powershell.exe"
        || lowered == "pwsh.exe"
        || lowered.ends_with(".exe")
        || lowered.ends_with(".cmd")
        || lowered.ends_with(".ps1"))
}

#[cfg(windows)]
fn sanitize_wsl_mcp_servers(value: toml::Value) -> Option<toml::Value> {
    let toml::Value::Table(servers) = value else {
        return None;
    };

    let mut sanitized = toml::map::Map::new();
    for (name, server) in servers {
        if name.eq_ignore_ascii_case("ccpanes") {
            continue;
        }

        let server = rewrite_toml_value_for_wsl(server);
        let keep = match &server {
            toml::Value::Table(table) => {
                if table.contains_key("url") {
                    true
                } else {
                    table
                        .get("command")
                        .and_then(toml::Value::as_str)
                        .map(is_wsl_compatible_mcp_command)
                        .unwrap_or(false)
                }
            }
            _ => false,
        };

        if keep {
            sanitized.insert(name, server);
        }
    }

    if sanitized.is_empty() {
        None
    } else {
        Some(toml::Value::Table(sanitized))
    }
}

#[cfg(windows)]
fn sanitize_wsl_codex_config_root(
    root: toml::map::Map<String, toml::Value>,
) -> toml::map::Map<String, toml::Value> {
    let mut sanitized = toml::map::Map::new();
    for (key, value) in root {
        match key.as_str() {
            "windows" | "projects" => {}
            "mcp_servers" => {
                if let Some(servers) = sanitize_wsl_mcp_servers(value) {
                    sanitized.insert(key, servers);
                }
            }
            _ => {
                sanitized.insert(key, rewrite_toml_value_for_wsl(value));
            }
        }
    }

    sanitized
}

#[cfg(windows)]
pub(super) fn parse_wsl_codex_config_content(
    content: &str,
) -> Result<Option<toml::map::Map<String, toml::Value>>> {
    if content.trim().is_empty() {
        return Ok(None);
    }

    let parsed: toml::Value = toml::from_str(content)?;
    let toml::Value::Table(root) = parsed else {
        return Ok(None);
    };

    let sanitized = sanitize_wsl_codex_config_root(root);
    if sanitized.is_empty() {
        Ok(None)
    } else {
        Ok(Some(sanitized))
    }
}

#[cfg(windows)]
fn serialize_wsl_codex_config_root(root: toml::map::Map<String, toml::Value>) -> Result<String> {
    if root.is_empty() {
        Ok(String::new())
    } else {
        Ok(toml::to_string_pretty(&toml::Value::Table(root))?)
    }
}

#[cfg(windows)]
fn is_simple_toml_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

#[cfg(windows)]
fn format_toml_key_segment_for_cli(segment: &str) -> String {
    if is_simple_toml_key_segment(segment) {
        segment.to_string()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| {
            format!("\"{}\"", segment.replace('\\', "\\\\").replace('"', "\\\""))
        })
    }
}

#[cfg(windows)]
pub(super) fn format_toml_value_for_cli(value: &toml::Value) -> String {
    match value {
        toml::Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        toml::Value::Integer(number) => number.to_string(),
        toml::Value::Float(number) => number.to_string(),
        toml::Value::Boolean(flag) => flag.to_string(),
        toml::Value::Datetime(datetime) => datetime.to_string(),
        toml::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(format_toml_value_for_cli)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        toml::Value::Table(table) => {
            let mut entries = table
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{} = {}",
                        format_toml_key_segment_for_cli(key),
                        format_toml_value_for_cli(value)
                    )
                })
                .collect::<Vec<_>>();
            entries.sort();
            format!("{{ {} }}", entries.join(", "))
        }
    }
}

#[cfg(windows)]
fn should_skip_wsl_codex_cli_override(path: &[String]) -> bool {
    matches!(
        path,
        [single] if single == "approval_policy" || single == "sandbox_mode"
    )
}

#[cfg(windows)]
fn table_requires_inline_wsl_override(
    path: &[String],
    table: &toml::map::Map<String, toml::Value>,
) -> bool {
    path.iter()
        .any(|segment| !is_simple_toml_key_segment(segment))
        || table
            .keys()
            .any(|segment| !is_simple_toml_key_segment(segment))
}

#[cfg(windows)]
fn collect_wsl_codex_cli_overrides(
    path: &mut Vec<String>,
    value: &toml::Value,
    overrides: &mut Vec<String>,
) {
    match value {
        toml::Value::Table(table) => {
            if !path.is_empty() && table_requires_inline_wsl_override(path, table) {
                if should_skip_wsl_codex_cli_override(path) {
                    return;
                }

                let key = path
                    .iter()
                    .map(|segment| format_toml_key_segment_for_cli(segment))
                    .collect::<Vec<_>>()
                    .join(".");
                overrides.push(format!("{}={}", key, format_toml_value_for_cli(value)));
                return;
            }

            for (key, child) in table {
                path.push(key.clone());
                collect_wsl_codex_cli_overrides(path, child, overrides);
                path.pop();
            }
        }
        _ => {
            if should_skip_wsl_codex_cli_override(path) {
                return;
            }

            let key = path
                .iter()
                .map(|segment| format_toml_key_segment_for_cli(segment))
                .collect::<Vec<_>>()
                .join(".");
            overrides.push(format!("{}={}", key, format_toml_value_for_cli(value)));
        }
    }
}

#[cfg(windows)]
pub(super) fn build_wsl_codex_cli_overrides(
    root: &toml::map::Map<String, toml::Value>,
) -> Vec<String> {
    let mut overrides = Vec::new();
    let mut path = Vec::new();
    for (key, value) in root {
        path.push(key.clone());
        collect_wsl_codex_cli_overrides(&mut path, value, &mut overrides);
        path.pop();
    }
    overrides.sort();
    overrides
}

impl TerminalService {
    #[cfg(windows)]
    fn strip_proxy_env(command: &mut std::process::Command) {
        for key in WSL_PROXY_ENV_KEYS {
            command.env_remove(key);
        }
    }

    #[cfg(windows)]
    fn run_wsl_shell_capture(
        wsl_path: &std::path::Path,
        distro: &str,
        script: &str,
    ) -> Result<String> {
        let mut command = std::process::Command::new(wsl_path);
        command
            .arg("-d")
            .arg(distro)
            .arg("--")
            .arg("bash")
            .arg(WSL_BASH_EVAL_FLAG)
            .arg(script);
        Self::strip_proxy_env(&mut command);

        let output = command.output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stderr.is_empty() {
                format!("exit code {}", output.status.code().unwrap_or(-1))
            } else {
                stderr
            };
            return Err(anyhow!(
                "WSL command failed in distro '{}': {}",
                distro,
                detail
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    #[cfg(windows)]
    fn prepare_wsl_codex_home_override(
        &self,
        _session_id: &str,
        _wsl_path: &std::path::Path,
        _distro: &str,
    ) -> Result<(Option<()>, bool, bool)> {
        Ok((None, false, false))
    }

    #[cfg(windows)]
    pub(super) fn build_wsl_codex_home_override_prelude(_wsl: &ResolvedWslLaunch) -> Vec<String> {
        Vec::new()
    }

    #[cfg(windows)]
    fn resolve_wsl_windows_host(wsl_path: &std::path::Path, distro: &str) -> Result<String> {
        let attempts = [
            ("default gateway", "ip route show default 2>/dev/null"),
            (
                "resolv.conf nameserver",
                "grep '^nameserver ' /etc/resolv.conf 2>/dev/null",
            ),
        ];
        let mut failures = Vec::new();

        for (label, script) in attempts {
            let require_private = label == "resolv.conf nameserver";
            match Self::run_wsl_shell_capture(wsl_path, distro, script) {
                Ok(candidate) => {
                    if let Some(host) =
                        resolve_wsl_host_candidate_from_output(&candidate, require_private)
                    {
                        return Ok(host.to_string());
                    }
                    failures.push(format!("{} returned {:?}", label, candidate));
                }
                Err(error) => failures.push(format!("{} failed: {}", label, error)),
            }
        }

        Err(anyhow!(
            "{}: could not resolve the Windows host address for WSL distro '{}': {}",
            WSL_ERROR_CODE_HOST_UNRESOLVED,
            distro,
            failures.join("; ")
        ))
    }

    #[cfg(not(windows))]
    fn resolve_wsl_windows_host(_wsl_path: &std::path::Path, _distro: &str) -> Result<String> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn validate_wsl_codex_runtime(&self, wsl: &mut ResolvedWslLaunch) -> Result<()> {
        let codex_path = Self::run_wsl_shell_capture(
            &wsl.wsl_path,
            &wsl.distro,
            "command -v codex 2>/dev/null || true",
        )?;
        if codex_path.is_empty() {
            return Err(anyhow!(
                "{}: Codex CLI was not found inside WSL distro '{}'. Install Codex CLI in WSL and ensure `command -v codex` succeeds.",
                WSL_ERROR_CODE_CODEX_NOT_FOUND,
                wsl.distro
            ));
        }

        if is_wsl_windows_shim_path(&codex_path) {
            return Err(anyhow!(
                "{}: WSL distro '{}' resolves codex to '{}'. Install a native Linux Codex CLI inside WSL instead of using Windows shim scripts under /mnt or *.cmd/*.ps1/*.exe wrappers.",
                WSL_ERROR_CODE_CODEX_WINDOWS_SHIM,
                wsl.distro,
                codex_path
            ));
        }

        let node_path = Self::run_wsl_shell_capture(
            &wsl.wsl_path,
            &wsl.distro,
            "command -v node 2>/dev/null || true",
        )?;
        if node_path.is_empty() || is_wsl_windows_shim_path(&node_path) {
            let detail = if node_path.is_empty() {
                "node is not available in WSL PATH".to_string()
            } else {
                format!("node resolves to Windows path '{}'", node_path)
            };
            return Err(anyhow!(
                "{}: WSL distro '{}' resolves codex to '{}', but {}. Install Node.js inside WSL before starting Codex (WSL).",
                WSL_ERROR_CODE_NODE_NOT_FOUND,
                wsl.distro,
                codex_path,
                detail
            ));
        }

        info!(
            distro = %wsl.distro,
            codex_path = %codex_path,
            node_path = %node_path,
            "validate_wsl_codex_runtime: native WSL runtime ready"
        );

        wsl.native_codex_path = Some(codex_path);
        wsl.native_node_path = Some(node_path);

        Ok(())
    }

    #[cfg(not(windows))]
    pub(super) fn validate_wsl_codex_runtime(&self, _wsl: &mut ResolvedWslLaunch) -> Result<()> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn resolve_wsl_launch(
        &self,
        wsl: &WslLaunchInfo,
        session_id: &str,
        require_windows_host: bool,
    ) -> Result<ResolvedWslLaunch> {
        let remote_path = wsl.remote_path.trim();
        if remote_path.is_empty() {
            return Err(anyhow!("WSL remote path cannot be empty"));
        }

        let distro = wsl
            .distro
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(crate::services::wsl_discovery_service::resolve_default_distro()?)
            .ok_or_else(|| anyhow!("No default WSL distro found"))?;

        if !crate::services::wsl_discovery_service::ensure_directory_exists(&distro, remote_path)? {
            return Err(anyhow!(
                "WSL path does not exist in distro '{}': {}",
                distro,
                remote_path
            ));
        }

        let wsl_path = cached_which("wsl.exe")
            .or_else(|_| cached_which("wsl"))
            .map_err(|_| anyhow!("wsl.exe not found in PATH"))?;

        let windows_host = if require_windows_host {
            match Self::resolve_wsl_windows_host(&wsl_path, &distro) {
                Ok(host) => Some(host),
                Err(error) => {
                    warn!(
                        distro = %distro,
                        error = %error,
                        "resolve_wsl_launch: failed to resolve Windows host for WSL MCP injection; continuing without MCP"
                    );
                    None
                }
            }
        } else {
            None
        };

        let _ = self.prepare_wsl_codex_home_override(session_id, &wsl_path, &distro)?;

        Ok(ResolvedWslLaunch {
            wsl_path,
            distro,
            remote_path: remote_path.to_string(),
            windows_host,
            native_codex_path: None,
            native_node_path: None,
        })
    }

    #[cfg(not(windows))]
    pub(super) fn resolve_wsl_launch(
        &self,
        _wsl: &WslLaunchInfo,
        _session_id: &str,
        _require_windows_host: bool,
    ) -> Result<ResolvedWslLaunch> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn ensure_wsl_codex_mcp_registered(
        &self,
        session_id: &str,
        wsl: &ResolvedWslLaunch,
        env_vars: &HashMap<String, String>,
        skip_mcp: bool,
    ) -> Result<()> {
        if skip_mcp {
            info!(
                session_id = %session_id,
                distro = %wsl.distro,
                "create_session: skip_mcp=true, skipping WSL Codex MCP injection"
            );
            return Ok(());
        }

        let (Some(port), Some(_token), Some(windows_host)) = (
            env_vars.get("CC_PANES_API_PORT"),
            env_vars.get("CC_PANES_API_TOKEN"),
            wsl.windows_host.as_deref(),
        ) else {
            warn!(
                session_id = %session_id,
                distro = %wsl.distro,
                has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                has_windows_host = wsl.windows_host.is_some(),
                "create_session: missing WSL Codex MCP context, session will start without ccpanes MCP injection"
            );
            return Ok(());
        };

        info!(
            session_id = %session_id,
            distro = %wsl.distro,
            port = %port,
            windows_host = %windows_host,
            "create_session: WSL Codex will inject ccpanes MCP via CLI config"
        );

        if wsl.native_codex_path.is_none() {
            warn!(
                session_id = %session_id,
                distro = %wsl.distro,
                "create_session: native WSL Codex path not captured before MCP injection planning"
            );
        }

        Ok(())
    }

    #[cfg(not(windows))]
    pub(super) fn ensure_wsl_codex_mcp_registered(
        &self,
        _session_id: &str,
        _wsl: &ResolvedWslLaunch,
        _env_vars: &HashMap<String, String>,
        _skip_mcp: bool,
    ) -> Result<()> {
        Ok(())
    }

    #[cfg(windows)]
    pub(super) fn build_wsl_shell_command(
        &self,
        wsl: &ResolvedWslLaunch,
    ) -> Result<(String, Vec<String>)> {
        let mut remote_parts = Vec::new();
        if !is_wsl_home_path(&wsl.remote_path) {
            remote_parts.push(format!("cd {}", Self::shell_escape(&wsl.remote_path)));
        }
        remote_parts.push("exec $SHELL -l".to_string());

        let args = vec![
            "-d".to_string(),
            wsl.distro.clone(),
            "--".to_string(),
            "bash".to_string(),
            WSL_BASH_EVAL_FLAG.to_string(),
            remote_parts.join(" && "),
        ];

        Ok((wsl.wsl_path.to_string_lossy().into_owned(), args))
    }

    #[cfg(not(windows))]
    pub(super) fn build_wsl_shell_command(
        &self,
        _wsl: &ResolvedWslLaunch,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    pub(super) fn build_wsl_command(
        &self,
        wsl: &ResolvedWslLaunch,
        env_vars: &HashMap<String, String>,
        resume_id: Option<&str>,
        initial_prompt: Option<&str>,
        skip_mcp: bool,
    ) -> Result<(String, Vec<String>)> {
        let mut remote_parts = Vec::new();

        let codex_path = wsl.native_codex_path.as_ref().ok_or_else(|| {
            anyhow!(
                "{}: native Codex CLI path was not resolved for WSL distro '{}'.",
                WSL_ERROR_CODE_CODEX_NOT_FOUND,
                wsl.distro
            )
        })?;

        let mut codex_args = Vec::new();

        if !skip_mcp {
            if let (Some(port), Some(token), Some(windows_host)) = (
                env_vars.get("CC_PANES_API_PORT"),
                env_vars.get("CC_PANES_API_TOKEN"),
                wsl.windows_host.as_deref(),
            ) {
                let mcp_url = build_wsl_mcp_url(windows_host, port, token);
                codex_args.push("-c".to_string());
                codex_args.push(format!(
                    "mcp_servers.ccpanes.url={}",
                    format_toml_value_for_cli(&toml::Value::String(mcp_url))
                ));
                codex_args.push("-c".to_string());
                codex_args.push(format!(
                    "mcp_servers.ccpanes.bearer_token_env_var={}",
                    format_toml_value_for_cli(&toml::Value::String("CC_PANES_API_TOKEN".into()))
                ));
            } else {
                warn!(
                    distro = %wsl.distro,
                    has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                    has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                    has_windows_host = wsl.windows_host.is_some(),
                    "build_wsl_command: skipping ccpanes MCP CLI override because WSL MCP context is incomplete"
                );
            }
        }

        codex_args.push("-a".to_string());
        codex_args.push("untrusted".to_string());
        codex_args.push("-s".to_string());
        codex_args.push("workspace-write".to_string());
        if wsl.remote_path != "~" && wsl.remote_path != "~/" {
            codex_args.push("-C".to_string());
            codex_args.push(wsl.remote_path.clone());
        }
        append_codex_resume_args(&mut codex_args, resume_id, initial_prompt);

        let escaped_codex_args = codex_args
            .iter()
            .map(|arg| Self::shell_escape(arg))
            .collect::<Vec<_>>()
            .join(" ");
        remote_parts.push(format!(
            "exec {} {}",
            Self::shell_escape(codex_path),
            escaped_codex_args
        ));

        let args = vec![
            "-d".to_string(),
            wsl.distro.clone(),
            "--".to_string(),
            "bash".to_string(),
            WSL_BASH_EVAL_FLAG.to_string(),
            remote_parts.join(" && "),
        ];

        Ok((wsl.wsl_path.to_string_lossy().into_owned(), args))
    }

    #[cfg(not(windows))]
    pub(super) fn build_wsl_command(
        &self,
        _wsl: &ResolvedWslLaunch,
        _env_vars: &HashMap<String, String>,
        _resume_id: Option<&str>,
        _initial_prompt: Option<&str>,
        _skip_mcp: bool,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::{append_codex_resume_args, is_wsl_windows_shim_path};

    #[test]
    fn append_codex_resume_args_keeps_prompt_after_resume_id() {
        let mut args = vec![
            "-a".to_string(),
            "untrusted".to_string(),
            "-s".to_string(),
            "workspace-write".to_string(),
            "-C".to_string(),
            "/workspace/project".to_string(),
        ];

        append_codex_resume_args(
            &mut args,
            Some("session-123"),
            Some("continue fixing tests"),
        );

        assert_eq!(
            args,
            vec![
                "-a",
                "untrusted",
                "-s",
                "workspace-write",
                "-C",
                "/workspace/project",
                "resume",
                "session-123",
                "continue fixing tests",
            ]
        );
    }

    #[test]
    fn append_codex_resume_args_keeps_prompt_without_resume_id() {
        let mut args = vec![];

        append_codex_resume_args(&mut args, None, Some("open the task"));

        assert_eq!(args, vec!["open the task"]);
    }

    #[test]
    fn windows_shim_paths_are_rejected_for_wsl_runtime() {
        assert!(is_wsl_windows_shim_path(
            "/mnt/c/Users/test/AppData/Roaming/npm/codex"
        ));
        assert!(is_wsl_windows_shim_path("codex.cmd"));
        assert!(is_wsl_windows_shim_path("codex.ps1"));
        assert!(is_wsl_windows_shim_path("codex.exe"));
        assert!(!is_wsl_windows_shim_path("/usr/local/bin/codex"));
    }
}
