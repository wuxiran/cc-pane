use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use cc_panes_core::{
    models::shared_mcp::{SharedMcpConfig, SharedMcpServerConfig, SharedMcpServerInfo},
    services::mcp_config_service::{McpLayer, McpServerConfig},
    utils::{validate_command, validate_mcp_name, validate_path},
};
use serde::Deserialize;

use crate::state::AppState;

/// Layer selector shared by the project/workspace MCP routes (docs/98):
/// `workspaceName` → workspace layer, else `projectPath` → project overlay.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpQuery {
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertMcpServerRequest {
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMcpServerQuery {
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMcpQuery {
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLegacyMcpRequest {
    pub project_path: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

fn resolve_layer(
    workspace_name: Option<&str>,
    project_path: Option<&str>,
) -> Result<McpLayer, (StatusCode, String)> {
    if let Some(path) = project_path.map(str::trim).filter(|p| !p.is_empty()) {
        validate_path(path).map_err(service_error)?;
    }
    McpLayer::resolve(workspace_name, project_path).map_err(service_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServerRequest {
    pub name: String,
    pub config: SharedMcpServerConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedGlobalConfigRequest {
    pub port_range_start: u16,
    pub port_range_end: u16,
    pub health_check_interval_secs: u64,
    pub max_restarts: u32,
}

fn service_error(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub async fn list_mcp_servers(
    State(state): State<AppState>,
    Query(query): Query<ProjectMcpQuery>,
) -> Result<Json<BTreeMap<String, McpServerConfig>>, (StatusCode, String)> {
    let layer = resolve_layer(
        query.workspace_name.as_deref(),
        query.project_path.as_deref(),
    )?;
    state
        .mcp_config_service
        .list(&layer)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(query): Query<ProjectMcpQuery>,
) -> Result<Json<Option<McpServerConfig>>, (StatusCode, String)> {
    let layer = resolve_layer(
        query.workspace_name.as_deref(),
        query.project_path.as_deref(),
    )?;
    state
        .mcp_config_service
        .get(&layer, &name)
        .map(Json)
        .map_err(service_error)
}

pub async fn upsert_mcp_server(
    State(state): State<AppState>,
    Json(req): Json<UpsertMcpServerRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let layer = resolve_layer(req.workspace_name.as_deref(), req.project_path.as_deref())?;
    validate_mcp_name(&req.name).map_err(service_error)?;
    validate_command(&req.command).map_err(service_error)?;
    let extra = state
        .mcp_config_service
        .get(&layer, &req.name)
        .map_err(service_error)?
        .map(|existing| existing.extra)
        .unwrap_or_default();
    let config = McpServerConfig {
        command: req.command,
        args: req.args,
        env: req.env,
        extra,
    };
    state
        .mcp_config_service
        .upsert(&layer, &req.name, config)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_mcp_server(
    State(state): State<AppState>,
    Query(query): Query<RemoveMcpServerQuery>,
) -> Result<Json<bool>, (StatusCode, String)> {
    let layer = resolve_layer(
        query.workspace_name.as_deref(),
        query.project_path.as_deref(),
    )?;
    state
        .mcp_config_service
        .remove(&layer, &query.name)
        .map(Json)
        .map_err(service_error)
}

pub async fn list_legacy_mcp_servers(
    State(state): State<AppState>,
    Query(query): Query<LegacyMcpQuery>,
) -> Result<Json<BTreeMap<String, McpServerConfig>>, (StatusCode, String)> {
    validate_path(&query.project_path).map_err(service_error)?;
    state
        .mcp_config_service
        .list_legacy_project_servers(&query.project_path)
        .map(Json)
        .map_err(service_error)
}

pub async fn import_legacy_mcp_servers(
    State(state): State<AppState>,
    Json(req): Json<ImportLegacyMcpRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    validate_path(&req.project_path).map_err(service_error)?;
    let into = McpLayer::resolve(
        req.workspace_name.as_deref(),
        Some(req.project_path.as_str()),
    )
    .map_err(service_error)?;
    state
        .mcp_config_service
        .import_legacy_project_servers(&req.project_path, &into, req.overwrite)
        .map(Json)
        .map_err(service_error)
}

pub async fn get_shared_mcp_config(State(state): State<AppState>) -> Json<SharedMcpConfig> {
    Json(state.shared_mcp_service.get_config())
}

pub async fn get_shared_mcp_status(
    State(state): State<AppState>,
) -> Json<Vec<SharedMcpServerInfo>> {
    Json(state.shared_mcp_service.get_all_status())
}

pub async fn upsert_shared_mcp_server(
    State(state): State<AppState>,
    Json(req): Json<SharedServerRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_mcp_name(&req.name).map_err(service_error)?;
    validate_command(&req.config.command).map_err(service_error)?;
    state
        .shared_mcp_service
        .upsert_server(&req.name, req.config)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_shared_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .shared_mcp_service
        .remove_server(&name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn start_shared_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .shared_mcp_service
        .start_server(&name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn stop_shared_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> StatusCode {
    state.shared_mcp_service.stop_server(&name);
    StatusCode::NO_CONTENT
}

pub async fn restart_shared_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .shared_mcp_service
        .restart_server(&name)
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_shared_mcp_global_config(
    State(state): State<AppState>,
    Json(req): Json<SharedGlobalConfigRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .shared_mcp_service
        .update_global_config(
            req.port_range_start,
            req.port_range_end,
            req.health_check_interval_secs,
            req.max_restarts,
        )
        .map_err(service_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn import_shared_mcp_from_claude(
    State(state): State<AppState>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    state
        .shared_mcp_service
        .import_from_claude_json()
        .map(Json)
        .map_err(service_error)
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod mcp_tests;
