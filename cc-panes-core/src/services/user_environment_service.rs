use crate::utils::AppPaths;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tracing::{info, warn};

const ENV_START_MARKER: &str = "__CCPANES_ENV_START__";
const ENV_END_MARKER: &str = "__CCPANES_ENV_END__";
const DEFAULT_ENV_OVERLAY_TEMPLATE: &str = r#"# CC-Panes user environment overlay.
#
# Purpose
# - This file is the user-level place for CC-Panes environment fixes.
# - Keep normal shell setup in ~/.zshrc, ~/.bashrc, or your shell config.
# - Put only CC-Panes-specific overrides here.
# - Do not copy the full output of `env` into this file. This is an overlay,
#   not a complete environment snapshot.
#
# Applies to
# - Local CC-Panes sessions, including Codex and Claude Code launches.
# - CC-Panes process-level environment checks after the app starts.
#
# Does not apply to
# - Already-running CC-Panes sessions. Create a new session after changing this.
# - WSL or SSH sessions. They must use their own runtime environment.
# - Source code behavior. If Rust/Tauri code changes, rebuild and reinstall
#   CC-Panes; editing this file alone cannot load new code.
#
# Reload rule
# - For edits to this file: fully quit and restart CC-Panes, then open a new session.
# - For source code edits: rebuild and reinstall CC-Panes, then restart it.
#
# Agent/CLI guidance
# - Prefer editing this file for CC-Panes-specific environment differences.
# - Prefer editing the user's shell config only for real shell behavior.
# - Preserve TOML syntax. Strings must be quoted. Lists use commas.
# - Keep PATH entries stable and explicit. Avoid command substitutions, aliases,
#   shell functions, or sourcing shell scripts from this file.

inheritSystem = true

# Keep false by default. Running an interactive/login shell from a desktop app can
# trigger prompt plugins or startup side effects in a non-interactive context.
resolveShell = false

# Used only when resolveShell = true.
# login            -> shell -lc
# interactiveLogin -> shell -ilc
# disabled         -> never resolve shell env
shellMode = "login"

# Top-level unset rules must stay before [env] and [path].
unset = []

[env]
# Example:
# JAVA_HOME = "/path/to/jdk"
# BUN_INSTALL = "$HOME/.bun"

