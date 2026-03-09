use crate::models::{MonitorInfo, ScreenshotResult, TempScreenshot};
use crate::utils::AppResult;
use std::path::PathBuf;

/// 获取鼠标当前物理坐标（Windows API: GetCursorPos）
#[cfg(target_os = "windows")]
fn get_cursor_position() -> AppResult<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    unsafe {
        let mut point = POINT { x: 0, y: 0 };
        GetCursorPos(&mut point)
            .map_err(|e| format!("GetCursorPos failed: {}", e))?;
        Ok((point.x, point.y))
    }
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_position() -> AppResult<(i32, i32)> {
    // 非 Windows 平台回退到 (0, 0)，截第一个显示器
    Ok((0, 0))
}

/// 在显示器列表中找到包含指定坐标的显示器
fn find_monitor_at_point(monitors: &[xcap::Monitor], x: i32, y: i32) -> Option<usize> {
    monitors.iter().position(|m| {
        let mx = m.x();
        let my = m.y();
        let mw = m.width() as i32;
        let mh = m.height() as i32;
        x >= mx && x < mx + mw && y >= my && y < my + mh
    })
}

pub struct ScreenshotService;

impl ScreenshotService {
    pub fn new() -> Self {
        Self
    }

    /// 截图保存目录：~/.cc-panes/screenshots/
    pub fn screenshots_dir() -> PathBuf {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cc-panes")
            .join("screenshots");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("Warning: failed to create screenshots dir: {}", e);
        }
        dir
    }

    /// 临时文件目录
    fn temp_dir() -> PathBuf {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cc-panes")
            .join("temp");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("Warning: failed to create temp dir: {}", e);
        }
        dir
    }

    /// 获取鼠标所在显示器的位置和尺寸（极快 <1ms，不截图）
    pub fn get_monitor_info() -> AppResult<MonitorInfo> {
        use xcap::Monitor;

        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        if monitors.is_empty() {
            return Err("No monitor found".into());
        }

        let (cursor_x, cursor_y) = get_cursor_position()?;
        let monitor_idx = find_monitor_at_point(&monitors, cursor_x, cursor_y)
            .unwrap_or(0);

        let monitor = &monitors[monitor_idx];
        Ok(MonitorInfo {
            x: monitor.x(),
            y: monitor.y(),
            width: monitor.width(),
            height: monitor.height(),
        })
    }

    /// 截取鼠标所在的单个显示器，保存为临时 BMP 文件（无压缩，编码极快）
    pub fn capture_current_monitor() -> AppResult<TempScreenshot> {
        use xcap::Monitor;

        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        if monitors.is_empty() {
            return Err("No monitor found".into());
        }

        // 获取鼠标位置，找到对应显示器
        let (cursor_x, cursor_y) = get_cursor_position()?;
        let monitor_idx = find_monitor_at_point(&monitors, cursor_x, cursor_y)
            .unwrap_or(0); // 找不到则回退到第一个显示器

        let monitor = &monitors[monitor_idx];
        let monitor_x = monitor.x();
        let monitor_y = monitor.y();
        let monitor_width = monitor.width();
        let monitor_height = monitor.height();

        // 截取该显示器
        let img = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture monitor '{}': {}", monitor.name(), e))?;

        // 保存为临时 BMP 文件（BMP 无压缩，编码 ~50ms vs PNG ~1-2s）
        let temp_path = Self::temp_dir().join("screenshot_temp.bmp");
        img.save(&temp_path)
            .map_err(|e| format!("Failed to save temp screenshot: {}", e))?;

        Ok(TempScreenshot {
            temp_file_path: temp_path.to_string_lossy().to_string(),
            width: img.width(),
            height: img.height(),
            monitor_x,
            monitor_y,
            monitor_width,
            monitor_height,
        })
    }

    /// 从临时 BMP 文件裁剪区域并保存为最终截图
    pub fn crop_and_save_from_file(
        temp_path: &str,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> AppResult<ScreenshotResult> {
        use image::DynamicImage;

        if w == 0 || h == 0 {
            return Err("Crop region has zero width or height".into());
        }

        // 从文件读取图像
        let img = image::open(temp_path)
            .map_err(|e| format!("Failed to open temp screenshot: {}", e))?;

        let img_width = img.width();
        let img_height = img.height();

        // 边界检查
        if x + w > img_width || y + h > img_height {
            return Err(format!(
                "Crop region ({},{},{},{}) exceeds image bounds ({}x{})",
                x, y, w, h, img_width, img_height
            )
            .into());
        }

        // 裁剪
        let cropped = DynamicImage::crop_imm(&img, x, y, w, h);

        // 生成文件名并保存
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
        let filename = format!("screenshot_{}.png", timestamp);
        let save_dir = Self::screenshots_dir();
        let file_path = save_dir.join(&filename);

        cropped
            .save(&file_path)
            .map_err(|e| format!("Failed to save screenshot: {}", e))?;

        let result = ScreenshotResult {
            file_path: file_path.to_string_lossy().to_string(),
            width: w,
            height: h,
        };

        // 清理临时文件
        let temp_path_owned = temp_path.to_string();
        std::thread::spawn(move || {
            let _ = std::fs::remove_file(&temp_path_owned);
            if let Err(e) = Self::cleanup_old_screenshots(7) {
                eprintln!("Screenshot cleanup error: {}", e);
            }
        });

        Ok(result)
    }

    /// 清理超过 retention_days 天的旧截图
    pub fn cleanup_old_screenshots(retention_days: u32) -> AppResult<()> {
        if retention_days == 0 {
            return Ok(());
        }

        let dir = Self::screenshots_dir();
        let cutoff = std::time::SystemTime::now()
            - std::time::Duration::from_secs(retention_days as u64 * 86400);

        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read screenshots dir: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("png") {
                continue;
            }
            if let Ok(meta) = path.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified < cutoff {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }

        Ok(())
    }
}
