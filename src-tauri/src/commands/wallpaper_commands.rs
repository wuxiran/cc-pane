//! 壁纸命令：文件导入 / 列表 / 删除 / asset URL 解析。
//! 安全校验全部在 core 的 WallpaperService（assetProtocol.scope 是 `**` 全放行）。

use crate::utils::AppResult;
use cc_panes_core::services::{WallpaperFileInfo, WallpaperService};
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn import_wallpaper(
    source_path: String,
    kind: String,
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<WallpaperFileInfo> {
    debug!(kind = %kind, "cmd::import_wallpaper");
    service.import_wallpaper(&source_path, &kind)
}

#[tauri::command]
pub fn list_wallpapers(
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<Vec<WallpaperFileInfo>> {
    service.list_wallpapers()
}

#[tauri::command]
pub fn remove_wallpaper(file: String, service: State<'_, Arc<WallpaperService>>) -> AppResult<()> {
    debug!(file = %file, "cmd::remove_wallpaper");
    service.remove_wallpaper(&file)
}

/// 解析壁纸相对文件名为前端可用的 asset URL
#[tauri::command]
pub fn resolve_wallpaper_asset(
    file: String,
    kind: String,
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<String> {
    let path = service.resolve_wallpaper_asset(&file, &kind)?;
    Ok(file_asset_url(&path))
}

/// 与 ccchan_service.rs::file_asset_url 同形：路径必须未 canonicalize
/// （Windows `\\?\` 前缀进 URL 会 404）。
fn file_asset_url(path: &Path) -> String {
    let path_text = path.to_string_lossy();
    let encoded = urlencoding::encode(&path_text);
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}
