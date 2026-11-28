//! 桌宠 ccchan：会话状态指示器窗口（Bot 形象）。
//!
//! 窗口固定大小（只随角色大小变），透明区域经命中测试动态
//! `set_ignore_cursor_events` 放行点击；聊天不再自带 CLI 进程，单次提问
//! 走 Bot 的 `ask_bot` 通路（bot_service/ask.rs）。
//!
//! Sprite attribution: Homie spritesheet from oc-claw (MIT), Copyright (c) rainnoon.

#[path = "ccchan_pets.rs"]
mod pets;
pub use pets::PetMeta;
#[path = "ccchan_window.rs"]
mod window;
pub use window::{window_size_for, Rect, RevealGate};

use crate::models::settings::CCChanSettings;
use crate::services::SettingsService;
use crate::utils::{AppError, AppPaths, AppResult};
use cc_panes_core::events::SessionNotifier;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tracing::{debug, warn};

pub const CCCHAN_WINDOW_LABEL: &str = "ccchan";
const CCCHAN_EVENT: &str = "ccchan-event";
const CCCHAN_HOVER_EVENT: &str = "ccchan:hover";
const REVEAL_FALLBACK_TIMEOUT: Duration = Duration::from_secs(3);
/// 命中测试轮询间隔：光标进出角色包围盒的响应延迟上限。
const HIT_POLL_INTERVAL: Duration = Duration::from_millis(60);
/// 拖拽停下多久后才吸附 + 持久化位置。
const MOVE_SETTLE: Duration = Duration::from_millis(450);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CCChanSay {
    pub text: String,
    pub duration_ms: u64,
}

/// 点击穿透状态：前端上报的命中区域 + 当前穿透开关 + 拖拽后的待落盘位置。
#[derive(Default)]
struct HitState {
    generation: u64,
    regions: Vec<Rect>,
    ignoring: Option<bool>,
    inside: bool,
    /// 平台不支持（或光标位置读不到）时降级为「不穿透」，不再反复尝试。
    disabled: bool,
    pending_move: Option<Instant>,
}

pub struct CCChanService {
    settings_service: Arc<SettingsService>,
    app_paths: Arc<AppPaths>,
    app_handle: Mutex<Option<AppHandle>>,
    pending_say: Mutex<Option<CCChanSay>>,
    reveal: Arc<Mutex<RevealGate>>,
    hit: Arc<Mutex<HitState>>,
}

