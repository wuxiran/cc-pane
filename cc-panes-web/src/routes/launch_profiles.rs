use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{
    LaunchProfile, LaunchProfileDraft, LaunchProfilePreviewRequest, LaunchProfileResolution,
};

use crate::state::AppState;

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_launch_profiles(
    State(state): State<AppState>,
) -> Result<Json<Vec<LaunchProfile>>, (StatusCode, String)> {
    Ok(Json(state.launch_profile_service.list_profiles()))
}

pub async fn get_launch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<LaunchProfile>>, (StatusCode, String)> {
    Ok(Json(state.launch_profile_service.get_profile(&id)))
}

pub async fn create_launch_profile(
    State(state): State<AppState>,
    Json(draft): Json<LaunchProfileDraft>,
) -> Result<(StatusCode, Json<LaunchProfile>), (StatusCode, String)> {
    let profile = state
        .launch_profile_service
        .create_profile(draft)
        .map_err(service_error)?;
    Ok((StatusCode::CREATED, Json(profile)))
}

pub async fn update_launch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(draft): Json<LaunchProfileDraft>,
) -> Result<Json<LaunchProfile>, (StatusCode, String)> {
    state
        .launch_profile_service
        .update_profile(&id, draft)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_launch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_profile_service
        .delete_profile(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_default_launch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .launch_profile_service
        .set_default_profile(&id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preview_launch_profile_resolution(
    State(state): State<AppState>,
    Json(request): Json<LaunchProfilePreviewRequest>,
) -> Result<Json<LaunchProfileResolution>, (StatusCode, String)> {
    let workspaces = state
        .workspace_service
        .list_workspaces()
        .map_err(service_error)?;
    let providers = state.provider_service.list_providers();
    let shared_config = state.shared_mcp_service.get_config();
    let running_urls = state.shared_mcp_service.get_running_servers_urls();
    Ok(Json(state.launch_profile_service.resolve_profile(
        &request,
        &workspaces,
        &providers,
        &shared_config,
        &running_urls,
    )))
}

#[cfg(test)]
#[path = "launch_profiles_tests.rs"]
pub(crate) mod launch_profiles_tests;
