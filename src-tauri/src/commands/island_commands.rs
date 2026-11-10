//! 灵动岛窗口命令。窗口 / 落位逻辑在 `services::island_window`。

use crate::services::island_window::{
    focus_main_window, IslandState, IslandWindowManager, ISLAND_NAVIGATE_EVENT,
};
use crate::services::orchestrator_service::pending_approval::{
    detect_pending_approval, APPROVAL_SCAN_LINES,
};
use crate::services::TerminalBackendState;
use crate::utils::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tracing::debug;

const MAX_TARGET_ID_LEN: usize = 256;

/// 岛上点一行要跳到的会话：`terminal` 为 PTY sessionId，`chat` 为 Agent Chat 的 chatId。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandNavigateTarget {
    pub kind: String,
    pub id: String,
}

fn validate_target(target: &IslandNavigateTarget) -> AppResult<()> {
    if !matches!(target.kind.as_str(), "terminal" | "chat") {
        return Err(AppError::from(format!(
            "unknown island target kind: {}",
            target.kind
        )));
    }
    if target.id.is_empty() || target.id.len() > MAX_TARGET_ID_LEN {
        return Err(AppError::from("invalid island target id"));
    }
    Ok(())
}

#[tauri::command]
pub fn island_get_state(manager: State<'_, Arc<IslandWindowManager>>) -> IslandState {
    manager.state()
}

/// 前端上报当前可见岛的逻辑尺寸；后端据此改原生窗口外框（= 点击穿透边界）。
/// async：改窗口尺寸在 Windows 同步命令里会和主线程互等。
#[tauri::command]
pub async fn island_set_layout(
    app: AppHandle,
    manager: State<'_, Arc<IslandWindowManager>>,
    width: f64,
    height: f64,
) -> AppResult<()> {
    manager.set_layout(&app, width, height)
}

/// 唤起主窗口并让主窗口事件桥定位到该会话的 pane/tab。
#[tauri::command]
pub async fn island_activate_session(
    app: AppHandle,
    target: IslandNavigateTarget,
) -> AppResult<()> {
    debug!(kind = %target.kind, "cmd::island_activate_session");
    validate_target(&target)?;
    focus_main_window(&app)?;
    app.emit_to("main", ISLAND_NAVIGATE_EVENT, &target)
        .map_err(|e| AppError::from(e.to_string()))
}

/// 终端 CLI 卡在审批框时，读屏幕底部取问题原文（与 MCP get_session_status 同一套检测）。
/// 只在岛上打开该会话的审批卡时按需调用一次，不轮询。
#[tauri::command]
pub async fn get_terminal_pending_approval(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
) -> AppResult<Option<String>> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let output = service
            .backend()
            .get_session_output(&session_id, APPROVAL_SCAN_LINES)?;
        Ok(detect_pending_approval(&output.lines))
    })
    .await
    .map_err(|error| AppError::from(format!("pending approval probe failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kind: &str, id: &str) -> IslandNavigateTarget {
        IslandNavigateTarget {
            kind: kind.into(),
            id: id.into(),
        }
    }

    #[test]
    fn only_known_kinds_with_bounded_ids_are_accepted() {
        assert!(validate_target(&target("terminal", "s-1")).is_ok());
        assert!(validate_target(&target("chat", "dock-chat-1")).is_ok());
        assert!(validate_target(&target("browser", "x")).is_err());
        assert!(validate_target(&target("chat", "")).is_err());
        assert!(validate_target(&target("chat", &"x".repeat(MAX_TARGET_ID_LEN + 1))).is_err());
    }
}
