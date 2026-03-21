//! Win32 原生全屏选区窗口
//!
//! 用 GDI 绘制截图背景 + 半透明遮罩 + 选区边框 + 尺寸标签。
//! 完全不涉及 WebView，延迟极低（50-150ms）。

#[cfg(target_os = "windows")]
pub use win32_impl::show_selection_overlay;

/// 用户选中的矩形区域（物理像素坐标，相对于截图图像）
#[derive(Debug, Clone, Copy)]
pub struct SelectionRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

// ────────────────── Windows 实现 ──────────────────

#[cfg(target_os = "windows")]
mod win32_impl {
    use super::SelectionRect;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tracing::{debug, error};

    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
    use windows::Win32::UI::WindowsAndMessaging::*;

    /// 窗口过程共享状态
    struct OverlayState {
        /// 背景截图 DC
        bg_dc: HDC,
        _bg_bmp: HBITMAP,
        img_width: i32,
        img_height: i32,
        /// 鼠标拖拽
        dragging: bool,
        start_x: i32,
        start_y: i32,
        end_x: i32,
        end_y: i32,
        /// 是否有有效选区
        has_selection: bool,
        /// 用户确认了选区（松开鼠标）
        confirmed: bool,
        /// 缓存的遮罩位图 DC（避免每次 WM_PAINT 重新分配 GDI 对象）
        mask_dc: HDC,
        mask_bmp: HBITMAP,
    }

