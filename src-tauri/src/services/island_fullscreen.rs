//! 「前台是不是全屏应用」探测，供灵动岛全屏避让（收成 3px 细线）。
//!
//! - Windows：前台窗口（非本进程、非桌面 / 任务栏、非最大化）外框盖满它所在显示器。
//! - macOS：`CGWindowListCopyWindowInfo` 取当前空间里最前面的普通层（layer 0）
//!   非本进程窗口，外框等于某块屏幕的完整 frame。只读窗口外框与 owner pid，
//!   不读窗口标题，所以不需要「屏幕录制」权限。
//! - 其它平台：恒为 false。
//!
//! 只在灵动岛开启且「全屏应用时收成细线」打开时，由 1s 的几何探测节拍调用。

use super::island_geometry::Area;

/// `monitors` 是各屏的逻辑坐标矩形（macOS 用来与 CG 窗口外框比对；Windows 自取显示器）。
pub fn foreground_is_fullscreen(monitors: &[Area]) -> bool {
    imp::foreground_is_fullscreen(monitors)
}

#[cfg(windows)]
mod imp {
    use super::super::island_geometry::{covers_monitor, Area};
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect,
        GetWindowThreadProcessId, IsZoomed,
    };

    const SHELL_CLASSES: &[&str] = &[
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
    ];

    fn rect_area(rect: RECT) -> Area {
        Area {
            x: f64::from(rect.left),
            y: f64::from(rect.top),
            width: f64::from(rect.right - rect.left),
            height: f64::from(rect.bottom - rect.top),
        }
    }

    pub(super) fn foreground_is_fullscreen(_monitors: &[Area]) -> bool {
        // SAFETY: 只读 Win32 查询，句柄来自系统且只在本函数内使用。
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() || hwnd == GetDesktopWindow() || hwnd == GetShellWindow() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == GetCurrentProcessId() {
                return false;
            }
            let mut class = [0u16; 64];
            let len = GetClassNameW(hwnd, &mut class).max(0) as usize;
            let class = String::from_utf16_lossy(&class[..len]);
            if SHELL_CLASSES.contains(&class.as_str()) {
                return false;
            }
            // 任务栏自动隐藏时最大化窗口也会盖满整屏，但它不是全屏应用。
            if IsZoomed(hwnd).as_bool() {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return false;
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return false;
            }
            covers_monitor(rect_area(rect), rect_area(info.rcMonitor))
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::super::island_geometry::{covers_monitor, Area};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{ns_string, NSArray, NSDictionary, NSNumber, NSString};

    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const NULL_WINDOW_ID: u32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // 返回 +1 的 CFArrayRef（Copy 规则），与 NSArray toll-free bridge。
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut AnyObject;
    }

    type Entry = NSDictionary<NSString, AnyObject>;

    fn number(dict: &Entry, key: &NSString) -> Option<f64> {
        dict.objectForKey(key)?
            .downcast::<NSNumber>()
            .ok()
            .map(|n| n.doubleValue())
    }

    fn bounds(dict: &Entry) -> Option<Area> {
        let raw = dict.objectForKey(ns_string!("kCGWindowBounds"))?;
        let bounds = raw.downcast::<NSDictionary>().ok()?;
        // SAFETY: kCGWindowBounds 是 {X,Y,Width,Height} → CFNumber 的字典。
        let bounds: &Entry = unsafe { &*(Retained::as_ptr(&bounds) as *const Entry) };
        Some(Area {
            x: number(bounds, ns_string!("X"))?,
            y: number(bounds, ns_string!("Y"))?,
            width: number(bounds, ns_string!("Width"))?,
            height: number(bounds, ns_string!("Height"))?,
        })
    }

    pub(super) fn foreground_is_fullscreen(monitors: &[Area]) -> bool {
        // SAFETY: CGWindowListCopyWindowInfo 返回自有引用或 NULL。
        let raw = unsafe {
            CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, NULL_WINDOW_ID)
        };
        let Some(list) = (unsafe { Retained::<NSArray<Entry>>::from_raw(raw.cast()) }) else {
            return false;
        };
        let own_pid = f64::from(std::process::id());
        // 列表按前→后排序：第一个 layer 0、非本进程的窗口就是前台应用的最前窗口。
        for entry in list.iter() {
            if number(&entry, ns_string!("kCGWindowLayer")) != Some(0.0) {
                continue;
            }
            if number(&entry, ns_string!("kCGWindowOwnerPID")) == Some(own_pid) {
                continue;
            }
            let Some(frame) = bounds(&entry) else {
                return false;
            };
            return monitors
                .iter()
                .any(|monitor| covers_monitor(frame, *monitor));
        }
        false
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::super::island_geometry::Area;

    pub(super) fn foreground_is_fullscreen(_monitors: &[Area]) -> bool {
        false
    }
}
