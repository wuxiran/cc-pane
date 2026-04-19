use crate::models::ScreenshotResult;
use crate::services::{ScreenshotService, SettingsService};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 更新截图快捷键（仅 Windows 生效，macOS 截图功能暂未实现）
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

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &settings_service, &old_shortcut, &new_shortcut);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;

        let new_sc: tauri_plugin_global_shortcut::Shortcut = new_shortcut
            .parse()
            .map_err(|e| format!("Invalid shortcut format: {}", e))?;

        // 先注销旧快捷键（忽略错误，可能已不存在）
        if !old_shortcut.is_empty() {
            if let Ok(old_sc) = old_shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                let _ = app.global_shortcut().unregister(old_sc);
            }
        }

        // 注册新快捷键
        let app_handle = app.clone();
        let settings_service = settings_service.inner().clone();
        app.global_shortcut()
            .on_shortcut(new_sc, move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    crate::trigger_screenshot(&app_handle, settings_service.clone());
                }
            })
            .map_err(|e| format!("Shortcut conflict: {}", e))?;

        Ok(())
    }
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
