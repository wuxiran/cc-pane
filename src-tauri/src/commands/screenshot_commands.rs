use crate::utils::AppResult;
use tracing::debug;

/// 更新截图快捷键（仅 Windows 生效，macOS 截图功能暂未实现）
#[tauri::command]
pub fn screenshot_update_shortcut(
    app: tauri::AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> AppResult<()> {
    debug!("cmd::screenshot_update_shortcut new_shortcut={}", new_shortcut);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&app, &old_shortcut, &new_shortcut);
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
        app.global_shortcut()
            .on_shortcut(new_sc, move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    crate::trigger_screenshot(&app_handle);
                }
            })
            .map_err(|e| format!("Shortcut conflict: {}", e))?;

        Ok(())
    }
}
