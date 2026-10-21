use cc_panes_core::models::task_verification::{
    AcceptTaskCompletionRequest, RunTaskVerificationRequest, SetTaskCompletionCriteriaRequest,
    TaskVerificationReport,
};
use cc_panes_core::services::TaskVerificationService;
use cc_panes_core::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_task_verification(
    service: State<'_, Arc<TaskVerificationService>>,
    task_id: String,
) -> AppResult<TaskVerificationReport> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list(&task_id))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn run_task_verification(
    service: State<'_, Arc<TaskVerificationService>>,
    task_id: String,
    request: RunTaskVerificationRequest,
) -> AppResult<TaskVerificationReport> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.run(&task_id, request))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn set_task_completion_criteria(
    service: State<'_, Arc<TaskVerificationService>>,
    task_id: String,
    request: SetTaskCompletionCriteriaRequest,
) -> AppResult<TaskVerificationReport> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.set_criteria(&task_id, request))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn accept_task_completion(
    service: State<'_, Arc<TaskVerificationService>>,
    task_id: String,
    request: AcceptTaskCompletionRequest,
) -> AppResult<TaskVerificationReport> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.accept(&task_id, request))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
}
