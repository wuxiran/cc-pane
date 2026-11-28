//! daemon 侧保持唤醒：PTY 会话真身在 daemon 里，关掉桌面窗口（甚至退出 app）后
//! agent 仍在跑，所以「会话在工作」的判定与持锁都放在这里。
//!
//! 活动源复用 `TerminalBackend::get_all_status()` 的 `SessionStatus::is_busy()`：
//! app 在线时经 `/hook-status` 转发 HTTP hook，app 不在时 OSC 兜底状态机与 ANSI
//! 推断照样更新它。开关读 config.toml 的 `terminal.keepAwakeWhileWorking`。

use std::sync::Arc;
use std::time::{Duration, Instant};

use cc_panes_core::services::keep_awake::{
    busy_session_count, system_inhibitor, KeepAwakeSample, KeepAwakeService, DEFAULT_POLL_INTERVAL,
};
use cc_panes_core::services::SettingsService;
use tracing::warn;

use crate::server::DaemonConfig;

pub const PTY_SOURCE: &str = "pty";

/// 重读 config.toml 的最小间隔：开关改动最迟这么久生效。
const SETTINGS_RELOAD_INTERVAL: Duration = Duration::from_secs(30);

pub fn spawn_keep_awake(config: DaemonConfig, settings: Arc<SettingsService>) {
    let service = Arc::new(KeepAwakeService::new(system_inhibitor()));
    config.set_keep_awake(service.clone());
    let mut last_reload: Option<Instant> = None;
    service.spawn_poller(
        "cc-panes-keep-awake",
        DEFAULT_POLL_INTERVAL,
        move || {
            let now = Instant::now();
            if last_reload.is_none_or(|at| now.duration_since(at) >= SETTINGS_RELOAD_INTERVAL) {
                last_reload = Some(now);
                if settings.config_path().exists() {
                    if let Err(error) = settings.reload_from_disk() {
                        warn!(error = %error, "keep-awake: settings reload failed; keeping in-memory settings");
                    }
                }
            }
            let enabled = settings.get_settings().terminal.keep_awake_while_working;
            let busy = match config.terminal_backend().get_all_status() {
                Ok(sessions) => busy_session_count(&sessions),
                Err(error) => {
                    warn!(error = %error, "keep-awake: failed to list sessions; skipping round");
                    return None;
                }
            };
            Some(KeepAwakeSample {
                enabled,
                sources: vec![(PTY_SOURCE, busy)],
            })
        },
    );
}
