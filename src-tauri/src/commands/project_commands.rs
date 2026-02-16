use crate::models::Project;
use crate::services::ProjectService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

/// Tauri 命令层 - 薄层，只做参数转换和错误转换

#[tauri::command]
pub fn list_projects(service: State<'_, Arc<ProjectService>>) -> AppResult<Vec<Project>> {
    Ok(service.list_projects()?)
}

#[tauri::command]
pub fn add_project(path: String, service: State<'_, Arc<ProjectService>>) -> AppResult<Project> {
    Ok(service.add_project(&path)?)
}

#[tauri::command]
pub fn remove_project(id: String, service: State<'_, Arc<ProjectService>>) -> AppResult<()> {
    Ok(service.remove_project(&id)?)
}

#[tauri::command]
pub fn get_project(id: String, service: State<'_, Arc<ProjectService>>) -> AppResult<Option<Project>> {
    Ok(service.get_project(&id)?)
}

#[tauri::command]
pub fn update_project_name(
    id: String,
    name: String,
    service: State<'_, Arc<ProjectService>>,
) -> AppResult<()> {
    Ok(service.update_project_name(&id, &name)?)
}

#[tauri::command]
pub fn update_project_alias(
    id: String,
    alias: Option<String>,
    service: State<'_, Arc<ProjectService>>,
) -> AppResult<()> {
    Ok(service.update_project_alias(&id, alias.as_deref())?)
}
