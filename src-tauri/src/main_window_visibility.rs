//! 主窗口看不见时，让 WebView2 也知道自己看不见。
//!
//! `window.hide()`（关到托盘）和最小化只改 Win32 窗口；wry 只在 `WebView::set_visible`
//! 里调 `SetIsVisible`，所以 WebView2 照常合成、内存不回落，页面的 `visibilitychange`
//! 也只能指望 Chromium 的遮挡检测。这里在主窗口 HWND 上挂子类：托盘、单实例唤起、
//! 全局快捷键、最小化/还原，无论走哪个入口，可见性变化都会经过 `WM_WINDOWPOSCHANGED`。
//! 看不见时 `SetIsVisible(false)` + 内存目标 LOW，看得见时恢复 NORMAL。
//! 同样做法的 Argus（Tauri 2 任务管理器）实测：托盘约 1.1% 单核 / 130 MB，可见约 4.3% / 500 MB。

use std::sync::atomic::{AtomicBool, Ordering};

static MAIN_WINDOW_HIDDEN: AtomicBool = AtomicBool::new(false);

/// 主窗口当前是否隐藏或最小化。只用于降频这类“晚一点也无妨”的决策。
pub(crate) fn main_window_hidden() -> bool {
    MAIN_WINDOW_HIDDEN.load(Ordering::Relaxed)
}

#[cfg(windows)]
mod imp {
    use super::MAIN_WINDOW_HIDDEN;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, WA_INACTIVE, WM_ACTIVATE, WM_NCDESTROY, WM_WINDOWPOSCHANGED,
    };
    use windows_core_061::Interface;

    const SUBCLASS_ID: usize = 0x4343_5649;

    struct State {
        controller: ICoreWebView2Controller,
        // SetIsVisible 可能同步派发消息再进到这里，用 Cell 而不是 &mut 避免重入别名。
        visible: Cell<bool>,
    }

    unsafe fn window_shown(hwnd: HWND) -> bool {
        IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool()
    }

    unsafe fn apply(state: &State, visible: bool) {
        if state.visible.replace(visible) == visible {
            return;
        }
        MAIN_WINDOW_HIDDEN.store(!visible, Ordering::Relaxed);
        if let Err(error) = state.controller.SetIsVisible(visible) {
            log::warn!("[window-visibility] SetIsVisible({visible}) failed: {error}");
        }
        let level = if visible {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        };
        // ICoreWebView2_19 需要 WebView2 Runtime 114+；拿不到就只做 SetIsVisible。
        if let Ok(core) = state
            .controller
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_19>())
        {
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
        log::info!("[window-visibility] main webview visible={visible}");
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        refdata: usize,
    ) -> LRESULT {
        let state = refdata as *const State;
        match msg {
            WM_WINDOWPOSCHANGED => apply(&*state, window_shown(hwnd)),
            // 兜底：窗口被激活却仍判成不可见，用户会看到白屏，宁可多校一次。
            WM_ACTIVATE if (wparam.0 & 0xFFFF) as u32 != WA_INACTIVE => {
                apply(&*state, window_shown(hwnd))
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                drop(Box::from_raw(state as *mut State));
                MAIN_WINDOW_HIDDEN.store(false, Ordering::Relaxed);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub(super) fn install(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
        let hwnd = window.hwnd()?.0 as isize;
        window.with_webview(move |webview| {
            let hwnd = HWND(hwnd as *mut _);
            let state = Box::into_raw(Box::new(State {
                controller: webview.controller(),
                visible: Cell::new(true),
            }));
            unsafe {
                if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, state as usize)
                    .as_bool()
                {
                    drop(Box::from_raw(state));
                    log::warn!("[window-visibility] SetWindowSubclass failed");
                    return;
                }
                apply(&*state, window_shown(hwnd));
            }
        })?;
        Ok(())
    }
}

/// 在主窗口上安装可见性同步。窗口重建后要重新调用（旧子类随旧窗口在 WM_NCDESTROY 摘除）。
pub(crate) fn install(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        imp::install(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}
