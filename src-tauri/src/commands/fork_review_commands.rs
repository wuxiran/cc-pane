use crate::utils::{AppError, AppResult};
use cc_panes_core::models::fork_review::*;
use cc_panes_core::services::ForkReviewService;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn prepare_chat_fork(
    service: State<'_, Arc<ForkReviewService>>,
    request: PrepareChatForkRequest,
) -> AppResult<PreparedChatFork> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.prepare(request))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}
#[tauri::command]
pub async fn list_fork_reviews(
    service: State<'_, Arc<ForkReviewService>>,
) -> AppResult<Vec<ForkReviewRecord>> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list())
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}
#[tauri::command]
pub async fn get_fork_comparison(
    service: State<'_, Arc<ForkReviewService>>,
    id: String,
) -> AppResult<ForkComparison> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.compare(&id))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}
#[tauri::command]
pub async fn apply_fork_changes(
    service: State<'_, Arc<ForkReviewService>>,
    id: String,
    request: ApplyForkChangesRequest,
) -> AppResult<ApplyForkChangesResult> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.apply(&id, request))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}
