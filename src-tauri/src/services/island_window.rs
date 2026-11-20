//! 灵动岛独立窗口（label `island`）的生命周期、落位与环境探测。
//!
//! 窗口构建沿用 cc酱 / 置顶小浏览器窗（0.12.22 `BrowserWindowMode::Mini`）的同一套
//! 范式：按需 `WebviewWindowBuilder` 动态创建、无边框、透明、置顶、不进任务栏，
//! 关窗请求一律拦下（关闭只走设置开关）。
//!
//! 点击穿透：原生窗口尺寸 = 当前可见岛外框（见 `island_geometry`），前端每次视图
//! 切换上报尺寸，后端改窗口。两端同一套实现，不依赖 ignore-cursor-events。
//!
//! 环境探测节拍（仅在开启时运行，1s 一次，不拉任何会话数据）：
//! 鼠标所在屏（display=mouse）、前台全屏（collapseInFullscreen）、主窗口是否前台
//! （hideWhenMainFocused）。会话数据全部来自主窗口的事件桥，见 `web/island/`。

use super::island_fullscreen::foreground_is_fullscreen;
use super::island_geometry::{place, sanitize_size, Area, Edge};
use crate::models::island_settings::ISLAND_DISPLAY_MOUSE;
use crate::models::settings::IslandSettings;
use crate::utils::{AppError, AppResult};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, Monitor, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tracing::{debug, warn};

pub const ISLAND_WINDOW_LABEL: &str = "island";
pub const ISLAND_ENV_EVENT: &str = "island:env";
pub const ISLAND_SETTINGS_EVENT: &str = "island:settings";
/// 发给主窗口：定位到某个会话（主窗口事件桥执行 pane/tab 跳转）。
pub const ISLAND_NAVIGATE_EVENT: &str = "island:navigate";

const PROBE_INTERVAL: Duration = Duration::from_millis(1000);
const INITIAL_SIZE: (f64, f64) = (120.0, 34.0);

/// 推给岛前端的环境状态。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandEnv {
    pub fullscreen: bool,
    pub main_focused: bool,
}

/// 岛前端启动时一次性取回的状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandState {
    pub settings: IslandSettings,
    pub env: IslandEnv,
}

#[derive(Default)]
struct Runtime {
    settings: IslandSettings,
    /// 前端最近一次上报的逻辑尺寸；None = 前端尚未就绪，窗口保持隐藏。
    size: Option<(f64, f64)>,
    env: IslandEnv,
    /// 当前落位的显示器原点，用于判断鼠标是否换屏。
    monitor_origin: Option<(i32, i32)>,
}

#[derive(Default)]
pub struct IslandWindowManager {
    runtime: Mutex<Runtime>,
    probe_generation: AtomicU64,
}

impl IslandWindowManager {
    fn snapshot(&self) -> Runtime {
        let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        Runtime {
            settings: guard.settings.clone(),
            size: guard.size,
            env: guard.env,
            monitor_origin: guard.monitor_origin,
        }
    }

