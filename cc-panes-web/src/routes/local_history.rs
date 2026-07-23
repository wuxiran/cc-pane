use std::path::Path;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::models::{
    DiffResult, FileVersion, HistoryConfig, HistoryLabel, RecentChange, WorktreeRecentChange,
};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryRequest {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfigRequest {
    pub project_path: String,
    pub config: HistoryConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersionQuery {
    pub project_path: String,
    pub file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionContentQuery {
    pub project_path: String,
    pub file_path: String,
    pub version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFileVersionRequest {
    pub project_path: String,
    pub file_path: String,
    pub version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsDiffQuery {
    pub project_path: String,
    pub file_path: String,
    pub old_version_id: String,
    pub new_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutLabelRequest {
    pub project_path: String,
    pub label: HistoryLabel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLabelQuery {
    pub project_path: String,
    pub label_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRequest {
    pub project_path: String,
    pub label_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutoLabelRequest {
    pub project_path: String,
    pub name: String,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryChangesQuery {
    pub project_path: String,
    pub dir_path: String,
    pub since: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitQuery {
    pub project_path: String,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchVersionsQuery {
    pub project_path: String,
    pub file_path: String,
    pub branch: String,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

fn decode_content(content: Vec<u8>) -> String {
    cc_panes_core::utils::decode_text_lossy_gbk(&content)
}

pub async fn init_project_history(
    State(state): State<AppState>,
    Json(req): Json<ProjectHistoryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .init_project_history(Path::new(&req.project_path))
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_file_versions(
    State(state): State<AppState>,
    Query(query): Query<FileVersionQuery>,
) -> Result<Json<Vec<FileVersion>>, (StatusCode, String)> {
    state
        .history_service
        .list_versions(Path::new(&query.project_path), &query.file_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_version_content(
    State(state): State<AppState>,
    Query(query): Query<VersionContentQuery>,
) -> Result<Json<String>, (StatusCode, String)> {
    state
        .history_service
        .get_version_content(
            Path::new(&query.project_path),
            &query.file_path,
            &query.version_id,
        )
        .map(decode_content)
        .map(Json)
        .map_err(service_error)
}

pub async fn restore_file_version(
    State(state): State<AppState>,
    Json(req): Json<RestoreFileVersionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .restore_version(
            Path::new(&req.project_path),
            &req.file_path,
            &req.version_id,
        )
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_history_config(
    State(state): State<AppState>,
    Query(query): Query<ProjectHistoryRequest>,
) -> Result<Json<HistoryConfig>, (StatusCode, String)> {
    state
        .history_service
        .get_config(Path::new(&query.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn update_history_config(
    State(state): State<AppState>,
    Json(req): Json<HistoryConfigRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .update_config(Path::new(&req.project_path), req.config)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_project_history(
    State(state): State<AppState>,
    Json(req): Json<ProjectHistoryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .stop_watching(Path::new(&req.project_path))
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn cleanup_project_history(
    State(state): State<AppState>,
    Json(req): Json<ProjectHistoryRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .cleanup(Path::new(&req.project_path))
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_version_diff(
    State(state): State<AppState>,
    Query(query): Query<VersionContentQuery>,
) -> Result<Json<DiffResult>, (StatusCode, String)> {
    state
        .history_service
        .get_version_diff(
            Path::new(&query.project_path),
            &query.file_path,
            &query.version_id,
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn get_versions_diff(
    State(state): State<AppState>,
    Query(query): Query<VersionsDiffQuery>,
) -> Result<Json<DiffResult>, (StatusCode, String)> {
    state
        .history_service
        .get_versions_diff(
            Path::new(&query.project_path),
            &query.file_path,
            &query.old_version_id,
            &query.new_version_id,
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn put_label(
    State(state): State<AppState>,
    Json(req): Json<PutLabelRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .put_label(Path::new(&req.project_path), &req.label)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_labels(
    State(state): State<AppState>,
    Query(query): Query<ProjectHistoryRequest>,
) -> Result<Json<Vec<HistoryLabel>>, (StatusCode, String)> {
    state
        .history_service
        .list_labels(Path::new(&query.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn delete_label(
    State(state): State<AppState>,
    Query(query): Query<DeleteLabelQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .history_service
        .delete_label(Path::new(&query.project_path), &query.label_id)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_to_label(
    State(state): State<AppState>,
    Json(req): Json<LabelRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    state
        .history_service
        .restore_to_label(Path::new(&req.project_path), &req.label_id)
        .map(Json)
        .map_err(service_error)
}

pub async fn create_auto_label(
    State(state): State<AppState>,
    Json(req): Json<CreateAutoLabelRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    state
        .history_service
        .create_auto_label(Path::new(&req.project_path), &req.name, &req.source)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_directory_changes(
    State(state): State<AppState>,
    Query(query): Query<DirectoryChangesQuery>,
) -> Result<Json<Vec<FileVersion>>, (StatusCode, String)> {
    state
        .history_service
        .list_directory_changes(
            Path::new(&query.project_path),
            &query.dir_path,
            query.since.as_deref(),
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn get_recent_changes(
    State(state): State<AppState>,
    Query(query): Query<LimitQuery>,
) -> Result<Json<Vec<RecentChange>>, (StatusCode, String)> {
    state
        .history_service
        .get_recent_changes(Path::new(&query.project_path), query.limit.unwrap_or(50))
        .map(Json)
        .map_err(service_error)
}

pub async fn list_deleted_files(
    State(state): State<AppState>,
    Query(query): Query<ProjectHistoryRequest>,
) -> Result<Json<Vec<FileVersion>>, (StatusCode, String)> {
    state
        .history_service
        .list_deleted_files(Path::new(&query.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn compress_history(
    State(state): State<AppState>,
    Json(req): Json<ProjectHistoryRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    state
        .history_service
        .compress_blobs(Path::new(&req.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn get_current_branch(
    State(state): State<AppState>,
    Query(query): Query<ProjectHistoryRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    state
        .history_service
        .get_current_branch(Path::new(&query.project_path))
        .map(Json)
        .map_err(service_error)
}

pub async fn get_file_branches(
    State(state): State<AppState>,
    Query(query): Query<FileVersionQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    state
        .history_service
        .get_file_branches(Path::new(&query.project_path), &query.file_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_file_versions_by_branch(
    State(state): State<AppState>,
    Query(query): Query<BranchVersionsQuery>,
) -> Result<Json<Vec<FileVersion>>, (StatusCode, String)> {
    state
        .history_service
        .list_versions_by_branch(
            Path::new(&query.project_path),
            &query.file_path,
            &query.branch,
        )
        .map(Json)
        .map_err(service_error)
}

pub async fn list_worktree_recent_changes(
    State(state): State<AppState>,
    Query(query): Query<LimitQuery>,
) -> Result<Json<Vec<WorktreeRecentChange>>, (StatusCode, String)> {
    state
        .history_service
        .list_worktree_recent_changes(Path::new(&query.project_path), query.limit.unwrap_or(50))
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
#[path = "local_history_tests.rs"]
mod local_history_tests;
