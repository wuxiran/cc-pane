use crate::models::{QuickCommand, QuickCommandDraft};
use crate::services::QuickCommandService;
use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::AppPaths;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

fn workspace_dir_for(app_paths: &AppPaths, workspace_name: &str) -> AppResult<PathBuf> {
    let name = workspace_name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(AppError::from(format!(
            "Invalid workspace name '{}'",
            workspace_name
        )));
    }
    Ok(app_paths.workspace_dir(name))
}

/// Workspace layer (docs/98): the default place for quick commands shared by a set of projects.
#[tauri::command]
pub fn list_workspace_quick_commands(
    workspace_name: String,
    service: State<'_, Arc<QuickCommandService>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<Vec<QuickCommand>> {
    let dir = workspace_dir_for(&app_paths, &workspace_name)?;
    Ok(service.list_workspace(&dir)?)
}

#[tauri::command]
pub fn save_workspace_quick_commands(
    workspace_name: String,
    commands: Vec<QuickCommand>,
    service: State<'_, Arc<QuickCommandService>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<Vec<QuickCommand>> {
    let dir = workspace_dir_for(&app_paths, &workspace_name)?;
    Ok(service.save_workspace(&dir, commands)?)
}

#[tauri::command]
pub fn list_quick_commands(
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<Vec<QuickCommand>> {
    Ok(service.list_global())
}

#[tauri::command]
pub fn create_quick_command(
    draft: QuickCommandDraft,
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<QuickCommand> {
    Ok(service.create_global(draft)?)
}

#[tauri::command]
pub fn update_quick_command(
    id: String,
    draft: QuickCommandDraft,
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<QuickCommand> {
    Ok(service.update_global(&id, draft)?)
}

#[tauri::command]
pub fn delete_quick_command(
    id: String,
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<()> {
    Ok(service.delete_global(&id)?)
}

#[tauri::command]
pub fn list_project_quick_commands(
    project_path: String,
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<Vec<QuickCommand>> {
    Ok(service.list_project(&PathBuf::from(project_path))?)
}

#[tauri::command]
pub fn save_project_quick_commands(
    project_path: String,
    commands: Vec<QuickCommand>,
    service: State<'_, Arc<QuickCommandService>>,
) -> AppResult<Vec<QuickCommand>> {
    Ok(service.save_project(&PathBuf::from(project_path), commands)?)
}
