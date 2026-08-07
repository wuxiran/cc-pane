use cc_panes_core::models::session_restore::SavedSession;
use cc_panes_core::services::SessionRestoreService;
use std::sync::Arc;
use tauri::State;

/// 保存终端会话元数据（关闭前调用）
#[tauri::command]
pub async fn save_terminal_sessions(
    sessions: Vec<SavedSession>,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<(), String> {
    service.save_sessions(&sessions)
}

/// 加载已保存的终端会话（启动时调用）
#[tauri::command]
pub async fn load_terminal_sessions(
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<Vec<SavedSession>, String> {
    service.load_sessions()
}

/// 清空已保存的终端会话
#[tauri::command]
pub async fn clear_terminal_sessions(
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<(), String> {
    service.clear_sessions()
}

/// Prune rows only from a complete, generation-consistent daemon snapshot.
#[tauri::command]
pub async fn prune_terminal_sessions(
    daemon_generation: u64,
    captured_at_ms: u64,
    live_session_ids: Vec<String>,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<usize, String> {
    service.prune_generation(daemon_generation, captured_at_ms, &live_session_ids)
}

/// 加载指定会话的输出内容
#[tauri::command]
pub async fn load_session_output(
    session_id: String,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<Option<Vec<String>>, String> {
    service.load_session_output(&session_id)
}

/// 清除指定会话的输出文件
#[tauri::command]
pub async fn clear_session_output(
    session_id: String,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<(), String> {
    service.clear_session_output(&session_id)
}

/// 回收陈旧的会话输出文件（保留期 14 天；保护集必须含 savedSessionId 口径）。
/// 启动对账完成后由前端触发一次。
#[tauri::command]
pub async fn prune_stale_session_outputs(
    protected_session_ids: Vec<String>,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<usize, String> {
    const RETENTION: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 60 * 60);
    service.prune_stale_outputs(RETENTION, &protected_session_ids)
}
