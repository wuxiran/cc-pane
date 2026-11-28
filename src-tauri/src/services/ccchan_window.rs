//! 桌宠窗口几何与点击穿透。
//!
//! 坐标口径统一为**物理像素桌面坐标**：工作区、窗口位置、持久化位置都用
//! 物理像素，混合 DPI 下不会因为「各显示器各除各的 scale」凭空造出缝隙/重叠。
//! 只有前端上报的命中区域是窗口内 CSS 像素，换算时乘本窗口的 scale。

use crate::models::settings::CCChanAppearance;
use serde::Deserialize;
use tauri::WebviewWindow;

/// 气泡/输入区高度（窗口顶部留给气泡）。与前端 petLayout.ts 同步。
pub const BUBBLE_AREA: f64 = 120.0;
/// 悬停控件条高度。
pub const TOOLBAR_AREA: f64 = 30.0;
/// 角色四周的小边距。
pub const PET_PADDING: f64 = 8.0;
/// 气泡最小宽度（单行输入约 260 + 边距）。
pub const MIN_WINDOW_WIDTH: f64 = 280.0;
/// 拖拽松手后距工作区边缘多近就吸附过去（物理像素按 scale 放大）。
pub const SNAP_DISTANCE: f64 = 24.0;

/// 宠物窗口固定尺寸（逻辑像素）：只随角色大小变，不随交互模式变。
/// 透明区域靠点击穿透放行，所以窗口可以比角色大，用来画气泡与控件条。
pub fn window_size_for(pet_size: f64) -> (f64, f64) {
    let width = (pet_size + PET_PADDING * 2.0).max(MIN_WINDOW_WIDTH);
    let height = pet_size + PET_PADDING + TOOLBAR_AREA + BUBBLE_AREA;
    (width, height)
}

/// 任务球直径（逻辑像素）。与前端 orbModel.ts 同步。
pub const ORB_SIZE: f64 = 56.0;
/// 球四周留白：容纳阴影与等待脉冲。
pub const ORB_PADDING: f64 = 14.0;
/// 收起时的任务球窗口边长。
pub const ORB_WINDOW: f64 = ORB_SIZE + ORB_PADDING * 2.0;
/// 展开列表的宽度。
pub const ORB_PANEL_WIDTH: f64 = 320.0;
/// 球格与列表之间的间隙。
pub const ORB_PANEL_GAP: f64 = 4.0;
/// 列表高度上下限（前端按内容上报，后端夹紧）。
pub const ORB_PANEL_MIN_HEIGHT: f64 = 80.0;
pub const ORB_PANEL_MAX_HEIGHT: f64 = 480.0;

/// 按外观给出窗口固定尺寸（逻辑像素）：任务球收起时只有球那么大。
pub fn window_size_for_appearance(appearance: CCChanAppearance, pet_size: f64) -> (f64, f64) {
    match appearance {
        CCChanAppearance::Pet => window_size_for(pet_size),
        CCChanAppearance::Orb => (ORB_WINDOW, ORB_WINDOW),
    }
}

/// 任务球展开后的窗口位置（物理像素）与球格在窗口内的偏移（逻辑像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrbPlacement {
    pub window: Rect,
    pub orb_x: f64,
    pub orb_y: f64,
    pub align_right: bool,
    pub open_up: bool,
}

/// 球格（物理像素，收起窗口那么大）→ 展开窗口：球在屏幕右半边就右对齐，
/// 在下半边就向上展开；夹进工作区后反推球格偏移，保证球在屏幕上不动。
pub fn orb_expanded_placement(
    cell: Rect,
    panel_height: f64,
    scale: f64,
    areas: &[Rect],
) -> OrbPlacement {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let panel_height = if panel_height.is_finite() {
        panel_height.clamp(ORB_PANEL_MIN_HEIGHT, ORB_PANEL_MAX_HEIGHT)
    } else {
        ORB_PANEL_MIN_HEIGHT
    };
    let width = ORB_PANEL_WIDTH.max(ORB_WINDOW) * scale;
    let height = (ORB_WINDOW + ORB_PANEL_GAP + panel_height) * scale;
    let (cx, cy) = (cell.x + cell.width / 2.0, cell.y + cell.height / 2.0);
    let area = *nearest_area(cx, cy, areas, &cell);
    let align_right = cx > area.x + area.width / 2.0;
    let open_up = cy > area.y + area.height / 2.0;
    let x = if align_right {
        cell.x + cell.width - width
    } else {
        cell.x
    };
    let y = if open_up {
        cell.y + cell.height - height
    } else {
        cell.y
    };
    let window = fit_window(x, y, width, height, areas);
    OrbPlacement {
        window,
        orb_x: ((cell.x - window.x) / scale).max(0.0),
        orb_y: ((cell.y - window.y) / scale).max(0.0),
        align_right,
        open_up,
    }
}

