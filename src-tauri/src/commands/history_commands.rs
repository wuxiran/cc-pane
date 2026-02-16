use crate::repository::LaunchRecord;
use crate::services::LaunchHistoryService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn add_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    project_id: String,
    project_name: String,
    project_path: String,
) -> AppResult<()> {
    Ok(service.add(&project_id, &project_name, &project_path)?)
}

#[tauri::command]
pub fn list_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
    limit: Option<usize>,
) -> AppResult<Vec<LaunchRecord>> {
    Ok(service.list(limit.unwrap_or(20))?)
}

#[tauri::command]
pub fn clear_launch_history(
    service: State<'_, Arc<LaunchHistoryService>>,
) -> AppResult<()> {
    Ok(service.clear()?)
}
