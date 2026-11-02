//! Physical monitor coordinates avoid inventing gaps on mixed-DPI desktops.
use super::*;
use tauri::{PhysicalPosition, PhysicalSize};

#[derive(Debug, Clone, Copy)]
pub(super) struct WindowGeometry {
    pub position: PhysicalPosition<i32>,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Copy)]
pub(super) struct WorkArea {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub scale: f64,
}
#[derive(Debug, Clone, Copy)]
pub(super) struct WindowPlan {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub minimum: PhysicalSize<u32>,
}

pub(super) fn window_plan(
    mode: BrowserWindowMode,
    area: WorkArea,
    frame: PhysicalSize<u32>,
    restore: Option<WindowGeometry>,
) -> AppResult<WindowPlan> {
    if mode == BrowserWindowMode::Embedded
        || !area.scale.is_finite()
        || area.scale <= 0.0
        || area.size.width == 0
        || area.size.height == 0
    {
        return Err("A detached browser requires a valid monitor work area".into());
    }
    let margin = (16.0 * area.scale)
        .min(f64::from(area.size.width) / 10.0)
        .min(f64::from(area.size.height) / 10.0)
        .floor();
    let available = PhysicalSize::new(
        (f64::from(area.size.width.saturating_sub(frame.width)) - 2.0 * margin).max(1.0) as u32,
        (f64::from(area.size.height.saturating_sub(frame.height)) - 2.0 * margin).max(1.0) as u32,
    );
    let (width, height, min_width, min_height) = match mode {
        BrowserWindowMode::Mini => (
            restore.map_or(480.0, |r| r.width),
            restore.map_or(300.0, |r| r.height),
            280.0,
            180.0,
        ),
        _ => (
            restore.map_or(1100.0, |r| r.width),
            restore.map_or(800.0, |r| r.height),
            480.0,
            360.0,
        ),
    };
    let bounded = |value: f64, limit: u32| ((value * area.scale).round() as u32).clamp(1, limit);
    let size = PhysicalSize::new(
        bounded(width, available.width),
        bounded(height, available.height),
    );
    let minimum = PhysicalSize::new(
        bounded(min_width, size.width),
        bounded(min_height, size.height),
    );
    let left = f64::from(area.position.x) + margin;
    let top = f64::from(area.position.y) + margin;
    let right = f64::from(area.position.x) + f64::from(area.size.width)
        - margin
        - f64::from(size.width + frame.width);
    let bottom = f64::from(area.position.y) + f64::from(area.size.height)
        - margin
        - f64::from(size.height + frame.height);
    let (x, y) = if mode == BrowserWindowMode::Mini && restore.is_none() {
        (right, top)
    } else {
        restore.map_or(((left + right) / 2.0, (top + bottom) / 2.0), |r| {
            (f64::from(r.position.x), f64::from(r.position.y))
        })
    };
    Ok(WindowPlan {
        position: PhysicalPosition::new(
            x.clamp(left, right.max(left)).round() as i32,
            y.clamp(top, bottom.max(top)).round() as i32,
        ),
        size,
        minimum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mini_is_top_right_at_logical_size_on_negative_high_dpi_monitor() {
        let area = WorkArea {
            position: PhysicalPosition::new(-2880, 48),
            size: PhysicalSize::new(2880, 1752),
            scale: 2.0,
        };
        let plan =
            window_plan(BrowserWindowMode::Mini, area, PhysicalSize::new(0, 0), None).unwrap();
        assert_eq!(plan.size, PhysicalSize::new(960, 600));
        assert_eq!(plan.position, PhysicalPosition::new(-992, 80));
        assert_eq!(plan.minimum, PhysicalSize::new(560, 360));
    }
    #[test]
    fn small_work_area_clamps_window_and_minimum_with_real_decorations() {
        let area = WorkArea {
            position: PhysicalPosition::new(100, 200),
            size: PhysicalSize::new(320, 240),
            scale: 1.0,
        };
        let frame = PhysicalSize::new(12, 32);
        for mode in [BrowserWindowMode::Mini, BrowserWindowMode::Window] {
            let plan = window_plan(mode, area, frame, None).unwrap();
            assert!(plan.size.width + frame.width < area.size.width);
            assert!(plan.size.height + frame.height < area.size.height);
            assert!(
                plan.minimum.width <= plan.size.width && plan.minimum.height <= plan.size.height
            );
            assert!(plan.position.x >= area.position.x && plan.position.y >= area.position.y);
        }
    }
    #[test]
    fn normal_mode_restores_size_and_clamps_old_monitor_position() {
        let area = WorkArea {
            position: PhysicalPosition::new(0, 24),
            size: PhysicalSize::new(1440, 876),
            scale: 1.0,
        };
        let restore = WindowGeometry {
            position: PhysicalPosition::new(-1800, 50),
            width: 800.0,
            height: 600.0,
        };
        let plan = window_plan(
            BrowserWindowMode::Window,
            area,
            PhysicalSize::new(0, 28),
            Some(restore),
        )
        .unwrap();
        assert_eq!(plan.size, PhysicalSize::new(800, 600));
        assert_eq!(plan.position, PhysicalPosition::new(16, 50));
    }
    #[test]
    fn embedded_and_invalid_monitor_data_cannot_move_a_window() {
        let mut area = WorkArea {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1000, 800),
            scale: 1.0,
        };
        assert!(window_plan(
            BrowserWindowMode::Embedded,
            area,
            PhysicalSize::new(0, 0),
            None
        )
        .is_err());
        area.scale = f64::NAN;
        assert!(window_plan(BrowserWindowMode::Mini, area, PhysicalSize::new(0, 0), None).is_err());
    }
}
