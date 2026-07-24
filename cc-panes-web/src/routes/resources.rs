use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use cc_panes_core::{
    constants::fs_limits::MAX_READ_SIZE,
    models::{
        filesystem::{
            DirListing, FileContent, FsEntry, ProjectContentSearchResult, ProjectFileSearchResult,
        },
        provider::Provider,
        Project, ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
        ProjectMigrationRollbackResult, ScannedRepo, SshConnectionInfo, Workspace,
        WorkspaceMigrationPlan, WorkspaceMigrationRequest, WorkspaceMigrationResult,
        WorkspaceMigrationRollbackResult, WorkspaceProject,
    },
    services::{ContentSearchLimits, WorkspaceService},
    utils::{validate_path, validate_ssh_info},
};
use serde::Deserialize;
use serde_json::Value;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceRequest {
    pub name: String,
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorkspaceRequest {
    pub new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAliasRequest {
    pub alias: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRequest {
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProviderRequest {
    pub provider_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceRequest {
    pub workspace: Workspace,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderWorkspacesRequest {
    pub ordered_names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorkspaceProjectRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSshProjectRequest {
    pub ssh_info: SshConnectionInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAliasRequest {
    pub alias: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNameRequest {
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdRequest {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsPathQuery {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWorkspaceQuery {
    pub root_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListQuery {
    pub path: String,
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchQuery {
    pub root: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteRequest {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleteRequest {
    pub path: String,
    #[serde(default)]
    pub permanent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRenameRequest {
    pub old_path: String,
    pub new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCopyMoveRequest {
    pub src: String,
    pub dest_dir: String,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_workspaces(
    State(state): State<AppState>,
) -> Result<Json<Vec<Workspace>>, (StatusCode, String)> {
    state
        .workspace_service
        .list_workspaces()
        .map(Json)
        .map_err(service_error)
}

pub async fn create_workspace(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkspaceRequest>,
) -> Result<(StatusCode, Json<Workspace>), (StatusCode, String)> {
    if let Some(path) = req.path.as_deref() {
        validate_path(path).map_err(service_error)?;
    }
    let workspace = state
        .workspace_service
        .create_workspace(&req.name, req.path.as_deref())
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(workspace)))
}

pub async fn get_workspace(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Workspace>, (StatusCode, String)> {
    state
        .workspace_service
        .get_workspace(&name)
        .map(Json)
        .map_err(service_error)
}

pub async fn rename_workspace(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<RenameWorkspaceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .rename_workspace(&name, &req.new_name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_workspace(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .delete_workspace(&name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_workspace_alias(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<WorkspaceAliasRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .update_workspace_alias(&name, req.alias.as_deref())
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_workspace_path(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<WorkspacePathRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if let Some(path) = req.path.as_deref() {
        validate_path(path).map_err(service_error)?;
    }
    state
        .workspace_service
        .update_workspace_path(&name, req.path.as_deref())
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_workspace_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<WorkspaceProviderRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .update_workspace_provider(&name, req.provider_id.as_deref())
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_workspace(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<UpdateWorkspaceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .write_workspace_json(&name, &req.workspace)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reorder_workspaces(
    State(state): State<AppState>,
    Json(req): Json<ReorderWorkspacesRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .reorder_workspaces(req.ordered_names)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn scan_workspace_directory(
    Query(query): Query<ScanWorkspaceQuery>,
) -> Result<Json<Vec<ScannedRepo>>, (StatusCode, String)> {
    validate_path(&query.root_path).map_err(service_error)?;
    WorkspaceService::scan_directory(std::path::Path::new(&query.root_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn preview_workspace_migration(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceMigrationRequest>,
) -> Result<Json<WorkspaceMigrationPlan>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || service.preview_workspace_migration(&request))
        .await
        .map_err(service_error)?
        .map(Json)
        .map_err(service_error)
}

pub async fn execute_workspace_migration(
    State(state): State<AppState>,
    Json(request): Json<WorkspaceMigrationRequest>,
) -> Result<Json<WorkspaceMigrationResult>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || service.execute_workspace_migration(&request))
        .await
        .map_err(service_error)?
        .map(Json)
        .map_err(service_error)
}

pub async fn rollback_workspace_migration(
    State(state): State<AppState>,
    Path((workspace_name, snapshot_id)): Path<(String, String)>,
) -> Result<Json<WorkspaceMigrationRollbackResult>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || {
        service.rollback_workspace_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(service_error)?
    .map(Json)
    .map_err(service_error)
}

pub async fn preview_project_migration(
    State(state): State<AppState>,
    Json(request): Json<ProjectMigrationRequest>,
) -> Result<Json<ProjectMigrationPlan>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || service.preview_project_migration(&request))
        .await
        .map_err(service_error)?
        .map(Json)
        .map_err(service_error)
}

pub async fn execute_project_migration(
    State(state): State<AppState>,
    Json(request): Json<ProjectMigrationRequest>,
) -> Result<Json<ProjectMigrationResult>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || service.execute_project_migration(&request))
        .await
        .map_err(service_error)?
        .map(Json)
        .map_err(service_error)
}

pub async fn rollback_project_migration(
    State(state): State<AppState>,
    Path((workspace_name, snapshot_id)): Path<(String, String)>,
) -> Result<Json<ProjectMigrationRollbackResult>, (StatusCode, String)> {
    let service = state.workspace_service.clone();
    tokio::task::spawn_blocking(move || {
        service.rollback_project_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(service_error)?
    .map(Json)
    .map_err(service_error)
}

pub async fn add_workspace_project(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<AddWorkspaceProjectRequest>,
) -> Result<(StatusCode, Json<WorkspaceProject>), (StatusCode, String)> {
    let project = state
        .workspace_service
        .add_project(&name, &req.path)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn add_workspace_ssh_project(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<AddSshProjectRequest>,
) -> Result<(StatusCode, Json<WorkspaceProject>), (StatusCode, String)> {
    validate_ssh_info(&req.ssh_info).map_err(service_error)?;
    let project = state
        .workspace_service
        .add_ssh_project(&name, req.ssh_info)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn remove_workspace_project(
    State(state): State<AppState>,
    Path((name, project_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .remove_project(&name, &project_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_workspace_project_alias(
    State(state): State<AppState>,
    Path((name, project_id)): Path<(String, String)>,
    Json(req): Json<ProjectAliasRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .workspace_service
        .update_project_alias(&name, &project_id, req.alias.as_deref())
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<Project>>, (StatusCode, String)> {
    state
        .project_service
        .list_projects()
        .map(Json)
        .map_err(service_error)
}

pub async fn add_project(
    State(state): State<AppState>,
    Json(req): Json<AddProjectRequest>,
) -> Result<(StatusCode, Json<Project>), (StatusCode, String)> {
    validate_path(&req.path).map_err(service_error)?;
    let project = state
        .project_service
        .add_project(&req.path)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<Project>>, (StatusCode, String)> {
    state
        .project_service
        .get_project(&id)
        .map(Json)
        .map_err(service_error)
}

pub async fn remove_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .project_service
        .remove_project(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_project_name(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ProjectNameRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .project_service
        .update_project_name(&id, &req.name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_project_alias(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ProjectAliasRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .project_service
        .update_project_alias(&id, req.alias.as_deref())
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_providers(State(state): State<AppState>) -> Json<Vec<Provider>> {
    Json(state.provider_service.list_providers())
}

pub async fn get_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<Option<Provider>> {
    Json(state.provider_service.get_provider(&id))
}

pub async fn get_default_provider(State(state): State<AppState>) -> Json<Option<Provider>> {
    Json(state.provider_service.get_default_provider())
}

pub async fn add_provider(
    State(state): State<AppState>,
    Json(provider): Json<Provider>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .provider_service
        .add_provider(provider)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut provider): Json<Provider>,
) -> Result<StatusCode, (StatusCode, String)> {
    provider.id = id;
    state
        .provider_service
        .update_provider(provider)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .provider_service
        .remove_provider(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_default_provider(
    State(state): State<AppState>,
    Json(req): Json<ProviderIdRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .provider_service
        .set_default(&req.id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.settings_service.get_settings()).unwrap_or(Value::Null))
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(settings): Json<Value>,
) -> Result<StatusCode, (StatusCode, String)> {
    let settings = serde_json::from_value(settings).map_err(service_error)?;
    state
        .settings_service
        .update_settings(settings)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWebAccessPasswordRequest {
    pub password: String,
}

pub async fn set_web_access_password(
    State(state): State<AppState>,
    Json(request): Json<SetWebAccessPasswordRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut settings = state.settings_service.get_settings();
    settings
        .web_access
        .set_password(&request.password)
        .map_err(service_error)?;
    state
        .settings_service
        .update_settings(settings)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_list_directory(
    State(state): State<AppState>,
    Query(query): Query<FsListQuery>,
) -> Result<Json<DirListing>, (StatusCode, String)> {
    state
        .filesystem_service
        .list_directory(&query.path, query.show_hidden)
        .map(Json)
        .map_err(service_error)
}

pub async fn fs_read_file(
    State(state): State<AppState>,
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FileContent>, (StatusCode, String)> {
    state
        .filesystem_service
        .read_file(&query.path)
        .map(Json)
        .map_err(service_error)
}

pub async fn search_project_files(
    State(state): State<AppState>,
    Query(query): Query<FsSearchQuery>,
) -> Result<Json<ProjectFileSearchResult>, (StatusCode, String)> {
    state
        .filesystem_service
        .search_project_files(
            &query.root,
            &query.query,
            query.limit.unwrap_or(200).clamp(1, 200),
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn search_project_contents(
    State(state): State<AppState>,
    Query(query): Query<FsSearchQuery>,
) -> Result<Json<ProjectContentSearchResult>, (StatusCode, String)> {
    state
        .filesystem_service
        .search_project_contents(
            &query.root,
            &query.query,
            ContentSearchLimits {
                max_results: query.limit.unwrap_or(300).clamp(1, 300),
                ..ContentSearchLimits::default()
            },
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn fs_read_raw_file(
    Query(query): Query<FsPathQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    validate_path(&query.path).map_err(service_error)?;
    let file_path = std::path::Path::new(&query.path);
    let metadata = std::fs::metadata(file_path).map_err(service_error)?;
    if !metadata.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("'{}' is not a file", query.path),
        ));
    }
    if metadata.len() > MAX_READ_SIZE {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "File too large ({:.1}MB). Maximum is {}MB",
                metadata.len() as f64 / 1024.0 / 1024.0,
                MAX_READ_SIZE / 1024 / 1024
            ),
        ));
    }

    let bytes = std::fs::read(file_path).map_err(service_error)?;
    let mime = mime_guess::from_path(file_path).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    Ok((headers, bytes))
}

pub async fn fs_write_file(
    State(state): State<AppState>,
    Json(req): Json<FsWriteRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .write_file(&req.path, &req.content)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_create_file(
    State(state): State<AppState>,
    Json(req): Json<FsCreateRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .create_file(&req.path)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_create_directory(
    State(state): State<AppState>,
    Json(req): Json<FsCreateRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .create_directory(&req.path)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_delete_entry(
    State(state): State<AppState>,
    Json(req): Json<FsDeleteRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .delete_entry(&req.path, req.permanent)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_rename_entry(
    State(state): State<AppState>,
    Json(req): Json<FsRenameRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .rename_entry(&req.old_path, &req.new_name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_copy_entry(
    State(state): State<AppState>,
    Json(req): Json<FsCopyMoveRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .copy_entry(&req.src, &req.dest_dir)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_move_entry(
    State(state): State<AppState>,
    Json(req): Json<FsCopyMoveRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .filesystem_service
        .move_entry(&req.src, &req.dest_dir)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fs_get_entry_info(
    State(state): State<AppState>,
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FsEntry>, (StatusCode, String)> {
    state
        .filesystem_service
        .get_entry_info(&query.path)
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod resources_tests;
