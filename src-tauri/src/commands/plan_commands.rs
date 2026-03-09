use crate::services::plan_service::PlanEntry;
use crate::services::PlanService;
use crate::utils::{AppResult, validate_path};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// Plan 命令层 - 管理已归档的 plan 文件

#[tauri::command]
pub fn list_plans(
    project_path: String,
    service: State<'_, Arc<PlanService>>,
) -> AppResult<Vec<PlanEntry>> {
    validate_path(&project_path)?;
    Ok(service.list_plans(&project_path)?)
}

#[tauri::command]
pub fn get_plan_content(
    project_path: String,
    file_name: String,
    service: State<'_, Arc<PlanService>>,
) -> AppResult<String> {
    validate_path(&project_path)?;
    Ok(service.get_plan_content(&project_path, &file_name)?)
}

#[tauri::command]
pub fn delete_plan(
    project_path: String,
    file_name: String,
    service: State<'_, Arc<PlanService>>,
) -> AppResult<()> {
    debug!("cmd::delete_plan file_name={}", file_name);
    validate_path(&project_path)?;
    Ok(service.delete_plan(&project_path, &file_name)?)
}
