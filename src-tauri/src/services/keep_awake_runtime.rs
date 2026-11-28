//! app 进程侧的保持唤醒：只覆盖活在 app 地址空间里的工作——ACP 对话（`Generating`）
//! 与非 daemon 模式下的 PTY 会话。daemon 模式的 PTY 会话由 daemon 自己持锁
//! （见 `cc-panes-daemon/src/keep_awake.rs`）；那时 app 内的 `TerminalService` 恒为空，
//! 不会重复计数。

use std::sync::Arc;

use cc_panes_core::services::keep_awake::{
    busy_session_count, system_inhibitor, KeepAwakeSample, KeepAwakeService, DEFAULT_POLL_INTERVAL,
};
use cc_panes_core::services::{SettingsService, TerminalService};
use tracing::warn;

use super::AcpChatService;

const ACP_SOURCE: &str = "acp";
const LOCAL_PTY_SOURCE: &str = "pty-local";

pub fn start_app_keep_awake(
    settings: Arc<SettingsService>,
    terminal: Arc<TerminalService>,
    acp: Arc<AcpChatService>,
) -> Arc<KeepAwakeService> {
    let service = Arc::new(KeepAwakeService::new(system_inhibitor()));
    service.spawn_poller("cc-panes-keep-awake", DEFAULT_POLL_INTERVAL, move || {
        let enabled = settings.get_settings().terminal.keep_awake_while_working;
        let acp_busy = tauri::async_runtime::block_on(acp.generating_count());
        let pty_busy = match terminal.get_all_status() {
            Ok(sessions) => busy_session_count(&sessions),
            Err(error) => {
                warn!(error = %error, "keep-awake: failed to list local sessions");
                0
            }
        };
        Some(KeepAwakeSample {
            enabled,
            sources: vec![(ACP_SOURCE, acp_busy), (LOCAL_PTY_SOURCE, pty_busy)],
        })
    });
    service
}
