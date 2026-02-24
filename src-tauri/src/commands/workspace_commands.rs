use crate::models::{ScannedRepo, Workspace, WorkspaceProject};
use crate::services::WorkspaceService;
use crate::utils::{AppResult, validate_path};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_workspaces(
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Vec<Workspace>> {
    Ok(service.list_workspaces()?)
}

#[tauri::command]
pub fn create_workspace(
    name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<Workspace> {
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
    Ok(service.rename_workspace(&old_name, &new_name)?)
}

#[tauri::command]
pub fn delete_workspace(
    name: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    Ok(service.delete_workspace(&name)?)
}

#[tauri::command]
pub fn add_workspace_project(
    workspace_name: String,
    path: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<WorkspaceProject> {
    Ok(service.add_project(&workspace_name, &path)?)
}

#[tauri::command]
pub fn remove_workspace_project(
    workspace_name: String,
    project_id: String,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    Ok(service.remove_project(&workspace_name, &project_id)?)
}

#[tauri::command]
pub fn update_workspace_alias(
    workspace_name: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    Ok(service.update_workspace_alias(&workspace_name, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_project_alias(
    workspace_name: String,
    project_id: String,
    alias: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    Ok(service.update_project_alias(&workspace_name, &project_id, alias.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_provider(
    workspace_name: String,
    provider_id: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    Ok(service.update_workspace_provider(&workspace_name, provider_id.as_deref())?)
}

#[tauri::command]
pub fn update_workspace_path(
    workspace_name: String,
    path: Option<String>,
    service: State<'_, Arc<WorkspaceService>>,
) -> AppResult<()> {
    if let Some(ref p) = path {
        validate_path(p)?;
    }
    Ok(service.update_workspace_path(&workspace_name, path.as_deref())?)
}

#[tauri::command]
pub fn scan_workspace_directory(
    root_path: String,
) -> AppResult<Vec<ScannedRepo>> {
    validate_path(&root_path)?;
    Ok(WorkspaceService::scan_directory(Path::new(&root_path))?)
}