impl CCChanService {
    pub fn new(settings_service: Arc<SettingsService>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            settings_service,
            app_paths,
            app_handle: Mutex::new(None),
            pending_say: Mutex::new(None),
            reveal: Arc::new(Mutex::new(RevealGate::default())),
            hit: Arc::new(Mutex::new(HitState::default())),
        }
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app_handle);
        }
    }

    pub fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle
            .lock()
            .ok()
            .and_then(|handle| handle.clone())
    }

    pub fn say(&self, app: &AppHandle, text: String, duration_ms: u64) -> AppResult<()> {
        *self.pending_say.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(CCChanSay { text, duration_ms });
        self.show_window(app)?;
        app.emit_to(CCCHAN_WINDOW_LABEL, "ccchan-say", ())
            .map_err(|e| AppError::from(e.to_string()))?;
        Ok(())
    }

    pub fn take_say(&self) -> Option<CCChanSay> {
        self.pending_say
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    pub fn settings(&self) -> CCChanSettings {
        self.settings_service.get_settings().ccchan
    }

    pub fn save_settings(&self, settings: CCChanSettings) -> AppResult<()> {
        self.settings_service
            .update_ccchan(|current| *current = settings)?;
        self.publish_settings();
        Ok(())
    }

    fn publish_settings(&self) {
        if let Some(app) = self.app_handle() {
            if let Err(error) = app.emit("ccchan:settings-updated", self.settings()) {
                warn!(%error, "failed to publish ccchan settings");
            }
        }
    }

    pub fn user_pets_dir(&self) -> PathBuf {
        self.app_paths.data_dir().join("ccchan").join("pets")
    }

    /// 确保用户皮肤目录存在，并在首次创建时放一份 README 模板。已有 README 不覆盖。
    pub fn ensure_user_pets_dir_scaffold(&self) -> AppResult<PathBuf> {
        let dir = self.user_pets_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|error| AppError::from(format!("cannot create pets dir: {error}")))?;
        let readme = dir.join("README.md");
        if !readme.exists() {
            if let Err(error) = std::fs::write(&readme, pets::USER_PETS_README) {
                warn!(%error, "failed to write ccchan pets README");
            }
        }
        Ok(dir)
    }

    /// 皮肤列表：内置 < `~/.codex/pets`（只读）< 用户目录，同 id 后者覆盖。
    pub fn get_pets(&self, app: &AppHandle) -> AppResult<Vec<PetMeta>> {
        let built_in = resolve_ccchan_root(app)
            .and_then(|root| pets::load_bundled_pets(&root))
            .unwrap_or_else(|error| {
                warn!(%error, "failed to load bundled pets; keeping custom pets available");
                Vec::new()
            });
        let codex = pets::codex_pets_dir()
            .map(|dir| pets::scan_pet_root(&dir, "codex"))
            .unwrap_or_default();
        let user = pets::scan_pet_root(&self.user_pets_dir(), "user");
        let all = pets::merge_pets(pets::merge_pets(built_in, codex), user);
        if let Err(error) = app.emit("ccchan:pets-updated", &all) {
            warn!(%error, "failed to publish refreshed pets");
        }
        Ok(all)
    }

    pub fn show_window(&self, app: &AppHandle) -> AppResult<()> {
        if let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) {
            if window.is_visible().unwrap_or(false) {
                return Ok(());
            }
        }
        let created = app.get_webview_window(CCCHAN_WINDOW_LABEL).is_none();
        if created {
            self.lock_reveal().reset();
        }
        let window = ccchan_window(app)?;
        self.apply_window_size(&window)?;
        self.position_window(&window)?;
        if created {
            self.start_hit_loop(app);
        }
        if self.lock_reveal().request_show() {
            return reveal_window(&window);
        }
        self.schedule_reveal_fallback(app);
        Ok(())
    }

    /// 窗口尺寸只随角色大小变（设置改了角色大小时调用）。
    pub fn apply_window_size(&self, window: &WebviewWindow) -> AppResult<()> {
        let (width, height) = window_size_for(self.settings().pet_size);
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| AppError::from(error.to_string()))
    }

    /// 前端首帧渲染完成后调用：执行挂起的 show。
    pub fn mark_window_ready(&self, app: &AppHandle) -> AppResult<()> {
        if !self.lock_reveal().mark_ready() {
            return Ok(());
        }
        match app.get_webview_window(CCCHAN_WINDOW_LABEL) {
            Some(window) => reveal_window(&window),
            None => Ok(()),
        }
    }

    fn lock_reveal(&self) -> std::sync::MutexGuard<'_, RevealGate> {
        self.reveal.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_hit(&self) -> std::sync::MutexGuard<'_, HitState> {
        self.hit.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 前端迟迟不发 ready（脚本加载失败等）时兜底显示，避免宠物永远不出现。
    fn schedule_reveal_fallback(&self, app: &AppHandle) {
        let generation = self.lock_reveal().generation();
        let reveal = Arc::clone(&self.reveal);
        let app_for_timer = app.clone();
        let spawned = std::thread::Builder::new()
            .name("ccchan-reveal-fallback".into())
            .spawn(move || {
                std::thread::sleep(REVEAL_FALLBACK_TIMEOUT);
                let fire = reveal
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take_timeout(generation);
                if !fire {
                    return;
                }
                warn!(
                    "[ccchan] frontend not ready after {REVEAL_FALLBACK_TIMEOUT:?}, showing anyway"
                );
                if let Some(window) = app_for_timer.get_webview_window(CCCHAN_WINDOW_LABEL) {
                    if let Err(error) = reveal_window(&window) {
                        warn!(%error, "failed to show ccchan window after ready timeout");
                    }
                }
            });
        if let Err(error) = spawned {
            warn!(%error, "failed to spawn ccchan reveal fallback; showing immediately");
            self.lock_reveal().take_timeout(generation);
            if let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) {
                if let Err(error) = reveal_window(&window) {
                    warn!(%error, "failed to show ccchan window");
                }
            }
        }
    }

    /// 关闭桌宠时直接销毁窗口而非隐藏：长期隐藏的 WebView2 会被系统置为
    /// 失效状态（0x8007139F），之后所有 emit 广播对它投递失败形成日志洪水。
    /// 窗口不存在时为幂等 no-op。下次启用经 show_window 重建。
    pub fn hide_window(&self, app: &AppHandle) -> AppResult<()> {
        self.lock_reveal().reset();
        self.lock_hit().generation += 1;
        let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) else {
            return Ok(());
        };
        window
            .close()
            .map_err(|error| AppError::from(error.to_string()))
    }

    /// 用户显式开关宠物时持久化可见性，保证下次启动按最后一次开关恢复。
    pub fn set_window_visible(&self, visible: bool) -> AppResult<()> {
        self.settings_service
            .update_ccchan(|settings| settings.window_visible = visible)?;
        self.publish_settings();
        Ok(())
    }

    /// 前端上报的可点击区域（窗口内 CSS 像素）：角色包围盒、悬停控件条、气泡。
    pub fn set_hit_regions(&self, regions: Vec<Rect>) {
        let regions = regions
            .into_iter()
            .filter(|r| r.x.is_finite() && r.y.is_finite() && r.width > 0.0 && r.height > 0.0)
            .take(16)
            .collect();
        self.lock_hit().regions = regions;
    }

    fn position_window(&self, window: &WebviewWindow) -> AppResult<()> {
        let settings = self.settings();
        let size = window
            .outer_size()
            .map_err(|e| AppError::from(e.to_string()))?;
        let scale = window
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        let (x, y) = stored_physical_position(&settings, scale).unwrap_or((80.0, 80.0));
        let rect = window::fit_window(
            x,
            y,
            size.width as f64,
            size.height as f64,
            &window::work_areas(window),
        );
        window
            .set_position(PhysicalPosition::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
            ))
            .map_err(|e| AppError::from(e.to_string()))
    }

    /// 设置页「重置位置」或手工改坐标：按物理像素放回并吸附进工作区。
    pub fn reposition(&self, app: &AppHandle) -> AppResult<()> {
        match app.get_webview_window(CCCHAN_WINDOW_LABEL) {
            Some(window) => self.position_window(&window),
            None => Ok(()),
        }
    }

    fn note_moved(&self) {
        self.lock_hit().pending_move = Some(Instant::now());
    }

    /// 拖拽停稳后：吸附到近处屏幕边缘，并以物理像素落盘。
    fn settle_position(&self, window: &WebviewWindow) {
        let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            return;
        };
        let current = Rect {
            x: pos.x as f64,
            y: pos.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let snapped = window::snap_window(
            current,
            &window::work_areas(window),
            window::SNAP_DISTANCE * scale,
        );
        if (snapped.x, snapped.y) != (current.x, current.y) {
            if let Err(error) = window.set_position(PhysicalPosition::new(
                snapped.x.round() as i32,
                snapped.y.round() as i32,
            )) {
                warn!(%error, "failed to snap ccchan window");
            }
        }
        let saved = self.settings_service.update_ccchan(|settings| {
            settings.window_x = Some(snapped.x.round());
            settings.window_y = Some(snapped.y.round());
            settings.window_pos_physical = true;
        });
        match saved {
            Ok(()) => self.publish_settings(),
            Err(error) => warn!(%error, "failed to persist ccchan position"),
        }
    }

    /// 命中测试轮询：低频读全局光标，进出角色区域时切换穿透并通知前端悬停。
    /// 读全局光标而不是依赖 DOM 事件，窗口失焦 / 已穿透时也能重新捕获悬停。
    fn start_hit_loop(&self, app: &AppHandle) {
        let generation = {
            let mut hit = self.lock_hit();
            hit.generation += 1;
            hit.ignoring = None;
            hit.inside = false;
            hit.disabled = false;
            hit.generation
        };
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("ccchan-hit-test".into())
            .spawn(move || loop {
                std::thread::sleep(HIT_POLL_INTERVAL);
                let Some(service) = app.try_state::<Arc<CCChanService>>() else {
                    return;
                };
                if service.lock_hit().generation != generation {
                    return;
                }
                let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) else {
                    return;
                };
                if !window.is_visible().unwrap_or(false) {
                    continue;
                }
                service.hit_tick(&window);
            });
        if let Err(error) = spawned {
            warn!(%error, "failed to spawn ccchan hit-test loop; click-through disabled");
        }
    }

    fn hit_tick(&self, window: &WebviewWindow) {
        let settle = {
            let mut hit = self.lock_hit();
            let ready = hit
                .pending_move
                .is_some_and(|at| at.elapsed() >= MOVE_SETTLE);
            if ready {
                hit.pending_move = None;
            }
            ready
        };
        if settle {
            self.settle_position(window);
        }
        if self.lock_hit().disabled {
            return;
        }
        let probe = (|| {
            let cursor = window.cursor_position().ok()?;
            let origin = window.outer_position().ok()?;
            let scale = window.scale_factor().ok()?;
            Some((cursor, origin, scale))
        })();
        let Some((cursor, origin, scale)) = probe else {
            self.disable_click_through(window, "cursor position unavailable");
            return;
        };
        let (inside, toggle, hover_changed) = {
            let mut hit = self.lock_hit();
            let inside = window::hit_test(
                &hit.regions,
                (cursor.x, cursor.y),
                (origin.x as f64, origin.y as f64),
                scale,
            );
            let toggle = hit.ignoring != Some(!inside);
            let hover_changed = hit.inside != inside;
            hit.inside = inside;
            (inside, toggle, hover_changed)
        };
        if toggle {
            match window.set_ignore_cursor_events(!inside) {
                Ok(()) => self.lock_hit().ignoring = Some(!inside),
                Err(error) => {
                    self.disable_click_through(window, &error.to_string());
                    return;
                }
            }
        }
        if hover_changed {
            if let Err(error) = window.emit_to(CCCHAN_WINDOW_LABEL, CCCHAN_HOVER_EVENT, inside) {
                debug!(%error, "failed to emit ccchan hover");
            }
        }
    }

    fn disable_click_through(&self, window: &WebviewWindow, reason: &str) {
        warn!(
            reason,
            "ccchan click-through unavailable; window stays clickable"
        );
        let _ = window.set_ignore_cursor_events(false);
        let mut hit = self.lock_hit();
        hit.disabled = true;
        hit.ignoring = Some(false);
    }

    pub fn notify_task_done(&self, session_id: &str, ok: bool) {
        let kind = if ok { "task-complete" } else { "task-failed" };
        self.emit_ccchan_event(kind, session_id, ok);
    }

    pub fn notify_task_waiting(&self, session_id: &str) {
        self.emit_ccchan_event("task-waiting", session_id, true);
    }

    /// 会话名由宠物前端经主窗口的会话目录反查（Rust 侧没有标签标题）。
    fn emit_ccchan_event(&self, kind: &str, session_id: &str, ok: bool) {
        let Some(app) = self.app_handle() else {
            debug!(
                session_id,
                kind, "ccchan event skipped before app handle is set"
            );
            return;
        };
        if app.get_webview_window(CCCHAN_WINDOW_LABEL).is_none() {
            return;
        }
        let payload = serde_json::json!({
            "kind": kind,
            "sessionId": session_id,
            "ok": ok,
            "ts": current_epoch_seconds(),
        });
        if let Err(error) = app.emit_to(CCCHAN_WINDOW_LABEL, CCCHAN_EVENT, payload) {
            warn!(session_id, kind, error = %error, "failed to emit ccchan event");
        }
    }
}

