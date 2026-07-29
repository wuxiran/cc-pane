use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use cc_panes_core::services::TerminalDaemonClient;
use cc_panes_core::utils::{no_window_command, AppPaths, AppResult};
use tracing::{info, warn};

use crate::utils::AppError;

const MANIFEST_FILE: &str = "daemon-manifest.json";
const DAEMON_BIN_ENV: &str = "CCPANES_TERMINAL_DAEMON_BIN";

/// 两次重连尝试之间的最小间隔。
///
/// daemon 起不来时（二进制缺失、端口被占）失败会连续到来，没有节流就会
/// 每次操作都 spawn 一个进程。宁可让用户多等一下，也不要刷出一堆僵尸。
const RECONNECT_THROTTLE: Duration = Duration::from_secs(5);

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
        config_path: &Path,
    ) -> AppResult<TerminalDaemonClient> {
        let manifest_path = app_paths.runtime_dir().join(MANIFEST_FILE);
        if let Some(client) = try_connect_manifest(&manifest_path) {
            return Ok(client);
        }

        let daemon_binary = resolve_daemon_binary(resource_dir)?;
        start_daemon_process(&daemon_binary, app_paths, config_path)?;
        wait_for_manifest(&manifest_path, Duration::from_secs(5))
    }

    /// daemon 掉线后的重连。
    ///
    /// `connect_or_start` 此前只在 `[boot]` 期调用一次：daemon 中途死掉后，
    /// app 手里的 client 一直指着死地址，之后每次开终端都 `connection timed out`，
    /// **不重启整个应用就永远好不了**。daemon 被定位成「跨 app 重启存活的锚点」，
    /// 却没有反向的韧性——这是基础设施只建了一半。
    ///
    /// 与 `connect_or_start` 的差别只有节流：失败路径会被高频触发。
    pub fn reconnect_throttled(
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
        config_path: &Path,
    ) -> AppResult<TerminalDaemonClient> {
        static LAST_ATTEMPT: std::sync::OnceLock<std::sync::Mutex<Option<Instant>>> =
            std::sync::OnceLock::new();
        let cell = LAST_ATTEMPT.get_or_init(|| std::sync::Mutex::new(None));
        {
            let mut guard = cell.lock().unwrap_or_else(|error| error.into_inner());
            let now = Instant::now();
            if !should_attempt_reconnect(*guard, now) {
                return Err(AppError::from(
                    "terminal daemon reconnect throttled; retry shortly",
                ));
            }
            *guard = Some(now);
        }
        warn!("terminal daemon appears down; attempting reconnect");
        Self::connect_or_start(app_paths, resource_dir, config_path)
    }
}

/// 距上次尝试是否已超过节流窗口。抽成纯函数便于直接断言边界，
/// 不必为了测节流去构造 AppPaths / 真实 daemon。
fn should_attempt_reconnect(last_attempt: Option<Instant>, now: Instant) -> bool {
    match last_attempt {
        None => true,
        Some(previous) => now.duration_since(previous) >= RECONNECT_THROTTLE,
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

fn start_daemon_process(
    daemon_binary: &Path,
    app_paths: &AppPaths,
    config_path: &Path,
) -> AppResult<()> {
    std::fs::create_dir_all(app_paths.runtime_dir())?;

    let mut command = no_window_command(daemon_binary);
    command
        .arg("--runtime-dir")
        .arg(app_paths.runtime_dir())
        .arg("--cwd")
        .arg(app_paths.data_dir())
        .arg("--data-dir")
        .arg(app_paths.data_dir())
        // app 的 config.toml 在 config dir（~/.cc-panes[-dev]/），自定义 data_dir 时
        // 与 data_dir/config.toml 不是同一份；显式传给 daemon 保证设置热重读一致。
        .arg("--config-path")
        .arg(config_path)
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

    /// daemon 起不来时失败会连续到来。没有节流就会每次操作都 spawn 一个进程，
    /// 把「连不上」变成「刷出一堆僵尸」。
    #[test]
    fn reconnect_throttle_window_boundaries() {
        let now = Instant::now();

        assert!(
            should_attempt_reconnect(None, now),
            "首次没有上次记录，必须允许尝试"
        );
        assert!(
            !should_attempt_reconnect(Some(now), now),
            "同一时刻的连续失败必须被拒"
        );
        assert!(
            !should_attempt_reconnect(
                Some(now - (RECONNECT_THROTTLE - Duration::from_millis(1))),
                now
            ),
            "窗口内差 1ms 也应被拒"
        );
        assert!(
            should_attempt_reconnect(Some(now - RECONNECT_THROTTLE), now),
            "刚好到窗口边界应放行"
        );
    }

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
