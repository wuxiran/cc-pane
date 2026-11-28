//! 「导出到手机」桌面命令（docs/112 §6）：候选列表、生成 / 取消导出码、状态。
//! 兑换只在 orchestrator `/provider-export/redeem`（经 cc-panes-web 设备令牌转发）。
use std::sync::Arc;

use cc_panes_core::services::{ExportCandidate, ExportStatus, ExportTicket, ProviderExportService};
use tauri::State;

use crate::utils::{AppError, AppResult};

type Export<'a> = State<'a, Arc<ProviderExportService>>;

#[tauri::command]
pub async fn provider_export_candidates(export: Export<'_>) -> AppResult<Vec<ExportCandidate>> {
    let export = export.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export.candidates())
        .await
        .map_err(|e| AppError::from(e.to_string()))
}

#[tauri::command]
pub async fn provider_export_start(
    export: Export<'_>,
    provider_ids: Vec<String>,
) -> AppResult<ExportTicket> {
    let export = export.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export.start(provider_ids))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .map_err(AppError::from)
}

#[tauri::command]
pub fn provider_export_cancel(export: Export<'_>) -> AppResult<()> {
    export.cancel();
    Ok(())
}

#[tauri::command]
pub fn provider_export_status(export: Export<'_>) -> AppResult<ExportStatus> {
    Ok(export.status())
}