/// 持久化位置 → 物理像素。旧版本存的是逻辑像素（`window_pos_physical = false`），
/// 按主显示器 scale 换算一次；之后统一以物理像素落盘。
fn stored_physical_position(settings: &CCChanSettings, legacy_scale: f64) -> Option<(f64, f64)> {
    let (x, y) = (settings.window_x?, settings.window_y?);
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    if settings.window_pos_physical {
        Some((x, y))
    } else {
        Some((x * legacy_scale, y * legacy_scale))
    }
}

pub struct CcChanSessionNotifier {
    inner: Arc<dyn SessionNotifier>,
    ccchan_service: Arc<CCChanService>,
}

impl CcChanSessionNotifier {
    pub fn new(inner: Arc<dyn SessionNotifier>, ccchan_service: Arc<CCChanService>) -> Self {
        Self {
            inner,
            ccchan_service,
        }
    }
}

impl SessionNotifier for CcChanSessionNotifier {
    fn notify_waiting_input(&self, session_id: &str) {
        self.inner.notify_waiting_input(session_id);
        self.ccchan_service.notify_task_waiting(session_id);
    }

    fn notify_session_exited(&self, session_id: &str, exit_code: i32) {
        self.inner.notify_session_exited(session_id, exit_code);
        self.ccchan_service
            .notify_task_done(session_id, exit_code == 0);
    }

