//! 内置组件 · 微信 的设置入口（见 services::wechat_component）。
use crate::services::wechat_component::{self, WechatComponentStatus, WechatRemote};
use crate::utils::AppResult;
use cc_panes_core::services::SharedMcpService;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub fn wechat_component_status(
    app: tauri::AppHandle,
    service: State<'_, Arc<SharedMcpService>>,
) -> WechatComponentStatus {
    wechat_component::status(&service, resource_dir(&app).as_deref())
}

#[tauri::command]
pub fn wechat_component_enable_local(
    app: tauri::AppHandle,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<WechatComponentStatus> {
    let resources = resource_dir(&app);
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Cannot resolve log directory: {e}"))?;
    let _ = std::fs::create_dir_all(&log_dir);
    wechat_component::enable_local(
        &service,
        resources.as_deref(),
        &log_dir.join("wechat-mcp.log"),
    )?;
    Ok(wechat_component::status(&service, resources.as_deref()))
}

#[tauri::command]
pub fn wechat_component_enable_remote(
    app: tauri::AppHandle,
    service: State<'_, Arc<SharedMcpService>>,
    remote: WechatRemote,
) -> AppResult<WechatComponentStatus> {
    wechat_component::enable_remote(&service, remote)?;
    Ok(wechat_component::status(
        &service,
        resource_dir(&app).as_deref(),
    ))
}

#[tauri::command]
pub fn wechat_component_disable(
    app: tauri::AppHandle,
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<WechatComponentStatus> {
    wechat_component::disable(&service)?;
    Ok(wechat_component::status(
        &service,
        resource_dir(&app).as_deref(),
    ))
}

/// 走一遍 MCP 调 wechat_status；返回组件自己的 JSON（ok / running / pid / error …）。
#[tauri::command]
pub async fn wechat_component_check(
    service: State<'_, Arc<SharedMcpService>>,
) -> AppResult<serde_json::Value> {
    let service = service.inner().clone();
    wechat_component::check(&service).await.map_err(Into::into)
}
