#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use super::cached_which;
use super::TerminalService;
use crate::models::{CliTool, WslLaunchInfo};
#[cfg(windows)]
use crate::services::default_skill_service::{BUNDLED_NAMESPACE, VERSION_FILE_NAME};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(windows)]
use tracing::{info, warn};

pub(super) const WSL_BASH_EVAL_FLAG: &str = "-lic";
#[cfg(windows)]
pub(super) const WSL_BASH_LOGIN_FLAG: &str = "-l";
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

#[derive(Debug, Clone)]
pub(super) struct ResolvedWslLaunch {
    pub(super) wsl_path: PathBuf,
    pub(super) distro: String,
    pub(super) remote_path: String,
    pub(super) workspace_remote_path: Option<String>,
    pub(super) windows_host: Option<String>,
}

fn is_wsl_proxy_env_key(key: &str) -> bool {
    WSL_PROXY_ENV_KEYS
        .iter()
        .any(|candidate| key.eq_ignore_ascii_case(candidate))
}

pub(super) fn strip_wsl_proxy_env_vars(env_vars: &mut HashMap<String, String>) {
    env_vars.retain(|key, _| !is_wsl_proxy_env_key(key));
}

pub(super) fn build_wsl_mcp_url(windows_host: &str, port: &str, token: &str) -> String {
    format!("http://{}:{}/mcp?token={}", windows_host, port, token)
}

#[cfg(windows)]
fn rewrite_local_mcp_url_for_wsl(url: &str, windows_host: &str) -> String {
    for prefix in ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            return format!("http://{}:{}", windows_host, rest);
        }
    }
    url.to_string()
}

fn shell_escape_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sanitize_wsl_script_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();
    if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    }
}

fn render_wsl_launch_script(commands: &[String]) -> String {
    let mut script = String::from("#!/usr/bin/env bash\nset -e\n");
    for command in commands {
        script.push_str(command);
        script.push('\n');
    }
    script
}

#[cfg(windows)]
fn push_wsl_env_exports(remote_parts: &mut Vec<String>, env_vars: &HashMap<String, String>) {
    let mut keys = env_vars.keys().collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        if TerminalService::is_valid_env_key(key) {
            if let Some(value) = env_vars.get(key) {
                remote_parts.push(format!(
                    "export {}={}",
                    key,
                    TerminalService::shell_escape(value)
                ));
            }
        } else {
            warn!("Skipping WSL env var with invalid key: {}", key);
        }
    }
}

#[cfg(windows)]
fn push_wsl_ccpanes_env_exports(
    remote_parts: &mut Vec<String>,
    env_vars: &HashMap<String, String>,
) {
    let mut keys = env_vars
        .keys()
        .filter(|key| key.starts_with("CC_PANES_"))
        .collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        if TerminalService::is_valid_env_key(key) {
            if let Some(value) = env_vars.get(key) {
                remote_parts.push(format!(
                    "export {}={}",
                    key,
                    TerminalService::shell_escape(value)
                ));
            }
        }
    }
}

#[cfg(windows)]
fn collect_wsl_claude_source_files(source_dir: &Path) -> Result<Vec<String>> {
    let version_path = source_dir.join(VERSION_FILE_NAME);
    if !version_path.is_file() {
        return Err(anyhow!(
            "Bundled Claude command source is missing version stamp: {}",
            version_path.display()
        ));
    }

    let mut files = Vec::new();
    for entry in std::fs::read_dir(source_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                files.push(file_name.to_string());
            }
        }
    }

    files.sort();
    if files.is_empty() {
        return Err(anyhow!(
            "Bundled Claude command source is empty: {}",
            source_dir.display()
        ));
    }

    Ok(files)
}

