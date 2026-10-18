//! 壁纸命令：文件导入 / 列表 / 删除 / asset URL 解析。
//! 安全校验全部在 core 的 WallpaperService（assetProtocol.scope 是 `**` 全放行）。

use crate::utils::AppResult;
use cc_panes_core::services::{WallpaperFileInfo, WallpaperService};
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub async fn import_wallpaper(
    source_path: String,
    kind: String,
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<WallpaperFileInfo> {
    debug!(kind = %kind, "cmd::import_wallpaper");
    let service = service.inner().clone();
    super::blocking::run(move || service.import_wallpaper(&source_path, &kind)).await
}

#[tauri::command]
pub async fn list_wallpapers(
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<Vec<WallpaperFileInfo>> {
    let service = service.inner().clone();
    super::blocking::run(move || service.list_wallpapers()).await
}

#[tauri::command]
pub async fn remove_wallpaper(
    file: String,
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<()> {
    debug!(file = %file, "cmd::remove_wallpaper");
    let service = service.inner().clone();
    super::blocking::run(move || service.remove_wallpaper(&file)).await
}

/// 解析壁纸相对文件名为前端可用的 asset URL
#[tauri::command]
pub async fn resolve_wallpaper_asset(
    file: String,
    kind: String,
    service: State<'_, Arc<WallpaperService>>,
) -> AppResult<String> {
    let service = service.inner().clone();
    super::blocking::run(move || {
        let path = service.resolve_wallpaper_asset(&file, &kind)?;
        Ok(file_asset_url(&path))
    })
    .await
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
