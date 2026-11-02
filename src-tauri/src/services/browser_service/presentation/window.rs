use super::window_geometry::{window_plan, WindowGeometry, WorkArea};
use super::*;
use tauri::{PhysicalSize, WebviewWindowBuilder, Window, WindowEvent};

fn current_geometry(window: &Window) -> AppResult<WindowGeometry> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(WindowGeometry {
        position: window.outer_position().map_err(|e| e.to_string())?,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

fn work_area(window: &Window) -> AppResult<WorkArea> {
    let monitor = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => monitor,
        None => window
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("Browser monitor work area is unavailable")?,
    };
    let area = monitor.work_area();
    Ok(WorkArea {
        position: area.position,
        size: area.size,
        scale: monitor.scale_factor(),
    })
}

fn configure_window(
    window: &Window,
    mode: BrowserWindowMode,
    area: WorkArea,
    restore: Option<WindowGeometry>,
) -> AppResult<BrowserBounds> {
    window
        .set_min_size(None::<PhysicalSize<u32>>)
        .map_err(|e| e.to_string())?;
    window
        .set_decorations(mode != BrowserWindowMode::Mini)
        .map_err(|e| e.to_string())?;
    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_always_on_top(mode == BrowserWindowMode::Mini)
        .map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let current_scale = window.scale_factor().map_err(|e| e.to_string())?;
    let target_pixels =
        |pixels: u32| (f64::from(pixels) / current_scale * area.scale).round() as u32;
    let frame = PhysicalSize::new(
        target_pixels(outer.width.saturating_sub(inner.width)),
        target_pixels(outer.height.saturating_sub(inner.height)),
    );
    let plan = window_plan(mode, area, frame, restore)?;
    window
        .set_position(plan.position)
        .map_err(|e| e.to_string())?;
    window.set_size(plan.size).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(plan.minimum))
        .map_err(|e| e.to_string())?;
    let toolbar = if mode == BrowserWindowMode::Mini {
        40.0
    } else {
        56.0
    };
    BrowserBounds::try_new(
        0.0,
        toolbar,
        f64::from(plan.size.width) / area.scale,
        (f64::from(plan.size.height) / area.scale - toolbar).max(1.0),
    )
}

impl BrowserTabManager {
    pub fn pop_out(self: &std::sync::Arc<Self>, app: &AppHandle, tab_id: &str) -> AppResult<()> {
        self.set_window_mode(app, tab_id, BrowserWindowMode::Window)
            .map(|_| ())
    }

    /// Move or resize the same native page. No navigation, screenshot surrogate, or new page.
    pub fn set_window_mode(
        self: &std::sync::Arc<Self>,
        app: &AppHandle,
        tab_id: &str,
        mode: BrowserWindowMode,
    ) -> AppResult<BrowserHostState> {
        if mode == BrowserWindowMode::Embedded {
            return Err("Use browser_reclaim to return a browser to the main panel".into());
        }
        let _operation = self.try_automation(tab_id)?;
        #[cfg(target_os = "macos")]
        let _native = self
            .native_operation(tab_id)?
            .try_lock_owned()
            .map_err(|_| "Browser snapshot is in progress; retry moving this tab")?;
        let previous = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .get(tab_id)
            .ok_or("Unknown browser tab")?
            .presentation
            .clone();
        let changed = if previous.host == "main" {
            self.detach_window(app, tab_id, mode)
        } else {
            self.change_window_mode(app, tab_id, mode, &previous)
        };
        // Even a partial native failure must report the real owner so the main
        // panel can offer Reclaim instead of leaving an unreachable blank tab.
        let published = self.emit_host(app, tab_id);
        changed?;
        published?;
        self.host_state(app, tab_id)
    }

    fn detach_window(
        self: &std::sync::Arc<Self>,
        app: &AppHandle,
        tab_id: &str,
        mode: BrowserWindowMode,
    ) -> AppResult<()> {
        let label = format!("popup-{}", browser_webview_label(tab_id));
        if app.get_window(&label).is_some() {
            return Err("A previous browser popup is still closing; retry shortly".into());
        }
        let area = work_area(
            &app.get_window("main")
                .ok_or("Main browser window is unavailable")?,
        )?;
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
        .inner_size(480.0, 300.0)
        .decorations(mode != BrowserWindowMode::Mini)
        .always_on_top(mode == BrowserWindowMode::Mini)
        .resizable(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        let native = app.get_window(&label).ok_or("Browser popup unavailable")?;
        // A failed transfer can leave the live page in this popup when rollback
        // also fails. Protect native Close before either outcome can expose it.
        self.install_popup_close(app, tab_id, &native);
        let prepared = configure_window(&native, mode, area, None)
            .and_then(|bounds| self.transfer_host(app, tab_id, &label, bounds, true));
        if let Err(error) = prepared {
            if self.is_host(tab_id, "main") {
                let _ = window.destroy();
            } else {
                self.set_presentation_mode(tab_id, mode, None)?;
                let _ = window.show();
                let _ = self.emit_host(app, tab_id);
            }
            return Err(error);
        }
        self.set_presentation_mode(tab_id, mode, None)?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn change_window_mode(
        &self,
        app: &AppHandle,
        tab_id: &str,
        mode: BrowserWindowMode,
        previous: &BrowserPresentation,
    ) -> AppResult<()> {
        let window = app
            .get_window(&previous.host)
            .ok_or("Browser popup unavailable")?;
        if previous.mode == mode {
            window.unminimize().map_err(|e| e.to_string())?;
            return window.set_focus().map_err(|e| e.to_string().into());
        }
        let old_geometry = current_geometry(&window)?;
        let area = work_area(&window)?;
        let restore = if mode == BrowserWindowMode::Window {
            previous.normal_geometry
        } else {
            None
        };
        let changed = configure_window(&window, mode, area, restore)
            .and_then(|bounds| self.set_bounds_for_host(app, &previous.host, tab_id, bounds));
        if let Err(error) = changed {
            let rollback = configure_window(&window, previous.mode, area, Some(old_geometry))
                .and_then(|_| {
                    self.set_bounds_for_host(app, &previous.host, tab_id, previous.bounds)
                });
            if let Err(rollback) = rollback {
                log::error!("Browser mode rollback failed after {error}: {rollback}");
            }
            return Err(error);
        }
        let normal = if previous.mode == BrowserWindowMode::Window {
            Some(old_geometry)
        } else {
            previous.normal_geometry
        };
        self.set_presentation_mode(tab_id, mode, normal)?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_presentation_mode(
        &self,
        tab_id: &str,
        mode: BrowserWindowMode,
        normal_geometry: Option<WindowGeometry>,
    ) -> AppResult<()> {
        let mut tabs = self
            .tabs
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        let entry = tabs.get_mut(tab_id).ok_or("Unknown browser tab")?;
        entry.presentation.mode = mode;
        entry.presentation.normal_geometry = normal_geometry;
        Ok(())
    }

    fn install_popup_close(
        self: &std::sync::Arc<Self>,
        app: &AppHandle,
        tab_id: &str,
        window: &Window,
    ) {
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
    }
}
