//! ccchan mascot backend service.
//!
//! Sprite attribution: Homie spritesheet from oc-claw (MIT), Copyright (c) rainnoon.

use crate::models::settings::CCChanSettings;
use crate::models::{CliTool, LaunchProviderSelection};
use crate::services::{SettingsService, TerminalService};
use crate::utils::{AppError, AppPaths, AppResult};
use cc_panes_core::events::SessionNotifier;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tracing::{debug, warn};

const CCCHAN_WINDOW_LABEL: &str = "ccchan";
const CCCHAN_EVENT: &str = "ccchan-event";
const CCCHAN_HELPER_PROMPT: &str =
    include_str!("../../resources/claude-bundle/default-skills/ccchan-helper.md");

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetMeta {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub spritesheet_url: String,
    pub atlas: PetAtlas,
    pub animations: HashMap<String, PetAnimation>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAtlas {
    pub cell_w: u32,
    pub cell_h: u32,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PetAnimation {
    pub row: u32,
    pub frames: u32,
    pub fps: u32,
    #[serde(default)]
    pub col_offset: u32,
}

#[derive(Deserialize)]
struct PetsManifest {
    pets: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetDefinition {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
    atlas: PetAtlas,
    animations: HashMap<String, PetAnimation>,
}

pub struct CCChanService {
    settings_service: Arc<SettingsService>,
    app_paths: Arc<AppPaths>,
    app_handle: Mutex<Option<AppHandle>>,
    chat_session_id: Mutex<Option<String>>,
}

impl CCChanService {
    pub fn new(settings_service: Arc<SettingsService>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            settings_service,
            app_paths,
            app_handle: Mutex::new(None),
            chat_session_id: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app_handle);
        }
    }

    pub fn settings(&self) -> CCChanSettings {
        self.settings_service.get_settings().ccchan
    }

    pub fn save_settings(&self, settings: CCChanSettings) -> AppResult<()> {
        let mut app_settings = self.settings_service.get_settings();
        app_settings.ccchan = settings;
        self.settings_service.update_settings(app_settings)?;
        Ok(())
    }

    pub fn show_window(&self, app: &AppHandle) -> AppResult<()> {
        let window = ccchan_window(app)?;
        window
            .set_size(LogicalSize::new(120.0, 120.0))
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_decorations(false)
            .map_err(|error| AppError::from(error.to_string()))?;
        window
            .set_always_on_top(true)
            .map_err(|error| AppError::from(error.to_string()))?;
        position_window(&window, &self.settings())?;
        window
            .show()
            .map_err(|error| AppError::from(error.to_string()))?;
        Ok(())
    }

    pub fn hide_window(&self, app: &AppHandle) -> AppResult<()> {
        let window = ccchan_window(app)?;
        window
            .hide()
            .map_err(|error| AppError::from(error.to_string()))?;
        Ok(())
    }

    pub fn save_window_position(&self, x: f64, y: f64) -> AppResult<()> {
        let mut settings = self.settings();
        settings.window_x = Some(x);
        settings.window_y = Some(y);
        self.save_settings(settings)
    }

    pub fn get_pets(&self, app: &AppHandle) -> AppResult<Vec<PetMeta>> {
        let root = resolve_ccchan_root(app)?;
        let manifest_path = root.join("pets-manifest.json");
        let manifest_content = std::fs::read_to_string(&manifest_path).map_err(|error| {
            AppError::from(format!(
                "Failed to read {}: {}",
                manifest_path.display(),
                error
            ))
        })?;
        let manifest: PetsManifest = serde_json::from_str(&manifest_content)
            .map_err(|error| AppError::from(format!("Invalid pets manifest: {error}")))?;

        manifest
            .pets
            .iter()
            .map(|pet_id| self.load_pet(&root, pet_id))
            .collect()
    }

    pub fn start_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        ai_engine: String,
    ) -> AppResult<String> {
        let cli_tool = parse_ai_engine(&ai_engine)?;
        let chat_dir = self.app_paths.data_dir().join("ccchan");
        std::fs::create_dir_all(&chat_dir).map_err(|error| {
            AppError::from(format!(
                "Failed to create ccchan chat directory {}: {}",
                chat_dir.display(),
                error
            ))
        })?;

        if let Some(existing) = self.take_chat_session_id()? {
            let _ = terminal_service.kill(&existing);
        }

        let chat_dir_str = chat_dir.to_string_lossy().to_string();
        let session_id = terminal_service.create_session(
            None,
            &chat_dir_str,
            80,
            24,
            None,
            None,
            LaunchProviderSelection::Inherit,
            None,
            None,
            None,
            cli_tool,
            None,
            false,
            Some(CCCHAN_HELPER_PROMPT),
            None,
            None,
            None,
            None,
        )?;

        let mut stored = self
            .chat_session_id
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        *stored = Some(session_id.clone());
        Ok(session_id)
    }

    pub fn send_to_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        session_id: &str,
        text: &str,
    ) -> AppResult<()> {
        terminal_service.write(session_id, text)?;
        terminal_service.write(session_id, "\r")?;
        Ok(())
    }

    pub fn stop_chat(
        &self,
        terminal_service: Arc<TerminalService>,
        session_id: &str,
    ) -> AppResult<()> {
        self.clear_chat_session_id(session_id)?;
        match terminal_service.kill(session_id) {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().to_ascii_lowercase().contains("not found") => Ok(()),
            Err(error) => Err(AppError::from(error.to_string())),
        }
    }

    pub fn notify_task_done(&self, session_id: &str, ok: bool) {
        let kind = if ok { "task-complete" } else { "task-failed" };
        self.emit_ccchan_event(kind, session_id, ok);
    }

    pub fn notify_task_waiting(&self, session_id: &str) {
        self.emit_ccchan_event("task-waiting", session_id, true);
    }

    #[allow(dead_code)]
    fn set_window_visible(&self, visible: bool) -> AppResult<()> {
        let mut settings = self.settings();
        settings.window_visible = visible;
        self.save_settings(settings)
    }

    fn load_pet(&self, root: &Path, pet_id: &str) -> AppResult<PetMeta> {
        let pet_dir = root.join(pet_id);
        let pet_json_path = pet_dir.join("pet.json");
        let pet_content = std::fs::read_to_string(&pet_json_path).map_err(|error| {
            AppError::from(format!(
                "Failed to read {}: {}",
                pet_json_path.display(),
                error
            ))
        })?;
        let definition: PetDefinition = serde_json::from_str(&pet_content)
            .map_err(|error| AppError::from(format!("Invalid pet.json for {pet_id}: {error}")))?;
        let spritesheet_path = pet_dir.join(&definition.spritesheet_path);

        Ok(PetMeta {
            id: definition.id,
            display_name: definition.display_name,
            description: definition.description,
            spritesheet_url: file_asset_url(&spritesheet_path),
            atlas: definition.atlas,
            animations: definition.animations,
        })
    }

    fn take_chat_session_id(&self) -> AppResult<Option<String>> {
        let mut stored = self
            .chat_session_id
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        Ok(stored.take())
    }

    fn clear_chat_session_id(&self, session_id: &str) -> AppResult<()> {
        let mut stored = self
            .chat_session_id
            .lock()
            .map_err(|_| AppError::from("ccchan chat session lock poisoned"))?;
        if stored.as_deref() == Some(session_id) {
            *stored = None;
        }
        Ok(())
    }

    fn emit_ccchan_event(&self, kind: &str, session_id: &str, ok: bool) {
        let app_handle = self
            .app_handle
            .lock()
            .ok()
            .and_then(|handle| handle.clone());
        let Some(app) = app_handle else {
            debug!(
                session_id,
                kind, "ccchan event skipped before app handle is set"
            );
            return;
        };

        let payload = serde_json::json!({
            "kind": kind,
            "sessionId": session_id,
            "title": serde_json::Value::Null,
            "ok": ok,
            "ts": current_epoch_seconds(),
        });
        if let Err(error) = app.emit(CCCHAN_EVENT, payload) {
            warn!(session_id, kind, error = %error, "failed to emit ccchan event");
        }
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

fn ccchan_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    if let Some(window) = app.get_webview_window(CCCHAN_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        CCCHAN_WINDOW_LABEL,
        WebviewUrl::App("index.html?mode=ccchan".into()),
    )
    .title("cc酱")
    .visible(false)
    .inner_size(120.0, 120.0)
    .position(-9999.0, -9999.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| AppError::from(format!("Failed to create ccchan window: {error}")))
}

