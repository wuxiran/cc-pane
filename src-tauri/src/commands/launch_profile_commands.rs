use crate::models::launch_profile::{
    LaunchProfile, LaunchProfileDraft, LaunchProfilePreviewRequest, LaunchProfileResolution,
};
use crate::services::{LaunchProfileService, ProviderService, SharedMcpService, WorkspaceService};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_launch_profiles(
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<Vec<LaunchProfile>> {
    Ok(service.list_profiles())
}

#[tauri::command]
pub fn get_launch_profile(
    id: String,
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<Option<LaunchProfile>> {
    Ok(service.get_profile(&id))
}

#[tauri::command]
pub fn create_launch_profile(
    draft: LaunchProfileDraft,
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<LaunchProfile> {
    Ok(service.create_profile(draft)?)
}

#[tauri::command]
pub fn update_launch_profile(
    id: String,
    draft: LaunchProfileDraft,
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<LaunchProfile> {
    Ok(service.update_profile(&id, draft)?)
}

#[tauri::command]
pub fn delete_launch_profile(
    id: String,
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<()> {
    Ok(service.delete_profile(&id)?)
}

#[tauri::command]
pub fn set_default_launch_profile(
    id: String,
    service: State<'_, Arc<LaunchProfileService>>,
) -> AppResult<()> {
    Ok(service.set_default_profile(&id)?)
}

#[tauri::command]
pub fn preview_launch_profile_resolution(
    request: LaunchProfilePreviewRequest,
    launch_profiles: State<'_, Arc<LaunchProfileService>>,
    workspaces: State<'_, Arc<WorkspaceService>>,
    providers: State<'_, Arc<ProviderService>>,
    shared_mcp: State<'_, Arc<SharedMcpService>>,
) -> AppResult<LaunchProfileResolution> {
    let workspace_list = workspaces.list_workspaces()?;
    let provider_list = providers.list_providers();
    let shared_config = shared_mcp.get_config();
    let running_urls = shared_mcp.get_running_servers_urls();
    Ok(launch_profiles.resolve_profile(
        &request,
        &workspace_list,
        &provider_list,
        &shared_config,
        &running_urls,
    ))
}
