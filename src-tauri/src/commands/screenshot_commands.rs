use crate::models::ScreenshotResult;
use crate::services::{ScreenshotService, SettingsService};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

static IMAGE_ATTACHMENT_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[tauri::command]
pub async fn screenshot_save_image_attachment(
    data_base64: String,
    settings_service: State<'_, Arc<SettingsService>>,
) -> AppResult<ScreenshotResult> {
    let retention_days = settings_service.get_settings().screenshot.retention_days;
    let permit = IMAGE_ATTACHMENT_SLOTS
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        ScreenshotService::save_image_attachment(&data_base64, retention_days)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 更新截图快捷键（Windows / macOS 原生选区）
#[tauri::command]
pub fn screenshot_update_shortcut(
    app: tauri::AppHandle,
    settings_service: State<'_, Arc<SettingsService>>,
    old_shortcut: String,
    new_shortcut: String,
) -> AppResult<()> {
    debug!(
        "cmd::screenshot_update_shortcut new_shortcut={}",
        new_shortcut
    );

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (&app, &settings_service, &old_shortcut, &new_shortcut);
        Ok(())
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;

        let new_sc: tauri_plugin_global_shortcut::Shortcut = new_shortcut
            .parse()
            .map_err(|e| format!("Invalid shortcut format: {}", e))?;

        let old_sc = old_shortcut
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .ok();
        if old_sc == Some(new_sc) && app.global_shortcut().is_registered(new_sc) {
            return Ok(());
        }

        // Keep the working shortcut when a new binding conflicts.
        // Only retire the old binding after the new registration succeeds.
        let app_handle = app.clone();
        let settings_service = settings_service.inner().clone();
        app.global_shortcut()
            .on_shortcut(new_sc, move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    crate::trigger_screenshot(&app_handle, settings_service.clone());
                }
            })
            .map_err(|e| format!("Shortcut conflict: {}", e))?;

        retire_previous_shortcut(&app, old_sc, new_sc)
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn retire_previous_shortcut(
    app: &tauri::AppHandle,
    old: Option<tauri_plugin_global_shortcut::Shortcut>,
    new: tauri_plugin_global_shortcut::Shortcut,
) -> AppResult<()> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Some(old) = old.filter(|old| *old != new) {
        if app.global_shortcut().is_registered(old) {
            if let Err(error) = app.global_shortcut().unregister(old) {
                let rollback = app.global_shortcut().unregister(new);
                return Err(format!(
                    "Failed to remove previous screenshot shortcut: {error}; rollback: {rollback:?}"
                )
                .into());
            }
        }
    }
    Ok(())
}

/// 从应用内（命令面板/菜单）触发截图：与全局热键同一条 trigger_screenshot 路径。
/// 此前截图是纯热键功能，无任何 UI 入口（批 6 可发现性）。
#[tauri::command]
pub fn screenshot_trigger(
    app: tauri::AppHandle,
    settings_service: State<'_, Arc<SettingsService>>,
) {
    crate::trigger_screenshot(&app, settings_service.inner().clone());
}

#[tauri::command]
pub async fn screenshot_save_clipboard_image(
    app: tauri::AppHandle,
    settings_service: State<'_, Arc<SettingsService>>,
) -> AppResult<Option<ScreenshotResult>> {
    let retention_days = settings_service.get_settings().screenshot.retention_days;
    let app_handle = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        match app_handle.clipboard().read_image() {
            Ok(image) => {
                ScreenshotService::save_terminal_paste_image(&image, retention_days).map(Some)
            }
            Err(err) => {
                debug!(
                    "cmd::screenshot_save_clipboard_image clipboard image unavailable: {}",
                    err
                );
                Ok(None)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}
