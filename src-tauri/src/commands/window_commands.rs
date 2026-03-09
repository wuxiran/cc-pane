use crate::utils::AppResult;
use tauri::{LogicalSize, WebviewWindow};
use tracing::debug;

/// 关闭窗口
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::close_window");
    Ok(window.close()?)
}

/// 最小化窗口
#[tauri::command]
pub fn minimize_window(window: WebviewWindow) -> AppResult<()> {
    Ok(window.minimize()?)
}

/// 最大化/还原窗口
#[tauri::command]
pub fn maximize_window(window: WebviewWindow) -> AppResult<()> {
    let is_maximized = window.is_maximized()?;
    if is_maximized {
        Ok(window.unmaximize()?)
    } else {
        Ok(window.maximize()?)
    }
}

/// 切换窗口置顶状态
#[tauri::command]
pub fn toggle_always_on_top(window: WebviewWindow) -> AppResult<bool> {
    debug!("cmd::toggle_always_on_top");
    let is_on_top = window.is_always_on_top()?;
    window.set_always_on_top(!is_on_top)?;
    Ok(!is_on_top)
}

/// 进入全屏模式
#[tauri::command]
pub fn enter_fullscreen(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::enter_fullscreen");
    Ok(window.set_fullscreen(true)?)
}

/// 退出全屏模式
#[tauri::command]
pub fn exit_fullscreen(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::exit_fullscreen");
    Ok(window.set_fullscreen(false)?)
}

/// 检查是否处于全屏模式
#[tauri::command]
pub fn is_fullscreen(window: WebviewWindow) -> AppResult<bool> {
    Ok(window.is_fullscreen()?)
}

/// 设置窗口边框（标题栏）
#[tauri::command]
pub fn set_decorations(window: WebviewWindow, decorations: bool) -> AppResult<()> {
    debug!("cmd::set_decorations decorations={}", decorations);
    Ok(window.set_decorations(decorations)?)
}

/// 进入迷你模式
#[tauri::command]
pub fn enter_mini_mode(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::enter_mini_mode");
    window.set_size(LogicalSize::new(320.0, 200.0))?;
    window.set_always_on_top(true)?;
    window.set_decorations(false)?;
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
    window.set_always_on_top(false)?;
    window.set_size(LogicalSize::new(width, height))?;
    Ok(())
}

/// 获取应用当前工作目录（tauri dev 时为项目根目录）
#[tauri::command]
pub fn get_app_cwd() -> AppResult<String> {
    Ok(std::env::current_dir()
        .map_err(|e| format!("Failed to get CWD: {}", e))?
        .to_string_lossy()
        .to_string())
}
