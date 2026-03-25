use crate::models::process_info::{ProcessScanResult, ResourceStats};
use crate::services::ProcessMonitorService;
use crate::utils::{error::AppError, AppResult};
use std::sync::Arc;
use tauri::State;

/// 扫描系统中所有 Claude 相关进程（async + spawn_blocking 防止阻塞主线程）
#[tauri::command]
pub async fn scan_claude_processes(
    service: State<'_, Arc<ProcessMonitorService>>,
) -> AppResult<ProcessScanResult> {
    let svc = service.inner().clone();
    let handle = tauri::async_runtime::spawn_blocking(move || svc.scan_claude_processes());
    match tokio::time::timeout(std::time::Duration::from_secs(10), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(AppError::from(e.to_string())),
        Err(_) => Err(AppError::from("进程扫描超时（10s）")),
    }
}

/// 终止单个 Claude 相关进程
#[tauri::command]
pub async fn kill_claude_process(
    pid: u32,
    service: State<'_, Arc<ProcessMonitorService>>,
) -> AppResult<bool> {
    let svc = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || svc.kill_process(pid))
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    result
}

/// 批量终止 Claude 相关进程
#[tauri::command]
pub async fn kill_claude_processes(
    pids: Vec<u32>,
    service: State<'_, Arc<ProcessMonitorService>>,
) -> AppResult<Vec<(u32, bool)>> {
    let svc = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || svc.kill_processes(pids))
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    result
}

/// 获取资源统计（一次性查询，供初始化或手动刷新）
#[tauri::command]
pub async fn get_resource_stats(
    service: State<'_, Arc<ProcessMonitorService>>,
) -> AppResult<ResourceStats> {
    let svc = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || svc.refresh_resource_stats())
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    result
}
