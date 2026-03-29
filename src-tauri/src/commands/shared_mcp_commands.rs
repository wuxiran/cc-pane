use crate::utils::AppResult;
use cc_panes_core::models::shared_mcp::{
    SharedMcpConfig, SharedMcpServerConfig, SharedMcpServerInfo,
};
use cc_panes_core::services::SharedMcpService;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_shared_mcp_config(
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<SharedMcpConfig> {
    Ok(service.get_config())
}

#[tauri::command]
pub fn get_shared_mcp_status(
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<Vec<SharedMcpServerInfo>> {
    Ok(service.get_all_status())
}

#[tauri::command]
pub fn upsert_shared_mcp_server(
    name: String,
    config: SharedMcpServerConfig,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service.upsert_server(&name, config).map_err(|e| e.into())
}

#[tauri::command]
pub fn remove_shared_mcp_server(
    name: String,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service.remove_server(&name).map_err(|e| e.into())
}

#[tauri::command]
pub fn start_shared_mcp_server(
    name: String,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service.start_server(&name).map_err(|e| e.into())
}

#[tauri::command]
pub fn stop_shared_mcp_server(
    name: String,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service.stop_server(&name);
    Ok(())
}

#[tauri::command]
pub fn restart_shared_mcp_server(
    name: String,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service.restart_server(&name).map_err(|e| e.into())
}

#[tauri::command]
pub fn update_shared_mcp_global_config(
    port_range_start: u16,
    port_range_end: u16,
    health_check_interval_secs: u64,
    max_restarts: u32,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<()> {
    service
        .update_global_config(
            port_range_start,
            port_range_end,
            health_check_interval_secs,
            max_restarts,
        )
        .map_err(|e| e.into())
}

#[tauri::command]
pub fn import_shared_mcp_from_claude(
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<Vec<String>> {
    service.import_from_claude_json().map_err(|e| e.into())
}
