use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use cc_cli_adapters::CliToolInfo;
use cc_panes_core::{services::ProjectCliHookGroupStatus, utils::validate_path};
use serde::Deserialize;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathQuery {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectCliHookRequest {
    pub project_path: String,
    pub cli_tool: String,
    pub hook_name: String,
    pub enabled: bool,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn get_app_cwd(State(state): State<AppState>) -> Json<String> {
    Json(state.default_cwd.clone())
}

pub async fn list_cli_tools(
    State(state): State<AppState>,
) -> Result<Json<Vec<CliToolInfo>>, (StatusCode, String)> {
    let registry = state.cli_registry.clone();
    tokio::task::spawn_blocking(move || registry.detect_all())
        .await
        .map(Json)
        .map_err(service_error)
}

/// docs/110 批 0：与 Tauri `get_cli_injection_profiles` 同源。
pub async fn get_cli_injection_profiles(
    State(state): State<AppState>,
) -> Json<std::collections::BTreeMap<String, cc_cli_adapters::InjectionProfile>> {
    Json(state.cli_registry.injection_profiles())
}

pub async fn get_project_cli_hooks(
    State(state): State<AppState>,
    Query(query): Query<ProjectPathQuery>,
) -> Result<Json<Vec<ProjectCliHookGroupStatus>>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .project_cli_hooks_service
        .list_project_cli_hooks(&query.project_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn set_project_cli_hook_enabled(
    State(state): State<AppState>,
    Json(req): Json<SetProjectCliHookRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    state
        .project_cli_hooks_service
        .set_project_cli_hook_enabled(
            &req.project_path,
            &req.cli_tool,
            &req.hook_name,
            req.enabled,
        )
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "system_tests.rs"]
mod system_tests;