    fn update<T>(&self, f: impl FnOnce(&mut Runtime) -> T) -> T {
        let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn state(&self) -> IslandState {
        let runtime = self.snapshot();
        IslandState {
            settings: runtime.settings,
            env: runtime.env,
        }
    }

    /// 应用设置：开启时建窗 + 启动探测节拍，关闭时销毁窗口并停掉节拍。
    /// 不能在同步命令里直接调（Windows 同步命令内建窗会死锁），调用方走 async。
    pub fn sync(self: &Arc<Self>, app: &AppHandle, settings: IslandSettings) {
        let enabled = settings.enabled;
        self.update(|runtime| runtime.settings = settings.clone());
        if !enabled {
            self.probe_generation.fetch_add(1, Ordering::SeqCst);
            self.update(|runtime| {
                runtime.size = None;
                runtime.monitor_origin = None;
            });
            if let Some(window) = app.get_webview_window(ISLAND_WINDOW_LABEL) {
                let _ = window.destroy();
            }
            return;
        }
        if let Err(error) = ensure_window(app) {
            warn!(%error, "[island] failed to create window");
            return;
        }
        let _ = app.emit_to(ISLAND_WINDOW_LABEL, ISLAND_SETTINGS_EVENT, &settings);
        self.start_probe(app);
        self.apply(app);
    }

    /// 前端上报当前可见岛的逻辑尺寸。
    pub fn set_layout(&self, app: &AppHandle, width: f64, height: f64) -> AppResult<()> {
        let size = sanitize_size(width, height)
            .ok_or_else(|| AppError::from("island size must be finite"))?;
        self.update(|runtime| runtime.size = Some(size));
        self.apply(app);
        Ok(())
    }

    fn start_probe(self: &Arc<Self>, app: &AppHandle) {
        let generation = self.probe_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let manager = Arc::clone(self);
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("island-probe".into())
            .spawn(move || {
                while manager.probe_generation.load(Ordering::SeqCst) == generation {
                    manager.probe(&app);
                    std::thread::sleep(PROBE_INTERVAL);
                }
                debug!("[island] probe stopped");
            });
        if let Err(error) = spawned {
            warn!(%error, "[island] failed to start probe thread");
        }
    }

    fn probe(&self, app: &AppHandle) {
        let runtime = self.snapshot();
        let settings = &runtime.settings;
        let env = IslandEnv {
            fullscreen: settings.collapse_in_fullscreen
                && foreground_is_fullscreen(&logical_monitor_rects(app)),
            main_focused: settings.hide_when_main_focused && main_window_focused(app),
        };
        let monitor_moved = target_monitor(app, &settings.display)
            .map(|m| (m.position().x, m.position().y))
            != runtime.monitor_origin;
        if env != runtime.env {
            self.update(|r| r.env = env);
            let _ = app.emit_to(ISLAND_WINDOW_LABEL, ISLAND_ENV_EVENT, env);
        }
        if env != runtime.env || monitor_moved {
            self.apply(app);
        }
    }

    /// 把窗口挪到目标屏的停靠位并按上报尺寸改大小；同时决定显隐。
    fn apply(&self, app: &AppHandle) {
        let Some(window) = app.get_webview_window(ISLAND_WINDOW_LABEL) else {
            return;
        };
        let runtime = self.snapshot();
        let hidden_by_main = runtime.settings.hide_when_main_focused && runtime.env.main_focused;
        let Some(size) = runtime
            .size
            .filter(|_| runtime.settings.enabled && !hidden_by_main)
        else {
            conceal(&window);
            return;
        };
        let Some(monitor) = target_monitor(app, &runtime.settings.display) else {
            return;
        };
        let line = runtime.env.fullscreen;
        let area = monitor_area(&monitor, line);
        let edge = Edge::parse(&runtime.settings.position);
        let placed = place(edge, area, monitor.scale_factor(), size);
        if let Err(error) = move_window(&window, placed, monitor.scale_factor()) {
            warn!(%error, "[island] failed to place window");
        }
        self.update(|r| r.monitor_origin = Some((monitor.position().x, monitor.position().y)));
        if !window.is_visible().unwrap_or(false) {
            reveal(&window);
        }
    }
}

/// 显示但不抢焦点。macOS 的 `show()` 走 makeKeyAndOrderFront，会把主窗口的键盘焦点抢走，
/// 这里直接 orderFrontRegardless；Windows 首次 show 因 `focused(false)` 走 SW_SHOWNOACTIVATE。
fn reveal(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| unsafe {
            let ns_window: &objc2_app_kit::NSWindow = &*webview.ns_window().cast();
            ns_window.orderFrontRegardless();
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
    }
}

/// 暂时藏起。Windows 上 tao 只有首次 show 是 SW_SHOWNOACTIVATE，之后再 show 会激活窗口
/// 抢焦点，所以不 hide，挪到屏幕外；下次 apply 会挪回来。
fn conceal(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(-32000, -32000));
    }
    #[cfg(not(windows))]
    {
        let _ = window.hide();
    }
}

