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
        let daemon_binary = resolve_daemon_binary(resource_dir);

        if let Some(client) = try_connect_manifest(&manifest_path) {
            match daemon_binary.as_ref() {
                Ok(binary) => match upgrade_if_idle_and_unshared(
                    binary,
                    app_paths,
                    config_path,
                    &manifest_path,
                    &client,
                    false,
                ) {
                    Ok(Some(replacement)) => return Ok(replacement),
                    Ok(None) => return Ok(client),
                    Err(error) => {
                        warn!(error = %error, "terminal daemon upgrade attempt failed; keeping current client");
                        return Ok(client);
                    }
                },
                Err(_) => return Ok(client),
            }
        }

        let daemon_binary = daemon_binary?;
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

    /// Re-evaluate a pending daemon upgrade immediately before a later PTY creation.
    /// This closes the gap where boot deferred for live sessions and no reconnect ever occurred
    /// after the final session exited.
    pub fn recheck_upgrade_before_create(
        app_paths: &AppPaths,
        resource_dir: Option<&Path>,
        config_path: &Path,
        client: &TerminalDaemonClient,
        current_desktop_connected: bool,
    ) -> AppResult<Option<TerminalDaemonClient>> {
        let daemon_binary = resolve_daemon_binary(resource_dir)?;
        let manifest_path = app_paths.runtime_dir().join(MANIFEST_FILE);
        upgrade_if_idle_and_unshared(
            &daemon_binary,
            app_paths,
            config_path,
            &manifest_path,
            client,
            current_desktop_connected,
        )
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

/// 磁盘上的 daemon 是否比正在跑的那个新，且现在换代是安全的。
///
/// 判据用**文件 mtime vs 进程 started_at**，不用版本号：`TerminalDaemonStatus.version`
/// 是 cc-panes-daemon crate 自己的版本（长期停在 0.1.0），跟 app 版本不联动，
/// 更新前后读出来一模一样，判不出新旧。
///
/// 待 Windows 实测（评审 #7）：分别覆盖安装器保留/刷新 mtime、系统时钟回拨和同版本
/// 重装；记录新 exe LastWriteTime、daemon startedAt 与实际换代结果。本轮不猜测修改判据。
///
/// 返回 `None` = 不换（已是最新 / 有活跃会话或其他桌面实例 / 读不到时间戳）。
fn pending_daemon_upgrade(
    daemon_binary: &Path,
    client: &TerminalDaemonClient,
    current_desktop_connected: bool,
) -> Option<String> {
    let status = client.status().ok()?;
    let binary_mtime_ms = daemon_binary
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;

    decide_daemon_upgrade(
        binary_mtime_ms,
        status.started_at,
        status.session_count,
        status.desktop_client_count,
        current_desktop_connected,
    )
}

/// 换代判定的纯函数部分，抽出来便于直接断言边界（构造真 daemon 太贵）。
fn decide_daemon_upgrade(
    binary_mtime_ms: u64,
    daemon_started_at_ms: u64,
    session_count: usize,
    desktop_client_count: Option<usize>,
    current_desktop_connected: bool,
) -> Option<String> {
    if binary_mtime_ms <= daemon_started_at_ms {
        return None;
    }
    if session_count > 0 {
        // 不是错误：这是我们**选择**保住会话。等用户把会话关完，下次启动自然换代。
        info!(
            session_count,
            "newer terminal daemon binary is installed, but sessions are live; deferring upgrade"
        );
        return None;
    }
    if let Some(desktop_client_count) = desktop_client_count {
        let current_client_count = if current_desktop_connected { 1 } else { 0 };
        if desktop_client_count > current_client_count {
            info!(
                desktop_client_count,
                current_desktop_connected,
                "newer terminal daemon binary is installed, but another desktop instance is connected; deferring upgrade"
            );
            return None;
        }
    } else {
        // 旧 daemon 没有该字段：兼容降级到 v0.11.7 的 session-only 判据。
        // 新 daemon 还会根据本实例控制 WS 是否已连上，排除当前实例后要求没有其他客户端。
        warn!("terminal daemon status has no desktopClientCount; using legacy session-only upgrade guard");
    }
    Some(format!(
        "binary mtime {binary_mtime_ms} is newer than running daemon started_at {daemon_started_at_ms}, no sessions are live, and no other desktop client is connected"
    ))
}

fn upgrade_if_idle_and_unshared(
    daemon_binary: &Path,
    app_paths: &AppPaths,
    config_path: &Path,
    manifest_path: &Path,
    client: &TerminalDaemonClient,
    current_desktop_connected: bool,
) -> AppResult<Option<TerminalDaemonClient>> {
    let Some(reason) = pending_daemon_upgrade(daemon_binary, client, current_desktop_connected)
    else {
        return Ok(None);
    };
    info!(reason = %reason, "terminal daemon upgrade pending; retiring idle daemon");
    client.shutdown().map_err(|error| {
        AppError::from(format!(
            "graceful shutdown of old daemon failed; keeping it: {error}"
        ))
    })?;
    if !wait_for_daemon_exit(client, Duration::from_secs(5)) {
        return Err(AppError::from(
            "old terminal daemon did not exit within timeout; replacement was not started",
        ));
    }
    start_daemon_process(daemon_binary, app_paths, config_path)?;
    wait_for_manifest(manifest_path, Duration::from_secs(5)).map(Some)
}

/// 等旧 daemon 真的退出（health 探不通即为退出）。daemon 使用随机端口，端口冲突
/// 不会替我们阻止双实例；超时必须明确拒绝启动 replacement，避免两个 daemon 争写 manifest。
fn wait_for_daemon_exit(client: &TerminalDaemonClient, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if client.health().is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    warn!("old terminal daemon did not exit within timeout");
    false
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

    /// 安装器故意不杀 daemon（保住 PTY 会话），换代因此改由 app 择机执行。
    /// 这组断言锁住「什么时候可以换」的边界。
    #[test]
    fn daemon_upgrade_only_when_binary_is_newer_and_no_sessions_live() {
        // 启动期本实例的控制 WS 尚未连接：计数为 0 才能安全换代。
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, Some(0), false).is_some());

        // 启动期计数为 1 代表另一个桌面实例，不能把它使用的 daemon 退掉。
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, Some(1), false).is_none());

        // 稍后重检时本实例控制 WS 已连接：计数为 1 只包含自己，可以换代。
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, Some(1), true).is_some());

        // 有会话就不换：换代要连根杀掉用户在跑的 agent，正是我们刚修掉的事故。
        assert!(
            decide_daemon_upgrade(2_000, 1_000, 1, Some(1), true).is_none(),
            "哪怕只有一条会话也必须让路——宁可多跑一版旧 daemon"
        );

        // 已是最新（或安装器根本没换过二进制）：不折腾
        assert!(decide_daemon_upgrade(1_000, 2_000, 0, Some(1), true).is_none());

        // 时间戳相等 = 同一个二进制，边界取「不换」，避免每次启动都重启 daemon
        assert!(decide_daemon_upgrade(1_000, 1_000, 0, Some(1), true).is_none());

        // 另一个桌面实例仍连接着同一 daemon，即使当前没有 PTY 也不能替它换代。
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, Some(2), true).is_none());

        // 旧 daemon 没有 desktopClientCount 字段，兼容降级到原有 session-only 判据。
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, None, false).is_some());

        // 同一新二进制在会话结束后再次评估，必须从 defer 变为可换代。
        assert!(decide_daemon_upgrade(2_000, 1_000, 3, Some(1), true).is_none());
        assert!(decide_daemon_upgrade(2_000, 1_000, 0, Some(1), true).is_some());
    }

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
