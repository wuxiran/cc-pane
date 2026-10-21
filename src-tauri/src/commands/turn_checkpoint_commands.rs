use crate::utils::{AppError, AppResult};
use cc_panes_core::models::turn_checkpoint::*;
use cc_panes_core::services::TurnCheckpointService;
use std::sync::{Arc, OnceLock};
use tauri::State;

/// Also used by ACP lifecycle hooks. The permit stays with the blocking worker
/// if its caller is cancelled, so abandoned requests cannot bypass the bound.
pub(crate) async fn run_checkpoint_job<T: Send + 'static>(
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = GATE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| AppError::from(error.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn list_turn_checkpoints(
    service: State<'_, Arc<TurnCheckpointService>>,
    chat_id: String,
) -> AppResult<Vec<TurnCheckpointRecord>> {
    let service = service.inner().clone();
    run_checkpoint_job(move || service.list(&chat_id)).await
}

#[tauri::command]
pub async fn review_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    id: String,
) -> AppResult<TurnCheckpointReview> {
    let service = service.inner().clone();
    run_checkpoint_job(move || service.review(&id)).await
}

#[tauri::command]
pub async fn restore_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    chats: State<'_, Arc<crate::services::AcpChatService>>,
    id: String,
    revision: String,
) -> AppResult<RestoreTurnCheckpointResult> {
    let probe = service.inner().clone();
    let probe_id = id.clone();
    let review = run_checkpoint_job(move || probe.review(&probe_id)).await?;
    if chats
        .has_background_tools_in(std::path::Path::new(&review.record.cwd))
        .await
    {
        return Err(AppError::coded(
            "CHECKPOINT_BACKGROUND_TOOLS",
            "Stop managed background commands in this repository before restoring a checkpoint",
        ));
    }
    let service = service.inner().clone();
    run_checkpoint_job(move || service.restore(&id, &revision)).await
}
