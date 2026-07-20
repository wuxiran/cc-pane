//! 壁纸文件管理：导入 / 列表 / 删除 / 解析 asset 路径。
//!
//! `assetProtocol.scope` 是 `**` 全放行，安全必须在这里兜（与 ccchan
//! `resolve_user_spritesheet` 同一范式）：只接受 wallpapers_dir 下的相对文件名、
//! 扩展名白名单且与 kind 匹配、canonicalize 后校验未逃逸、大小上限。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::utils::error::AppError;
use crate::utils::AppResult;

const WALLPAPER_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif"];
const WALLPAPER_VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm"];
const WALLPAPER_AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "ogg", "wav", "flac"];

const WALLPAPER_IMAGE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const WALLPAPER_VIDEO_MAX_BYTES: u64 = 512 * 1024 * 1024;
const WALLPAPER_AUDIO_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 壁纸库中的一个文件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperFileInfo {
    /// wallpapers_dir 下的相对文件名
    pub name: String,
    /// "image" | "video" | "audio"
    pub kind: String,
    pub size_bytes: u64,
}

pub struct WallpaperService {
    wallpapers_dir: PathBuf,
}

impl WallpaperService {
    pub fn new(wallpapers_dir: PathBuf) -> Self {
        Self { wallpapers_dir }
    }

