use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
use tracing::debug;

use crate::services::{
    SettingsService, TerminalDaemonClient, WebAccessLifecycle, WebAccessStatus,
};
use crate::utils::{AppPaths, AppResult};

#[tauri::command]
pub fn get_web_access_status(
    settings_service: State<'_, Arc<SettingsService>>,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<WebAccessStatus> {
    let settings = settings_service.get_settings().web_access;
    Ok(web_access.status(&settings))
}

#[tauri::command]
pub fn start_web_access(
    app: AppHandle,
    app_paths: State<'_, Arc<AppPaths>>,
    settings_service: State<'_, Arc<SettingsService>>,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<WebAccessStatus> {
    debug!("cmd::start_web_access");
    let all_settings = settings_service.get_settings();
    let resource_dir = app.path().resource_dir().ok();
    web_access.start(
        app_paths.inner().as_ref(),
        resource_dir.as_deref(),
        &all_settings.web_access,
        all_settings.terminal.daemon_enabled,
    )
}

#[tauri::command]
pub fn restart_web_access(
    app: AppHandle,
    app_paths: State<'_, Arc<AppPaths>>,
    settings_service: State<'_, Arc<SettingsService>>,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<WebAccessStatus> {
    debug!("cmd::restart_web_access");
    let all_settings = settings_service.get_settings();
    let resource_dir = app.path().resource_dir().ok();
    web_access.restart(
        app_paths.inner().as_ref(),
        resource_dir.as_deref(),
        &all_settings.web_access,
        all_settings.terminal.daemon_enabled,
    )
}

#[tauri::command]
pub fn stop_web_access(
    settings_service: State<'_, Arc<SettingsService>>,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<WebAccessStatus> {
    debug!("cmd::stop_web_access");
    web_access.stop();
    let settings = settings_service.get_settings().web_access;
    Ok(web_access.status(&settings))
}

/// 停止终端 daemon（`cc-panes-daemon.exe`）——更新前调用，释放其对
/// `binaries/cc-panes-daemon.exe` 的文件锁，否则 NSIS 安装程序无法替换该二进制，
/// daemon 侧修复无法通过应用内更新生效。会中断所有 daemon 托管的活会话（更新即将
/// 重启应用，可接受）。无 daemon 运行时为 no-op。
#[tauri::command]
pub fn stop_terminal_daemon(app_paths: State<'_, Arc<AppPaths>>) -> AppResult<()> {
    debug!("cmd::stop_terminal_daemon");
    let manifest = app_paths.runtime_dir().join("daemon-manifest.json");
    if !manifest.exists() {
        return Ok(());
    }
    let client = TerminalDaemonClient::from_manifest_path(&manifest)?;
    // 已在退出 / 连不上都视作已停止，不阻断更新。
    let _ = client.shutdown();
    // 轮询等 daemon 真正退出（HTTP 停服 → 进程退出 → 释放二进制锁），最多 ~3s。
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(3) {
        if client.health().is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[tauri::command]
pub fn open_web_access(
    app: AppHandle,
    settings_service: State<'_, Arc<SettingsService>>,
) -> AppResult<()> {
    debug!("cmd::open_web_access");
    use tauri_plugin_opener::OpenerExt;

    let settings = settings_service.get_settings().web_access;
    let url = crate::services::web_access_local_url(settings.port);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_web_access_password(
    settings_service: State<'_, Arc<SettingsService>>,
    password: String,
) -> AppResult<()> {
    debug!("cmd::set_web_access_password");
    let mut settings = settings_service.get_settings();
    settings.web_access.set_password(&password)?;
    settings_service.update_settings(settings)?;
    Ok(())
}
