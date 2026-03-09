use crate::models::ScreenshotResult;
use crate::utils::AppResult;
use std::path::PathBuf;
use tracing::{error, warn};

/// 内存中的截图结果（无文件 I/O）
pub struct CaptureResult {
    pub image: image::RgbaImage,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub monitor_width: u32,
    pub monitor_height: u32,
}

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

impl Default for ScreenshotService {
    fn default() -> Self {
        Self
    }
}

impl ScreenshotService {
    pub fn new() -> Self {
        Self
    }

    /// 截图保存目录：~/.cc-panes/screenshots/
    pub fn screenshots_dir() -> PathBuf {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(crate::utils::APP_DIR_NAME)
            .join("screenshots");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            warn!("Failed to create screenshots dir: {}", e);
        }
        dir
    }

    /// 截取鼠标所在的单个显示器，直接返回内存中的 RgbaImage（无文件 I/O）
    pub fn capture_to_memory() -> AppResult<CaptureResult> {
        use xcap::Monitor;

        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        if monitors.is_empty() {
            return Err("No monitor found".into());
        }

        let (cursor_x, cursor_y) = get_cursor_position()?;
        let monitor_idx = find_monitor_at_point(&monitors, cursor_x, cursor_y)
            .unwrap_or(0);

        let monitor = &monitors[monitor_idx];
        let img = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture monitor '{}': {}", monitor.name(), e))?;

        Ok(CaptureResult {
            image: img,
            monitor_x: monitor.x(),
            monitor_y: monitor.y(),
            monitor_width: monitor.width(),
            monitor_height: monitor.height(),
        })
    }

    /// 从内存中的 RgbaImage 裁剪区域并保存为 PNG
    pub fn save_cropped(
        img: &image::RgbaImage,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> AppResult<ScreenshotResult> {
        if w == 0 || h == 0 {
            return Err("Crop region has zero width or height".into());
        }

        let img_width = img.width();
        let img_height = img.height();

        if x + w > img_width || y + h > img_height {
            return Err(format!(
                "Crop region ({},{},{},{}) exceeds image bounds ({}x{})",
                x, y, w, h, img_width, img_height
            )
            .into());
        }

        let cropped = image::imageops::crop_imm(img, x, y, w, h).to_image();

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

        std::thread::spawn(move || {
            if let Err(e) = Self::cleanup_old_screenshots(7) {
                error!("Screenshot cleanup error: {}", e);
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
