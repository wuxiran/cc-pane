//! 首页 Agent 新版本检测：先跑一遍 CLI 检测拿到已装工具的路径与版本，再并发查最新版本。

use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::services::cli_update_service::{self, CliUpdateInfo, InstalledCli};
use tauri::State;

use crate::utils::error::AppError;
use crate::utils::AppResult;

#[tauri::command]
pub async fn check_cli_updates(
    registry: State<'_, Arc<CliToolRegistry>>,
) -> AppResult<Vec<CliUpdateInfo>> {
    let registry = registry.inner().clone();
    let tools = tauri::async_runtime::spawn_blocking(move || registry.detect_all())
        .await
        .map_err(|e| AppError::from(format!("Detect CLI tools failed: {}", e)))?;
    let installed = tools
        .into_iter()
        .filter(|tool| tool.installed)
        .filter_map(|tool| {
            tool.path.map(|path| InstalledCli {
                id: tool.id,
                path,
                version: tool.version,
            })
        })
        .collect();
    Ok(cli_update_service::check_updates(installed).await)
}
