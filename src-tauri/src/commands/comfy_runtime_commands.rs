//! Tauri commands for the managed local ComfyUI engine.

use crate::services::{ComfyRuntimeService, ComfyRuntimeStatus};
use cc_panes_core::utils::{AppPaths, AppResult};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

fn resource_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub fn get_comfy_runtime_status(
    service: State<'_, Arc<ComfyRuntimeService>>,
) -> ComfyRuntimeStatus {
    service.status()
}

#[tauri::command]
pub fn start_comfy_runtime(
    app: AppHandle,
    paths: State<'_, Arc<AppPaths>>,
    service: State<'_, Arc<ComfyRuntimeService>>,
) -> AppResult<ComfyRuntimeStatus> {
    let resource = resource_dir(&app);
    service.start(paths.inner(), resource.as_deref())
}

#[tauri::command]
pub fn stop_comfy_runtime(service: State<'_, Arc<ComfyRuntimeService>>) -> ComfyRuntimeStatus {
    service.stop();
    service.status()
}

#[tauri::command]
pub fn restart_comfy_runtime(
    app: AppHandle,
    paths: State<'_, Arc<AppPaths>>,
    service: State<'_, Arc<ComfyRuntimeService>>,
) -> ComfyRuntimeStatus {
    let resource = resource_dir(&app);
    service.restart(paths.inner(), resource.as_deref())
}
