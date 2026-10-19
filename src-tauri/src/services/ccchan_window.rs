use crate::utils::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, PhysicalPosition, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CCChanWindowMode {
    #[default]
    Collapsed,
    Bubble,
    Menu,
    Chat,
}

#[derive(Default)]
pub struct WindowPlacement {
    anchor: Option<(f64, f64)>,
}

#[derive(Serialize)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

pub fn window_size_for(mode: CCChanWindowMode, size: f64) -> (f64, f64) {
    match mode {
        CCChanWindowMode::Collapsed => (size, size),
        CCChanWindowMode::Bubble => ((size + 180.0).max(300.0), (size + 100.0).max(220.0)),
        CCChanWindowMode::Menu => ((size + 180.0).max(300.0), (size + 160.0).max(280.0)),
        CCChanWindowMode::Chat => ((size + 340.0).max(460.0), (size + 560.0).max(680.0)),
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

// Use one physical desktop coordinate system when choosing between monitors.
// Dividing each monitor's origin by its own DPI invents gaps/overlaps.
fn work_areas(window: &WebviewWindow) -> Vec<Rect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            Rect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        })
        .collect()
}

fn fit_window(x: f64, y: f64, width: f64, height: f64, areas: &[Rect]) -> Rect {
    let fallback = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let area = areas
        .iter()
        .min_by(|a, b| {
            let distance = |r: &Rect| {
                (x - x.clamp(r.x, r.x + r.width)).powi(2)
                    + (y - y.clamp(r.y, r.y + r.height)).powi(2)
            };
            distance(a).total_cmp(&distance(b))
        })
        .unwrap_or(&fallback);
    let width = width.min(area.width).max(1.0);
    let height = height.min(area.height).max(1.0);
    Rect {
        x: x.clamp(area.x, area.x + area.width - width),
        y: y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    }
}

impl WindowPlacement {
    pub fn resize(
        &mut self,
        window: &WebviewWindow,
        mode: CCChanWindowMode,
        size: f64,
    ) -> AppResult<WindowSize> {
        let scale = window
            .scale_factor()
            .map_err(|e| AppError::from(e.to_string()))?;
        let pos = window
            .outer_position()
            .map_err(|e| AppError::from(e.to_string()))?;
        let anchor = self.anchor.unwrap_or((pos.x as f64, pos.y as f64));
        let (width, height) = window_size_for(mode, size);
        let (offset_x, offset_y) = if mode == CCChanWindowMode::Bubble {
            (10.0, (height - size - 4.0).max(0.0))
        } else {
            (0.0, 0.0)
        };
        let rect = fit_window(
            anchor.0 - offset_x * scale,
            anchor.1 - offset_y * scale,
            width * scale,
            height * scale,
            &work_areas(window),
        );
        window
            .set_size(LogicalSize::new(rect.width / scale, rect.height / scale))
            .map_err(|e| AppError::from(e.to_string()))?;
        window
            .set_position(PhysicalPosition::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
            ))
            .map_err(|e| AppError::from(e.to_string()))?;
        self.anchor = if mode == CCChanWindowMode::Collapsed {
            None
        } else {
            Some(anchor)
        };
        Ok(WindowSize {
            width: rect.width / scale,
            height: rect.height / scale,
        })
    }

    pub fn move_to(&mut self, window: &WebviewWindow, x: f64, y: f64) -> AppResult<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() {
            return Err(AppError::from("Window position must be finite"));
        }
        let scale = window
            .scale_factor()
            .map_err(|e| AppError::from(e.to_string()))?;
        let old = window
            .outer_position()
            .map_err(|e| AppError::from(e.to_string()))?;
        let size = window
            .outer_size()
            .map_err(|e| AppError::from(e.to_string()))?;
        let rect = fit_window(
            x * scale,
            y * scale,
            size.width as f64,
            size.height as f64,
            &work_areas(window),
        );
        window
            .set_position(PhysicalPosition::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
            ))
            .map_err(|e| AppError::from(e.to_string()))?;
        if let Some((ax, ay)) = self.anchor.as_mut() {
            *ax += rect.x - old.x as f64;
            *ay += rect.y - old.y as f64;
        }
        let anchor = self.anchor.unwrap_or((rect.x, rect.y));
        Ok((anchor.0 / scale, anchor.1 / scale))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expansion_at_bottom_right_keeps_chat_inside_work_area() {
        let areas = [Rect {
            x: 0.0,
            y: 24.0,
            width: 1440.0,
            height: 816.0,
        }];
        let r = fit_window(1300.0, 710.0, 460.0, 680.0, &areas);
        assert_eq!((r.x, r.y, r.width, r.height), (980.0, 160.0, 460.0, 680.0));
    }
    #[test]
    fn small_display_caps_size_and_negative_monitor_keeps_its_origin() {
        let areas = [Rect {
            x: -1280.0,
            y: -100.0,
            width: 1280.0,
            height: 600.0,
        }];
        let r = fit_window(-10.0, 450.0, 580.0, 800.0, &areas);
        assert_eq!(
            (r.x, r.y, r.width, r.height),
            (-580.0, -100.0, 580.0, 600.0)
        );
    }
}
