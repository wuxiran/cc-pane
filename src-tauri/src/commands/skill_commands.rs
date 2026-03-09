use crate::services::skill_service::{SkillInfo, SkillSummary};
use crate::services::SkillService;
use crate::utils::{validate_path, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_skills(
    project_path: String,
    service: State<'_, Arc<SkillService>>,
) -> AppResult<Vec<SkillSummary>> {
    validate_path(&project_path)?;
    service.list_skills(&project_path)
}

#[tauri::command]
pub fn get_skill(
    project_path: String,
    name: String,
    service: State<'_, Arc<SkillService>>,
) -> AppResult<Option<SkillInfo>> {
    validate_path(&project_path)?;
    service.get_skill(&project_path, &name)
}

#[tauri::command]
pub fn save_skill(
    project_path: String,
    name: String,
    content: String,
    service: State<'_, Arc<SkillService>>,
) -> AppResult<SkillInfo> {
    debug!(project_path = %project_path, name = %name, "cmd::save_skill");
    validate_path(&project_path)?;
    service.save_skill(&project_path, &name, &content)
}

#[tauri::command]
pub fn delete_skill(
    project_path: String,
    name: String,
    service: State<'_, Arc<SkillService>>,
) -> AppResult<bool> {
    debug!(project_path = %project_path, name = %name, "cmd::delete_skill");
    validate_path(&project_path)?;
    service.delete_skill(&project_path, &name)
}

#[tauri::command]
pub fn copy_skill(
    source_project: String,
    target_project: String,
    name: String,
    service: State<'_, Arc<SkillService>>,
) -> AppResult<SkillInfo> {
    debug!(name = %name, source_project = %source_project, target_project = %target_project, "cmd::copy_skill");
    validate_path(&source_project)?;
    validate_path(&target_project)?;
    service.copy_skill(&source_project, &target_project, &name)
}
