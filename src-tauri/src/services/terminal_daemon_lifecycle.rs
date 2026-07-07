use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use cc_panes_core::services::TerminalDaemonClient;
use cc_panes_core::utils::{no_window_command, AppPaths, AppResult};
use tracing::{info, warn};

use crate::utils::AppError;

const MANIFEST_FILE: &str = "daemon-manifest.json";
const DAEMON_BIN_ENV: &str = "CCPANES_TERMINAL_DAEMON_BIN";

pub struct TerminalDaemonLifecycle;

impl TerminalDaemonLifecycle {
    pub fn enabled_from_env() -> bool {
        std::env::var("CCPANES_TERMINAL_DAEMON")
            .ok()
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
    }

    pub fn connect_or_start(
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
    ) -> AppResult<TerminalDaemonClient> {
        let manifest_path = app_paths.runtime_dir().join(MANIFEST_FILE);
        if let Some(client) = try_connect_manifest(&manifest_path) {
            return Ok(client);
        }

        let daemon_binary = resolve_daemon_binary(resource_dir)?;
        start_daemon_process(&daemon_binary, app_paths)?;
        wait_for_manifest(&manifest_path, Duration::from_secs(5))
    }
}

fn try_connect_manifest(manifest_path: &Path) -> Option<TerminalDaemonClient> {
    let client = TerminalDaemonClient::from_manifest_path(manifest_path).ok()?;
    if let Err(error) = client.health() {
        warn!(
            manifest = %manifest_path.display(),
            error = %error,
            "terminal daemon manifest health probe failed"
        );
        return None;
    }
    if let Err(error) = client.status() {
        warn!(
            manifest = %manifest_path.display(),
            error = %error,
            "terminal daemon manifest status probe failed"
        );
        return None;
    }
    info!(manifest = %manifest_path.display(), "reusing terminal daemon");
    Some(client)
}

fn start_daemon_process(daemon_binary: &Path, app_paths: &AppPaths) -> AppResult<()> {
    std::fs::create_dir_all(app_paths.runtime_dir())?;

    let mut command = no_window_command(daemon_binary);
    command
        .arg("--runtime-dir")
        .arg(app_paths.runtime_dir())
        .arg("--cwd")
        .arg(app_paths.data_dir())
        .arg("--data-dir")
        .arg(app_paths.data_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command.spawn().map_err(|error| {
        AppError::from(format!(
            "failed to start terminal daemon {}: {}",
            daemon_binary.display(),
            error
        ))
    })?;

    info!(binary = %daemon_binary.display(), "terminal daemon start requested");
    Ok(())
}

fn wait_for_manifest(manifest_path: &Path, timeout: Duration) -> AppResult<TerminalDaemonClient> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(client) = try_connect_manifest(manifest_path) {
            return Ok(client);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Err(AppError::from(format!(
        "terminal daemon did not publish manifest within {}ms: {}",
        timeout.as_millis(),
        manifest_path.display()
    )))
}

fn resolve_daemon_binary(resource_dir: Option<&Path>) -> AppResult<PathBuf> {
    let binary_name = daemon_binary_name();

    if let Ok(explicit) = std::env::var(DAEMON_BIN_ENV) {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(resource_dir) = resource_dir {
        let candidate = resource_dir.join("binaries").join(binary_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir.join("binaries").join(binary_name);
            if candidate.exists() {
                return Ok(candidate);
            }

            let candidate = exe_dir.join(binary_name);
            if candidate.exists() {
                return Ok(candidate);
            }

            #[cfg(target_os = "macos")]
            if let Some(contents_dir) = exe_dir.parent() {
                let candidate = contents_dir
                    .join("Resources")
                    .join("binaries")
                    .join(binary_name);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    for candidate in workspace_daemon_candidates(binary_name) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::from(format!(
        "cc-panes-daemon binary not found; set {DAEMON_BIN_ENV} or run `cargo build -p cc-panes-daemon`"
    )))
}

fn workspace_daemon_candidates(binary_name: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.to_path_buf());
        }
    }

    let mut candidates = Vec::new();
    for root in roots {
        let mut dir = root.as_path();
        for _ in 0..6 {
            candidates.push(dir.join("target").join("debug").join(binary_name));
            candidates.push(dir.join("target").join("release").join(binary_name));
            if let Some(parent) = dir.parent() {
                dir = parent;
            } else {
                break;
            }
        }
    }
    candidates
}

fn daemon_binary_name() -> &'static str {
    if cfg!(windows) {
        "cc-panes-daemon.exe"
    } else {
        "cc-panes-daemon"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_candidates_include_debug_and_release_paths() {
        let candidates = workspace_daemon_candidates("cc-panes-daemon");

        assert!(candidates
            .iter()
            .any(|path| path.ends_with(Path::new("target/debug/cc-panes-daemon"))));
        assert!(candidates
            .iter()
            .any(|path| path.ends_with(Path::new("target/release/cc-panes-daemon"))));
    }

    #[test]
    fn daemon_binary_name_uses_platform_extension() {
        let name = daemon_binary_name();
        if cfg!(windows) {
            assert_eq!(name, "cc-panes-daemon.exe");
        } else {
            assert_eq!(name, "cc-panes-daemon");
        }
    }

    #[test]
    fn resolve_daemon_binary_uses_resource_binaries_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let binaries_dir = dir.path().join("binaries");
        std::fs::create_dir_all(&binaries_dir).expect("binaries dir");
        let daemon = binaries_dir.join(daemon_binary_name());
        std::fs::write(&daemon, "fake daemon").expect("daemon file");

        let resolved = resolve_daemon_binary(Some(dir.path())).expect("resolved daemon");

        assert_eq!(resolved, daemon);
    }
}
