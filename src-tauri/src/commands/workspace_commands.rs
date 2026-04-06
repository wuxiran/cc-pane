use crate::models::{
    ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
    ProjectMigrationRollbackResult, ScannedRepo, SshConnectionInfo, Workspace,
    WorkspaceMigrationPlan, WorkspaceMigrationRequest, WorkspaceMigrationResult,
    WorkspaceMigrationRollbackResult, WorkspaceProject,
};
use crate::services::WorkspaceService;
use crate::utils::{validate_path, validate_ssh_info, AppResult};
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_workspaces(service: State<'_, Arc<WorkspaceService>>) -> AppResult<Vec<Workspace>> {
    Ok(service.list_workspaces()?)
}

#[tauri::command]
pub fn create_workspace(
    name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Workspace> {
    debug!(name = %name, "cmd::create_workspace");
    if let Some(ref p) = path {
        validate_path(p)?;
    }
    Ok(service.create_workspace(&name, path.as_deref())?)
}

#[tauri::command]
pub fn get_workspace(
    name: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Workspace> {
    Ok(service.get_workspace(&name)?)
}

#[tauri::command]
pub fn rename_workspace(
    old_name: String,
    new_name: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(old_name = %old_name, new_name = %new_name, "cmd::rename_workspace");
    Ok(service.rename_workspace(&old_name, &new_name)?)
}

#[tauri::command]
pub fn delete_workspace(name: String, service: State<'_, Arc<WorkspaceService>>) -> AppResult<()> {
    debug!(name = %name, "cmd::delete_workspace");
    Ok(service.delete_workspace(&name)?)
}

#[tauri::command]
pub fn add_workspace_project(
    workspace_name: String,
    path: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceProject> {
    debug!(workspace_name = %workspace_name, path = %path, "cmd::add_workspace_project");
    Ok(service.add_project(&workspace_name, &path)?)
}

#[tauri::command]
pub fn add_ssh_project(
    workspace_name: String,
    ssh_info: SshConnectionInfo,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceProject> {
    debug!(workspace_name = %workspace_name, host = %ssh_info.host, "cmd::add_ssh_project");
    validate_ssh_info(&ssh_info)?;
    Ok(service.add_ssh_project(&workspace_name, ssh_info)?)
}

#[tauri::command]
pub fn remove_workspace_project(
    workspace_name: String,
    project_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, project_id = %project_id, "cmd::remove_workspace_project");
    Ok(service.remove_project(&workspace_name, &project_id)?)
}

#[tauri::command]
pub fn update_workspace_alias(
    workspace_name: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_alias");
    Ok(service.update_workspace_alias(&workspace_name, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_project_alias(
    workspace_name: String,
    project_id: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, project_id = %project_id, "cmd::update_workspace_project_alias");
    Ok(service.update_project_alias(&workspace_name, &project_id, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_provider(
    workspace_name: String,
    provider_id: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_provider");
    Ok(service.update_workspace_provider(&workspace_name, provider_id.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_path(
    workspace_name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(workspace_name = %workspace_name, "cmd::update_workspace_path");
    if let Some(ref p) = path {
        validate_path(p)?;
    }
    Ok(service.update_workspace_path(&workspace_name, path.as_deref())?)
}

#[tauri::command]
pub fn update_workspace(
    name: String,
    workspace: Workspace,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!(name = %name, "cmd::update_workspace");
    Ok(service.write_workspace_json(&name, &workspace)?)
}

#[tauri::command]
pub fn reorder_workspaces(
    ordered_names: Vec<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    debug!("cmd::reorder_workspaces");
    Ok(service.reorder_workspaces(ordered_names)?)
}

#[tauri::command]
pub fn scan_workspace_directory(root_path: String) -> AppResult<Vec<ScannedRepo>> {
    validate_path(&root_path)?;
    Ok(WorkspaceService::scan_directory(Path::new(&root_path))?)
}

#[tauri::command]
pub async fn preview_workspace_migration(
    request: WorkspaceMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceMigrationPlan> {
    debug!(workspace = %request.workspace_name, "cmd::preview_workspace_migration");
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.preview_workspace_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to preview workspace migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn execute_workspace_migration(
    request: WorkspaceMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceMigrationResult> {
    debug!(workspace = %request.workspace_name, "cmd::execute_workspace_migration");
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.execute_workspace_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to execute workspace migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn rollback_workspace_migration(
    workspace_name: String,
    snapshot_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceMigrationRollbackResult> {
    debug!(workspace = %workspace_name, snapshot_id = %snapshot_id, "cmd::rollback_workspace_migration");
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        svc.rollback_workspace_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(|e| {
        crate::utils::AppError::from(format!("Failed to rollback workspace migration: {}", e))
    })?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn preview_project_migration(
    request: ProjectMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<ProjectMigrationPlan> {
    debug!(
        workspace = %request.workspace_name,
        project = %request.project_id,
        "cmd::preview_project_migration"
    );
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.preview_project_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to preview project migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn execute_project_migration(
    request: ProjectMigrationRequest,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<ProjectMigrationResult> {
    debug!(
        workspace = %request.workspace_name,
        project = %request.project_id,
        "cmd::execute_project_migration"
    );
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.execute_project_migration(&request))
        .await
        .map_err(|e| {
            crate::utils::AppError::from(format!("Failed to execute project migration: {}", e))
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn rollback_project_migration(
    workspace_name: String,
    snapshot_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<ProjectMigrationRollbackResult> {
    debug!(
        workspace = %workspace_name,
        snapshot_id = %snapshot_id,
        "cmd::rollback_project_migration"
    );
    let svc = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        svc.rollback_project_migration(&workspace_name, &snapshot_id)
    })
    .await
    .map_err(|e| {
        crate::utils::AppError::from(format!("Failed to rollback project migration: {}", e))
    })?
    .map_err(Into::into)
}
