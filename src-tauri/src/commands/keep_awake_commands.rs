use std::sync::Arc;

use cc_panes_core::services::keep_awake::{KeepAwakeService, KeepAwakeStatus};
use serde::Serialize;
use tauri::State;

use crate::services::{SettingsService, TerminalBackendState};
use crate::utils::AppResult;

/// 保持唤醒的合并视图：app 与 daemon 各持各的锁，任一持有即视为「保持唤醒中」。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeReport {
    pub enabled: bool,
    pub holding: bool,
    pub app: KeepAwakeStatus,
    /// None = 非 daemon 模式、daemon 不可达或旧 daemon 不支持。
    pub daemon: Option<KeepAwakeStatus>,
}

fn combine_report(
    enabled: bool,
    app: KeepAwakeStatus,
    daemon: Option<KeepAwakeStatus>,
) -> KeepAwakeReport {
    let holding = app.holding || daemon.is_some_and(|status| status.holding);
    KeepAwakeReport {
        enabled,
        holding,
        app,
        daemon,
    }
}

#[tauri::command]
pub async fn get_keep_awake_status(
    service: State<'_, Arc<KeepAwakeService>>,
    backend: State<'_, Arc<TerminalBackendState>>,
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<KeepAwakeReport> {
    let enabled = settings.get_settings().terminal.keep_awake_while_working;
    let app = service.status();
    let daemon = match backend.daemon_client() {
        Some(client) => tauri::async_runtime::spawn_blocking(move || client.status())
            .await
            .ok()
            .and_then(|result| result.ok())
            .and_then(|status| status.keep_awake),
        None => None,
    };
    Ok(combine_report(enabled, app, daemon))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(holding: bool) -> KeepAwakeStatus {
        KeepAwakeStatus {
            enabled: true,
            holding,
            busy_count: usize::from(holding),
        }
    }

    #[test]
    fn holding_when_either_side_holds() {
        assert!(combine_report(true, status(false), Some(status(true))).holding);
        assert!(combine_report(true, status(true), None).holding);
        assert!(!combine_report(true, status(false), Some(status(false))).holding);
        assert!(!combine_report(true, status(false), None).holding);
    }

    #[test]
    fn report_serializes_camel_case() {
        let json = serde_json::to_value(combine_report(true, status(true), None)).unwrap();
        assert_eq!(json["app"]["busyCount"], 1);
        assert!(json["daemon"].is_null());
    }
}
