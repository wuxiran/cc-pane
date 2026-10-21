use crate::services::{AcpChatService, UndoAcpFileEdit};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn undo_acp_file_edit(
    chat_id: String,
    edit: UndoAcpFileEdit,
    service: State<'_, Arc<AcpChatService>>,
) -> AppResult<()> {
    service.undo_file_edit(&chat_id, edit).await
}