    /// 显示全屏选区窗口，返回用户选中的矩形区域（物理像素坐标）。
    /// 阻塞调用，在独立线程的消息循环中运行。
    pub fn show_selection_overlay(
        screenshot: &image::RgbaImage,
        monitor_x: i32,
        monitor_y: i32,
        monitor_width: u32,
        monitor_height: u32,
    ) -> Option<SelectionRect> {
        // 防重入
        static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);
        if OVERLAY_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return None;
        }

        let result = run_overlay(
            screenshot,
            monitor_x,
            monitor_y,
            monitor_width,
            monitor_height,
        );
        OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        result
    }

    fn run_overlay(
        screenshot: &image::RgbaImage,
        monitor_x: i32,
        monitor_y: i32,
        monitor_width: u32,
        monitor_height: u32,
    ) -> Option<SelectionRect> {
        unsafe {
            // 强制本线程使用 Per-Monitor DPI V2，确保窗口坐标使用物理像素
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            let img_w = screenshot.width() as i32;
            let img_h = screenshot.height() as i32;

            debug!(
                "[screenshot-overlay] monitor={}x{} at ({},{}), image={}x{}",
                monitor_width, monitor_height, monitor_x, monitor_y, img_w, img_h
            );

            let hinstance = GetModuleHandleW(None).unwrap_or_default();

            // 注册窗口类（dev/release 使用不同类名，避免并行运行时冲突）
            let class_name = if cfg!(debug_assertions) {
                windows::core::w!("CCPanesDevScreenshotOverlay")
            } else {
                windows::core::w!("CCPanesScreenshotOverlay")
            };
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance.into(),
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                lpszClassName: class_name,
                ..Default::default()
            };
            let atom = RegisterClassExW(&wc);
            if atom == 0 {
                error!("[screenshot-overlay] RegisterClassExW failed");
                return None;
            }

            // 窗口和位图都使用 monitor 物理像素尺寸
            // （DPI aware 后 monitor_width/height 就是物理像素）
            let win_w = monitor_width as i32;
            let win_h = monitor_height as i32;

            // 创建背景位图 DC（缩放到窗口尺寸）
            let screen_dc = GetDC(None);
            let bg_dc = CreateCompatibleDC(Some(screen_dc));
            let bg_bmp = create_bitmap_from_rgba(screen_dc, screenshot, win_w, win_h);
            SelectObject(bg_dc, bg_bmp.into());

            // 预分配遮罩位图（全屏尺寸，全黑），避免每次 WM_PAINT 创建/销毁
            let mask_dc = CreateCompatibleDC(Some(screen_dc));
            let mask_bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: win_w,
                    biHeight: -win_h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut _mask_bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let mask_bmp = CreateDIBSection(
                Some(screen_dc),
                &mask_bmi,
                DIB_RGB_COLORS,
                &mut _mask_bits,
                None,
                0,
            )
            .unwrap_or_default();
            SelectObject(mask_dc, mask_bmp.into());
            // DIBSection 初始化为全零（全黑），正好用于 AlphaBlend 遮罩

            ReleaseDC(None, screen_dc);

            // 初始化共享状态（堆分配，避免栈指针脆弱性）
            let state_box = Box::new(OverlayState {
                bg_dc,
                _bg_bmp: bg_bmp,
                img_width: win_w,
                img_height: win_h,
                dragging: false,
                start_x: 0,
                start_y: 0,
                end_x: 0,
                end_y: 0,
                has_selection: false,
                confirmed: false,
                mask_dc,
                mask_bmp,
            });
            let state_raw = Box::into_raw(state_box);
            let state_ptr = state_raw as isize;

            // 创建全屏窗口（物理像素坐标/尺寸）
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                class_name,
                windows::core::w!("Screenshot Overlay"),
                WS_POPUP | WS_VISIBLE,
                monitor_x,
                monitor_y,
                win_w,
                win_h,
                None,
                None,
                Some(hinstance.into()),
                Some(state_ptr as *const std::ffi::c_void),
            )
            .unwrap_or_default();

            if hwnd.0.is_null() {
                // 清理：回收堆 state + 所有 GDI 资源
                let failed_state = Box::from_raw(state_raw);
                let _ = DeleteDC(failed_state.mask_dc);
                let _ = DeleteObject(failed_state.mask_bmp.into());
                let _ = DeleteDC(bg_dc);
                let _ = DeleteObject(bg_bmp.into());
                let _ = UnregisterClassW(class_name, Some(hinstance.into()));
                return None;
            }

            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);

            // 消息循环
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // 立即销毁窗口（不留残影）
            let _ = DestroyWindow(hwnd);

            // 回收堆分配的 state
            let state = Box::from_raw(state_raw);

            // 读取结果（窗口坐标 → 原始图像坐标）
            let result = if state.confirmed && state.has_selection {
                let (x1, y1, x2, y2) =
                    normalize_rect(state.start_x, state.start_y, state.end_x, state.end_y);
                let sel_w = (x2 - x1) as u32;
                let sel_h = (y2 - y1) as u32;
                if sel_w > 2 && sel_h > 2 {
                    // 如果窗口尺寸和原始图像尺寸不同，映射坐标
                    let scale_x = img_w as f64 / win_w as f64;
                    let scale_y = img_h as f64 / win_h as f64;
                    let mapped_x = (x1 as f64 * scale_x) as u32;
                    let mapped_y = (y1 as f64 * scale_y) as u32;
                    let mapped_w = (sel_w as f64 * scale_x) as u32;
                    let mapped_h = (sel_h as f64 * scale_y) as u32;
                    Some(SelectionRect {
                        x: mapped_x,
                        y: mapped_y,
                        w: mapped_w,
                        h: mapped_h,
                    })
                } else {
                    None
                }
            } else {
                None
            };

            // 清理 GDI 资源（含缓存的遮罩位图）
            let _ = DeleteDC(state.mask_dc);
            let _ = DeleteObject(state.mask_bmp.into());
            let _ = DeleteDC(bg_dc);
            let _ = DeleteObject(bg_bmp.into());
            let _ = UnregisterClassW(class_name, Some(hinstance.into()));

            result
        }
    }

    /// 将 RGBA 图像转为 GDI HBITMAP（缩放到窗口尺寸）
    unsafe fn create_bitmap_from_rgba(
        hdc: HDC,
        img: &image::RgbaImage,
        target_w: i32,
        target_h: i32,
    ) -> HBITMAP {
        let src_w = img.width() as i32;
        let src_h = img.height() as i32;

        // 创建 DIB section（目标尺寸）
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: target_w,
                biHeight: -target_h, // 顶部向下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbmp = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .unwrap_or_default();

        if bits.is_null() {
            return hbmp;
        }

        // 如果源图像和目标尺寸相同，直接复制像素；否则用 StretchBlt
        if src_w == target_w && src_h == target_h {
            // 直接复制像素（RGBA → BGRA）
            let dst_slice =
                std::slice::from_raw_parts_mut(bits as *mut u8, (target_w * target_h * 4) as usize);
            let src = img.as_raw();
            for i in 0..(target_w * target_h) as usize {
                let si = i * 4;
                dst_slice[si] = src[si + 2]; // B
                dst_slice[si + 1] = src[si + 1]; // G
                dst_slice[si + 2] = src[si]; // R
                dst_slice[si + 3] = 255; // A
            }
        } else {
            // 先创建源尺寸位图，再 StretchBlt 缩放
            let src_bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: src_w,
                    biHeight: -src_h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut src_bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let src_bmp =
                CreateDIBSection(Some(hdc), &src_bmi, DIB_RGB_COLORS, &mut src_bits, None, 0)
                    .unwrap_or_default();

            if !src_bits.is_null() {
                let dst_slice = std::slice::from_raw_parts_mut(
                    src_bits as *mut u8,
                    (src_w * src_h * 4) as usize,
                );
                let src = img.as_raw();
                for i in 0..(src_w * src_h) as usize {
                    let si = i * 4;
                    dst_slice[si] = src[si + 2];
                    dst_slice[si + 1] = src[si + 1];
                    dst_slice[si + 2] = src[si];
                    dst_slice[si + 3] = 255;
                }

                let src_dc = CreateCompatibleDC(Some(hdc));
                SelectObject(src_dc, src_bmp.into());
                let dst_dc = CreateCompatibleDC(Some(hdc));
                SelectObject(dst_dc, hbmp.into());

                SetStretchBltMode(dst_dc, HALFTONE);
                let _ = StretchBlt(
                    dst_dc,
                    0,
                    0,
                    target_w,
                    target_h,
                    Some(src_dc),
                    0,
                    0,
                    src_w,
                    src_h,
                    SRCCOPY,
                );

                let _ = DeleteDC(src_dc);
                let _ = DeleteDC(dst_dc);
            }
            let _ = DeleteObject(src_bmp.into());
        }

        hbmp
    }

    /// 规范化矩形（确保 x1 <= x2, y1 <= y2）
    fn normalize_rect(x1: i32, y1: i32, x2: i32, y2: i32) -> (i32, i32, i32, i32) {
        (x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2))
    }

    /// 窗口过程
    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CREATE => {
                // 从 CREATESTRUCT 中取出 state 指针
                let cs = lparam.0 as *const CREATESTRUCTW;
                if !cs.is_null() {
                    let state_ptr = (*cs).lpCreateParams as isize;
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr);
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let state = get_state(hwnd);
                if !state.is_null() {
                    paint(hwnd, &*state);
                }
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                let state = get_state(hwnd);
                if !state.is_null() {
                    let x = (lparam.0 & 0xFFFF) as i16 as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                    (*state).dragging = true;
                    (*state).start_x = x;
                    (*state).start_y = y;
                    (*state).end_x = x;
                    (*state).end_y = y;
                    (*state).has_selection = false;
                    SetCapture(hwnd);
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let state = get_state(hwnd);
                if !state.is_null() && (*state).dragging {
                    let x = (lparam.0 & 0xFFFF) as i16 as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                    (*state).end_x = x;
                    (*state).end_y = y;
                    (*state).has_selection = true;
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                let state = get_state(hwnd);
                if !state.is_null() && (*state).dragging {
                    let x = (lparam.0 & 0xFFFF) as i16 as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                    (*state).end_x = x;
                    (*state).end_y = y;
                    (*state).dragging = false;
                    (*state).has_selection = true;
                    (*state).confirmed = true;
                    let _ = ReleaseCapture();
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            WM_KEYDOWN => {
                if wparam.0 == VK_ESCAPE.0 as usize {
                    let state = get_state(hwnd);
                    if !state.is_null() {
                        (*state).confirmed = false;
                    }
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            WM_SETCURSOR => {
                // 保持十字光标
                let cursor = LoadCursorW(None, IDC_CROSS).unwrap_or_default();
                SetCursor(Some(cursor));
                LRESULT(1)
            }
            WM_ERASEBKGND => {
                // 阻止背景擦除（防闪烁）
                LRESULT(1)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// 从窗口用户数据中获取 state 裸指针（避免 &mut 别名 UB）
    unsafe fn get_state(hwnd: HWND) -> *mut OverlayState {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        if ptr == 0 {
            std::ptr::null_mut()
        } else {
            ptr as *mut OverlayState
        }
    }

    /// 双缓冲绘制：背景截图 + 半透明遮罩 + 选区边框 + 尺寸标签
    unsafe fn paint(hwnd: HWND, state: &OverlayState) {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);

        let w = state.img_width;
        let h = state.img_height;

        // 双缓冲：先绘制到内存 DC
        let mem_dc = CreateCompatibleDC(Some(hdc));
        let mem_bmp = CreateCompatibleBitmap(hdc, w, h);
        let old_bmp = SelectObject(mem_dc, mem_bmp.into());

        // 1. 绘制背景截图
        let _ = BitBlt(mem_dc, 0, 0, w, h, Some(state.bg_dc), 0, 0, SRCCOPY);

        // 2. 绘制半透明遮罩
        if state.has_selection {
            let (x1, y1, x2, y2) =
                normalize_rect(state.start_x, state.start_y, state.end_x, state.end_y);

            // 选区外区域绘制半透明遮罩（分四个矩形，使用缓存的 mask_dc）
            draw_mask_region(mem_dc, state.mask_dc, 0, 0, w, y1); // 上
            draw_mask_region(mem_dc, state.mask_dc, 0, y1, x1, y2); // 左
            draw_mask_region(mem_dc, state.mask_dc, x2, y1, w, y2); // 右
            draw_mask_region(mem_dc, state.mask_dc, 0, y2, w, h); // 下

            // 3. 选区边框（2px 蓝色 #4fc3f7）
            let pen = CreatePen(PS_SOLID, 2, COLORREF(0x00f7c34f)); // BGR: 4f c3 f7
            let old_pen = SelectObject(mem_dc, pen.into());
            let null_brush = GetStockObject(NULL_BRUSH);
            let old_brush = SelectObject(mem_dc, null_brush);
            let _ = Rectangle(mem_dc, x1, y1, x2, y2);
            SelectObject(mem_dc, old_pen);
            SelectObject(mem_dc, old_brush);
            let _ = DeleteObject(pen.into());

            // 4. 尺寸标签
            let sel_w = (x2 - x1).unsigned_abs();
            let sel_h = (y2 - y1).unsigned_abs();
            draw_size_label(mem_dc, x1, y1, sel_w, sel_h);
        } else {
            // 无选区：全屏遮罩
            draw_mask_region(mem_dc, state.mask_dc, 0, 0, w, h);
        }

        // 一次性拷贝到屏幕
        let _ = BitBlt(hdc, 0, 0, w, h, Some(mem_dc), 0, 0, SRCCOPY);

        // 清理
        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(mem_bmp.into());
        let _ = DeleteDC(mem_dc);

        let _ = EndPaint(hwnd, &ps);
    }

    /// 绘制半透明遮罩区域（40% 黑色），使用缓存的 mask_dc 避免高频 GDI 分配
    unsafe fn draw_mask_region(hdc: HDC, mask_dc: HDC, x1: i32, y1: i32, x2: i32, y2: i32) {
        if x2 <= x1 || y2 <= y1 {
            return;
        }

        let rw = x2 - x1;
        let rh = y2 - y1;

        // 使用缓存的全黑 mask_dc，通过 AlphaBlend 从 (0,0) 区域取 rw*rh 像素混合
        let bf = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 102, // 40% = 255 * 0.4
            AlphaFormat: 0,
        };
        let _ = GdiAlphaBlend(hdc, x1, y1, rw, rh, mask_dc, 0, 0, rw, rh, bf);
    }

    /// 在选区上方绘制尺寸标签 "宽 x 高"
    unsafe fn draw_size_label(hdc: HDC, x: i32, y: i32, w: u32, h: u32) {
        let text = format!("{} x {}", w, h);
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();

        // 标签位置：选区上方 4px
        let label_y = y - 24;
        let label_y = if label_y < 0 { y + 4 } else { label_y };

        // 创建字体
        let font = CreateFontW(
            16,
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            (FF_SWISS.0 | VARIABLE_PITCH.0) as u32,
            windows::core::w!("Segoe UI"),
        );
        let old_font = SelectObject(hdc, font.into());

        // 测量文本大小
        let mut size = SIZE::default();
        let _ = GetTextExtentPoint32W(hdc, &wide[..wide.len() - 1], &mut size);

        let pad_x = 8;
        let pad_y = 3;
        let bg_rect = RECT {
            left: x,
            top: label_y,
            right: x + size.cx + pad_x * 2,
            bottom: label_y + size.cy + pad_y * 2,
        };

        // 背景（深色半透明）
        let bg_brush = CreateSolidBrush(COLORREF(0x00333333));
        FillRect(hdc, &bg_rect, bg_brush);
        let _ = DeleteObject(bg_brush.into());

        // 文本（白色）
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, COLORREF(0x00FFFFFF));
        let _ = TextOutW(hdc, x + pad_x, label_y + pad_y, &wide[..wide.len() - 1]);

        SelectObject(hdc, old_font);
        let _ = DeleteObject(font.into());
    }
}
