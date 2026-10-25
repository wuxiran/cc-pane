//! Native browser geometry and host ownership. Never recreate a page to move it.
use super::*;
use tauri::{WebviewWindowBuilder, WindowEvent};

#[derive(Debug, Clone)]
pub(super) struct BrowserPresentation {
    pub host: String,
    pub bounds: BrowserBounds,
    pub main_bounds: BrowserBounds,
    pub main_visible: bool,
    pub scale: f64,
}
impl BrowserPresentation {
    pub fn new(bounds: BrowserBounds) -> Self {
        Self {
            host: "main".into(),
            bounds,
            main_bounds: bounds,
            main_visible: true,
            scale: 1.0,
        }
    }
}
impl Default for BrowserPresentation {
    fn default() -> Self {
        Self::new(BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHostState {
    pub tab_id: String,
    pub host_window: String,
    pub url: String,
    pub title: String,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewportRequest {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}
impl BrowserViewportRequest {
    fn validate(self) -> AppResult<Self> {
        if ![self.width, self.height, self.scale]
            .iter()
            .all(|n| n.is_finite())
            || !(240.0..=3840.0).contains(&self.width)
            || !(240.0..=2160.0).contains(&self.height)
            || !(0.1..=2.0).contains(&self.scale)
            || self.width * self.height * self.scale * self.scale > 8_300_000.0
        {
            return Err("Browser viewport must be 240–3840 × 240–2160 CSS pixels, scale 10–200%, at most 8.3 million display pixels".into());
        }
        Ok(self)
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewportResult {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub display_width: f64,
    pub display_height: f64,
}

struct ViewportRollback<'a> {
    manager: &'a BrowserTabManager,
    app: &'a AppHandle,
    tab_id: &'a str,
    host: &'a str,
    previous: BrowserPresentation,
    committed: bool,
}
impl Drop for ViewportRollback<'_> {
    fn drop(&mut self) {
        if self.committed || !self.manager.is_host(self.tab_id, self.host) {
            return;
        }
        if let Ok(view) = self.manager.webview(self.app, self.tab_id) {
            if let Err(error) = view.set_zoom(self.previous.scale) {
                log::error!("Could not restore browser zoom: {error}");
            }
            if let Err(error) = self.manager.set_bounds_for_host(
                self.app,
                self.host,
                self.tab_id,
                self.previous.bounds,
            ) {
                log::error!("Could not restore browser bounds: {error}");
            }
            if let Ok(mut tabs) = self.manager.tabs.lock() {
                if let Some(entry) = tabs.get_mut(self.tab_id) {
                    entry.presentation = self.previous.clone();
                }
            }
        }
    }
}

impl BrowserTabManager {
    /// React layout unmount is not a tab close. A detached page remains owned by its popup.
    pub fn release_host(&self, app: &AppHandle, host: &str, tab_id: &str) -> AppResult<()> {
        if host != "main" {
            return Ok(());
        }
        let entry = {
            let mut tabs = self
                .tabs
                .lock()
                .map_err(|_| "browser registry unavailable")?;
            let Some(entry) = tabs.get_mut(tab_id) else {
                return Ok(());
            };
            if entry.presentation.host != "main" {
                entry.presentation.main_visible = false;
                return Ok(());
            }
            // Comparison and removal are atomic with native host transfers.
            tabs.remove(tab_id).ok_or("Unknown browser tab")?
        };
        entry
            .page_state
            .lock()
            .map_err(|_| "browser page unavailable")?
            .invalidate();
        if let Some(view) = app.get_webview(&entry.label) {
            view.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn host_state(&self, app: &AppHandle, tab_id: &str) -> AppResult<BrowserHostState> {
        let view = self.webview(app, tab_id)?;
        let host = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get(tab_id)
            .ok_or("Unknown browser tab")?
            .presentation
            .host
            .clone();
        let title = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get(tab_id)
            .ok_or("Unknown browser tab")?
            .page_state
            .lock()
            .map_err(|_| "browser page unavailable")?
            .title
            .clone();
        Ok(BrowserHostState {
            tab_id: tab_id.into(),
            host_window: host,
            url: view.url().map_err(|e| e.to_string())?.to_string(),
            title,
        })
    }

    pub fn is_host(&self, tab_id: &str, host: &str) -> bool {
        self.tabs
            .lock()
            .ok()
            .and_then(|tabs| {
                tabs.get(tab_id)
                    .map(|entry| entry.presentation.host == host)
            })
            .unwrap_or(false)
    }

    pub fn create_for_host(
        &self,
        app: &AppHandle,
        host: &str,
        tab_id: &str,
        url: &str,
        bounds: BrowserBounds,
        visible: bool,
    ) -> AppResult<()> {
        if self.contains(tab_id) {
            if !self.is_host(tab_id, host) {
                return Ok(());
            }
            // Attachment never reloads an existing document. The frontend explicitly
            // navigates when its already-mounted tab URL changes.
            self.set_bounds_for_host(app, host, tab_id, bounds)?;
            return self.set_visible_for_host(app, host, tab_id, visible, false);
        }
        if host != "main" {
            return Err("Only the main window can create browser tabs".into());
        }
        self.create(app, tab_id, url, bounds, visible)
    }

    pub fn set_bounds_for_host(
        &self,
        app: &AppHandle,
        host: &str,
        tab_id: &str,
        bounds: BrowserBounds,
    ) -> AppResult<()> {
        let bounds = BrowserBounds::try_new(bounds.x, bounds.y, bounds.width, bounds.height)?;
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        let Some(entry) = tabs.get_mut(tab_id) else {
            return Ok(());
        };
        if host == "main" {
            entry.presentation.main_bounds = bounds;
        }
        if entry.presentation.host != host {
            return Ok(());
        }
        if entry.presentation.bounds == bounds {
            return Ok(());
        }
        entry
            .page_state
            .lock()
            .map_err(|_| "browser page unavailable")?
            .invalidate();
        let view = app
            .get_webview(&entry.label)
            .ok_or("Browser view unavailable")?;
        view.set_position(bounds.logical_position())
            .map_err(|e| e.to_string())?;
        view.set_size(bounds.logical_size())
            .map_err(|e| e.to_string())?;
        entry.presentation.bounds = bounds;
        Ok(())
    }

    pub fn set_visible_for_host(
        &self,
        app: &AppHandle,
        host: &str,
        tab_id: &str,
        visible: bool,
        focus: bool,
    ) -> AppResult<()> {
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        let Some(entry) = tabs.get_mut(tab_id) else {
            return Ok(());
        };
        if host == "main" {
            entry.presentation.main_visible = visible;
        }
        if entry.presentation.host != host {
            return Ok(());
        }
        let view = app
            .get_webview(&entry.label)
            .ok_or("Browser view unavailable")?;
        if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())?;
        entry.visibility.user_requested(visible);
        if visible && focus {
            view.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Bounds are the actual on-screen rectangle; requested dimensions are CSS pixels.
    pub async fn set_viewport(
        &self,
        app: &AppHandle,
        host: &str,
        tab_id: &str,
        bounds: BrowserBounds,
        requested: Option<BrowserViewportRequest>,
    ) -> AppResult<BrowserViewportResult> {
        let _operation = self.automation(tab_id)?.lock_owned().await;
        #[cfg(target_os = "macos")]
        let _native = self.native_operation(tab_id)?.lock_owned().await;
        if !self.is_host(tab_id, host) {
            return Err("Browser tab has moved to another window".into());
        }
        let requested = requested
            .map(BrowserViewportRequest::validate)
            .transpose()?;
        let scale = requested.map(|v| v.scale).unwrap_or(1.0);
        let mut actual_bounds = BrowserBounds::try_new(
            bounds.x,
            bounds.y,
            requested.map(|v| v.width * scale).unwrap_or(bounds.width),
            requested.map(|v| v.height * scale).unwrap_or(bounds.height),
        )?;
        // Reject an impossible initial fit before touching native zoom or page tokens.
        if actual_bounds.width > bounds.width + 1.0 || actual_bounds.height > bounds.height + 1.0 {
            return Err("Browser preview does not fit its host; reduce display scale".into());
        }
        let previous = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get(tab_id)
            .ok_or("Unknown browser tab")?
            .presentation
            .clone();
        let mut rollback = ViewportRollback {
            manager: self,
            app,
            tab_id,
            host,
            previous,
            committed: false,
        };
        self.invalidate_snapshot(tab_id)?;
        self.webview(app, tab_id)?
            .set_zoom(scale)
            .map_err(|e| e.to_string())?;
        let mut observed = (0.0, 0.0);
        // WKWebView's non-overlay scrollbar consumes native height at pageZoom < 1.
        // Correct from real layout measurements, bounded to the available host region.
        for attempt in 0..4 {
            if actual_bounds.width > bounds.width + 1.0
                || actual_bounds.height > bounds.height + 1.0
            {
                return Err("Browser preview does not fit its host; reduce display scale".into());
            }
            actual_bounds.x = bounds.x + (bounds.width - actual_bounds.width) / 2.0;
            actual_bounds.y = bounds.y + (bounds.height - actual_bounds.height) / 2.0;
            self.set_bounds_for_host(app, host, tab_id, actual_bounds)?;
            observed = self.read_css_viewport(app, tab_id).await?;
            let Some(target) = requested else {
                break;
            };
            if (target.width - observed.0).abs() <= 2.0 && (target.height - observed.1).abs() <= 2.0
            {
                break;
            }
            if attempt == 3 {
                break;
            }
            actual_bounds.width += (target.width - observed.0) * scale;
            actual_bounds.height += (target.height - observed.1) * scale;
        }
        if let Some(entry) = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get_mut(tab_id)
        {
            entry.presentation.scale = scale;
        }
        rollback.committed = true;
        Ok(BrowserViewportResult {
            width: observed.0,
            height: observed.1,
            scale,
            display_width: actual_bounds.width,
            display_height: actual_bounds.height,
        })
    }

    async fn read_css_viewport(&self, app: &AppHandle, tab_id: &str) -> AppResult<(f64, f64)> {
        let result = self.call_cdp(app, tab_id, "Runtime.evaluate", &browser_evaluate_params(
            "new Promise(resolve => setTimeout(() => resolve({width:innerWidth,height:innerHeight}), 60))"
        )).await?;
        let value: serde_json::Value = serde_json::from_str(&result).map_err(|e| e.to_string())?;
        let size = &value["result"]["value"];
        let dimension = |key: &str| {
            size[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.0)
                .ok_or("Cannot read actual browser viewport")
        };
        Ok((dimension("width")?, dimension("height")?))
    }

    pub fn pop_out(self: &std::sync::Arc<Self>, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        let label = format!("popup-{}", browser_webview_label(tab_id));
        if let Some(window) = app.get_window(&label) {
            window.unminimize().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        let _operation = self.try_automation(tab_id)?;
        #[cfg(target_os = "macos")]
        let _native = self
            .native_operation(tab_id)?
            .try_lock_owned()
            .map_err(|_| "Browser snapshot is in progress; retry moving this tab")?;
        if !self.is_host(tab_id, "main") {
            return Err("Browser already belongs to another window".into());
        }
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(
                format!(
                    "index.html?mode=browser-popup&tabId={}",
                    urlencoding::encode(tab_id)
                )
                .into(),
            ),
        )
        .title("Browser · CC-Panes")
        .inner_size(1100.0, 800.0)
        .min_inner_size(480.0, 360.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        if let Err(error) = self.transfer_host(
            app,
            tab_id,
            &label,
            BrowserBounds::try_new(0.0, 56.0, 1100.0, 744.0)?,
            true,
        ) {
            if self.is_host(tab_id, "main") {
                let _ = window.destroy();
            } else {
                let _ = window.show();
                let _ = self.emit_host(app, tab_id);
            }
            return Err(error);
        }
        let manager = self.clone();
        let handle = app.clone();
        let id = tab_id.to_string();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let (manager, app, id) = (manager.clone(), handle.clone(), id.clone());
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = manager.reclaim(&app, &id).await {
                        log::error!("Could not reclaim browser tab: {error}");
                        let _ = app.emit_to("main", "browser-host-error", error.to_string());
                    }
                });
            }
        });
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        self.emit_host(app, tab_id)?;
        Ok(())
    }

    fn transfer_host(
        &self,
        app: &AppHandle,
        tab_id: &str,
        target: &str,
        bounds: BrowserBounds,
        visible: bool,
    ) -> AppResult<()> {
        let window = app
            .get_window(target)
            .ok_or("Browser host window unavailable")?;
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        let entry = tabs.get_mut(tab_id).ok_or("Unknown browser tab")?;
        let view = app
            .get_webview(&entry.label)
            .ok_or("Browser view unavailable")?;
        entry
            .page_state
            .lock()
            .map_err(|_| "browser page unavailable")?
            .invalidate();
        let previous = entry.presentation.clone();
        let was_visible = entry.visibility.visible;
        let transfer = (|| -> AppResult<()> {
            view.hide().map_err(|e| e.to_string())?;
            view.reparent(&window).map_err(|e| e.to_string())?;
            entry.presentation.host = target.into();
            view.set_zoom(1.0).map_err(|e| e.to_string())?;
            view.set_position(bounds.logical_position())
                .map_err(|e| e.to_string())?;
            view.set_size(bounds.logical_size())
                .map_err(|e| e.to_string())?;
            if visible {
                view.show().map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if let Err(error) = transfer {
            // Restore native parenting and geometry before permitting a failed host to close.
            let restored = app
                .get_window(&previous.host)
                .ok_or("Previous browser host unavailable")
                .and_then(|old| {
                    view.reparent(&old)
                        .map_err(|_| "Could not restore browser host")
                });
            if restored.is_ok() {
                let _ = view.set_zoom(previous.scale);
                let _ = view.set_position(previous.bounds.logical_position());
                let _ = view.set_size(previous.bounds.logical_size());
                if was_visible {
                    let _ = view.show();
                }
                entry.presentation = previous;
            }
            return Err(error);
        }
        entry.presentation.bounds = bounds;
        entry.presentation.scale = 1.0;
        entry.visibility.user_requested(visible);
        Ok(())
    }

    pub async fn reclaim(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        let _operation = self.automation(tab_id)?.lock_owned().await;
        #[cfg(target_os = "macos")]
        let _native = self.native_operation(tab_id)?.lock_owned().await;
        let old = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get(tab_id)
            .ok_or("Unknown browser tab")?
            .presentation
            .clone();
        if old.host == "main" {
            return Ok(());
        }
        self.transfer_host(app, tab_id, "main", old.main_bounds, old.main_visible)?;
        self.emit_host(app, tab_id)?;
        if let Some(window) = app.get_window(&old.host) {
            window.destroy().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn emit_host(&self, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        let state = self.host_state(app, tab_id)?;
        app.emit_to("main", "browser-host-changed", &state)
            .map_err(|e| e.to_string())?;
        if state.host_window != "main" {
            app.emit_to(&state.host_window, "browser-host-changed", &state)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responsive_geometry_rejects_unbounded_allocation() {
        assert!(BrowserViewportRequest {
            width: 1440.0,
            height: 1000.0,
            scale: 0.57
        }
        .validate()
        .is_ok());
        for request in [
            BrowserViewportRequest {
                width: f64::NAN,
                height: 1000.0,
                scale: 1.0,
            },
            BrowserViewportRequest {
                width: 9999.0,
                height: 1000.0,
                scale: 1.0,
            },
            BrowserViewportRequest {
                width: 3840.0,
                height: 2160.0,
                scale: 2.0,
            },
            BrowserViewportRequest {
                width: 1440.0,
                height: 1000.0,
                scale: 0.0,
            },
        ] {
            assert!(request.validate().is_err());
        }
    }
}