/// 全屏细线贴屏幕真实上沿；平时挂在工作区（macOS 菜单栏 / 刘海下方，Windows 任务栏内侧）。
fn monitor_area(monitor: &Monitor, full: bool) -> Area {
    if full {
        let (pos, size) = (monitor.position(), monitor.size());
        return Area {
            x: f64::from(pos.x),
            y: f64::from(pos.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        };
    }
    let work = monitor.work_area();
    Area {
        x: f64::from(work.position.x),
        y: f64::from(work.position.y),
        width: f64::from(work.size.width),
        height: f64::from(work.size.height),
    }
}

fn move_window(window: &WebviewWindow, placed: Area, scale: f64) -> tauri::Result<()> {
    // macOS 的物理坐标由 tao 按「窗口当前所在屏」缩放换算，跨不同缩放的屏会算错；
    // 这里按目标屏缩放先换成逻辑坐标再设置。Windows 物理坐标就是真实桌面坐标。
    #[cfg(target_os = "macos")]
    {
        window.set_size(tauri::LogicalSize::new(
            placed.width / scale,
            placed.height / scale,
        ))?;
        window.set_position(tauri::LogicalPosition::new(
            placed.x / scale,
            placed.y / scale,
        ))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        let position = tauri::PhysicalPosition::new(placed.x as i32, placed.y as i32);
        // 先挪到目标屏（可能触发 DPI 变化重算尺寸），再定尺寸，再按最终尺寸校正位置。
        window.set_position(position)?;
        window.set_size(tauri::PhysicalSize::new(
            placed.width as u32,
            placed.height as u32,
        ))?;
        window.set_position(position)?;
    }
    Ok(())
}

fn target_monitor(app: &AppHandle, display: &str) -> Option<Monitor> {
    if display == ISLAND_DISPLAY_MOUSE {
        if let Ok(cursor) = app.cursor_position() {
            if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
                return Some(monitor);
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())
}

fn logical_monitor_rects(app: &AppHandle) -> Vec<Area> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            Area {
                x: f64::from(m.position().x) / scale,
                y: f64::from(m.position().y) / scale,
                width: f64::from(m.size().width) / scale,
                height: f64::from(m.size().height) / scale,
            }
        })
        .collect()
}

fn main_window_focused(app: &AppHandle) -> bool {
    app.get_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

fn ensure_window(app: &AppHandle) -> AppResult<()> {
    if app.get_webview_window(ISLAND_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        app,
        ISLAND_WINDOW_LABEL,
        WebviewUrl::App("index.html?mode=island".into()),
    )
    .title("CC-Panes Island")
    .inner_size(INITIAL_SIZE.0, INITIAL_SIZE.1)
    .position(-9999.0, -9999.0)
    .visible(false)
    .focused(false)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true);
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let window = builder
        .build()
        .map_err(|error| AppError::from(format!("Failed to create island window: {error}")))?;
    #[cfg(target_os = "macos")]
    configure_macos_window(&window);
    let guard = window.clone();
    window.on_window_event(move |event| {
        // 无边框窗口仍可能收到 Alt+F4 / Cmd+W；关闭只走设置开关。
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = guard.hide();
        }
    });
    Ok(())
}

/// 进所有空间（含全屏应用空间）、不进 Mission Control / Cmd+` 轮换。
#[cfg(target_os = "macos")]
fn configure_macos_window(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let ns_window: &NSWindow = &*webview.ns_window().cast();
        let mut behavior = ns_window.collectionBehavior();
        behavior.insert(NSWindowCollectionBehavior::CanJoinAllSpaces);
        behavior.insert(NSWindowCollectionBehavior::FullScreenAuxiliary);
        behavior.insert(NSWindowCollectionBehavior::Stationary);
        behavior.insert(NSWindowCollectionBehavior::IgnoresCycle);
        ns_window.setCollectionBehavior(behavior);
        ns_window.setHasShadow(false);
    });
}

/// 唤起主窗口（从托盘 / 最小化恢复）。Windows 上最小化时必须先 unminimize。
pub fn focus_main_window(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_window("main")
        .ok_or_else(|| AppError::from("main window is unavailable"))?;
    let _ = window.unminimize();
    window.show().map_err(|e| AppError::from(e.to_string()))?;
    window
        .set_focus()
        .map_err(|e| AppError::from(e.to_string()))
}