#[cfg(windows)]
fn collect_wsl_codex_source_dirs(source_root: &Path) -> Result<Vec<String>> {
    let version_path = source_root.join(VERSION_FILE_NAME);
    if !version_path.is_file() {
        return Err(anyhow!(
            "Bundled Codex skill source is missing version stamp: {}",
            version_path.display()
        ));
    }

    let prefix = format!("{}-", BUNDLED_NAMESPACE);
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(source_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(dir_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !dir_name.starts_with(&prefix) || !path.join("SKILL.md").is_file() {
            continue;
        }
        dirs.push(dir_name.to_string());
    }

    dirs.sort();
    if dirs.is_empty() {
        return Err(anyhow!(
            "Bundled Codex skill source is empty: {}",
            source_root.display()
        ));
    }

    Ok(dirs)
}

#[cfg(windows)]
fn build_wsl_claude_skill_sync_prelude(
    source_wsl_path: &str,
    file_names: &[String],
) -> Vec<String> {
    let mut commands = vec![
        format!(
            "CCPANES_WSL_CLAUDE_SRC={}",
            shell_escape_posix(source_wsl_path)
        ),
        format!(
            "CCPANES_WSL_CLAUDE_DST=\"$HOME/.claude/commands/{}\"",
            BUNDLED_NAMESPACE
        ),
        format!(
            "CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE={}",
            shell_escape_posix(VERSION_FILE_NAME)
        ),
        "CCPANES_WSL_NEEDS_SYNC=0".to_string(),
        "if [ ! -f \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ \"$(cat \"$CCPANES_WSL_CLAUDE_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" != \"$(cat \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
    ];

    for file_name in file_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ ! -f \"$CCPANES_WSL_CLAUDE_DST/{}\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi",
            file_name
        ));
    }

    commands.push(
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CLAUDE_DST\"; fi"
            .to_string(),
    );
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then find \"$CCPANES_WSL_CLAUDE_DST\" -maxdepth 1 -type f -name '*.md' -delete; fi".to_string());
    for file_name in file_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CLAUDE_SRC/{}\" \"$CCPANES_WSL_CLAUDE_DST/{}\"; fi",
            file_name, file_name
        ));
    }
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CLAUDE_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" \"$CCPANES_WSL_CLAUDE_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\"; fi".to_string());

    commands
}

#[cfg(windows)]
fn build_wsl_codex_skill_sync_prelude(source_wsl_path: &str, dir_names: &[String]) -> Vec<String> {
    let mut commands = vec![
        format!(
            "CCPANES_WSL_CODEX_SRC={}",
            shell_escape_posix(source_wsl_path)
        ),
        "CCPANES_WSL_CODEX_DST=\"${CODEX_HOME:-$HOME/.codex}/skills\"".to_string(),
        format!(
            "CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE={}",
            shell_escape_posix(VERSION_FILE_NAME)
        ),
        "CCPANES_WSL_NEEDS_SYNC=0".to_string(),
        "if [ ! -f \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ \"$(cat \"$CCPANES_WSL_CODEX_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" != \"$(cat \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\")\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi".to_string(),
    ];

    for dir_name in dir_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 0 ] && [ ! -f \"$CCPANES_WSL_CODEX_DST/{}/SKILL.md\" ]; then CCPANES_WSL_NEEDS_SYNC=1; fi",
            dir_name
        ));
    }

    commands.push(
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CODEX_DST\"; fi"
            .to_string(),
    );
    commands.push(format!(
        "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then find \"$CCPANES_WSL_CODEX_DST\" -maxdepth 1 -mindepth 1 -type d -name '{}-*' -exec rm -rf {{}} +; fi",
        BUNDLED_NAMESPACE
    ));
    for dir_name in dir_names {
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then mkdir -p \"$CCPANES_WSL_CODEX_DST/{}\"; fi",
            dir_name
        ));
        commands.push(format!(
            "if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CODEX_SRC/{}/SKILL.md\" \"$CCPANES_WSL_CODEX_DST/{}/SKILL.md\"; fi",
            dir_name, dir_name
        ));
    }
    commands.push("if [ \"$CCPANES_WSL_NEEDS_SYNC\" -eq 1 ]; then cp \"$CCPANES_WSL_CODEX_SRC/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\" \"$CCPANES_WSL_CODEX_DST/$CCPANES_WSL_DEFAULT_SKILLS_VERSION_FILE\"; fi".to_string());

    commands
}

#[cfg(windows)]
fn sanitize_wsl_claude_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect()
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

fn push_codex_developer_instructions_arg(
    codex_args: &mut Vec<String>,
    append_system_prompt: Option<&str>,
) {
    let Some(prompt) = append_system_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    else {
        return;
    };

    codex_args.push("-c".to_string());
    codex_args.push(format!(
        "developer_instructions={}",
        format_toml_value_for_cli(&toml::Value::String(prompt.to_string()))
    ));
}

