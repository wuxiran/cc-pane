use cc_panes_core::models::task_verification::{
    RunTaskVerificationRequest, TaskVerificationReport,
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
