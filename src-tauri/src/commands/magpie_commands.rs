//! Magpie 网关实况（只读）：会话路由、供应商额度、实时路由组 / 模型。
//! 请求只发往 127.0.0.1，不带密钥；Magpie 不在线时返回 `available: false`，前端静默隐藏。

use crate::services::{LaunchHistoryService, ProviderService};
use crate::utils::{AppError, AppResult};
use cc_panes_core::models::provider::Provider;
use cc_panes_core::services::{
    MagpieCatalog, MagpieLiveService, MagpieQuotaReport, MagpieRouteStatus,
};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 会话路由只对本机 Claude / Codex 会话有意义：这两家会把自己的会话 id 放进请求头，
/// WSL / SSH 里的 127.0.0.1 也不是宿主机的 Magpie。
fn route_target(
    history: &LaunchHistoryService,
    providers: &ProviderService,
    pty_session_id: &str,
) -> Option<(Provider, String)> {
    let record = history
        .find_by_pty_session_id(pty_session_id)
        .map_err(
            |error| debug!(%pty_session_id, err = %error, "magpie route: history lookup failed"),
        )
        .ok()??;
    let cli = record.cli_tool.trim().to_ascii_lowercase();
    if !matches!(cli.as_str(), "claude" | "codex") {
        return None;
    }
    let runtime = record.runtime_kind.trim();
    if !(runtime.is_empty() || runtime.eq_ignore_ascii_case("local")) {
        return None;
    }
    let provider = providers.get_provider_for_display(record.provider_id.as_deref()?.trim())?;
    Some((provider, record.resume_session_id?))
}

#[tauri::command]
pub async fn get_magpie_session_route(
    magpie: State<'_, Arc<MagpieLiveService>>,
    history: State<'_, Arc<LaunchHistoryService>>,
    providers: State<'_, Arc<ProviderService>>,
    pty_session_id: String,
    after: Option<i64>,
    wait_secs: Option<u32>,
) -> AppResult<MagpieRouteStatus> {
    let history = history.inner().clone();
    let providers = providers.inner().clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        route_target(&history, &providers, &pty_session_id)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?;
    let Some((provider, resume_id)) = target else {
        return Ok(MagpieRouteStatus::unavailable());
    };
    Ok(magpie
        .session_route(Some(&provider), Some(&resume_id), after, wait_secs)
        .await)
}

#[tauri::command]
pub async fn get_magpie_provider_quotas(
    magpie: State<'_, Arc<MagpieLiveService>>,
    providers: State<'_, Arc<ProviderService>>,
    provider_id: String,
) -> AppResult<MagpieQuotaReport> {
    let Some(provider) = providers.get_provider_for_display(&provider_id) else {
        return Ok(MagpieQuotaReport::default());
    };
    Ok(magpie.provider_quotas(&provider).await)
}

#[tauri::command]
pub async fn get_magpie_catalog(
    magpie: State<'_, Arc<MagpieLiveService>>,
    providers: State<'_, Arc<ProviderService>>,
    provider_id: Option<String>,
) -> AppResult<MagpieCatalog> {
    let provider = match provider_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => match providers.get_provider_for_display(id) {
            Some(provider) => Some(provider),
            None => return Ok(MagpieCatalog::default()),
        },
        None => None,
    };
    Ok(magpie.catalog(provider.as_ref()).await)
}
