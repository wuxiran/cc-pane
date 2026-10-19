use crate::ccchan_service::{CCChanService, CCChanWindowMode, PetMeta};
use crate::models::settings::CCChanSettings;
use crate::services::TerminalService;
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tracing::debug;

#[tauri::command]
pub async fn show_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::show_ccchan");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.show_window(&app)?;
    service.set_window_visible(true)
}

#[tauri::command]
pub async fn hide_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::hide_ccchan");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.hide_window(&app)?;
    service.set_window_visible(false)
}

#[tauri::command]
pub fn focus_ccchan_main(app: AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::from("Main window is unavailable"))?;
    window.show().map_err(|e| AppError::from(e.to_string()))?;
    window
        .unminimize()
        .map_err(|e| AppError::from(e.to_string()))?;
    window
        .set_focus()
        .map_err(|e| AppError::from(e.to_string()))
}

fn resize_ccchan_window(window: &WebviewWindow, mode: CCChanWindowMode) -> AppResult<()> {
    let service = window
        .app_handle()
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.resize_window(window, mode).map(|_| ())
}

#[tauri::command]
pub async fn set_ccchan_window_mode(
    window: WebviewWindow,
    mode: CCChanWindowMode,
) -> AppResult<crate::ccchan_service::WindowSize> {
    let service = window
        .app_handle()
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.resize_window(&window, mode)
}

#[tauri::command]
pub async fn resize_ccchan_for_chat(window: WebviewWindow, expanded: bool) -> AppResult<()> {
    debug!(expanded, "cmd::resize_ccchan_for_chat");
    let mode = if expanded {
        CCChanWindowMode::Chat
    } else {
        CCChanWindowMode::Collapsed
    };
    resize_ccchan_window(&window, mode)
}

#[tauri::command]
pub async fn resize_ccchan_for_menu(window: WebviewWindow, expanded: bool) -> AppResult<()> {
    debug!(expanded, "cmd::resize_ccchan_for_menu");
    let mode = if expanded {
        CCChanWindowMode::Menu
    } else {
        CCChanWindowMode::Collapsed
    };
    resize_ccchan_window(&window, mode)
}

#[tauri::command]
pub async fn resize_ccchan_for_bubble(window: WebviewWindow, expanded: bool) -> AppResult<()> {
    debug!(expanded, "cmd::resize_ccchan_for_bubble");
    let mode = if expanded {
        CCChanWindowMode::Bubble
    } else {
        CCChanWindowMode::Collapsed
    };
    resize_ccchan_window(&window, mode)
}

#[tauri::command]
pub async fn move_ccchan_window(
    window: WebviewWindow,
    x: f64,
    y: f64,
    persist: Option<bool>,
) -> AppResult<()> {
    debug!(x, y, persist, "cmd::move_ccchan_window");
    let service = window
        .app_handle()
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?;
    service.move_window(&window, x, y, persist.unwrap_or(true))
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
pub fn is_ccchan_chat_session_alive(
    app: AppHandle,
    terminal_service: State<'_, Arc<TerminalService>>,
    session_id: String,
) -> AppResult<bool> {
    debug!(session_id = %session_id, "cmd::is_ccchan_chat_session_alive");
    let service = app
        .try_state::<Arc<CCChanService>>()
        .ok_or_else(|| AppError::from("CCChanService is not registered"))?
        .inner()
        .clone();
    service.is_chat_session_alive(terminal_service.inner().clone(), &session_id)
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
pub async fn save_ccchan_settings(
    service: State<'_, Arc<CCChanService>>,
    settings: CCChanSettings,
) -> AppResult<()> {
    debug!("cmd::save_ccchan_settings");
    let previous = service.settings();
    service.save_settings(settings.clone())?;
    if let Some(app) = service.app_handle() {
        if settings.window_visible != previous.window_visible {
            if settings.window_visible {
                service.show_window(&app)?;
            } else {
                service.hide_window(&app)?;
            }
        }
        if (settings.window_x, settings.window_y) != (previous.window_x, previous.window_y) {
            if let Some(window) = app.get_webview_window("ccchan") {
                service.move_window(
                    &window,
                    settings.window_x.unwrap_or(80.0),
                    settings.window_y.unwrap_or(80.0),
                    true,
                )?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_ccchan_pets_dir(service: State<'_, Arc<CCChanService>>) -> AppResult<String> {
    debug!("cmd::get_ccchan_pets_dir");
    Ok(service.user_pets_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_ccchan_pets_dir(
    app: AppHandle,
    service: State<'_, Arc<CCChanService>>,
) -> AppResult<()> {
    debug!("cmd::open_ccchan_pets_dir");
    use tauri_plugin_opener::OpenerExt;
    let dir = service.ensure_user_pets_dir_scaffold()?;
    app.opener()
        .open_path(dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn take_ccchan_say(
    service: State<'_, Arc<CCChanService>>,
) -> Option<crate::ccchan_service::CCChanSay> {
    service.take_say()
}