fn push_wsl_codex_mcp_isolation_prelude(
    remote_parts: &mut Vec<String>,
    disable_unlisted_mcp_servers: bool,
    session_id: &str,
    selected_mcp_config_toml: &str,
) {
    if !disable_unlisted_mcp_servers {
        return;
    }

    let session_id = sanitize_wsl_script_component(session_id);
    let heredoc = format!("CCPANES_CODEX_MCP_{}", session_id);
    remote_parts.push("CCPANES_CODEX_REAL_HOME=\"${CODEX_HOME:-$HOME/.codex}\"".to_string());
    remote_parts.push(format!(
        "export CODEX_HOME=\"$HOME/.cache/cc-panes/codex-home/{}\"",
        session_id
    ));
    remote_parts.push("rm -rf \"$CODEX_HOME\"".to_string());
    remote_parts.push("mkdir -p \"$CODEX_HOME\"".to_string());
    remote_parts.push(
        r#"if [ -f "$CCPANES_CODEX_REAL_HOME/config.toml" ]; then
  awk 'BEGIN{skip=0} /^\[(mcp_servers|plugins|marketplaces)(\.|\])/{skip=1; next} /^\[/{skip=0} !skip{print}' "$CCPANES_CODEX_REAL_HOME/config.toml" > "$CODEX_HOME/config.toml"
else
  : > "$CODEX_HOME/config.toml"
fi"#
        .to_string(),
    );
    remote_parts.push(
        "for CCPANES_CODEX_LINK_NAME in auth.json AGENTS.md prompts rules; do if [ -e \"$CCPANES_CODEX_REAL_HOME/$CCPANES_CODEX_LINK_NAME\" ]; then ln -sn \"$CCPANES_CODEX_REAL_HOME/$CCPANES_CODEX_LINK_NAME\" \"$CODEX_HOME/$CCPANES_CODEX_LINK_NAME\"; fi; done".to_string(),
    );
    if !selected_mcp_config_toml.trim().is_empty() {
        remote_parts.push(format!(
            "cat >> \"$CODEX_HOME/config.toml\" <<'{}'\n{}\n{}",
            heredoc,
            selected_mcp_config_toml.trim_end(),
            heredoc
        ));
    }
}

fn is_wsl_home_path(path: &str) -> bool {
    matches!(path.trim(), "~" | "~/")
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

fn is_simple_toml_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn format_toml_key_segment_for_cli(segment: &str) -> String {
    if is_simple_toml_key_segment(segment) {
        segment.to_string()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| {
            format!("\"{}\"", segment.replace('\\', "\\\\").replace('"', "\\\""))
        })
    }
}

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

impl TerminalService {
    #[cfg(windows)]
    fn write_wsl_launch_script(
        &self,
        session_id: &str,
        label: &str,
        commands: &[String],
    ) -> Result<String> {
        let script_dir = self.app_paths.data_dir().join("wsl-launch");
        std::fs::create_dir_all(&script_dir)?;

        let file_name = format!(
            "{}-{}.sh",
            sanitize_wsl_script_component(label),
            sanitize_wsl_script_component(session_id)
        );
        let script_path = script_dir.join(file_name);
        std::fs::write(&script_path, render_wsl_launch_script(commands))?;

        windows_path_to_wsl(&script_path).ok_or_else(|| {
            anyhow!(
                "Failed to translate WSL launch script path to WSL path: {}",
                script_path.display()
            )
        })
    }

    #[cfg(windows)]
    fn build_wsl_script_command(
        &self,
        wsl: &ResolvedWslLaunch,
        session_id: &str,
        label: &str,
        commands: Vec<String>,
    ) -> Result<(String, Vec<String>)> {
        let script_path = self.write_wsl_launch_script(session_id, label, &commands)?;
        let args = vec![
            "-d".to_string(),
            wsl.distro.clone(),
            "--".to_string(),
            "bash".to_string(),
            WSL_BASH_LOGIN_FLAG.to_string(),
            script_path,
        ];
        Ok((wsl.wsl_path.to_string_lossy().into_owned(), args))
    }

    #[cfg(windows)]
    fn build_wsl_claude_skill_sync_commands(&self) -> Result<Vec<String>> {
        let source_dir = dirs::home_dir()
            .ok_or_else(|| anyhow!("Failed to resolve Windows home directory"))?
            .join(".claude")
            .join("commands")
            .join(BUNDLED_NAMESPACE);
        let source_wsl_path = windows_path_to_wsl(&source_dir).ok_or_else(|| {
            anyhow!(
                "Failed to translate Claude bundled skill path to WSL path: {}",
                source_dir.display()
            )
        })?;
        let file_names = collect_wsl_claude_source_files(&source_dir)?;
        Ok(build_wsl_claude_skill_sync_prelude(
            &source_wsl_path,
            &file_names,
        ))
    }

