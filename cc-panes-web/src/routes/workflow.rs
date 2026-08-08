use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{
    spec::{CreateSpecRequest, SpecEntry, SpecStatus, UpdateSpecRequest},
    task_binding::{
        CreateTaskBindingRequest, PlanCollaboration, PlanCollaborationKey,
        RegisterPlanLeaderRequest, RegisterPlanWorkerRequest, TaskBinding, TaskBindingQuery,
        TaskBindingQueryResult, UpdateTaskBindingRequest,
    },
    todo::{
        CreateTodoRequest, TodoActivity, TodoItem, TodoQuery, TodoQueryResult, TodoScope,
        TodoStats, TodoStatus, TodoSubtask, UpdateTodoRequest,
    },
};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderTodosRequest {
    pub todo_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTodoStatusRequest {
    pub ids: Vec<String>,
    pub status: TodoStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoStatsQuery {
    pub scope: Option<TodoScope>,
    pub scope_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSubtaskRequest {
    pub title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubtaskRequest {
    pub title: Option<String>,
    pub completed: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSubtasksRequest {
    pub subtask_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSpecsQuery {
    pub project_path: String,
    pub status: Option<SpecStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecContentQuery {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSpecContentRequest {
    pub project_path: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSpecTasksRequest {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTaskBindingBySessionQuery {
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPlanChildRequest {
    #[serde(flatten)]
    pub inner: RegisterPlanWorkerRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCollaborationQuery {
    #[serde(default)]
    pub leader_id: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub normalized_plan_path: Option<String>,
    #[serde(default)]
    pub verbose: Option<bool>,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn create_todo(
    State(state): State<AppState>,
    Json(req): Json<CreateTodoRequest>,
) -> Result<(StatusCode, Json<TodoItem>), (StatusCode, String)> {
    let todo = state.todo_service.create_todo(req).map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(todo)))
}

pub async fn get_todo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<TodoItem>>, (StatusCode, String)> {
    state
        .todo_service
        .get_todo(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_todo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTodoRequest>,
) -> Result<Json<TodoItem>, (StatusCode, String)> {
    state
        .todo_service
        .update_todo(&id, req)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_todo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state.todo_service.delete_todo(&id).map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn query_todos(
    State(state): State<AppState>,
    Json(query): Json<TodoQuery>,
) -> Result<Json<TodoQueryResult>, (StatusCode, String)> {
    state
        .todo_service
        .query_todos(query)
        .map(Json)
        .map_err(service_error)
}

pub async fn reorder_todos(
    State(state): State<AppState>,
    Json(req): Json<ReorderTodosRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .todo_service
        .reorder_todos(req.todo_ids)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn batch_update_todo_status(
    State(state): State<AppState>,
    Json(req): Json<BatchTodoStatusRequest>,
) -> Result<Json<u32>, (StatusCode, String)> {
    state
        .todo_service
        .batch_update_status(req.ids, req.status)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_todo_stats(
    State(state): State<AppState>,
    Query(query): Query<TodoStatsQuery>,
) -> Result<Json<TodoStats>, (StatusCode, String)> {
    state
        .todo_service
        .get_stats(query.scope, query.scope_ref)
        .map(Json)
        .map_err(service_error)
}

pub async fn toggle_todo_my_day(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TodoItem>, (StatusCode, String)> {
    state
        .todo_service
        .toggle_my_day(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn check_todo_reminders(
    State(state): State<AppState>,
) -> Result<Json<Vec<TodoItem>>, (StatusCode, String)> {
    state
        .todo_service
        .get_due_reminders()
        .map(Json)
        .map_err(service_error)
}

pub async fn list_todo_activities(
    State(state): State<AppState>,
    Path(todo_id): Path<String>,
) -> Result<Json<Vec<TodoActivity>>, (StatusCode, String)> {
    state
        .todo_service
        .list_activities(&todo_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn add_todo_subtask(
    State(state): State<AppState>,
    Path(todo_id): Path<String>,
    Json(req): Json<AddSubtaskRequest>,
) -> Result<(StatusCode, Json<TodoSubtask>), (StatusCode, String)> {
    let subtask = state
        .todo_service
        .add_subtask(&todo_id, &req.title)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(subtask)))
}

pub async fn update_todo_subtask(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateSubtaskRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    state
        .todo_service
        .update_subtask(&id, req.title, req.completed)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_todo_subtask(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .todo_service
        .delete_subtask(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn toggle_todo_subtask(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, (StatusCode, String)> {
    state
        .todo_service
        .toggle_subtask(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn reorder_todo_subtasks(
    State(state): State<AppState>,
    Json(req): Json<ReorderSubtasksRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .todo_service
        .reorder_subtasks(req.subtask_ids)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_spec(
    State(state): State<AppState>,
    Json(req): Json<CreateSpecRequest>,
) -> Result<(StatusCode, Json<SpecEntry>), (StatusCode, String)> {
    let spec = state.spec_service.create_spec(req).map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(spec)))
}

pub async fn list_specs(
    State(state): State<AppState>,
    Query(query): Query<ListSpecsQuery>,
) -> Result<Json<Vec<SpecEntry>>, (StatusCode, String)> {
    state
        .spec_service
        .list_specs(&query.project_path, query.status)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_spec_content(
    State(state): State<AppState>,
    Path(spec_id): Path<String>,
    Query(query): Query<SpecContentQuery>,
) -> Result<Json<String>, (StatusCode, String)> {
    state
        .spec_service
        .get_spec_content(&query.project_path, &spec_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn save_spec_content(
    State(state): State<AppState>,
    Path(spec_id): Path<String>,
    Json(req): Json<SaveSpecContentRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .spec_service
        .save_spec_content(&req.project_path, &spec_id, &req.content)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_spec(
    State(state): State<AppState>,
    Path(spec_id): Path<String>,
    Json(req): Json<UpdateSpecRequest>,
) -> Result<Json<SpecEntry>, (StatusCode, String)> {
    state
        .spec_service
        .update_spec(&spec_id, req)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_spec(
    State(state): State<AppState>,
    Path(spec_id): Path<String>,
    Query(query): Query<SpecContentQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .spec_service
        .delete_spec(&query.project_path, &spec_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sync_spec_tasks(
    State(state): State<AppState>,
    Path(spec_id): Path<String>,
    Json(req): Json<SyncSpecTasksRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let service = state.spec_service.clone();
    tokio::task::spawn_blocking(move || service.sync_tasks(&req.project_path, &spec_id))
        .await
        .map_err(|error| service_error(format!("Failed to join sync_spec_tasks: {error}")))?
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_task_binding(
    State(state): State<AppState>,
    Json(req): Json<CreateTaskBindingRequest>,
) -> Result<(StatusCode, Json<TaskBinding>), (StatusCode, String)> {
    let binding = state
        .task_binding_service
        .create(req)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(binding)))
}

pub async fn get_task_binding(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<TaskBinding>>, (StatusCode, String)> {
    state
        .task_binding_service
        .get(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn find_task_binding_by_session(
    State(state): State<AppState>,
    Query(query): Query<FindTaskBindingBySessionQuery>,
) -> Result<Json<Option<TaskBinding>>, (StatusCode, String)> {
    state
        .task_binding_service
        .find_by_session_id(&query.session_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_task_binding(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTaskBindingRequest>,
) -> Result<Json<TaskBinding>, (StatusCode, String)> {
    state
        .task_binding_service
        .update(&id, req)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_task_binding_patch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<serde_json::Value>,
) -> Result<Json<TaskBinding>, (StatusCode, String)> {
    state
        .task_binding_service
        .update_patch(&id, patch)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_task_binding(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, (StatusCode, String)> {
    state
        .task_binding_service
        .delete(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_task_binding_cascade(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, (StatusCode, String)> {
    state
        .task_binding_service
        .delete_cascade(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn query_task_bindings(
    State(state): State<AppState>,
    Json(query): Json<TaskBindingQuery>,
) -> Result<Json<TaskBindingQueryResult>, (StatusCode, String)> {
    state
        .task_binding_service
        .query(query)
        .map(Json)
        .map_err(service_error)
}

pub async fn register_plan_leader(
    State(state): State<AppState>,
    Json(req): Json<RegisterPlanLeaderRequest>,
) -> Result<Json<TaskBinding>, (StatusCode, String)> {
    state
        .task_binding_service
        .register_plan_leader(req)
        .map(Json)
        .map_err(service_error)
}

pub async fn register_plan_worker(
    State(state): State<AppState>,
    Json(req): Json<RegisterPlanWorkerRequest>,
) -> Result<Json<TaskBinding>, (StatusCode, String)> {
    state
        .task_binding_service
        .register_plan_worker(req)
        .map(Json)
        .map_err(service_error)
}

pub async fn register_plan_child(
    State(state): State<AppState>,
    Json(req): Json<RegisterPlanChildRequest>,
) -> Result<Json<TaskBinding>, (StatusCode, String)> {
    state
        .task_binding_service
        .register_plan_child(req.inner)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_plan_collaboration(
    State(state): State<AppState>,
    Query(query): Query<PlanCollaborationQuery>,
) -> Result<Json<PlanCollaboration>, (StatusCode, String)> {
    state
        .task_binding_service
        .get_plan_collaboration(
            PlanCollaborationKey {
                leader_id: query.leader_id,
                plan_path: query.plan_path,
                normalized_plan_path: query.normalized_plan_path,
            },
            query.verbose.unwrap_or(false),
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn reconcile_plan_collaboration(
    State(state): State<AppState>,
    Query(query): Query<PlanCollaborationQuery>,
) -> Result<Json<PlanCollaboration>, (StatusCode, String)> {
    state
        .task_binding_service
        .reconcile_plan_collaboration(
            PlanCollaborationKey {
                leader_id: query.leader_id,
                plan_path: query.plan_path,
                normalized_plan_path: query.normalized_plan_path,
            },
            Vec::new(),
            query.verbose.unwrap_or(false),
        )
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod workflow_tests;
