use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{
    CreateDramaEpisodeRequest, CreateDramaProjectRequest, CreateDramaShotRequest, DramaEpisode,
    DramaProject, DramaShot, UpdateDramaEpisodeRequest, UpdateDramaProjectRequest,
    UpdateDramaShotRequest,
};
use serde::Deserialize;

use crate::state::AppState;

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsQuery {
    pub workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEpisodesQuery {
    pub drama_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListShotsQuery {
    pub episode_id: String,
}

pub async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<CreateDramaProjectRequest>,
) -> Result<Json<DramaProject>, (StatusCode, String)> {
    state
        .drama_service
        .create_project(&req)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_projects(
    State(state): State<AppState>,
    Query(query): Query<ListProjectsQuery>,
) -> Result<Json<Vec<DramaProject>>, (StatusCode, String)> {
    state
        .drama_service
        .list_projects(&query.workspace_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(drama_id): Path<String>,
) -> Result<Json<Option<DramaProject>>, (StatusCode, String)> {
    state
        .drama_service
        .get_project(&drama_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_project(
    State(state): State<AppState>,
    Path(drama_id): Path<String>,
    Json(req): Json<UpdateDramaProjectRequest>,
) -> Result<Json<DramaProject>, (StatusCode, String)> {
    state
        .drama_service
        .update_project(&drama_id, &req)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(drama_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .drama_service
        .delete_project(&drama_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_episode(
    State(state): State<AppState>,
    Json(req): Json<CreateDramaEpisodeRequest>,
) -> Result<Json<DramaEpisode>, (StatusCode, String)> {
    state
        .drama_service
        .create_episode(&req)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_episodes(
    State(state): State<AppState>,
    Query(query): Query<ListEpisodesQuery>,
) -> Result<Json<Vec<DramaEpisode>>, (StatusCode, String)> {
    state
        .drama_service
        .list_episodes(&query.drama_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_episode(
    State(state): State<AppState>,
    Path(episode_id): Path<String>,
    Json(req): Json<UpdateDramaEpisodeRequest>,
) -> Result<Json<DramaEpisode>, (StatusCode, String)> {
    state
        .drama_service
        .update_episode(&episode_id, &req)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_episode(
    State(state): State<AppState>,
    Path(episode_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .drama_service
        .delete_episode(&episode_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_shot(
    State(state): State<AppState>,
    Json(req): Json<CreateDramaShotRequest>,
) -> Result<Json<DramaShot>, (StatusCode, String)> {
    state
        .drama_service
        .create_shot(&req)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_shots(
    State(state): State<AppState>,
    Query(query): Query<ListShotsQuery>,
) -> Result<Json<Vec<DramaShot>>, (StatusCode, String)> {
    state
        .drama_service
        .list_shots(&query.episode_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn update_shot(
    State(state): State<AppState>,
    Path(shot_id): Path<String>,
    Json(req): Json<UpdateDramaShotRequest>,
) -> Result<Json<DramaShot>, (StatusCode, String)> {
    state
        .drama_service
        .update_shot(&shot_id, &req)
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_shot(
    State(state): State<AppState>,
    Path(shot_id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .drama_service
        .delete_shot(&shot_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}
