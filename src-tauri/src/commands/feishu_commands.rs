//! 内置组件 · 飞书 CLI 的设置入口（见 services::feishu_cli）。
use crate::services::feishu_cli::{self, FeishuStatus};
use crate::services::{SettingsService, SkillMarketService};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn feishu_cli_status(
    market: State<'_, Arc<SkillMarketService>>,
) -> AppResult<FeishuStatus> {
    let market = market.inner().clone();
    Ok(feishu_cli::status(&market).await)
}

#[tauri::command]
pub fn feishu_cli_install(settings: State<'_, Arc<SettingsService>>) -> AppResult<()> {
    feishu_cli::start_install(settings.get_settings().proxy).map_err(Into::into)
}

/// step：config（创建/绑定应用）或 login（用户授权），都要在浏览器里确认
#[tauri::command]
pub fn feishu_cli_start(step: String) -> AppResult<()> {
    let kind = match step.as_str() {
        "config" => "config",
        "login" => "login",
        _ => return Err(format!("unknown step {step}").into()),
    };
    feishu_cli::start_browser_step(kind).map_err(Into::into)
}

#[tauri::command]
pub fn feishu_cli_install_skills(market: State<'_, Arc<SkillMarketService>>) -> AppResult<()> {
    feishu_cli::start_skills(market.inner().clone()).map_err(Into::into)
}

#[tauri::command]
pub fn feishu_cli_cancel() {
    feishu_cli::cancel();
}

#[tauri::command]
pub async fn feishu_cli_logout() -> AppResult<()> {
    feishu_cli::logout().await.map_err(Into::into)
}
