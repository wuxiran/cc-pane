use crate::services::{JournalService, SessionSummary, JournalIndex};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

/// Journal 命令层 - 管理会话日志

#[tauri::command]
pub fn add_journal_session(
    workspace_name: String,
    title: String,
    summary: String,
    commits: Vec<String>,
    service: State<'_, Arc<JournalService>>,
) -> AppResult<u32> {
    let session = SessionSummary {
        title,
        summary,
        commits,
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
    };
    service.add_session_by_workspace(&workspace_name, session).map_err(|e| e.into())
}

#[tauri::command]
pub fn get_journal_index(
    workspace_name: String,
    service: State<'_, Arc<JournalService>>,
) -> AppResult<JournalIndex> {
    service.get_index_by_workspace(&workspace_name).map_err(|e| e.into())
}

#[tauri::command]
pub fn get_recent_journal(
    workspace_name: String,
    service: State<'_, Arc<JournalService>>,
) -> AppResult<String> {
    service.get_recent_journal_by_workspace(&workspace_name).map_err(|e| e.into())
}
