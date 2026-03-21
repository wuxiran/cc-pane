use crate::models::todo::*;
use crate::services::TodoService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

// ============ TodoItem 命令 (8 个) ============

#[tauri::command]
pub fn create_todo(
    service: State<'_, Arc<TodoService>>,
    request: CreateTodoRequest,
) -> AppResult<TodoItem> {
    debug!("cmd::create_todo");
    service.create_todo(request)
}

#[tauri::command]
pub fn get_todo(service: State<'_, Arc<TodoService>>, id: String) -> AppResult<Option<TodoItem>> {
    service.get_todo(&id)
}

#[tauri::command]
pub fn update_todo(
    service: State<'_, Arc<TodoService>>,
    id: String,
    request: UpdateTodoRequest,
) -> AppResult<TodoItem> {
    debug!(id = %id, "cmd::update_todo");
    service.update_todo(&id, request)
}

#[tauri::command]
pub fn delete_todo(service: State<'_, Arc<TodoService>>, id: String) -> AppResult<()> {
    debug!(id = %id, "cmd::delete_todo");
    service.delete_todo(&id)
}

#[tauri::command]
pub fn query_todos(
    service: State<'_, Arc<TodoService>>,
    query: TodoQuery,
) -> AppResult<TodoQueryResult> {
    service.query_todos(query)
}

#[tauri::command]
pub fn reorder_todos(service: State<'_, Arc<TodoService>>, todo_ids: Vec<String>) -> AppResult<()> {
    debug!("cmd::reorder_todos");
    service.reorder_todos(todo_ids)
}

#[tauri::command]
pub fn batch_update_todo_status(
    service: State<'_, Arc<TodoService>>,
    ids: Vec<String>,
    status: TodoStatus,
) -> AppResult<u32> {
    debug!(count = ids.len(), "cmd::batch_update_todo_status");
    service.batch_update_status(ids, status)
}

#[tauri::command]
pub fn get_todo_stats(
    service: State<'_, Arc<TodoService>>,
    scope: Option<TodoScope>,
    scope_ref: Option<String>,
) -> AppResult<TodoStats> {
    service.get_stats(scope, scope_ref)
}

#[tauri::command]
pub fn toggle_todo_my_day(service: State<'_, Arc<TodoService>>, id: String) -> AppResult<TodoItem> {
    debug!(id = %id, "cmd::toggle_todo_my_day");
    service.toggle_my_day(&id)
}

#[tauri::command]
pub fn check_todo_reminders(service: State<'_, Arc<TodoService>>) -> AppResult<Vec<TodoItem>> {
    service.get_due_reminders()
}

// ============ Subtask 命令 (5 个) ============

#[tauri::command]
pub fn add_todo_subtask(
    service: State<'_, Arc<TodoService>>,
    todo_id: String,
    title: String,
) -> AppResult<TodoSubtask> {
    debug!(todo_id = %todo_id, "cmd::add_todo_subtask");
    service.add_subtask(&todo_id, &title)
}

#[tauri::command]
pub fn update_todo_subtask(
    service: State<'_, Arc<TodoService>>,
    id: String,
    title: Option<String>,
    completed: Option<bool>,
) -> AppResult<bool> {
    debug!(id = %id, "cmd::update_todo_subtask");
    service.update_subtask(&id, title, completed)
}

#[tauri::command]
pub fn delete_todo_subtask(service: State<'_, Arc<TodoService>>, id: String) -> AppResult<()> {
    debug!(id = %id, "cmd::delete_todo_subtask");
    service.delete_subtask(&id)
}

#[tauri::command]
pub fn toggle_todo_subtask(service: State<'_, Arc<TodoService>>, id: String) -> AppResult<bool> {
    debug!(id = %id, "cmd::toggle_todo_subtask");
    service.toggle_subtask(&id)
}

#[tauri::command]
pub fn reorder_todo_subtasks(
    service: State<'_, Arc<TodoService>>,
    subtask_ids: Vec<String>,
) -> AppResult<()> {
    debug!("cmd::reorder_todo_subtasks");
    service.reorder_subtasks(subtask_ids)
}
