//! 任务球外观的窗口操作：展开 / 收起列表时临时改窗口尺寸，换外观时重锚定。
//!
//! 收起时窗口只有球那么大（透明区不挡别的应用）；展开时朝屏幕中心方向扩大，
//! 球在屏幕上的位置保持不动。展开期间的 Moved 事件不吸附、不落盘位置，
//! 收起后再按球格位置正常吸附 + 持久化（拖着展开的列表走也能落到新位置）。

use super::window::{self, Rect, ORB_WINDOW};
use super::{CCChanService, CCCHAN_WINDOW_LABEL};
use crate::models::settings::CCChanAppearance;
use crate::utils::{AppError, AppResult};
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// 告诉前端窗口现在多大、球格画在哪、列表朝哪展开（逻辑像素）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbLayout {
    pub expanded: bool,
    pub width: f64,
    pub height: f64,
    pub orb_x: f64,
    pub orb_y: f64,
    pub align_right: bool,
    pub open_up: bool,
}

impl OrbLayout {
    pub fn collapsed() -> Self {
        Self {
            expanded: false,
            width: ORB_WINDOW,
            height: ORB_WINDOW,
            orb_x: 0.0,
            orb_y: 0.0,
            align_right: false,
            open_up: false,
        }
    }
}

fn err(error: impl ToString) -> AppError {
    AppError::from(error.to_string())
}

fn outer_rect(window: &WebviewWindow) -> AppResult<Rect> {
    let pos = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    Ok(Rect {
        x: pos.x as f64,
        y: pos.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    })
}

fn place(window: &WebviewWindow, rect: Rect) -> AppResult<()> {
    window
        .set_size(PhysicalSize::new(
            rect.width.round() as u32,
            rect.height.round() as u32,
        ))
        .map_err(err)?;
    window
        .set_position(PhysicalPosition::new(
            rect.x.round() as i32,
            rect.y.round() as i32,
        ))
        .map_err(err)
}

impl CCChanService {
    /// 展开 / 收起任务球列表。`panel_height` 为列表内容高度（逻辑像素，后端夹紧）。
    pub fn set_orb_expanded(
        &self,
        app: &AppHandle,
        expanded: bool,
        panel_height: f64,
    ) -> AppResult<OrbLayout> {
        if self.settings().appearance != CCChanAppearance::Orb {
            return Err(AppError::from("ccchan appearance is not orb"));
        }
        let window = app
            .get_webview_window(CCCHAN_WINDOW_LABEL)
            .ok_or_else(|| AppError::from("ccchan window is unavailable"))?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let current = outer_rect(&window)?;
        let (offset_x, offset_y) = self.lock_hit().orb_offset.unwrap_or((0.0, 0.0));
        let cell = Rect {
            x: current.x + offset_x * scale,
            y: current.y + offset_y * scale,
            width: ORB_WINDOW * scale,
            height: ORB_WINDOW * scale,
        };
        if !expanded {
            self.lock_hit().orb_offset = None;
            place(&window, cell)?;
            // 尺寸变了但原点可能没变（不触发 Moved）：显式排一次吸附 + 落盘。
            self.note_moved();
            return Ok(OrbLayout::collapsed());
        }
        let placement =
            window::orb_expanded_placement(cell, panel_height, scale, &window::work_areas(&window));
        self.lock_hit().orb_offset = Some((placement.orb_x, placement.orb_y));
        place(&window, placement.window)?;
        Ok(OrbLayout {
            expanded: true,
            width: placement.window.width / scale,
            height: placement.window.height / scale,
            orb_x: placement.orb_x,
            orb_y: placement.orb_y,
            align_right: placement.align_right,
            open_up: placement.open_up,
        })
    }

    /// 换外观：新尺寸以旧窗口底边中点为锚（角色脚 / 球都在窗口底部），再落盘。
    pub fn switch_appearance(&self, window: &WebviewWindow) -> AppResult<()> {
        let old = outer_rect(window)?;
        self.apply_window_size(window)?;
        let settings = self.settings();
        let scale = window.scale_factor().unwrap_or(1.0);
        let (width, height) =
            window::window_size_for_appearance(settings.appearance, settings.pet_size);
        let rect = window::reanchor_bottom_center(
            old,
            width * scale,
            height * scale,
            &window::work_areas(window),
        );
        window
            .set_position(PhysicalPosition::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
            ))
            .map_err(err)?;
        self.note_moved();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsed_layout_is_orb_sized() {
        let layout = OrbLayout::collapsed();
        assert!(!layout.expanded);
        assert_eq!((layout.width, layout.height), (ORB_WINDOW, ORB_WINDOW));
        let json = serde_json::to_value(layout).unwrap();
        assert_eq!(json["orbX"], 0.0);
        assert_eq!(json["alignRight"], false);
    }
}
