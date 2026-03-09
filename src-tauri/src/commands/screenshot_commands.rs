use crate::models::{ScreenshotResult, TempScreenshot};
use crate::services::ScreenshotService;
use crate::utils::AppResult;

/// 由前端 JS mount 后调用，执行截图并直接返回结果（替代旧的 pull 模型）
#[tauri::command]
pub fn screenshot_capture() -> AppResult<TempScreenshot> {
    ScreenshotService::capture_current_monitor()
}

/// 裁剪区域并保存为 PNG（前端传入 temp_file_path，不再从全局 Mutex 取）
#[tauri::command]
pub fn screenshot_crop_and_save(
    temp_file_path: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> AppResult<ScreenshotResult> {
    ScreenshotService::crop_and_save_from_file(
        &temp_file_path,
        x, y, w, h,
    )
}

/// 更新截图快捷键
#[tauri::command]
pub fn screenshot_update_shortcut(
    app: tauri::AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> AppResult<()> {
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
    app.global_shortcut()
        .on_shortcut(new_sc, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                crate::trigger_screenshot(&app_handle);
            }
        })
        .map_err(|e| format!("Shortcut conflict: {}", e))?;

    Ok(())
}
