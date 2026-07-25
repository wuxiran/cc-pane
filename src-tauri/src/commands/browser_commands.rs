use crate::services::{BrowserBounds, BrowserOpenTabEvent, BrowserTabManager};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
    visible: bool,
) -> AppResult<()> {
    manager.create(&app, &tab_id, &url, bounds, visible)
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    bounds: BrowserBounds,
) -> AppResult<()> {
    manager.set_bounds(&app, &tab_id, bounds)
}

#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    visible: bool,
    focus: bool,
) -> AppResult<()> {
    manager.set_visible(&app, &tab_id, visible, focus)
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    url: String,
) -> AppResult<()> {
    manager.navigate(&app, &tab_id, &url)
}

#[tauri::command]
pub fn browser_back(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.eval(&app, &tab_id, "history.back()")
}

#[tauri::command]
pub fn browser_forward(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.eval(&app, &tab_id, "history.forward()")
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.reload(&app, &tab_id)
}

#[tauri::command]
pub fn browser_open_devtools(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.open_devtools(&app, &tab_id)
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.close(&app, &tab_id)
}

#[tauri::command]
pub fn open_browser_tab(app: AppHandle, url: String) -> AppResult<BrowserOpenTabEvent> {
    let event = BrowserOpenTabEvent::try_new(&url, None)?;
    app.emit_to("main", "orchestrator-open-browser-tab", &event)
        .map_err(|error| format!("failed to emit browser tab event: {error}"))?;
    Ok(event)
}
