use serde::{Deserialize, Serialize};

/// 截图结果（裁剪保存后）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub file_path: String,
    pub width: u32,
    pub height: u32,
}

