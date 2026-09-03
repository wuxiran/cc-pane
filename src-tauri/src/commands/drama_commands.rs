use cc_panes_core::models::{
    CreateDramaEpisodeRequest, CreateDramaProjectRequest, CreateDramaShotRequest, DramaEpisode,
    DramaProject, DramaShot, UpdateDramaEpisodeRequest, UpdateDramaProjectRequest,
    UpdateDramaShotRequest,
};
use cc_panes_core::services::DramaService;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn create_drama_project(
    request: CreateDramaProjectRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaProject, String> {
    service.create_project(&request)
}

#[tauri::command]
pub async fn list_drama_projects(
    workspace_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<Vec<DramaProject>, String> {
    service.list_projects(&workspace_id)
}

#[tauri::command]
pub async fn get_drama_project(
    drama_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<Option<DramaProject>, String> {
    service.get_project(&drama_id)
}

#[tauri::command]
pub async fn update_drama_project(
    drama_id: String,
    request: UpdateDramaProjectRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaProject, String> {
    service.update_project(&drama_id, &request)
}

#[tauri::command]
pub async fn delete_drama_project(
    drama_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<bool, String> {
    service.delete_project(&drama_id)
}

#[tauri::command]
pub async fn create_drama_episode(
    request: CreateDramaEpisodeRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaEpisode, String> {
    service.create_episode(&request)
}

#[tauri::command]
pub async fn list_drama_episodes(
    drama_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<Vec<DramaEpisode>, String> {
    service.list_episodes(&drama_id)
}

#[tauri::command]
pub async fn update_drama_episode(
    episode_id: String,
    request: UpdateDramaEpisodeRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaEpisode, String> {
    service.update_episode(&episode_id, &request)
}

#[tauri::command]
pub async fn delete_drama_episode(
    episode_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<bool, String> {
    service.delete_episode(&episode_id)
}

#[tauri::command]
pub async fn create_drama_shot(
    request: CreateDramaShotRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaShot, String> {
    service.create_shot(&request)
}

#[tauri::command]
pub async fn list_drama_shots(
    episode_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<Vec<DramaShot>, String> {
    service.list_shots(&episode_id)
}

#[tauri::command]
pub async fn update_drama_shot(
    shot_id: String,
    request: UpdateDramaShotRequest,
    service: State<'_, Arc<DramaService>>,
) -> Result<DramaShot, String> {
    service.update_shot(&shot_id, &request)
}

#[tauri::command]
pub async fn delete_drama_shot(
    shot_id: String,
    service: State<'_, Arc<DramaService>>,
) -> Result<bool, String> {
    service.delete_shot(&shot_id)
}
