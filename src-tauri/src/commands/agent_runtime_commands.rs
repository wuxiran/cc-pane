use crate::services::{AcpChatService, EventPage, RunFilter, RunPage};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_acp_run_records(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: Option<String>,
    engine_id: Option<String>,
    acp_session_id: Option<String>,
    offset: Option<u32>,
) -> AppResult<RunPage> {
    service
        .list_run_records(RunFilter {
            chat_id,
            engine_id,
            acp_session_id,
            offset: offset.unwrap_or(0),
        })
        .await
}

#[tauri::command]
pub async fn read_acp_run_events(
    service: State<'_, Arc<AcpChatService>>,
    run_id: String,
    after_seq: Option<u64>,
) -> AppResult<EventPage> {
    service
        .read_run_events(run_id, after_seq.unwrap_or(0))
        .await
}
