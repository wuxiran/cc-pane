use crate::services::{ProjectCliHookGroupStatus, ProjectCliHooksService, ProjectContextService};
use crate::utils::{validate_path, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 项目 Hooks 命令层 - 管理各 CLI 的项目级 hooks 与 `.ccpanes` 上下文

#[tauri::command]
pub fn get_project_cli_hooks(
    project_path: String,
    service: State<'_, Arc<ProjectCliHooksService>>,
) -> AppResult<Vec<ProjectCliHookGroupStatus>> {
    validate_path(&project_path)?;
    Ok(service.list_project_cli_hooks(&project_path)?)
}

#[tauri::command]
pub fn set_project_cli_hook_enabled(
    project_path: String,
    cli_tool: String,
    hook_name: String,
    enabled: bool,
    service: State<'_, Arc<ProjectCliHooksService>>,
) -> AppResult<()> {
    debug!(
        project_path = %project_path,
        cli_tool = %cli_tool,
        hook_name = %hook_name,
        enabled,
        "cmd::set_project_cli_hook_enabled"
    );
    validate_path(&project_path)?;
    Ok(service.set_project_cli_hook_enabled(&project_path, &cli_tool, &hook_name, enabled)?)
}

#[tauri::command]
pub fn get_workflow(
    project_path: String,
    service: State<'_, Arc<ProjectContextService>>,
) -> AppResult<String> {
    validate_path(&project_path)?;
    Ok(service.get_workflow(&project_path)?)
}

#[tauri::command]
pub fn save_workflow(
    project_path: String,
    content: String,
    service: State<'_, Arc<ProjectContextService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::save_workflow");
    validate_path(&project_path)?;
    Ok(service.save_workflow(&project_path, &content)?)
}

#[tauri::command]
pub fn init_ccpanes(
    project_path: String,
    service: State<'_, Arc<ProjectContextService>>,
) -> AppResult<()> {
    debug!(project_path = %project_path, "cmd::init_ccpanes");
    validate_path(&project_path)?;
    Ok(service.init_ccpanes(&project_path)?)
}
