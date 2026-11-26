//! 从本机 Chromium 系浏览器一次性导入 cookies 到内置浏览器。
//!
//! 内置浏览器标签（`BrowserTabManager` 的子 webview）没有设置 incognito / data_store_identifier，
//! 在 macOS 上和主窗口 webview 共用 `WKWebsiteDataStore.defaultDataStore`，
//! 所以对任一 webview `set_cookie` 都会写进同一个 cookie 库。
//!
//! 安全约束：不记录 cookie 值、钥匙串密码与派生 key；临时拷贝在离开作用域时删除。

pub mod chrome_db;
pub mod crypto;
pub mod sources;

use crate::utils::{AppError, AppResult};
use std::collections::HashSet;
#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};
use tauri::webview::cookie::Cookie;

pub use sources::{BrowserImportProfile, BrowserImportSource};

pub const ERR_UNSUPPORTED_PLATFORM: &str = "BROWSER_IMPORT_UNSUPPORTED_PLATFORM";
pub const ERR_SOURCE_NOT_FOUND: &str = "BROWSER_IMPORT_SOURCE_NOT_FOUND";
pub const ERR_KEYCHAIN_DENIED: &str = "BROWSER_IMPORT_KEYCHAIN_DENIED";
pub const ERR_KEYCHAIN_NOT_FOUND: &str = "BROWSER_IMPORT_KEYCHAIN_NOT_FOUND";
pub const ERR_READ_FAILED: &str = "BROWSER_IMPORT_READ_FAILED";
pub const ERR_NO_WEBVIEW: &str = "BROWSER_IMPORT_NO_WEBVIEW";

/// 解密阶段的产物：待写入的 cookie + 计数。
pub struct DecodedCookies {
    pub cookies: Vec<Cookie<'static>>,
    pub skipped: usize,
    pub failed: usize,
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> AppError {
    AppError::coded(
        ERR_UNSUPPORTED_PLATFORM,
        "Importing browser cookies is only supported on macOS for now",
    )
}

#[cfg(target_os = "macos")]
fn app_support_dir() -> AppResult<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join("Library/Application Support"))
        .ok_or_else(|| AppError::coded(ERR_SOURCE_NOT_FOUND, "home directory is unavailable"))
}

pub fn list_import_sources() -> AppResult<Vec<BrowserImportSource>> {
    #[cfg(target_os = "macos")]
    {
        Ok(sources::list_sources(&app_support_dir()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(unsupported())
    }
}

/// 读取并解密指定浏览器配置的 cookies（阻塞：拷文件 + 钥匙串授权框 + SQLite）。
pub fn read_profile_cookies(source: &str, profile: &str) -> AppResult<DecodedCookies> {
    #[cfg(target_os = "macos")]
    {
        read_profile_cookies_macos(source, profile)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, profile);
        Err(unsupported())
    }
}

#[cfg(target_os = "macos")]
fn read_profile_cookies_macos(source: &str, profile: &str) -> AppResult<DecodedCookies> {
    let not_found = || AppError::coded(ERR_SOURCE_NOT_FOUND, "browser profile not found");
    let browser = sources::find_browser(source).ok_or_else(not_found)?;
    if !sources::is_safe_profile_dir(profile) {
        return Err(not_found());
    }
    let root = sources::browser_root(&app_support_dir()?, browser);
    let local_state = std::fs::read_to_string(root.join("Local State")).map_err(|_| not_found())?;
    if !sources::parse_profiles(&local_state)
        .iter()
        .any(|p| p.id == profile)
    {
        return Err(not_found());
    }
    let db_path = sources::cookies_db_path(&root.join(profile)).ok_or_else(not_found)?;

    let temp = TempCopy::of_sqlite(&db_path)
        .map_err(|e| AppError::coded(ERR_READ_FAILED, format!("copy cookies db: {e}")))?;
    let conn = rusqlite::Connection::open(temp.db_path())
        .map_err(|e| AppError::coded(ERR_READ_FAILED, format!("open cookies db: {e}")))?;
    let schema = chrome_db::schema_version(&conn).unwrap_or(0);
    let rows = chrome_db::read_rows(&conn)
        .map_err(|e| AppError::coded(ERR_READ_FAILED, format!("read cookies: {e}")))?;
    drop(conn);
    drop(temp);

    let needs_key = rows.iter().any(|r| !r.encrypted_value.is_empty());
    let key = if needs_key {
        let password = sources::read_keychain_password(browser).map_err(|e| match e {
            sources::KeychainError::NotFound => {
                AppError::coded(ERR_KEYCHAIN_NOT_FOUND, "safe storage key not found")
            }
            sources::KeychainError::Denied => {
                AppError::coded(ERR_KEYCHAIN_DENIED, "keychain access was denied")
            }
        })?;
        Some(crypto::derive_key(&password))
    } else {
        None
    };

    Ok(decode_rows(&rows, key.as_ref(), schema, now_unix()))
}

#[cfg(target_os = "macos")]
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn decode_rows(
    rows: &[chrome_db::RawCookieRow],
    key: Option<&[u8; crypto::KEY_LEN]>,
    schema: i64,
    now: i64,
) -> DecodedCookies {
    let mut out = DecodedCookies {
        cookies: Vec::with_capacity(rows.len()),
        skipped: 0,
        failed: 0,
    };
    for row in rows {
        match chrome_db::row_to_cookie(row, key, schema, now) {
            Ok(cookie) => out.cookies.push(cookie),
            Err(chrome_db::RowOutcome::Skipped) => out.skipped += 1,
            Err(chrome_db::RowOutcome::Failed) => out.failed += 1,
        }
    }
    out
}

/// 去掉前导点后的去重域名数（UI 里的「覆盖 N 个站点」）。
pub fn count_domains<'a>(cookies: impl IntoIterator<Item = &'a Cookie<'static>>) -> usize {
    cookies
        .into_iter()
        .filter_map(|c| c.domain())
        .map(|d| d.trim_start_matches('.').to_ascii_lowercase())
        .collect::<HashSet<_>>()
        .len()
}