    #[cfg(windows)]
    fn build_wsl_codex_skill_sync_commands(&self) -> Result<Vec<String>> {
        let source_root = dirs::home_dir()
            .ok_or_else(|| anyhow!("Failed to resolve Windows home directory"))?
            .join(".codex")
            .join("skills");
        let source_wsl_path = windows_path_to_wsl(&source_root).ok_or_else(|| {
            anyhow!(
                "Failed to translate Codex bundled skill path to WSL path: {}",
                source_root.display()
            )
        })?;
        let dir_names = collect_wsl_codex_source_dirs(&source_root)?;
        Ok(build_wsl_codex_skill_sync_prelude(
            &source_wsl_path,
            &dir_names,
        ))
    }

    #[cfg(windows)]
    pub(super) fn resolve_reachable_wsl_windows_host(
        &self,
        _wsl_path: &std::path::Path,
        _distro: &str,
        _port: u16,
    ) -> Result<String> {
        Ok("127.0.0.1".to_string())
    }

    #[cfg(not(windows))]
    pub(super) fn resolve_reachable_wsl_windows_host(
        &self,
        _wsl_path: &std::path::Path,
        _distro: &str,
        _port: u16,
    ) -> Result<String> {
        Err(anyhow!("WSL launch is only supported on Windows"))
    }

    #[cfg(windows)]
    pub(super) fn resolve_wsl_launch(
        &self,
        wsl: &WslLaunchInfo,
        _session_id: &str,
    ) -> Result<ResolvedWslLaunch> {
        let remote_path = wsl.remote_path.trim();
        if remote_path.is_empty() {
            return Err(anyhow!("WSL remote path cannot be empty"));
        }
        let workspace_remote_path = wsl
            .workspace_remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        let distro = wsl
            .distro
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or(crate::services::wsl_discovery_service::resolve_default_distro()?)
            .ok_or_else(|| anyhow!("No default WSL distro found"))?;

        let wsl_path = cached_which("wsl.exe")
            .or_else(|_| cached_which("wsl"))
            .map_err(|_| anyhow!("wsl.exe not found in PATH"))?;

        Ok(ResolvedWslLaunch {
            wsl_path,
            distro,
            remote_path: remote_path.to_string(),
            workspace_remote_path,
            windows_host: None,
        })
    }