    fn cleanup_session(&self, session_id: &str) {
        self.inner.cleanup_session(session_id);
    }
}

/// 在页面任何脚本/样式执行前给 <html> 打标记，index.html 的内联样式据此
/// 把 html/body/#root 置透明——首帧即透明，不依赖 bundle 加载。
const TRANSPARENT_INIT_SCRIPT: &str = r#"(function () {
  var mark = function () {
    var el = document.documentElement;
    if (!el) return false;
    el.setAttribute("data-ccchan-window", "");
    return true;
  };
  if (mark()) return;
  new MutationObserver(function (_records, observer) {
    if (mark()) observer.disconnect();
  }).observe(document, { childList: true });
})();"#;

fn reveal_window(window: &WebviewWindow) -> AppResult<()> {
    window
        .show()
        .map_err(|error| AppError::from(error.to_string()))
}

/// 按需创建（get-or-create）。绝不在 tauri.conf.json 预创建隐藏窗口。
fn ccchan_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    if let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        CCCHAN_WINDOW_LABEL,
        WebviewUrl::App("index.html?mode=ccchan".into()),
    )
    .title("cc酱")
    .visible(false)
    .inner_size(280.0, 280.0)
    .position(-9999.0, -9999.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .initialization_script(TRANSPARENT_INIT_SCRIPT)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| AppError::from(format!("Failed to create ccchan window: {error}")))?;
    let app = app.clone();
    let label_window = window.clone();
    window.on_window_event(move |event| {
        let Some(service) = app.try_state::<Arc<CCChanService>>() else {
            return;
        };
        match event {
            tauri::WindowEvent::Moved(_) => {
                if label_window.is_visible().unwrap_or(false) {
                    service.note_moved();
                }
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                if let Err(error) = service.set_window_visible(false) {
                    warn!(%error, "failed to persist ccchan close");
                }
            }
            _ => {}
        }
    });
    Ok(window)
}

fn resolve_ccchan_root(app: &AppHandle) -> AppResult<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let root = resource_dir.join("resources").join("ccchan");
        if root.exists() {
            return Ok(root);
        }
    }
    let cwd = std::env::current_dir()?;
    for candidate in [
        cwd.join("src-tauri").join("resources").join("ccchan"),
        cwd.join("resources").join("ccchan"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::from("ccchan resources not found"))
}

fn current_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_logical_position_converts_once_to_physical() {
        let mut settings = CCChanSettings {
            window_x: Some(100.0),
            window_y: Some(50.0),
            ..CCChanSettings::default()
        };
        assert_eq!(
            stored_physical_position(&settings, 2.0),
            Some((200.0, 100.0))
        );
        settings.window_pos_physical = true;
        assert_eq!(
            stored_physical_position(&settings, 2.0),
            Some((100.0, 50.0))
        );
        settings.window_x = None;
        assert_eq!(stored_physical_position(&settings, 2.0), None);
    }
}