[path]
# Final PATH order:
#   1. prepend
#   2. inherited/resolved PATH
#   3. append
#
# CC-Panes expands $VAR and ${VAR}, drops empty entries, drops non-existing
# directories, removes entries listed in remove, and deduplicates while
# preserving first occurrence.
prepend = []
append = []
remove = []
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EnvOverlayConfig {
    pub inherit_system: bool,
    pub resolve_shell: bool,
    pub shell_mode: ShellEnvMode,
    pub env: HashMap<String, String>,
    pub path: PathOverlay,
    pub unset: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PathOverlay {
    pub prepend: Vec<String>,
    pub append: Vec<String>,
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ShellEnvMode {
    #[default]
    Login,
    InteractiveLogin,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedUserEnvironment {
    pub env: HashMap<String, String>,
    pub unset: Vec<String>,
    pub overlay_path: PathBuf,
    pub cache_path: PathBuf,
    pub shell_resolved: bool,
    pub shell_error: Option<String>,
}

pub struct UserEnvironmentService {
    app_paths: Arc<AppPaths>,
    cache: RwLock<Option<ResolvedUserEnvironment>>,
}

impl Default for EnvOverlayConfig {
    fn default() -> Self {
        Self {
            inherit_system: true,
            resolve_shell: false,
            shell_mode: ShellEnvMode::Login,
            env: HashMap::new(),
            path: PathOverlay::default(),
            unset: Vec::new(),
        }
    }
}

impl UserEnvironmentService {
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        Self {
            app_paths,
            cache: RwLock::new(None),
        }
    }

    pub fn resolve(&self) -> ResolvedUserEnvironment {
        let config = self.load_overlay_config();
        let mut env = if config.inherit_system {
            std::env::vars().collect::<HashMap<_, _>>()
        } else {
            minimal_env()
        };

        let mut shell_resolved = false;
        let mut shell_error = None;
        if config.resolve_shell && config.shell_mode != ShellEnvMode::Disabled {
            match resolve_shell_env(config.shell_mode) {
                Ok(shell_env) => {
                    env.extend(shell_env);
                    shell_resolved = true;
                }
                Err(error) => {
                    shell_error = Some(error.to_string());
                    warn!(error = %error, "Failed to resolve user shell environment");
                }
            }
        }

        for key in &config.unset {
            env.remove(key);
        }
        env.extend(config.env.clone());
        apply_path_overlay(&mut env, &config.path);

        let resolved = ResolvedUserEnvironment {
            env,
            unset: config.unset.clone(),
            overlay_path: self.app_paths.env_overlay_path(),
            cache_path: self.app_paths.env_cache_path(),
            shell_resolved,
            shell_error,
        };
        self.write_cache(&resolved);
        if let Ok(mut guard) = self.cache.write() {
            *guard = Some(resolved.clone());
        }
        resolved
    }

    pub fn resolved_env(&self) -> HashMap<String, String> {
        if let Ok(guard) = self.cache.read() {
            if let Some(resolved) = guard.as_ref() {
                return resolved.env.clone();
            }
        }
        self.resolve().env
    }

    pub fn apply_to_process(&self) -> ResolvedUserEnvironment {
        let resolved = self.resolve();
        for key in &resolved.unset {
            unsafe {
                std::env::remove_var(key);
            }
        }
        for (key, value) in &resolved.env {
            unsafe {
                std::env::set_var(key, value);
            }
        }
        resolved
    }

    fn load_overlay_config(&self) -> EnvOverlayConfig {
        let path = self.app_paths.env_overlay_path();
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.create_default_overlay_template(&path);
                return EnvOverlayConfig::default();
            }
            Err(error) => {
                warn!(
                    path = %path.display(),
                    error = %error,
                    "Failed to read env overlay config, using defaults"
                );
                return EnvOverlayConfig::default();
            }
        };
        match toml::from_str::<EnvOverlayConfig>(&content) {
            Ok(config) => config,
            Err(error) => {
                warn!(
                    path = %path.display(),
                    error = %error,
                    "Invalid env overlay config, using defaults"
                );
                EnvOverlayConfig::default()
            }
        }
    }

    fn create_default_overlay_template(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                warn!(
                    path = %parent.display(),
                    error = %error,
                    "Failed to create env overlay directory"
                );
                return;
            }
        }

        if let Err(error) = std::fs::write(path, DEFAULT_ENV_OVERLAY_TEMPLATE) {
            warn!(
                path = %path.display(),
                error = %error,
                "Failed to create default env overlay template"
            );
        }
    }

    fn write_cache(&self, resolved: &ResolvedUserEnvironment) {
        let cache_path = self.app_paths.env_cache_path();
        if let Some(parent) = cache_path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                warn!(
                    path = %parent.display(),
                    error = %error,
                    "Failed to create env cache directory"
                );
                return;
            }
        }
        match serde_json::to_vec_pretty(resolved) {
            Ok(data) => {
                if let Err(error) = std::fs::write(&cache_path, data) {
                    warn!(
                        path = %cache_path.display(),
                        error = %error,
                        "Failed to write env cache"
                    );
                }
            }
            Err(error) => warn!(error = %error, "Failed to serialize env cache"),
        }
    }
}

fn minimal_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    env
}

fn resolve_shell_env(mode: ShellEnvMode) -> Result<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let args = match mode {
        ShellEnvMode::Login => vec!["-lc", shell_env_command()],
        ShellEnvMode::InteractiveLogin => vec!["-ilc", shell_env_command()],
        ShellEnvMode::Disabled => return Ok(HashMap::new()),
    };

    let child = std::process::Command::new(&shell)
        .args(args)
        .env("CCPANES_RESOLVING_ENVIRONMENT", "1")
        .env("ZSH_TMUX_AUTOSTART", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| anyhow!("failed to spawn shell {}: {}", shell, error))?;

    let child_pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(output)) if output.status.success() => parse_env_snapshot(&output.stdout),
        Ok(Ok(output)) => Err(anyhow!(
            "shell exited with status {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Ok(Err(error)) => Err(anyhow!("failed to read shell env output: {}", error)),
        Err(_) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(child_pid as i32, libc::SIGKILL);
            }
            Err(anyhow!("shell env resolution timed out"))
        }
    }
}

fn shell_env_command() -> &'static str {
    "printf '__CCPANES_ENV_START__\\n'; env -0; printf '\\n__CCPANES_ENV_END__\\n'"
}

fn parse_env_snapshot(output: &[u8]) -> Result<HashMap<String, String>> {
    let start_marker = format!("{ENV_START_MARKER}\n");
    let start = output
        .windows(start_marker.len())
        .position(|window| window == start_marker.as_bytes())
        .map(|index| index + start_marker.len())
        .ok_or_else(|| anyhow!("env start marker not found"))?;
    let end = output[start..]
        .windows(ENV_END_MARKER.len())
        .position(|window| window == ENV_END_MARKER.as_bytes())
        .map(|index| start + index)
        .ok_or_else(|| anyhow!("env end marker not found"))?;

    let payload = trim_ascii_bytes(&output[start..end]);
    let mut env = HashMap::new();
    for entry in payload.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Some(eq_index) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let key = String::from_utf8_lossy(&entry[..eq_index]).to_string();
        let value = String::from_utf8_lossy(&entry[eq_index + 1..]).to_string();
        if !key.is_empty() {
            env.insert(key, value);
        }
    }
    Ok(env)
}