/// 换外观时窗口尺寸变化：保持底边中点不动（角色脚、任务球都在窗口底部）。
pub fn reanchor_bottom_center(old: Rect, width: f64, height: f64, areas: &[Rect]) -> Rect {
    let x = old.x + old.width / 2.0 - width / 2.0;
    let y = old.y + old.height - height;
    fit_window(x, y, width, height, areas)
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// 所有显示器的工作区（物理像素）。
pub fn work_areas(window: &WebviewWindow) -> Vec<Rect> {
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

fn nearest_area<'a>(x: f64, y: f64, areas: &'a [Rect], fallback: &'a Rect) -> &'a Rect {
    areas
        .iter()
        .min_by(|a, b| {
            let distance = |r: &Rect| {
                (x - x.clamp(r.x, r.x + r.width)).powi(2)
                    + (y - y.clamp(r.y, r.y + r.height)).powi(2)
            };
            distance(a).total_cmp(&distance(b))
        })
        .unwrap_or(fallback)
}

/// 把窗口（物理像素）夹进离它最近的工作区。
pub fn fit_window(x: f64, y: f64, width: f64, height: f64, areas: &[Rect]) -> Rect {
    let fallback = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let area = nearest_area(x + width / 2.0, y + height / 2.0, areas, &fallback);
    let width = width.min(area.width).max(1.0);
    let height = height.min(area.height).max(1.0);
    Rect {
        x: x.clamp(area.x, area.x + area.width - width),
        y: y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    }
}

/// 夹进工作区后，离左右/下边缘不到 `snap` 的贴过去。顶边不吸附：
/// 窗口顶部是气泡区，贴顶会把角色推离屏幕上沿过远。
pub fn snap_window(rect: Rect, areas: &[Rect], snap: f64) -> Rect {
    let fitted = fit_window(rect.x, rect.y, rect.width, rect.height, areas);
    let fallback = fitted;
    let area = nearest_area(
        fitted.x + fitted.width / 2.0,
        fitted.y + fitted.height / 2.0,
        areas,
        &fallback,
    );
    let mut out = fitted;
    if (out.x - area.x).abs() <= snap {
        out.x = area.x;
    } else if (area.x + area.width - (out.x + out.width)).abs() <= snap {
        out.x = area.x + area.width - out.width;
    }
    if (area.y + area.height - (out.y + out.height)).abs() <= snap {
        out.y = area.y + area.height - out.height;
    }
    out
}

/// 窗口内 CSS 像素命中区域 → 是否命中（光标与窗口原点均为物理像素）。
pub fn hit_test(
    regions: &[Rect],
    cursor: (f64, f64),
    window_origin: (f64, f64),
    scale: f64,
) -> bool {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let local_x = (cursor.0 - window_origin.0) / scale;
    let local_y = (cursor.1 - window_origin.1) / scale;
    regions
        .iter()
        .any(|region| region.contains(local_x, local_y))
}

/// 首帧门闩：新建窗口先不 show，等前端首帧渲染完发 ready 再显示，
/// 避免透明背景注入前闪出一帧不透明底色。超时兜底由调用方按 generation 触发。
#[derive(Default)]
pub struct RevealGate {
    generation: u64,
    ready: bool,
    pending: bool,
}

impl RevealGate {
    /// 窗口即将新建或已销毁：作废旧窗口的 ready 与在途兜底。
    pub fn reset(&mut self) -> u64 {
        self.generation += 1;
        self.ready = false;
        self.pending = false;
        self.generation
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 请求显示；前端已 ready 时返回 true（立即 show），否则挂起等待 ready。
    pub fn request_show(&mut self) -> bool {
        if self.ready {
            return true;
        }
        self.pending = true;
        false
    }

    /// 前端首帧就绪；返回 true 表示有挂起的显示请求需要执行。
    pub fn mark_ready(&mut self) -> bool {
        self.ready = true;
        std::mem::take(&mut self.pending)
    }

    /// 兜底超时到点；仅当同一代窗口仍在挂起时返回 true。
    pub fn take_timeout(&mut self, generation: u64) -> bool {
        generation == self.generation && std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn window_size_is_fixed_per_pet_size() {
        assert_eq!(window_size_for(120.0), (280.0, 278.0));
        assert_eq!(window_size_for(240.0), (280.0, 398.0));
        assert_eq!(window_size_for(80.0).0, 280.0);
    }

    #[test]
    fn orb_window_is_smaller_than_pet_window() {
        assert_eq!(
            window_size_for_appearance(CCChanAppearance::Orb, 240.0),
            (ORB_WINDOW, ORB_WINDOW)
        );
        assert_eq!(
            window_size_for_appearance(CCChanAppearance::Pet, 120.0),
            window_size_for(120.0)
        );
    }

    #[test]
    fn orb_expands_toward_screen_center_and_keeps_orb_in_place() {
        let areas = [area(0.0, 0.0, 1000.0, 800.0)];
        // 左上：向右下展开，球格就在窗口左上角。
        let p = orb_expanded_placement(area(100.0, 100.0, 84.0, 84.0), 200.0, 1.0, &areas);
        assert!(!p.align_right && !p.open_up);
        assert_eq!((p.window.x, p.window.y), (100.0, 100.0));
        assert_eq!((p.orb_x, p.orb_y), (0.0, 0.0));
        // 右下：右对齐、向上展开；球格偏移指向窗口右下角。
        let p = orb_expanded_placement(area(900.0, 700.0, 84.0, 84.0), 200.0, 1.0, &areas);
        assert!(p.align_right && p.open_up);
        assert_eq!(p.window.x + p.orb_x, 900.0);
        assert_eq!(p.window.y + p.orb_y, 700.0);
        assert_eq!(p.orb_x, ORB_PANEL_WIDTH - ORB_WINDOW);
    }

    #[test]
    fn orb_expansion_scales_and_clamps_panel_height() {
        let areas = [area(0.0, 0.0, 4000.0, 3000.0)];
        let p = orb_expanded_placement(area(100.0, 100.0, 168.0, 168.0), 10_000.0, 2.0, &areas);
        assert_eq!(p.window.width, ORB_PANEL_WIDTH * 2.0);
        assert_eq!(
            p.window.height,
            (ORB_WINDOW + ORB_PANEL_GAP + ORB_PANEL_MAX_HEIGHT) * 2.0
        );
    }

    #[test]
    fn appearance_switch_keeps_bottom_center() {
        let areas = [area(0.0, 0.0, 1000.0, 800.0)];
        let r = reanchor_bottom_center(area(300.0, 300.0, 280.0, 278.0), 84.0, 84.0, &areas);
        assert_eq!((r.x, r.y), (398.0, 494.0));
    }

    #[test]
    fn reveal_gate_waits_for_ready_then_shows_once() {
        let mut gate = RevealGate::default();
        let generation = gate.reset();
        assert!(!gate.request_show());
        assert!(gate.mark_ready());
        assert!(!gate.take_timeout(generation));
        assert!(gate.request_show());
    }

    #[test]
    fn reveal_gate_timeout_fires_only_for_current_generation() {
        let mut gate = RevealGate::default();
        let stale = gate.reset();
        assert!(!gate.request_show());
        let current = gate.reset();
        assert!(!gate.request_show());
        assert!(!gate.take_timeout(stale));
        assert!(gate.take_timeout(current));
        assert!(!gate.take_timeout(current));
    }

    #[test]
    fn fit_keeps_window_inside_and_negative_monitor_keeps_origin() {
        let areas = [area(0.0, 24.0, 1440.0, 816.0)];
        let r = fit_window(1300.0, 710.0, 280.0, 278.0, &areas);
        assert_eq!((r.x, r.y), (1160.0, 562.0));
        let areas = [area(-1280.0, -100.0, 1280.0, 600.0)];
        let r = fit_window(-10.0, 450.0, 580.0, 800.0, &areas);
        assert_eq!(
            (r.x, r.y, r.width, r.height),
            (-580.0, -100.0, 580.0, 600.0)
        );
    }

    #[test]
    fn mixed_dpi_monitors_choose_nearest_physical_area() {
        // 左 1x 1920 宽，右 2x（物理 3840 宽）紧邻：物理坐标里没有缝隙。
        let areas = [
            area(0.0, 0.0, 1920.0, 1080.0),
            area(1920.0, 0.0, 3840.0, 2160.0),
        ];
        let r = fit_window(3000.0, 1500.0, 560.0, 556.0, &areas);
        assert_eq!((r.x, r.y), (3000.0, 1500.0));
    }

    #[test]
    fn snap_pulls_window_to_close_edges_only() {
        let areas = [area(0.0, 0.0, 1000.0, 800.0)];
        let snapped = snap_window(area(10.0, 300.0, 200.0, 200.0), &areas, 24.0);
        assert_eq!((snapped.x, snapped.y), (0.0, 300.0));
        let snapped = snap_window(area(500.0, 590.0, 200.0, 200.0), &areas, 24.0);
        assert_eq!((snapped.x, snapped.y), (500.0, 600.0));
        let free = snap_window(area(400.0, 300.0, 200.0, 200.0), &areas, 24.0);
        assert_eq!((free.x, free.y), (400.0, 300.0));
    }

    #[test]
    fn hit_test_converts_physical_cursor_with_window_scale() {
        let regions = [area(80.0, 150.0, 120.0, 120.0)];
        // 2x：窗口原点 (1000,1000)，光标物理 (1000+100*2, 1000+200*2) → CSS (100,200)。
        assert!(hit_test(&regions, (1200.0, 1400.0), (1000.0, 1000.0), 2.0));
        assert!(!hit_test(&regions, (1010.0, 1010.0), (1000.0, 1000.0), 2.0));
        assert!(!hit_test(&[], (1200.0, 1400.0), (1000.0, 1000.0), 2.0));
    }
}
