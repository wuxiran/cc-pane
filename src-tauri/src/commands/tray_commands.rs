//! 托盘相关 Tauri 命令。
//!
//! - `confirm_tray_quit`：前端确认退出对话框确认后调用，真正退出进程。
//! - `tray_set_language`：前端启动时推送界面语言；settings.general.language 为空时兜底
//!   （优先读 settings，见 TrayMenuController::effective_lang）。

use crate::services::tray_menu::TrayMenuController;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// 前端确认退出（托盘 confirm-quit 流程的确认分支）。
#[tauri::command]
pub fn confirm_tray_quit(app: AppHandle) {
    app.exit(0);
}

/// 推送托盘菜单语言。空串清除 override。
#[tauri::command]
pub fn tray_set_language(controller: State<'_, Arc<TrayMenuController>>, language: String) {
    let language = if language.trim().is_empty() {
        None
    } else {
        Some(language)
    };
    controller.inner().clone().set_language_override(language);
}
