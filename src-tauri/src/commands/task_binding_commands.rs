use crate::models::task_binding::*;
use crate::services::{TaskBindingService, TerminalService};
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
pub fn update_task_binding_patch(
    service: State<'_, Arc<TaskBindingService>>,
    id: String,
    patch: serde_json::Value,
) -> AppResult<TaskBinding> {
    debug!(id = %id, "cmd::update_task_binding_patch");
    service.update_patch(&id, patch)
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
pub fn delete_task_binding_cascade(
    service: State<'_, Arc<TaskBindingService>>,
    id: String,
) -> AppResult<bool> {
    debug!(id = %id, "cmd::delete_task_binding_cascade");
    // fix(H3) review: 前端只发一次命令，后端原子删除自身与所有后代。
    service.delete_cascade(&id)
}

#[tauri::command]
pub fn query_task_bindings(
    service: State<'_, Arc<TaskBindingService>>,
    query: TaskBindingQuery,
) -> AppResult<TaskBindingQueryResult> {
    service.query(query)
}

#[tauri::command]
pub fn register_plan_leader(
    service: State<'_, Arc<TaskBindingService>>,
    request: RegisterPlanLeaderRequest,
) -> AppResult<TaskBinding> {
    debug!("cmd::register_plan_leader");
    service.register_plan_leader(request)
}

#[tauri::command]
pub fn register_plan_worker(
    service: State<'_, Arc<TaskBindingService>>,
    request: RegisterPlanWorkerRequest,
) -> AppResult<TaskBinding> {
    debug!("cmd::register_plan_worker");
    service.register_plan_worker(request)
}

#[tauri::command]
pub fn register_plan_child(
    service: State<'_, Arc<TaskBindingService>>,
    request: RegisterPlanChildRequest,
) -> AppResult<TaskBinding> {
    debug!("cmd::register_plan_child");
    service.register_plan_child(request)
}

#[tauri::command]
pub fn get_plan_collaboration(
    service: State<'_, Arc<TaskBindingService>>,
    key: PlanCollaborationKey,
    verbose: Option<bool>,
) -> AppResult<PlanCollaboration> {
    service.get_plan_collaboration(key, verbose.unwrap_or(false))
}

#[tauri::command]
pub fn reconcile_plan_collaboration(
    task_binding_service: State<'_, Arc<TaskBindingService>>,
    terminal_service: State<'_, Arc<TerminalService>>,
    key: PlanCollaborationKey,
    verbose: Option<bool>,
) -> AppResult<PlanCollaboration> {
    let live_sessions = terminal_service
        .get_all_status()?
        .into_iter()
        .map(|status| PlanLiveSession {
            session_id: status.session_id,
            pane_id: None,
            tab_id: None,
        })
        .collect();
    task_binding_service.reconcile_plan_collaboration(key, live_sessions, verbose.unwrap_or(false))
}