    #[cfg(not(windows))]
    pub(super) fn resolve_wsl_launch(
        &self,
        _wsl: &WslLaunchInfo,
        _session_id: &str,
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
    pub(super) fn build_wsl_supported_cli_command(
        &self,
        wsl: &ResolvedWslLaunch,
        cli_tool: CliTool,
        session_id: &str,
        env_vars: &HashMap<String, String>,
        provider_env: &HashMap<String, String>,
        resume_id: Option<&str>,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        skip_mcp: bool,
    ) -> Result<(String, Vec<String>)> {
        let command = match cli_tool {
            CliTool::Claude => "claude",
            CliTool::Gemini => "gemini",
            CliTool::Kimi => "kimi",
            CliTool::Glm => "crush",
            CliTool::Opencode => "opencode",
            CliTool::Cursor => "cursor-agent",
            other => {
                return Err(anyhow!(
                    "WSL generic launch does not support CLI tool {:?}",
                    other
                ));
            }
        };

        let mut remote_parts = Vec::new();
        push_wsl_env_exports(&mut remote_parts, provider_env);
        push_wsl_ccpanes_env_exports(&mut remote_parts, env_vars);
        if cli_tool == CliTool::Claude {
            match self.build_wsl_claude_skill_sync_commands() {
                Ok(mut commands) => remote_parts.append(&mut commands),
                Err(error) => warn!(
                    distro = %wsl.distro,
                    error = %error,
                    "build_wsl_supported_cli_command: failed to prepare bundled Claude skill sync; continuing without sync"
                ),
            }
        }
        let workspace_remote_path = wsl
            .workspace_remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let launch_cwd = workspace_remote_path.unwrap_or(wsl.remote_path.as_str());
        if !is_wsl_home_path(launch_cwd) {
            remote_parts.push(format!("cd {}", Self::shell_escape(launch_cwd)));
        }

        let mut cli_args = Vec::new();
        if cli_tool == CliTool::Claude {
            if let Some(resume_id) = resume_id {
                cli_args.push("--resume".to_string());
                cli_args.push(resume_id.to_string());
            }
            if workspace_remote_path.is_some()
                && workspace_remote_path != Some(wsl.remote_path.as_str())
            {
                cli_args.push("--add-dir".to_string());
                cli_args.push(wsl.remote_path.clone());
            }
            if !skip_mcp {
                if let Some(config_path) =
                    self.write_wsl_claude_mcp_config(session_id, wsl, env_vars)?
                {
                    cli_args.push("--mcp-config".to_string());
                    cli_args.push(config_path);
                }
            }
            if let Some(prompt) = append_system_prompt {
                cli_args.push("--append-system-prompt".to_string());
                cli_args.push(prompt.to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push("--".to_string());
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Kimi {
            if workspace_remote_path.is_some()
                && workspace_remote_path != Some(wsl.remote_path.as_str())
            {
                cli_args.push("--add-dir".to_string());
                cli_args.push(wsl.remote_path.clone());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Glm {
            cli_args.push("--cwd".to_string());
            cli_args.push(launch_cwd.to_string());
            if let Some(resume_id) = resume_id {
                cli_args.push("--session".to_string());
                cli_args.push(resume_id.to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push("run".to_string());
                cli_args.push(prompt.to_string());
            }
        } else if cli_tool == CliTool::Cursor {
            if let Some(resume_id) = resume_id {
                cli_args.push("--resume".to_string());
                cli_args.push(resume_id.to_string());
            }
            if let Some(prompt) = initial_prompt {
                cli_args.push(prompt.to_string());
            }
        } else if let Some(prompt) = initial_prompt {
            cli_args.push(prompt.to_string());
        }

        let escaped_cli_args = cli_args
            .iter()
            .map(|arg| Self::shell_escape(arg))
            .collect::<Vec<_>>()
            .join(" ");
        remote_parts.push(if escaped_cli_args.is_empty() {
            format!("exec {}", command)
        } else {
            format!("exec {} {}", command, escaped_cli_args)
        });

        self.build_wsl_script_command(wsl, session_id, command, remote_parts)
    }

    #[cfg(not(windows))]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_supported_cli_command(
        &self,
        _wsl: &ResolvedWslLaunch,
        _cli_tool: CliTool,
        _session_id: &str,
        _env_vars: &HashMap<String, String>,
        _provider_env: &HashMap<String, String>,
        _resume_id: Option<&str>,
        _append_system_prompt: Option<&str>,
        _initial_prompt: Option<&str>,
        _skip_mcp: bool,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    fn write_wsl_claude_mcp_config(
        &self,
        session_id: &str,
        wsl: &ResolvedWslLaunch,
        env_vars: &HashMap<String, String>,
    ) -> Result<Option<String>> {
        let (Some(port), Some(token), Some(windows_host)) = (
            env_vars.get("CC_PANES_API_PORT"),
            env_vars.get("CC_PANES_API_TOKEN"),
            wsl.windows_host.as_deref(),
        ) else {
            warn!(
                distro = %wsl.distro,
                has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                has_windows_host = wsl.windows_host.is_some(),
                "write_wsl_claude_mcp_config: incomplete MCP context, skipping WSL Claude MCP config"
            );
            return Ok(None);
        };

        let file_name = format!(
            "wsl-claude-mcp-{}.json",
            sanitize_wsl_claude_session_id(session_id)
        );
        let config_path = self.app_paths.data_dir().join(file_name);
        let wsl_config_path = windows_path_to_wsl(&config_path).ok_or_else(|| {
            anyhow!(
                "Failed to translate Claude MCP config path to WSL path: {}",
                config_path.display()
            )
        })?;

        let config = serde_json::json!({
            "mcpServers": {
                "ccpanes": {
                    "type": "http",
                    "url": build_wsl_mcp_url(windows_host, port, token),
                    "headers": {
                        "Authorization": format!("Bearer {}", token)
                    }
                }
            }
        });

        std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;

        Ok(Some(wsl_config_path))
    }

    #[cfg(not(windows))]
    fn write_wsl_claude_mcp_config(
        &self,
        _session_id: &str,
        _wsl: &ResolvedWslLaunch,
        _env_vars: &HashMap<String, String>,
    ) -> Result<Option<String>> {
        unreachable!("WSL launch is only supported on Windows")
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_command(
        &self,
        wsl: &ResolvedWslLaunch,
        session_id: &str,
        env_vars: &HashMap<String, String>,
        provider_env: &HashMap<String, String>,
        resume_id: Option<&str>,
        append_system_prompt: Option<&str>,
        initial_prompt: Option<&str>,
        skip_mcp: bool,
        shared_mcp_urls: &HashMap<String, String>,
        _allowed_mcp_server_ids: &[String],
        disable_unlisted_mcp_servers: bool,
        selected_mcp_config_toml: &str,
    ) -> Result<(String, Vec<String>)> {
        let mut remote_parts = Vec::new();
        push_wsl_env_exports(&mut remote_parts, provider_env);
        push_wsl_ccpanes_env_exports(&mut remote_parts, env_vars);
        push_wsl_codex_mcp_isolation_prelude(
            &mut remote_parts,
            disable_unlisted_mcp_servers,
            session_id,
            selected_mcp_config_toml,
        );
        match self.build_wsl_codex_skill_sync_commands() {
            Ok(mut commands) => remote_parts.append(&mut commands),
            Err(error) => warn!(
                distro = %wsl.distro,
                error = %error,
                "build_wsl_command: failed to prepare bundled Codex skill sync; continuing without sync"
            ),
        }

        let codex_path = "codex";

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
                codex_args.push("-c".to_string());
                codex_args.push("mcp_servers.ccpanes.enabled=true".to_string());
                for (name, url) in shared_mcp_urls {
                    let mcp_url = rewrite_local_mcp_url_for_wsl(url, windows_host);
                    codex_args.push("-c".to_string());
                    codex_args.push(format!(
                        "mcp_servers.{}.url={}",
                        format_toml_key_segment_for_cli(name),
                        format_toml_value_for_cli(&toml::Value::String(mcp_url))
                    ));
                }
            } else {
                warn!(
                    distro = %wsl.distro,
                    has_port = env_vars.contains_key("CC_PANES_API_PORT"),
                    has_token = env_vars.contains_key("CC_PANES_API_TOKEN"),
                    has_windows_host = wsl.windows_host.is_some(),
                    "build_wsl_command: skipping ccpanes MCP CLI override because WSL MCP context is incomplete"
                );
            }
        } else {
            codex_args.push("-c".to_string());
            codex_args.push("mcp_servers.ccpanes.enabled=false".to_string());
        }

        if let Some(token) = env_vars.get("CC_PANES_API_TOKEN") {
            remote_parts.push(format!(
                "export CC_PANES_API_TOKEN={}",
                Self::shell_escape(token)
            ));
        }

        if wsl.remote_path != "~" && wsl.remote_path != "~/" {
            codex_args.push("-C".to_string());
            codex_args.push(wsl.remote_path.clone());
        }
        push_codex_developer_instructions_arg(&mut codex_args, append_system_prompt);
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

        self.build_wsl_script_command(wsl, session_id, "codex", remote_parts)
    }

    #[cfg(not(windows))]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn build_wsl_command(
        &self,
        _wsl: &ResolvedWslLaunch,
        _session_id: &str,
        _env_vars: &HashMap<String, String>,
        _provider_env: &HashMap<String, String>,
        _resume_id: Option<&str>,
        _append_system_prompt: Option<&str>,
        _initial_prompt: Option<&str>,
        _skip_mcp: bool,
        _shared_mcp_urls: &HashMap<String, String>,
        _allowed_mcp_server_ids: &[String],
        _disable_unlisted_mcp_servers: bool,
        _selected_mcp_config_toml: &str,
    ) -> Result<(String, Vec<String>)> {
        unreachable!("WSL launch is only supported on Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_codex_resume_args, push_codex_developer_instructions_arg,
        push_wsl_codex_mcp_isolation_prelude, render_wsl_launch_script,
    };
    #[cfg(windows)]
    use super::{
        build_wsl_claude_skill_sync_prelude, build_wsl_codex_skill_sync_prelude,
        collect_wsl_claude_source_files, collect_wsl_codex_source_dirs, VERSION_FILE_NAME,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-wsl-codex-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn remove_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn append_codex_resume_args_keeps_prompt_after_resume_id() {
        let mut args = vec!["-C".to_string(), "/workspace/project".to_string()];

        append_codex_resume_args(
            &mut args,
            Some("session-123"),
            Some("continue fixing tests"),
        );

        assert_eq!(
            args,
            vec![
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
    fn codex_developer_instructions_arg_precedes_resume_and_prompt() {
        let mut args = vec!["-C".to_string(), "/workspace/project".to_string()];

        push_codex_developer_instructions_arg(&mut args, Some("profile skill"));
        append_codex_resume_args(&mut args, Some("session-123"), Some("continue"));

        assert_eq!(
            args,
            vec![
                "-C",
                "/workspace/project",
                "-c",
                "developer_instructions=\"profile skill\"",
                "resume",
                "session-123",
                "continue",
            ]
        );
    }

    #[test]
    fn codex_mcp_isolation_prelude_uses_isolated_codex_home() {
        let mut commands = Vec::new();

        push_wsl_codex_mcp_isolation_prelude(
            &mut commands,
            true,
            "session-123",
            "[mcp_servers.fetch]\ncommand = \"uvx\"",
        );
        let script = render_wsl_launch_script(&commands);

        assert!(
            script.contains("export CODEX_HOME=\"$HOME/.cache/cc-panes/codex-home/session-123\"")
        );
        assert!(script.contains("(mcp_servers|plugins|marketplaces)"));
        assert!(script.contains("[mcp_servers.fetch]\ncommand = \"uvx\""));
    }

    #[test]
    fn render_wsl_launch_script_keeps_each_command_on_its_own_line() {
        let script = render_wsl_launch_script(&[
            "export TOKEN='secret'".to_string(),
            "exec codex '-C' '/mnt/d/repo'".to_string(),
        ]);

        assert_eq!(
            script,
            "#!/usr/bin/env bash\nset -e\nexport TOKEN='secret'\nexec codex '-C' '/mnt/d/repo'\n"
        );
    }

    #[test]
    #[cfg(windows)]
    fn collect_wsl_claude_source_files_requires_version_and_md_files() {
        let root = unique_temp_dir("claude-source");
        fs::write(root.join(VERSION_FILE_NAME), "1.0.0").unwrap();
        fs::write(root.join("launch-task.md"), "body").unwrap();
        fs::write(root.join("workspace.md"), "body").unwrap();

        let files = collect_wsl_claude_source_files(&root).unwrap();
        assert_eq!(files, vec!["launch-task.md", "workspace.md"]);
        remove_dir(&root);
    }

    #[test]
    #[cfg(windows)]
    fn collect_wsl_codex_source_dirs_filters_to_bundled_dirs() {
        let root = unique_temp_dir("codex-source");
        fs::write(root.join(VERSION_FILE_NAME), "1.0.0").unwrap();
        fs::create_dir_all(root.join("ccpanes-launch-task")).unwrap();
        fs::write(root.join("ccpanes-launch-task").join("SKILL.md"), "body").unwrap();
        fs::create_dir_all(root.join("user-skill")).unwrap();
        fs::write(root.join("user-skill").join("SKILL.md"), "body").unwrap();

        let dirs = collect_wsl_codex_source_dirs(&root).unwrap();
        assert_eq!(dirs, vec!["ccpanes-launch-task"]);
        remove_dir(&root);
    }

    #[test]
    #[cfg(windows)]
    fn build_wsl_claude_skill_sync_prelude_mentions_expected_targets() {
        let commands = build_wsl_claude_skill_sync_prelude(
            "/mnt/c/Users/test/.claude/commands/ccpanes",
            &[String::from("launch-task.md")],
        );

        assert!(commands
            .iter()
            .any(|line: &String| line.contains("$HOME/.claude/commands/ccpanes")));
        assert!(commands
            .iter()
            .any(|line: &String| line.contains("cp \"$CCPANES_WSL_CLAUDE_SRC/launch-task.md\"")));
    }

    #[test]
    #[cfg(windows)]
    fn build_wsl_codex_skill_sync_prelude_copies_skill_dirs_only() {
        let commands = build_wsl_codex_skill_sync_prelude(
            "/mnt/c/Users/test/.codex/skills",
            &[String::from("ccpanes-launch-task")],
        );

        assert!(commands
            .iter()
            .any(|line: &String| line.contains("$HOME/.codex/skills")));
        assert!(commands
            .iter()
            .any(|line: &String| line.contains("find \"$CCPANES_WSL_CODEX_DST\"")));
        assert!(commands.iter().any(|line: &String| line
            .contains("cp \"$CCPANES_WSL_CODEX_SRC/ccpanes-launch-task/SKILL.md\"")));
    }
}