/// `Cookies` 及 -wal/-journal 的临时拷贝；Drop 时整目录删除。
/// 只有 macOS 导入路径用它（其余平台直接报不支持）；测试在所有平台都覆盖它。
#[cfg(any(target_os = "macos", test))]
struct TempCopy {
    dir: PathBuf,
}

#[cfg(any(target_os = "macos", test))]
impl TempCopy {
    fn of_sqlite(src: &Path) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "ccpanes-cookie-import-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir)?;
        let copy = Self { dir };
        std::fs::copy(src, copy.db_path())?;
        let file_name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Cookies");
        for suffix in ["-wal", "-journal"] {
            let side = src.with_file_name(format!("{file_name}{suffix}"));
            if side.is_file() {
                std::fs::copy(&side, copy.dir.join(format!("Cookies{suffix}")))?;
            }
        }
        Ok(copy)
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join("Cookies")
    }
}

#[cfg(any(target_os = "macos", test))]
impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::chrome_db::RawCookieRow;
    use super::*;

    #[test]
    fn browser_decode_rows_counts_outcomes_and_domains() {
        let base = RawCookieRow {
            host_key: ".a.com".into(),
            name: "n".into(),
            value: "v".into(),
            path: "/".into(),
            samesite: -1,
            ..Default::default()
        };
        let mut partitioned = base.clone();
        partitioned.top_frame_site_key = "https://x.com".into();
        let mut encrypted = base.clone();
        encrypted.encrypted_value = b"v10garbage".to_vec();
        let mut other = base.clone();
        other.host_key = "www.b.com".into();
        let mut same_site_as_a = base.clone();
        same_site_as_a.host_key = "a.com".into();
        let decoded = decode_rows(
            &[base, partitioned, encrypted, other, same_site_as_a],
            None,
            24,
            0,
        );
        assert_eq!(decoded.cookies.len(), 3);
        assert_eq!(decoded.skipped, 1);
        assert_eq!(decoded.failed, 1);
        assert_eq!(count_domains(&decoded.cookies), 2);
    }

    #[test]
    fn browser_temp_copy_is_removed_on_drop() {
        let src_dir = std::env::temp_dir().join(format!("ccpanes-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("Cookies");
        std::fs::write(&src, b"db").unwrap();
        std::fs::write(src_dir.join("Cookies-wal"), b"wal").unwrap();
        let copy = TempCopy::of_sqlite(&src).unwrap();
        let dir = copy.dir.clone();
        assert!(dir.join("Cookies-wal").is_file());
        drop(copy);
        assert!(!dir.exists());
        std::fs::remove_dir_all(src_dir).unwrap();
    }
}
