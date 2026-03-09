use serde::{Deserialize, Serialize};

/// 截图结果（裁剪保存后）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub file_path: String,
    pub width: u32,
    pub height: u32,
}

/// 临时截图信息（单显示器模式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempScreenshot {
    /// 临时 BMP 文件路径
    pub temp_file_path: String,
    /// 图像宽度（物理像素）
    pub width: u32,
    /// 图像高度（物理像素）
    pub height: u32,
    /// 目标显示器位置 X（物理像素）
    pub monitor_x: i32,
    /// 目标显示器位置 Y（物理像素）
    pub monitor_y: i32,
    /// 目标显示器宽度（物理像素）
    pub monitor_width: u32,
    /// 目标显示器高度（物理像素）
    pub monitor_height: u32,
}

