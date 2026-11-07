//! 资源库「技能」REST（docs/109 第 2 批），与 Tauri 的 `skill_library_*` 命令一一对应。

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::skill_library::{
        FoundSkill, LibrarySkill, SkillCheck, SkillImportResult, SkillInstallResult,
        SkillLibraryContent, SkillProbe, SkillRemoveResult, SkillUpdateResult,
    },
    services::SkillLibraryService,
    utils::AppResult,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::state::AppState;

type ApiResult<T> = Result<Json<T>, (StatusCode, String)>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub probe_id: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    #[serde(default)]
    pub ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub ids: Vec<String>,
    #[serde(default)]
    pub replace_edited: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsRequest {
    pub ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysRequest {
    pub keys: Vec<String>,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

async fn blocking<T, F>(state: &AppState, work: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(&SkillLibraryService) -> AppResult<T> + Send + 'static,
{
    let service: Arc<SkillLibraryService> = state.skill_library_service.clone();
    tokio::task::spawn_blocking(move || work(&service))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(service_error)
}

pub async fn list(State(state): State<AppState>) -> ApiResult<Vec<LibrarySkill>> {
    blocking(&state, |service| service.list()).await
}

pub async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<SkillLibraryContent> {
    blocking(&state, move |service| service.read(&id)).await
}

pub async fn probe(
    State(state): State<AppState>,
    Json(req): Json<ProbeRequest>,
) -> ApiResult<SkillProbe> {
    state
        .skill_library_service
        .probe(&req.source)
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn install(
    State(state): State<AppState>,
    Json(req): Json<InstallRequest>,
) -> ApiResult<SkillInstallResult> {
    state
        .skill_library_service
        .install(&req.probe_id, &req.paths)
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn check(
    State(state): State<AppState>,
    body: Option<Json<CheckRequest>>,
) -> ApiResult<Vec<SkillCheck>> {
    let req = body.map(|Json(req)| req).unwrap_or_default();
    state
        .skill_library_service
        .check(req.ids.as_deref())
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> ApiResult<SkillUpdateResult> {
    state
        .skill_library_service
        .update(&req.ids, req.replace_edited)
        .await
        .map(Json)
        .map_err(service_error)
}

pub async fn remove(
    State(state): State<AppState>,
    Json(req): Json<IdsRequest>,
) -> ApiResult<SkillRemoveResult> {
    blocking(&state, move |service| service.remove(&req.ids)).await
}

pub async fn found(State(state): State<AppState>) -> ApiResult<Vec<FoundSkill>> {
    blocking(&state, |service| service.found()).await
}

pub async fn import(
    State(state): State<AppState>,
    Json(req): Json<KeysRequest>,
) -> ApiResult<SkillImportResult> {
    blocking(&state, move |service| service.import(&req.keys)).await
}
