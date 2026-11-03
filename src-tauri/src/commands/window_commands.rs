use crate::models::settings::LayoutSwitcherSettings;
use crate::services::SettingsService;
use crate::utils::{AppError, AppPaths, AppResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};
use tracing::debug;

/// 弹出窗口数据共享存储：label -> tabData JSON
pub type PopupDataStore = Mutex<HashMap<String, String>>;
pub type LayoutSwitcherSnapshotStore = Mutex<Option<String>>;

const LAYOUT_SWITCHER_WINDOW_LABEL: &str = "layout-switcher";
const LAYOUT_SWITCHER_WIDTH: f64 = 280.0;
const LAYOUT_SWITCHER_HEIGHT: f64 = 420.0;

/// 主窗口是原生 `Window` + 子 webview 结构（浏览器标签依赖子 webview），
/// 不能按 `WebviewWindow` 命令参数注入解析——主窗口命令必须经此按 label 取原生
/// `Window`。调用方自身的窗口操作（如 layout-switcher 关自己）才用 `WebviewWindow` 参数。
fn main_window(app: &AppHandle) -> AppResult<Window> {
    app.get_window("main")
        .ok_or_else(|| AppError::from("main window is unavailable"))
}

/// 关闭窗口
#[tauri::command]
pub fn close_window(app: AppHandle) -> AppResult<()> {
    debug!("cmd::close_window");
    let window = main_window(&app)?;
    Ok(window.close().map_err(|e| e.to_string())?)
}

/// 最小化窗口
#[tauri::command]
pub fn minimize_window(app: AppHandle) -> AppResult<()> {
    let window = main_window(&app)?;
    Ok(window.minimize().map_err(|e| e.to_string())?)
}

/// 最大化/还原窗口
#[tauri::command]
pub fn maximize_window(app: AppHandle) -> AppResult<()> {
    let window = main_window(&app)?;
    let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if is_maximized {
        Ok(window.unmaximize().map_err(|e| e.to_string())?)
    } else {
        Ok(window.maximize().map_err(|e| e.to_string())?)
    }
}

/// 切换窗口置顶状态
#[tauri::command]
pub fn toggle_always_on_top(app: AppHandle) -> AppResult<bool> {
    debug!("cmd::toggle_always_on_top");
    let window = main_window(&app)?;
    let is_on_top = window.is_always_on_top().map_err(|e| e.to_string())?;
    window
        .set_always_on_top(!is_on_top)
        .map_err(|e| e.to_string())?;
    Ok(!is_on_top)
}

/// 进入全屏模式
#[tauri::command]
pub fn enter_fullscreen(app: AppHandle) -> AppResult<()> {
    debug!("cmd::enter_fullscreen");
    let window = main_window(&app)?;
    Ok(window.set_fullscreen(true).map_err(|e| e.to_string())?)
}

/// 退出全屏模式
#[tauri::command]
pub fn exit_fullscreen(app: AppHandle) -> AppResult<()> {
    debug!("cmd::exit_fullscreen");
    let window = main_window(&app)?;
    Ok(window.set_fullscreen(false).map_err(|e| e.to_string())?)
}

/// 检查是否处于全屏模式
#[tauri::command]
pub fn is_fullscreen(app: AppHandle) -> AppResult<bool> {
    let window = main_window(&app)?;
    Ok(window.is_fullscreen().map_err(|e| e.to_string())?)
}

/// 设置窗口边框（标题栏）
#[tauri::command]
pub fn set_decorations(app: AppHandle, decorations: bool) -> AppResult<()> {
    debug!("cmd::set_decorations decorations={}", decorations);
    let window = main_window(&app)?;
    Ok(window
        .set_decorations(decorations)
        .map_err(|e| e.to_string())?)
}

/// 进入迷你模式
#[tauri::command]
pub fn enter_mini_mode(app: AppHandle) -> AppResult<()> {
    debug!("cmd::enter_mini_mode");
    let window = main_window(&app)?;
    window
        .set_size(LogicalSize::new(320.0, 200.0))
        .map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    Ok(())
}

