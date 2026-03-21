use crate::services::{HookStatus, HooksService};
use crate::utils::{validate_path, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// Hooks 命令层 - 管理 Claude Code hooks

#[tauri::command]
pub fn is_hooks_enabled(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<bool> {
    validate_path(&project_path)?;
    Ok(service.is_hooks_enabled(&project_path)?)
}

#[tauri::command]
pub fn enable_hooks(project_path: String, service: State<'_, Arc<HooksService>>) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::enable_hooks");
    validate_path(&project_path)?;
    Ok(service.enable_hooks(&project_path)?)
}

#[tauri::command]
pub fn disable_hooks(project_path: String, service: State<'_, Arc<HooksService>>) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::disable_hooks");
    validate_path(&project_path)?;
    Ok(service.disable_hooks(&project_path)?)
}

#[tauri::command]
pub fn get_hooks_status(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<Vec<HookStatus>> {
    validate_path(&project_path)?;
    Ok(service.get_hooks_status(&project_path)?)
}

#[tauri::command]
pub fn enable_hook(
    project_path: String,
    hook_name: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, hook_name = %hook_name, "cmd::enable_hook");
    validate_path(&project_path)?;
    Ok(service.enable_hook(&project_path, &hook_name)?)
}

#[tauri::command]
pub fn disable_hook(
    project_path: String,
    hook_name: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, hook_name = %hook_name, "cmd::disable_hook");
    validate_path(&project_path)?;
    Ok(service.disable_hook(&project_path, &hook_name)?)
}

#[tauri::command]
pub fn enable_all_hooks(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::enable_all_hooks");
    validate_path(&project_path)?;
    Ok(service.enable_all_hooks(&project_path)?)
}

#[tauri::command]
pub fn get_workflow(
    project_path: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<String> {
    validate_path(&project_path)?;
    Ok(service.get_workflow(&project_path)?)
}

#[tauri::command]
pub fn save_workflow(
    project_path: String,
    content: String,
    service: State<'_, Arc<HooksService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::save_workflow");
    validate_path(&project_path)?;
    Ok(service.save_workflow(&project_path, &content)?)
}

#[tauri::command]
pub fn init_ccpanes(project_path: String, service: State<'_, Arc<HooksService>>) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::init_ccpanes");
    validate_path(&project_path)?;
    Ok(service.init_ccpanes(&project_path)?)
}
