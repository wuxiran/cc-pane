use crate::services::mcp_config_service::McpServerConfig;
use crate::services::McpConfigService;
use crate::utils::{validate_command, validate_mcp_name, validate_path, AppResult};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_mcp_servers(
    project_path: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<HashMap<String, McpServerConfig>> {
    validate_path(&project_path)?;
    Ok(service.list_mcp_servers(&project_path)?)
}

#[tauri::command]
pub fn get_mcp_server(
    project_path: String,
    name: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<Option<McpServerConfig>> {
    validate_path(&project_path)?;
    Ok(service.get_mcp_server(&project_path, &name)?)
}

#[tauri::command]
pub fn upsert_mcp_server(
    project_path: String,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<()> {
    debug!("cmd::upsert_mcp_server name={}", name);
    validate_path(&project_path)?;
    validate_mcp_name(&name)?;
    validate_command(&command)?;
    let config = McpServerConfig { command, args, env };
    Ok(service.upsert_mcp_server(&project_path, &name, config)?)
}

#[tauri::command]
pub fn remove_mcp_server(
    project_path: String,
    name: String,
    service: State<'_, Arc<McpConfigService>>,
) -> AppResult<bool> {
    debug!("cmd::remove_mcp_server name={}", name);
    validate_path(&project_path)?;
    Ok(service.remove_mcp_server(&project_path, &name)?)
}