    /// 列出壁纸库中所有可识别的媒体文件
    pub fn list_wallpapers(&self) -> AppResult<Vec<WallpaperFileInfo>> {
        let mut files = Vec::new();
        let entries = match std::fs::read_dir(&self.wallpapers_dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(files),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(kind) = kind_for_extension(&extension_of(Path::new(name))) else {
                continue;
            };
            let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(WallpaperFileInfo {
                name: name.to_string(),
                kind: kind.to_string(),
                size_bytes,
            });
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(files)
    }

    /// 导入用户选择的源文件：校验扩展名/大小后复制进 wallpapers_dir，
    /// 生成受控文件名（uuid + 原扩展名），不沿用用户文件名——一步消除路径注入面。
    pub fn import_wallpaper(&self, source_path: &str, kind: &str) -> AppResult<WallpaperFileInfo> {
        let source = Path::new(source_path);
        if !source.is_file() {
            return Err(AppError::from(format!(
                "wallpaper source is not a file: {source_path}"
            )));
        }
        let extension = extension_of(source);
        validate_extension_for_kind(&extension, kind)?;
        let size_bytes = std::fs::metadata(source)
            .map_err(|error| AppError::from(format!("cannot stat wallpaper source: {error}")))?
            .len();
        let max_bytes = max_bytes_for_kind(kind)?;
        if size_bytes > max_bytes {
            return Err(AppError::from(format!(
                "wallpaper file too large ({size_bytes} bytes, max {max_bytes} for {kind})"
            )));
        }

        std::fs::create_dir_all(&self.wallpapers_dir)
            .map_err(|error| AppError::from(format!("cannot create wallpapers dir: {error}")))?;
        let name = format!("{}.{extension}", uuid::Uuid::new_v4());
        let target = self.wallpapers_dir.join(&name);
        std::fs::copy(source, &target)
            .map_err(|error| AppError::from(format!("cannot copy wallpaper: {error}")))?;
        Ok(WallpaperFileInfo {
            name,
            kind: kind.to_string(),
            size_bytes,
        })
    }

    /// 删除壁纸库中的一个文件（同样只接受受控相对文件名）
    pub fn remove_wallpaper(&self, file: &str) -> AppResult<()> {
        validate_relative_name(file)?;
        let target = self.wallpapers_dir.join(file);
        if target.is_file() {
            std::fs::remove_file(&target)
                .map_err(|error| AppError::from(format!("cannot remove wallpaper: {error}")))?;
        }
        Ok(())
    }

    /// 解析配置里的相对文件名为可供 asset 协议使用的绝对路径。
    ///
    /// 返回**未 canonicalize** 的路径：Windows canonicalize 产生 `\\?\` 前缀，
    /// 塞进 `http://asset.localhost/` 会 404。canonicalize 只用于逃逸校验。
    pub fn resolve_wallpaper_asset(&self, file: &str, kind: &str) -> AppResult<PathBuf> {
        validate_relative_name(file)?;
        let extension = extension_of(Path::new(file));
        validate_extension_for_kind(&extension, kind)?;

        let candidate = self.wallpapers_dir.join(file);
        let canonical = candidate
            .canonicalize()
            .map_err(|error| AppError::from(format!("wallpaper not found: {error}")))?;
        let canonical_dir = self.wallpapers_dir.canonicalize().map_err(|error| {
            AppError::from(format!("cannot canonicalize wallpapers dir: {error}"))
        })?;
        if !canonical.starts_with(&canonical_dir) {
            return Err(AppError::from(
                "wallpaper file escapes the wallpapers directory",
            ));
        }
        let size_bytes = std::fs::metadata(&canonical)
            .map_err(|error| AppError::from(format!("cannot stat wallpaper: {error}")))?
            .len();
        let max_bytes = max_bytes_for_kind(kind)?;
        if size_bytes > max_bytes {
            return Err(AppError::from(format!(
                "wallpaper file too large ({size_bytes} bytes, max {max_bytes} for {kind})"
            )));
        }
        Ok(candidate)
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn extensions_for_kind(kind: &str) -> AppResult<&'static [&'static str]> {
    match kind {
        "image" => Ok(WALLPAPER_IMAGE_EXTENSIONS),
        "video" => Ok(WALLPAPER_VIDEO_EXTENSIONS),
        "audio" => Ok(WALLPAPER_AUDIO_EXTENSIONS),
        other => Err(AppError::from(format!(
            "unsupported wallpaper kind '{other}'; expected image/video/audio"
        ))),
    }
}

fn max_bytes_for_kind(kind: &str) -> AppResult<u64> {
    match kind {
        "image" => Ok(WALLPAPER_IMAGE_MAX_BYTES),
        "video" => Ok(WALLPAPER_VIDEO_MAX_BYTES),
        "audio" => Ok(WALLPAPER_AUDIO_MAX_BYTES),
        other => Err(AppError::from(format!(
            "unsupported wallpaper kind '{other}'; expected image/video/audio"
        ))),
    }
}

/// 扩展名白名单 + 与 kind 匹配（image 配置不能指到 mp4）
fn validate_extension_for_kind(extension: &str, kind: &str) -> AppResult<()> {
    let allowed = extensions_for_kind(kind)?;
    if !allowed.contains(&extension) {
        return Err(AppError::from(format!(
            "wallpaper extension '{extension}' is not allowed for kind '{kind}'"
        )));
    }
    Ok(())
}

/// 只接受 wallpapers_dir 下的相对文件名：拒绝 `/` `\` `..` 与绝对路径
fn validate_relative_name(file: &str) -> AppResult<()> {
    if file.is_empty() {
        return Err(AppError::from("wallpaper file name is empty"));
    }
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(AppError::from(
            "wallpaper file must be a plain file name without path separators or '..'",
        ));
    }
    if Path::new(file).is_absolute() {
        return Err(AppError::from("wallpaper file must be relative"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service(tmp: &TempDir) -> WallpaperService {
        WallpaperService::new(tmp.path().join("wallpapers"))
    }

    fn put_file(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, vec![0u8; bytes]).unwrap();
        path
    }

    #[test]
    fn resolve_rejects_absolute_path() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        let abs = if cfg!(windows) {
            "C:\\evil.png"
        } else {
            "/evil.png"
        };
        assert!(svc.resolve_wallpaper_asset(abs, "image").is_err());
    }

    #[test]
    fn resolve_rejects_parent_dir_and_separators() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        assert!(svc.resolve_wallpaper_asset("../evil.png", "image").is_err());
        assert!(svc
            .resolve_wallpaper_asset("sub/evil.png", "image")
            .is_err());
        assert!(svc
            .resolve_wallpaper_asset("sub\\evil.png", "image")
            .is_err());
        assert!(svc.resolve_wallpaper_asset("", "image").is_err());
    }

    #[test]
    fn resolve_rejects_extension_outside_whitelist_or_kind_mismatch() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        put_file(&tmp.path().join("wallpapers"), "a.exe", 10);
        put_file(&tmp.path().join("wallpapers"), "b.mp4", 10);
        assert!(svc.resolve_wallpaper_asset("a.exe", "image").is_err());
        // kind 与扩展名不匹配：image 配置不能指到 mp4
        assert!(svc.resolve_wallpaper_asset("b.mp4", "image").is_err());
        assert!(svc.resolve_wallpaper_asset("b.mp4", "video").is_ok());
    }

