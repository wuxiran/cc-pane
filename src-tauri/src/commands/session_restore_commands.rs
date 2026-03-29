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
