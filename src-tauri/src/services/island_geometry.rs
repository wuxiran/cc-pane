//! 灵动岛窗口落位的纯计算（无 Tauri 依赖，便于单测）。
//!
//! 点击穿透策略：原生窗口始终**正好等于**当前可见岛的外框——前端每次状态切换
//! （收起 / 展开 / 审批卡 / 细线）量好内容尺寸后上报，后端按停靠边把窗口挪到
//! 目标屏并改尺寸。窗口之外天然不挡点击，Mac / Windows 同一套代码，不依赖
//! `set_ignore_cursor_events` 的逐像素切换（那需要高频跟踪光标，且两端行为不一致）。

/// 物理像素矩形（Windows 是真实桌面坐标；macOS 由 tao 按该屏缩放换算）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 停靠边。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Top,
    Left,
    Right,
}

impl Edge {
    pub fn parse(value: &str) -> Self {
        match value {
            "left" => Self::Left,
            "right" => Self::Right,
            _ => Self::Top,
        }
    }
}

/// 前端可上报的逻辑尺寸上下限：最小是 3px 细线，最大是展开面板 + 审批卡。
pub const MIN_ISLAND_EXTENT: f64 = 3.0;
pub const MAX_ISLAND_WIDTH: f64 = 640.0;
pub const MAX_ISLAND_HEIGHT: f64 = 760.0;

/// 把前端上报的逻辑尺寸钳到合法区间；非有限值视为非法。
pub fn sanitize_size(width: f64, height: f64) -> Option<(f64, f64)> {
    if !width.is_finite() || !height.is_finite() {
        return None;
    }
    Some((
        width.clamp(MIN_ISLAND_EXTENT, MAX_ISLAND_WIDTH),
        height.clamp(MIN_ISLAND_EXTENT, MAX_ISLAND_HEIGHT),
    ))
}

/// 计算窗口在目标区域内的物理外框：顶部居中悬挂，或贴左 / 右边垂直居中。
/// 尺寸超出区域时收窄到区域内，保证窗口不会跨屏。
pub fn place(edge: Edge, area: Area, scale: f64, logical: (f64, f64)) -> Area {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = (logical.0 * scale).round().min(area.width).max(1.0);
    let height = (logical.1 * scale).round().min(area.height).max(1.0);
    let centered_x = area.x + ((area.width - width) / 2.0).round();
    let centered_y = area.y + ((area.height - height) / 2.0).round();
    let (x, y) = match edge {
        Edge::Top => (centered_x, area.y),
        Edge::Left => (area.x, centered_y),
        Edge::Right => (area.x + area.width - width, centered_y),
    };
    Area {
        x,
        y,
        width,
        height,
    }
}

/// 前台窗口是否盖满整块屏幕（允许几像素误差：Windows 无边框全屏常有 ±1 的出入）。
pub fn covers_monitor(window: Area, monitor: Area) -> bool {
    const TOLERANCE: f64 = 2.0;
    window.x <= monitor.x + TOLERANCE
        && window.y <= monitor.y + TOLERANCE
        && window.x + window.width >= monitor.x + monitor.width - TOLERANCE
        && window.y + window.height >= monitor.y + monitor.height - TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 2880.0,
        height: 1800.0,
    };

    #[test]
    fn top_edge_hangs_centered_at_area_top() {
        let placed = place(Edge::Top, SCREEN, 2.0, (200.0, 34.0));
        assert_eq!(
            placed,
            Area {
                x: 1240.0,
                y: 0.0,
                width: 400.0,
                height: 68.0
            }
        );
    }

    #[test]
    fn side_edges_center_vertically_and_stick_to_the_edge() {
        let left = place(Edge::Left, SCREEN, 1.0, (34.0, 120.0));
        assert_eq!((left.x, left.y), (0.0, 840.0));
        let right = place(Edge::Right, SCREEN, 1.0, (34.0, 120.0));
        assert_eq!((right.x, right.y), (2846.0, 840.0));
    }

    #[test]
    fn secondary_monitor_with_negative_origin_keeps_its_offset() {
        let area = Area {
            x: -1920.0,
            y: 120.0,
            width: 1920.0,
            height: 1080.0,
        };
        let placed = place(Edge::Top, area, 1.0, (480.0, 300.0));
        assert_eq!((placed.x, placed.y), (-1200.0, 120.0));
    }

    #[test]
    fn oversized_island_is_clamped_into_the_area() {
        let area = Area {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 200.0,
        };
        let placed = place(Edge::Top, area, 1.0, (480.0, 600.0));
        assert_eq!((placed.width, placed.height), (300.0, 200.0));
        assert_eq!(placed.x, 0.0);
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        let placed = place(Edge::Top, SCREEN, f64::NAN, (100.0, 34.0));
        assert_eq!(placed.width, 100.0);
    }

    #[test]
    fn sanitize_rejects_non_finite_and_clamps_extremes() {
        assert_eq!(sanitize_size(f64::INFINITY, 10.0), None);
        assert_eq!(sanitize_size(0.0, 10_000.0), Some((3.0, MAX_ISLAND_HEIGHT)));
        assert_eq!(sanitize_size(480.0, 34.0), Some((480.0, 34.0)));
    }

    #[test]
    fn edge_parse_defaults_to_top() {
        assert_eq!(Edge::parse("left"), Edge::Left);
        assert_eq!(Edge::parse("right"), Edge::Right);
        assert_eq!(Edge::parse("bogus"), Edge::Top);
    }

    #[test]
    fn covers_monitor_accepts_borderless_fullscreen_and_rejects_work_area_windows() {
        let monitor = Area {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert!(covers_monitor(
            Area {
                x: -1.0,
                y: 0.0,
                width: 1921.0,
                height: 1080.0
            },
            monitor
        ));
        // 普通最大化窗口只盖到任务栏上沿。
        assert!(!covers_monitor(
            Area {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1040.0
            },
            monitor
        ));
        assert!(!covers_monitor(
            Area {
                x: 100.0,
                y: 100.0,
                width: 800.0,
                height: 600.0
            },
            monitor
        ));
    }
}