/// 退出迷你模式
#[tauri::command]
pub fn exit_mini_mode(app: AppHandle, width: f64, height: f64) -> AppResult<()> {
    debug!("cmd::exit_mini_mode");
    let window = main_window(&app)?;
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 弹出窗口 label 前缀：与前端 `popOutTab` 的 `popup-${tabId}` 约定一致。
const POPUP_WINDOW_LABEL_PREFIX: &str = "popup-";

/// 只有弹出窗口允许被本命令抢焦点，避免被用来把主窗口/布局切换器顶到前面。
fn is_popup_window_label(label: &str) -> bool {
    label
        .strip_prefix(POPUP_WINDOW_LABEL_PREFIX)
        .is_some_and(|rest| !rest.is_empty())
}

/// 聚焦已弹出的终端窗口（docs/105 F7.3）。
///
/// tab 弹出后主窗口里只剩占位符，真身在 `popup-<tabId>` 这个独立系统窗口里，
/// 所以通知点击必须把那个窗口唤到前面，而不是聚焦一个写着「已弹出」的空面板。
/// 返回 `false` 表示窗口已不存在——调用方据此自愈（回收 tab 后回退到主窗口内定位）。
#[tauri::command]
pub fn focus_popup_terminal_window(app: AppHandle, label: String) -> AppResult<bool> {
    debug!("cmd::focus_popup_terminal_window label={}", label);
    if !is_popup_window_label(&label) {
        return Err(AppError::from(format!(
            "not a popup terminal window label: {label}"
        )));
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    // 最小化时 set_focus 在 Windows 上不会还原窗口，必须先 unminimize。
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(true)
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
    if !is_popup_window_label(&label) {
        return Err(AppError::from(format!(
            "popup window label must start with {POPUP_WINDOW_LABEL_PREFIX}: {label}"
        )));
    }
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

/// 打开布局切换浮窗。动态创建窗口，避免修改 tauri.conf.json。
#[tauri::command]
pub async fn open_layout_switcher_window(app: AppHandle) -> AppResult<()> {
    debug!("cmd::open_layout_switcher_window");
    if let Some(window) = app.get_webview_window(LAYOUT_SWITCHER_WINDOW_LABEL) {
        window
            .show()
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_always_on_top(true)
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_focus()
            .map_err(|error| AppError::from(error.to_string()))?;
        return Ok(());
    }

    let settings_service = app
        .try_state::<Arc<SettingsService>>()
        .ok_or_else(|| AppError::from("SettingsService is not registered"))?;
    let settings = settings_service.get_settings().layout_switcher;
    let (x, y) = resolve_layout_switcher_position(&app, settings.window_x, settings.window_y);

    WebviewWindowBuilder::new(
        &app,
        LAYOUT_SWITCHER_WINDOW_LABEL,
        WebviewUrl::App("index.html?mode=layout-switcher".into()),
    )
    .title("Layouts")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(LAYOUT_SWITCHER_WIDTH, LAYOUT_SWITCHER_HEIGHT)
    .position(x, y)
    .focused(true)
    .build()
    .map_err(|error| AppError::from(format!("Failed to create layout switcher window: {error}")))?;
    Ok(())
}

#[tauri::command]
pub fn close_layout_switcher_window(window: WebviewWindow) -> AppResult<()> {
    debug!("cmd::close_layout_switcher_window");
    window
        .close()
        .map_err(|error| AppError::from(error.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn get_layout_switcher_state(
    settings_service: State<'_, Arc<SettingsService>>,
) -> AppResult<LayoutSwitcherSettings> {
    Ok(settings_service.get_settings().layout_switcher)
}

#[tauri::command]
pub fn save_layout_switcher_state(
    settings_service: State<'_, Arc<SettingsService>>,
    x: Option<f64>,
    y: Option<f64>,
    pinned: bool,
) -> AppResult<()> {
    let mut app_settings = settings_service.get_settings();
    app_settings.layout_switcher.window_x = x;
    app_settings.layout_switcher.window_y = y;
    app_settings.layout_switcher.pinned = pinned;
    settings_service.update_settings(app_settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_layout_switcher_snapshot(
    snapshot_store: State<'_, LayoutSwitcherSnapshotStore>,
) -> AppResult<Option<String>> {
    Ok(snapshot_store
        .lock()
        .map_err(|error| AppError::from(error.to_string()))?
        .clone())
}

#[tauri::command]
pub fn save_layout_switcher_snapshot(
    snapshot_store: State<'_, LayoutSwitcherSnapshotStore>,
    snapshot: String,
) -> AppResult<()> {
    *snapshot_store
        .lock()
        .map_err(|error| AppError::from(error.to_string()))? = Some(snapshot);
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

fn resolve_layout_switcher_position(
    app: &AppHandle,
    saved_x: Option<f64>,
    saved_y: Option<f64>,
) -> (f64, f64) {
    let fallback = app
        .get_webview_window("main")
        .and_then(|main| {
            let position = main.outer_position().ok()?;
            let scale = main.scale_factor().ok()?;
            let x = position.x as f64 / scale + 24.0;
            let y = position.y as f64 / scale + 120.0;
            Some((x, y))
        })
        .unwrap_or((80.0, 80.0));

    clamp_layout_switcher_position(
        app,
        saved_x.unwrap_or(fallback.0),
        saved_y.unwrap_or(fallback.1),
    )
}

fn clamp_layout_switcher_position(app: &AppHandle, x: f64, y: f64) -> (f64, f64) {
    const SAFE_MARGIN: f64 = 8.0;
    const HALF_OFF_TOLERANCE: f64 = 40.0;

    let Ok(monitors) = app.available_monitors() else {
        return (80.0, 80.0);
    };
    if monitors.is_empty() {
        return (80.0, 80.0);
    }

    let already_visible = monitors.iter().any(|monitor| {
        let (lx, ly, lw, lh) = monitor_logical_rect(monitor);
        x + HALF_OFF_TOLERANCE > lx
            && x < lx + lw - HALF_OFF_TOLERANCE
            && y + HALF_OFF_TOLERANCE > ly
            && y < ly + lh - HALF_OFF_TOLERANCE
    });
    if already_visible {
        return (x, y);
    }

    let mut best: Option<(f64, f64, f64)> = None;
    for monitor in &monitors {
        let (lx, ly, lw, lh) = monitor_logical_rect(monitor);
        let cx = x.clamp(
            lx + SAFE_MARGIN,
            (lx + lw - LAYOUT_SWITCHER_WIDTH - SAFE_MARGIN).max(lx + SAFE_MARGIN),
        );
        let cy = y.clamp(
            ly + SAFE_MARGIN,
            (ly + lh - LAYOUT_SWITCHER_HEIGHT - SAFE_MARGIN).max(ly + SAFE_MARGIN),
        );
        let dist = (cx - x).powi(2) + (cy - y).powi(2);
        if best.is_none_or(|candidate| dist < candidate.0) {
            best = Some((dist, cx, cy));
        }
    }

    best.map(|(_, cx, cy)| (cx, cy)).unwrap_or((80.0, 80.0))
}

fn monitor_logical_rect(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    (
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

#[cfg(test)]
mod tests {
    use super::is_popup_window_label;

    #[test]
    fn popup_label_guard_accepts_real_popup_windows() {
        assert!(is_popup_window_label("popup-tab-1"));
        assert!(is_popup_window_label("popup-abc"));
    }

    #[test]
    fn popup_label_guard_rejects_bare_prefix_and_other_windows() {
        // 裸前缀没有 tabId，无法定位窗口，拒绝。
        assert!(!is_popup_window_label("popup-"));
        // 其他窗口不得被本命令抢焦点。
        assert!(!is_popup_window_label("main"));
        assert!(!is_popup_window_label("layout-switcher"));
        assert!(!is_popup_window_label("screenshot"));
        assert!(!is_popup_window_label(""));
    }
}

/// 设置窗口 label，capabilities/default.json 需同步。
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
pub const SETTINGS_WINDOW_NAVIGATE_EVENT: &str = "settings-window-navigate";

fn settings_target_is_safe(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 打开独立设置窗口（按需创建，见 CLAUDE.md 隐藏 WebView 的说明）。
/// 必须是 async：Windows 上同步命令里建窗口会死锁。
#[tauri::command]
pub async fn open_settings_window(
    app: AppHandle,
    pane_id: Option<String>,
    section_id: Option<String>,
) -> AppResult<()> {
    debug!("cmd::open_settings_window");
    for value in [pane_id.as_deref(), section_id.as_deref()]
        .into_iter()
        .flatten()
    {
        if !settings_target_is_safe(value) {
            return Err(AppError::from(format!("invalid settings target: {value}")));
        }
    }
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|e| AppError::from(e.to_string()))?;
        window
            .set_focus()
            .map_err(|e| AppError::from(e.to_string()))?;
        if pane_id.is_some() {
            window
                .emit(
                    SETTINGS_WINDOW_NAVIGATE_EVENT,
                    serde_json::json!({ "paneId": pane_id, "targetSectionId": section_id }),
                )
                .map_err(|e| AppError::from(e.to_string()))?;
        }
        return Ok(());
    }
    let mut url = String::from("index.html?mode=settings");
    if let Some(pane) = &pane_id {
        url.push_str(&format!("&pane={pane}"));
    }
    if let Some(section) = &section_id {
        url.push_str(&format!("&section={section}"));
    }
    WebviewWindowBuilder::new(&app, SETTINGS_WINDOW_LABEL, WebviewUrl::App(url.into()))
        .title("Settings")
        .inner_size(1040.0, 720.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .focused(true)
        .build()
        .map_err(|e| AppError::from(format!("Failed to create settings window: {e}")))?;
    Ok(())
}
