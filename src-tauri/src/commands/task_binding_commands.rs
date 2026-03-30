use crate::models::task_binding::*;
use crate::services::TaskBindingService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn create_task_binding(
    service: State<'_, Arc<TaskBindingService>>,
    request: CreateTaskBindingRequest,
) -> AppResult<TaskBinding> {
    debug!("cmd::create_task_binding");
    service.create(request)
}

#[tauri::command]
pub fn get_task_binding(
    service: State<'_, Arc<TaskBindingService>>,
    id: String,
) -> AppResult<Option<TaskBinding>> {
    service.get(&id)
}

#[tauri::command]
pub fn find_task_binding_by_session(
    service: State<'_, Arc<TaskBindingService>>,
    session_id: String,
) -> AppResult<Option<TaskBinding>> {
    service.find_by_session_id(&session_id)
}

#[tauri::command]
pub fn update_task_binding(
    service: State<'_, Arc<TaskBindingService>>,
    id: String,
    request: UpdateTaskBindingRequest,
) -> AppResult<TaskBinding> {
    debug!(id = %id, "cmd::update_task_binding");
    service.update(&id, request)
}

#[tauri::command]
pub fn delete_task_binding(
    service: State<'_, Arc<TaskBindingService>>,
    id: String,
) -> AppResult<bool> {
    debug!(id = %id, "cmd::delete_task_binding");
    service.delete(&id)
}

#[tauri::command]
pub fn query_task_bindings(
    service: State<'_, Arc<TaskBindingService>>,
    query: TaskBindingQuery,
) -> AppResult<TaskBindingQueryResult> {
    service.query(query)
}