fn apply_path_overlay(env: &mut HashMap<String, String>, overlay: &PathOverlay) {
    let base_path = env.get("PATH").cloned().unwrap_or_default();
    let mut entries = Vec::new();
    let remove_set = overlay
        .remove
        .iter()
        .filter_map(|entry| expand_path_entry(entry, env))
        .collect::<HashSet<_>>();

    for entry in &overlay.prepend {
        if let Some(expanded) = expand_path_entry(entry, env) {
            entries.push(expanded);
        }
    }
    for entry in base_path.split(path_separator()) {
        if !entry.trim().is_empty() {
            entries.push(entry.to_string());
        }
    }
    for entry in &overlay.append {
        if let Some(expanded) = expand_path_entry(entry, env) {
            entries.push(expanded);
        }
    }

    let mut seen = HashSet::new();
    let normalized = entries
        .into_iter()
        .filter(|entry| !remove_set.contains(entry))
        .filter(|entry| Path::new(entry).is_dir())
        .filter(|entry| seen.insert(entry.clone()))
        .collect::<Vec<_>>();

    if !normalized.is_empty() {
        env.insert("PATH".to_string(), normalized.join(path_separator()));
    }
}

fn expand_path_entry(template: &str, env: &HashMap<String, String>) -> Option<String> {
    let expanded = expand_vars(template, env);
    if expanded.trim().is_empty() {
        None
    } else {
        Some(expanded)
    }
}

fn expand_vars(template: &str, env: &HashMap<String, String>) -> String {
    let mut output = String::with_capacity(template.len());
    let chars = template.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '$' {
            if index + 1 < chars.len() && chars[index + 1] == '{' {
                if let Some(end) = chars[index + 2..].iter().position(|c| *c == '}') {
                    let key = chars[index + 2..index + 2 + end].iter().collect::<String>();
                    output.push_str(env.get(&key).map(String::as_str).unwrap_or_default());
                    index += end + 3;
                    continue;
                }
            }
            let mut end = index + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if end > index + 1 {
                let key = chars[index + 1..end].iter().collect::<String>();
                output.push_str(env.get(&key).map(String::as_str).unwrap_or_default());
                index = end;
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

#[cfg(windows)]
fn path_separator() -> &'static str {
    ";"
}

#[cfg(not(windows))]
fn path_separator() -> &'static str {
    ":"
}

fn trim_ascii_bytes(input: &[u8]) -> &[u8] {
    let start = input
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(input.len());
    let end = input
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    &input[start..end]
}

pub fn apply_env_to_process(env: &HashMap<String, String>) {
    for (key, value) in env {
        unsafe {
            std::env::set_var(key, value);
        }
    }
    info!("Applied resolved user environment to process");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_snapshot_ignores_noise_around_markers() {
        let data = b"noise\n__CCPANES_ENV_START__\nA=1\0B=two words\0\n__CCPANES_ENV_END__\nmore";
        let env = parse_env_snapshot(data).unwrap();
        assert_eq!(env.get("A").unwrap(), "1");
        assert_eq!(env.get("B").unwrap(), "two words");
    }

    #[test]
    fn path_overlay_expands_filters_and_dedupes() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        let extra = temp.path().join("extra");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&extra).unwrap();

        let mut env = HashMap::from([
            (
                "HOME".to_string(),
                temp.path().to_string_lossy().to_string(),
            ),
            ("PATH".to_string(), bin.to_string_lossy().to_string()),
        ]);
        let overlay = PathOverlay {
            prepend: vec!["$HOME/extra".to_string(), "$HOME/missing".to_string()],
            append: vec!["$HOME/extra".to_string()],
            remove: vec![],
        };
        apply_path_overlay(&mut env, &overlay);
        let path = env.get("PATH").unwrap();
        let parts = path.split(path_separator()).collect::<Vec<_>>();
        assert_eq!(parts, vec![extra.to_string_lossy(), bin.to_string_lossy()]);
    }

    #[test]
    fn default_overlay_template_is_valid_toml() {
        let config = toml::from_str::<EnvOverlayConfig>(DEFAULT_ENV_OVERLAY_TEMPLATE).unwrap();
        assert!(config.inherit_system);
        assert!(!config.resolve_shell);
        assert_eq!(config.shell_mode, ShellEnvMode::Login);
        assert!(config.unset.is_empty());
        assert!(config.env.is_empty());
        assert!(config.path.prepend.is_empty());
        assert!(config.path.append.is_empty());
        assert!(config.path.remove.is_empty());
    }
}
