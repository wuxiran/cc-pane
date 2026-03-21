use crate::utils::{AppPaths, AppResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{LogicalSize, State, WebviewWindow};
use tracing::debug;

/// 弹出窗口数据共享存储：label -> tabData JSON
pub type PopupDataStore = Mutex<HashMap<String, String>>;

/// 关闭窗口
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::close_window");
    Ok(window.close().map_err(|e| e.to_string())?)
}

/// 最小化窗口
#[tauri::command]
pub fn minimize_window(window: WebviewWindow) -> AppResult<()> {
    Ok(window.minimize().map_err(|e| e.to_string())?)
}

/// 最大化/还原窗口
#[tauri::command]
pub fn maximize_window(window: WebviewWindow) -> AppResult<()> {
    let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if is_maximized {
        Ok(window.unmaximize().map_err(|e| e.to_string())?)
    } else {
        Ok(window.maximize().map_err(|e| e.to_string())?)
    }
}

/// 切换窗口置顶状态
#[tauri::command]
pub fn toggle_always_on_top(window: WebviewWindow) -> AppResult<bool> {
    debug!("cmd::toggle_always_on_top");
    let is_on_top = window.is_always_on_top().map_err(|e| e.to_string())?;
    window.set_always_on_top(!is_on_top).map_err(|e| e.to_string())?;
    Ok(!is_on_top)
}

/// 进入全屏模式
#[tauri::command]
pub fn enter_fullscreen(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::enter_fullscreen");
    Ok(window.set_fullscreen(true).map_err(|e| e.to_string())?)
}

/// 退出全屏模式
#[tauri::command]
pub fn exit_fullscreen(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::exit_fullscreen");
    Ok(window.set_fullscreen(false).map_err(|e| e.to_string())?)
}

/// 检查是否处于全屏模式
#[tauri::command]
pub fn is_fullscreen(window: WebviewWindow) -> AppResult<bool> {
    Ok(window.is_fullscreen().map_err(|e| e.to_string())?)
}

/// 设置窗口边框（标题栏）
#[tauri::command]
pub fn set_decorations(window: WebviewWindow, decorations: bool) -> AppResult<()> {
    debug!("cmd::set_decorations decorations={}", decorations);
    Ok(window.set_decorations(decorations).map_err(|e| e.to_string())?)
}

/// 进入迷你模式
#[tauri::command]
pub fn enter_mini_mode(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::enter_mini_mode");
    window.set_size(LogicalSize::new(320.0, 200.0)).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    Ok(())
}

/// 退出迷你模式
#[tauri::command]
pub fn exit_mini_mode(
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> AppResult<()> {
    debug!("cmd::exit_mini_mode");
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 创建弹出终端窗口
/// 使用 async fn 避免在 Windows 上同步创建 WebView2 导致主线程死锁
#[tauri::command]
pub async fn create_popup_terminal_window(
    app: tauri::AppHandle,
    tab_data: String,
    label: String,
    popup_store: State<'_, PopupDataStore>,
) -> AppResult<()> {
    debug!("cmd::create_popup_terminal_window label={}", label);
    // 存入共享 state，弹出窗口启动后通过 get_popup_tab_data 取回
    popup_store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert(label.clone(), tab_data);
    // 简短 URL（不再将 tabData 放入 URL）+ 居中 + 获取焦点
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html?mode=popup".into()),
    )
    .title("Terminal")
    .inner_size(800.0, 500.0)
    .decorations(true)
    .resizable(true)
    .center()
    .focused(true)
    .build()
    .map_err(|e| {
        // 创建失败时清理已存入的数据
        if let Ok(mut s) = popup_store.lock() {
            s.remove(&label);
        }
        format!("Failed to create popup window: {e}")
    })?;
    Ok(())
}

/// 弹出窗口获取 tabData（one-shot：取后删除）
#[tauri::command]
pub fn get_popup_tab_data(
    window: WebviewWindow,
    popup_store: State<'_, PopupDataStore>,
) -> AppResult<Option<String>> {
    let label = window.label().to_string();
    debug!("cmd::get_popup_tab_data label={}", label);
    Ok(popup_store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .remove(&label))
}

/// 获取自我对话工作目录
/// Release: 数据目录（包含提取的 .claude/ skills）
/// Dev: 项目根目录（源码中的 .claude/ 直接可用）
#[tauri::command]
pub fn get_app_cwd(app_paths: State<'_, Arc<AppPaths>>) -> AppResult<String> {
    if cfg!(debug_assertions) {
        // Dev 模式：使用项目根目录（CWD）
        Ok(std::env::current_dir()
            .map_err(|e| format!("Failed to get CWD: {}", e))?
            .to_string_lossy()
            .to_string())
    } else {
        // Release 模式：使用数据目录（含提取的 .claude/）
        Ok(app_paths.data_dir().to_string_lossy().to_string())
    }
}