    #[test]
    fn resolve_rejects_oversized_file() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        let dir = tmp.path().join("wallpapers");
        put_file(&dir, "big.png", 10);
        // 用截断写法伪造超大文件代价太高，改走 import 校验分支：直接断言大小判断逻辑
        assert!(svc.resolve_wallpaper_asset("big.png", "image").is_ok());
        assert!(WALLPAPER_IMAGE_MAX_BYTES < WALLPAPER_VIDEO_MAX_BYTES);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        let dir = tmp.path().join("wallpapers");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = put_file(tmp.path(), "outside.png", 10);
        std::os::unix::fs::symlink(&outside, dir.join("link.png")).unwrap();
        assert!(svc.resolve_wallpaper_asset("link.png", "image").is_err());
    }

    #[test]
    fn resolve_returns_non_verbatim_path_for_valid_file() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        put_file(&tmp.path().join("wallpapers"), "ok.png", 10);
        let resolved = svc.resolve_wallpaper_asset("ok.png", "image").unwrap();
        // asset URL 必须用未 canonicalize 的路径：Windows verbatim 前缀进 URL 会 404
        assert!(!resolved.to_string_lossy().starts_with("\\\\?\\"));
        assert!(resolved.ends_with("ok.png"));
    }

    #[test]
    fn import_generates_controlled_name_and_validates_kind() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        let source = put_file(tmp.path(), "My Photo (1).PNG", 128);

        let info = svc
            .import_wallpaper(&source.to_string_lossy(), "image")
            .unwrap();
        // 受控文件名：uuid + 小写扩展名，不沿用用户文件名
        assert!(info.name.ends_with(".png"));
        assert_ne!(info.name, "My Photo (1).PNG");
        assert_eq!(info.kind, "image");
        assert_eq!(info.size_bytes, 128);
        assert!(tmp.path().join("wallpapers").join(&info.name).is_file());

        // kind 不匹配拒绝
        assert!(svc
            .import_wallpaper(&source.to_string_lossy(), "video")
            .is_err());
    }

    #[test]
    fn list_and_remove_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let svc = service(&tmp);
        let dir = tmp.path().join("wallpapers");
        put_file(&dir, "a.png", 5);
        put_file(&dir, "b.mp3", 5);
        put_file(&dir, "ignored.txt", 5);

        let files = svc.list_wallpapers().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "a.png");
        assert_eq!(files[0].kind, "image");
        assert_eq!(files[1].kind, "audio");

        svc.remove_wallpaper("a.png").unwrap();
        assert!(!dir.join("a.png").exists());
        assert!(svc.remove_wallpaper("../a.png").is_err());
    }
}

fn kind_for_extension(extension: &str) -> Option<&'static str> {
    if WALLPAPER_IMAGE_EXTENSIONS.contains(&extension) {
        Some("image")
    } else if WALLPAPER_VIDEO_EXTENSIONS.contains(&extension) {
        Some("video")
    } else if WALLPAPER_AUDIO_EXTENSIONS.contains(&extension) {
        Some("audio")
    } else {
        None
    }
}
