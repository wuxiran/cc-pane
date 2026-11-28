use crate::ccchan_service::{CCChanService, PetMeta, Rect};
use crate::models::settings::CCChanSettings;
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tracing::debug;

fn service_of(app: &AppHandle) -> AppResult<Arc<CCChanService>> {
    app.try_state::<Arc<CCChanService>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| AppError::from("CCChanService is not registered"))
}

#[tauri::command]
pub async fn show_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::show_ccchan");
    let service = service_of(&app)?;
    service.show_window(&app)?;
    service.set_window_visible(true)
}

/// 宠物窗口前端首帧渲染完成后调用，后端据此执行挂起的 show（首帧透明保护）。
#[tauri::command]
pub fn ccchan_window_ready(
    app: AppHandle,
    service: State<'_, Arc<CCChanService>>,
) -> AppResult<()> {
    debug!("cmd::ccchan_window_ready");
    service.mark_window_ready(&app)
}

/// 隐藏 = 销毁宠物窗口并记住「不显示」；下次从状态栏 / 设置重新打开。
#[tauri::command]
pub async fn hide_ccchan(app: AppHandle) -> AppResult<()> {
    debug!("cmd::hide_ccchan");
    let service = service_of(&app)?;
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

/// 宠物窗口上报可点击区域（窗口内 CSS 像素）；区域外的透明部分点击穿透。
#[tauri::command]
pub fn set_ccchan_hit_regions(
    service: State<'_, Arc<CCChanService>>,
    regions: Vec<Rect>,
) -> AppResult<()> {
    service.set_hit_regions(regions);
    Ok(())
}

#[tauri::command]
pub fn get_ccchan_pets(app: AppHandle) -> AppResult<Vec<PetMeta>> {
    debug!("cmd::get_ccchan_pets");
    service_of(&app)?.get_pets(&app)
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
    let Some(app) = service.app_handle() else {
        return Ok(());
    };
    if settings.window_visible != previous.window_visible {
        if settings.window_visible {
            service.show_window(&app)?;
        } else {
            service.hide_window(&app)?;
        }
    }
    if let Some(window) = app.get_webview_window("ccchan") {
        if settings.pet_size != previous.pet_size {
            service.apply_window_size(&window)?;
        }
        if (settings.window_x, settings.window_y) != (previous.window_x, previous.window_y) {
            service.reposition(&app)?;
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