fn position_window(window: &WebviewWindow, settings: &CCChanSettings) -> AppResult<()> {
    let (x, y) = match (settings.window_x, settings.window_y) {
        (Some(x), Some(y)) => clamp_position_to_visible(window, x, y),
        _ => (80.0, 80.0),
    };
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| AppError::from(error.to_string()))
}

/// Snap a window position into a currently-attached monitor.
///
/// - If `(x, y)` is already inside any monitor (with a 40px sliver for half-off
///   tolerance), return as-is.
/// - Otherwise pick the monitor closest to `(x, y)` and clamp the position to
///   that monitor's interior (leaving the mascot's full body visible).
/// - If no monitors are attached at all, fall back to (80, 80).
///
/// Used both on startup (resolve stale persisted positions after monitor
/// hot-unplug / DPI change) AND on every drag-release (so a user who drags
/// the mascot off-screen sees it snap back instead of vanishing).
pub fn clamp_position_to_visible(window: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    const PET_SIZE: f64 = 120.0;
    const SAFE_MARGIN: f64 = 8.0;
    const HALF_OFF_TOLERANCE: f64 = 40.0;

    let Ok(monitors) = window.available_monitors() else {
        return (80.0, 80.0);
    };
    if monitors.is_empty() {
        return (80.0, 80.0);
    }

    let already_visible = monitors.iter().any(|m| {
        let (lx, ly, lw, lh) = monitor_logical_rect(m);
        x + HALF_OFF_TOLERANCE > lx
            && x < lx + lw - HALF_OFF_TOLERANCE
            && y + HALF_OFF_TOLERANCE > ly
            && y < ly + lh - HALF_OFF_TOLERANCE
    });
    if already_visible {
        return (x, y);
    }

    let mut best: Option<(f64, f64, f64)> = None;
    for m in &monitors {
        let (lx, ly, lw, lh) = monitor_logical_rect(m);
        let cx = x.clamp(
            lx + SAFE_MARGIN,
            (lx + lw - PET_SIZE - SAFE_MARGIN).max(lx + SAFE_MARGIN),
        );
        let cy = y.clamp(
            ly + SAFE_MARGIN,
            (ly + lh - PET_SIZE - SAFE_MARGIN).max(ly + SAFE_MARGIN),
        );
        let dist = (cx - x).powi(2) + (cy - y).powi(2);
        if best.is_none_or(|b| dist < b.0) {
            best = Some((dist, cx, cy));
        }
    }
    best.map(|(_, cx, cy)| (cx, cy)).unwrap_or((80.0, 80.0))
}

fn monitor_logical_rect(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    (
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

fn parse_ai_engine(ai_engine: &str) -> AppResult<CliTool> {
    match ai_engine.trim().to_ascii_lowercase().as_str() {
        "claude" => Ok(CliTool::Claude),
        "codex" => Ok(CliTool::Codex),
        other => Err(AppError::from(format!(
            "Unsupported ccchan aiEngine '{}'; expected 'claude' or 'codex'",
            other
        ))),
    }
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

fn file_asset_url(path: &Path) -> String {
    let path_text = path.to_string_lossy();
    let encoded = urlencoding::encode(&path_text);
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

fn current_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
