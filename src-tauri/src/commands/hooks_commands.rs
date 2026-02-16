use crate::services::HooksService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

/// Hooks 命令层 - 管理 Claude Code hooks

#[tauri::command]
pub fn is_hooks_enabled(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<bool> {
    Ok(service.is_hooks_enabled(&project_path)?)
}

#[tauri::command]
pub fn enable_hooks(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    Ok(service.enable_hooks(&project_path)?)
}

#[tauri::command]
pub fn disable_hooks(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    Ok(service.disable_hooks(&project_path)?)
}

#[tauri::command]
pub fn get_workflow(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<String> {
    Ok(service.get_workflow(&project_path)?)
}

#[tauri::command]
pub fn save_workflow(
    project_path: String,
    content: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    Ok(service.save_workflow(&project_path, &content)?)
}

#[tauri::command]
pub fn init_ccpanes(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    Ok(service.init_ccpanes(&project_path)?)
}
