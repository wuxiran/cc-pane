//! Layered MCP config commands (docs/98 workspace-first). Every command takes a layer selector:
//! `workspaceName` → `~/.cc-panes/workspaces/<name>/mcp.json`, else `projectPath` →
//! `<repo>/.ccpanes/mcp.json`. The legacy `.claude/settings.local.json` is read-only.
use crate::services::mcp_config_service::{McpLayer, McpServerConfig};
use crate::services::McpConfigService;
use crate::utils::{validate_command, validate_mcp_name, validate_path, AppError, AppResult};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

fn resolve_layer(workspace_name: Option<&str>, project_path: Option<&str>) -> AppResult<McpLayer> {
    if let Some(path) = project_path.map(str::trim).filter(|p| !p.is_empty()) {
        validate_path(path)?;
    }
    McpLayer::resolve(workspace_name, project_path).map_err(AppError::from)
}

#[tauri::command]
pub fn list_mcp_servers(
    project_path: Option<String>,
    workspace_name: Option<String>,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<BTreeMap<String, McpServerConfig>> {
    let layer = resolve_layer(workspace_name.as_deref(), project_path.as_deref())?;
    Ok(service.list(&layer)?)
}

#[tauri::command]
pub fn get_mcp_server(
    project_path: Option<String>,
    workspace_name: Option<String>,
    name: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<Option<McpServerConfig>> {
    let layer = resolve_layer(workspace_name.as_deref(), project_path.as_deref())?;
    Ok(service.get(&layer, &name)?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn upsert_mcp_server(
    project_path: Option<String>,
    workspace_name: Option<String>,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<()> {
    debug!("cmd::upsert_mcp_server name={}", name);
    let layer = resolve_layer(workspace_name.as_deref(), project_path.as_deref())?;
    validate_mcp_name(&name)?;
    validate_command(&command)?;
    // Keep fields the UI does not edit (type/url/headers) when editing an existing entry.
    let extra = service
        .get(&layer, &name)?
        .map(|existing| existing.extra)
        .unwrap_or_default();
    let config = McpServerConfig {
        command,
        args,
        env,
        extra,
    };
    Ok(service.upsert(&layer, &name, config)?)
}

#[tauri::command]
pub fn remove_mcp_server(
    project_path: Option<String>,
    workspace_name: Option<String>,
    name: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<bool> {
    debug!("cmd::remove_mcp_server name={}", name);
    let layer = resolve_layer(workspace_name.as_deref(), project_path.as_deref())?;
    Ok(service.remove(&layer, &name)?)
}

/// Servers still sitting in the pre-0.12.10 `<repo>/.claude/settings.local.json`.
#[tauri::command]
pub fn list_legacy_mcp_servers(
    project_path: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<BTreeMap<String, McpServerConfig>> {
    validate_path(&project_path)?;
    Ok(service.list_legacy_project_servers(&project_path)?)
}

/// Copy legacy project servers into the workspace layer (`workspaceName`) or, when absent,
/// the project overlay. The legacy file is not modified. Returns the imported names.
#[tauri::command]
pub fn import_legacy_mcp_servers(
    project_path: String,
    workspace_name: Option<String>,
    overwrite: Option<bool>,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<Vec<String>> {
    validate_path(&project_path)?;
    let into = McpLayer::resolve(workspace_name.as_deref(), Some(project_path.as_str()))
        .map_err(AppError::from)?;
    Ok(service.import_legacy_project_servers(&project_path, &into, overwrite.unwrap_or(false))?)
}
