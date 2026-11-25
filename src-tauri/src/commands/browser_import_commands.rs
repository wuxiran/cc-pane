//! 设置 → 浏览器：从本机 Chrome 等导入登录状态（cookies）。

use crate::services::browser_cookie_import::{self, BrowserImportSource};
use crate::utils::{AppError, AppResult};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tracing::info;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCookieImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub domains: usize,
}

#[tauri::command]
pub async fn list_browser_import_sources() -> AppResult<Vec<BrowserImportSource>> {
    tauri::async_runtime::spawn_blocking(browser_cookie_import::list_import_sources)
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub async fn import_browser_cookies(
    app: AppHandle,
    source: String,
    profile: String,
) -> AppResult<BrowserCookieImportResult> {
    // 文件拷贝 + 钥匙串授权框（等用户点）+ 解密，全部离开 async worker。
    let (source_for_task, profile_for_task) = (source.clone(), profile.clone());
    let decoded = tauri::async_runtime::spawn_blocking(move || {
        browser_cookie_import::read_profile_cookies(&source_for_task, &profile_for_task)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))??;

    // 内置浏览器标签与主窗口共用默认数据存储，写到任一 webview 即可被标签共享。
    let webview = app
        .get_webview("main")
        .or_else(|| app.webviews().into_values().next())
        .ok_or_else(|| {
            AppError::coded(
                browser_cookie_import::ERR_NO_WEBVIEW,
                "no webview available to receive cookies",
            )
        })?;

    let mut imported = Vec::with_capacity(decoded.cookies.len());
    let mut failed = decoded.failed;
    for cookie in decoded.cookies {
        // set_cookie 只是把消息投递给主线程，失败意味着事件循环已不可用。
        match webview.set_cookie(cookie.clone()) {
            Ok(()) => imported.push(cookie),
            Err(_) => failed += 1,
        }
    }
    let result = BrowserCookieImportResult {
        imported: imported.len(),
        skipped: decoded.skipped,
        failed,
        domains: browser_cookie_import::count_domains(&imported),
    };
    // 只记录计数，绝不记录 cookie 名 / 值。
    info!(
        source = %source,
        profile = %profile,
        imported = result.imported,
        skipped = result.skipped,
        failed = result.failed,
        domains = result.domains,
        "browser cookies imported"
    );
    Ok(result)
}
