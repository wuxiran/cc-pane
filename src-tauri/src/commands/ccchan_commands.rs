use crate::ccchan_service::{clamp_position_to_visible, CCChanService, PetMeta};
use crate::models::settings::CCChanSettings;
use crate::services::TerminalService;
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
use tracing::debug;

#[tauri::command]
pub async fn show_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::show_ccchan");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.show_window(&app)
}

#[tauri::command]
pub async fn hide_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::hide_ccchan");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.hide_window(&app)
}

#[tauri::command]
pub async fn resize_ccchan_for_chat(window: WebviewWindow, expanded: bool) -> AppResult<()> {
    debug!(expanded, "cmd::resize_ccchan_for_chat");
    let (width, height) = if expanded {
        (460.0, 640.0)
    } else {
        (120.0, 120.0)
    };
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn resize_ccchan_for_menu(window: WebviewWindow, expanded: bool) -> AppResult<()> {
    debug!(expanded, "cmd::resize_ccchan_for_menu");
    let (width, height) = if expanded {
        (300.0, 280.0)
    } else {
        (120.0, 120.0)
    };
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn move_ccchan_window(
    window: WebviewWindow,
    x: f64,
    y: f64,
    persist: Option<bool>,
) -> AppResult<()> {
    debug!(x, y, persist, "cmd::move_ccchan_window");
    let (cx, cy) = clamp_position_to_visible(&window, x, y);
    window
        .set_position(LogicalPosition::new(cx, cy))
        .map_err(|error| AppError::from(error.to_string()))?;
    if persist.unwrap_or(true) {
        if let Some(service) = window.app_handle().try_state::<Arc<CCChanService>>() {
            service.save_window_position(cx, cy)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_ccchan_chat(
    app: AppHandle,
    terminal_service: State<'_, Arc<TerminalService>>,
    ai_engine: String,
) -> AppResult<String> {
    debug!(ai_engine = %ai_engine, "cmd::start_ccchan_chat");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?
        .inner()
        .clone();
    let terminal_service = terminal_service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.start_chat(terminal_service, ai_engine)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?;
    result
}

#[tauri::command]
pub async fn send_to_ccchan(
    service: State<'_, Arc<CCChanService>>,
    terminal_service: State<'_, Arc<TerminalService>>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::send_to_ccchan");
    let service = service.inner().clone();
    let terminal_service = terminal_service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.send_to_chat(terminal_service, &session_id, &text)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn stop_ccchan_chat(
    app: AppHandle,
    terminal_service: State<'_, Arc<TerminalService>>,
    session_id: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::stop_ccchan_chat");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?
        .inner()
        .clone();
    let terminal_service = terminal_service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.stop_chat(terminal_service, &session_id)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?;
    result
}

#[tauri::command]
pub fn get_ccchan_pets(app: AppHandle) -> AppResult<Vec<PetMeta>> {
    debug!("cmd::get_ccchan_pets");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.get_pets(&app)
}

#[tauri::command]
pub fn get_ccchan_settings(service: State<'_, Arc<CCChanService>>) -> AppResult<CCChanSettings> {
    debug!("cmd::get_ccchan_settings");
    Ok(service.settings())
}

#[tauri::command]
pub fn save_ccchan_settings(
    service: State<'_, Arc<CCChanService>>,
    settings: CCChanSettings,
) -> AppResult<()> {
    debug!("cmd::save_ccchan_settings");
    service.save_settings(settings)
}
