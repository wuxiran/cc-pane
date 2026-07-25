use crate::models::{QuickCommand, QuickCommandDraft};
use crate::services::QuickCommandService;
use crate::utils::AppResult;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

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
