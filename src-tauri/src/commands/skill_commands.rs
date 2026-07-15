use crate::services::skill_service::{SkillInfo, SkillSummary};
use crate::services::SkillService;
use crate::services::{SkillMarketEntry, SkillMarketService};
use crate::utils::{validate_path, AppResult};
use cc_panes_core::models::DiscoveredExternalSkill;
use cc_panes_core::services::{ExternalSkillRegistry, InstalledUserSkill};
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

#[tauri::command]
pub fn list_external_skills(
    source: Option<String>,
    registry: State<'_, Arc<ExternalSkillRegistry>>,
) -> AppResult<Vec<DiscoveredExternalSkill>> {
    let source = source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    match source.as_deref() {
        None => registry.list(),
        Some("claude" | "codex" | "plugin") => {
            registry.list_by_source_filter(source.as_deref().unwrap())
        }
        Some(other) => Err(format!(
            "Unsupported external skill source '{}'; expected claude, codex, or plugin",
            other
        )
        .into()),
    }
}

#[tauri::command]
pub async fn list_skill_market_entries(
    service: State<'_, Arc<SkillMarketService>>,
) -> AppResult<Vec<SkillMarketEntry>> {
    service.list_market_entries().await
}

#[tauri::command]
pub fn list_user_skills(
    service: State<'_, Arc<SkillMarketService>>,
) -> AppResult<Vec<InstalledUserSkill>> {
    service.list_user_skills()
}

#[tauri::command]
pub async fn install_market_skill(
    skill_id: String,
    service: State<'_, Arc<SkillMarketService>>,
) -> AppResult<InstalledUserSkill> {
    debug!(skill_id = %skill_id, "cmd::install_market_skill");
    service.install_market_skill(&skill_id).await
}

#[tauri::command]
pub fn remove_user_skill(
    skill_id: String,
    service: State<'_, Arc<SkillMarketService>>,
) -> AppResult<bool> {
    debug!(skill_id = %skill_id, "cmd::remove_user_skill");
    service.remove_user_skill(&skill_id)
}

/// 列出 CC-Panes 内置注入的 skill（只读，供资源中心展示）。
#[tauri::command]
pub fn list_bundled_skills(
    app: tauri::AppHandle,
) -> AppResult<Vec<cc_panes_core::services::BundledSkillInfo>> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
    let templates_dir = resource_dir
        .join("resources")
        .join("claude-bundle")
        .join("default-skills");
    let svc = cc_panes_core::services::DefaultSkillService::new(templates_dir);
    Ok(svc.list_bundled())
}
