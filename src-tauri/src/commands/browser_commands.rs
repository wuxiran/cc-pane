use crate::services::{
    BrowserBounds, BrowserDomSnapshot, BrowserHostState, BrowserOpenTabEvent, BrowserTabInfo,
    BrowserTabManager, BrowserViewportRequest, BrowserViewportResult, BrowserWindowMode,
    ScreenshotService,
};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
    visible: bool,
) -> AppResult<()> {
    manager.create_for_host(&app, window.label(), &tab_id, &url, bounds, visible)
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    bounds: BrowserBounds,
) -> AppResult<()> {
    manager.set_bounds_for_host(&app, window.label(), &tab_id, bounds)
}

#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    visible: bool,
    focus: bool,
) -> AppResult<()> {
    manager.set_visible_for_host(&app, window.label(), &tab_id, visible, focus)
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

#[tauri::command]
pub fn browser_list_tabs(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
) -> AppResult<Vec<BrowserTabInfo>> {
    manager.list_tabs(&app)
}

#[tauri::command]
pub async fn browser_snapshot(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<BrowserDomSnapshot> {
    manager.snapshot(&app, &tab_id).await
}

#[tauri::command]
pub async fn browser_screenshot(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<String> {
    manager
        .screenshot(&app, &tab_id, &ScreenshotService::screenshots_dir())
        .await
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn browser_fill(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    page_token: String,
    element_id: u32,
    text: String,
) -> AppResult<()> {
    manager
        .fill(&app, &tab_id, &page_token, element_id, &text)
        .await
}

#[tauri::command]
pub async fn browser_press_key(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    page_token: String,
    key: String,
) -> AppResult<()> {
    manager.press_key(&app, &tab_id, &page_token, &key).await
}

#[tauri::command]
pub async fn browser_scroll(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    page_token: String,
    delta_x: f64,
    delta_y: f64,
) -> AppResult<()> {
    manager
        .scroll(&app, &tab_id, &page_token, delta_x, delta_y)
        .await
}

#[tauri::command]
pub async fn browser_click_element(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    page_token: String,
    element_id: u32,
) -> AppResult<()> {
    manager
        .click_element(&app, &tab_id, &page_token, element_id)
        .await
}

#[tauri::command]
pub fn browser_host_state(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<BrowserHostState> {
    manager.host_state(&app, &tab_id)
}

#[tauri::command]
pub async fn browser_set_viewport(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    bounds: BrowserBounds,
    viewport: Option<BrowserViewportRequest>,
) -> AppResult<BrowserViewportResult> {
    manager
        .set_viewport(&app, window.label(), &tab_id, bounds, viewport)
        .await
}

#[tauri::command]
pub async fn browser_pop_out(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err("Only the main window can detach a browser tab".into());
    }
    manager.inner().pop_out(&app, &tab_id)
}

#[tauri::command]
pub async fn browser_reclaim(
    app: AppHandle,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.reclaim(&app, &tab_id).await
}

#[tauri::command]
pub fn browser_release_host(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
) -> AppResult<()> {
    manager.release_host(&app, window.label(), &tab_id)
}

#[tauri::command]
pub async fn browser_set_window_mode(
    app: AppHandle,
    window: tauri::Window,
    manager: State<'_, Arc<BrowserTabManager>>,
    tab_id: String,
    mode: BrowserWindowMode,
) -> AppResult<BrowserHostState> {
    if window.label() != "main" && !manager.is_host(&tab_id, window.label()) {
        return Err("Only this browser's host window can change its presentation".into());
    }
    manager.inner().set_window_mode(&app, &tab_id, mode)
}
