use crate::services::voice_local::{self, install, LocalVoiceStatus};
use crate::services::voice_service;
use crate::services::SettingsService;
use crate::utils::{AppPaths, AppResult};
use cc_panes_core::models::settings::ProxySettings;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

pub use crate::services::voice_service::{VoiceTranscribeRequest, VoiceTranscribeResponse};

#[tauri::command]
pub async fn transcribe_voice_input(
    settings_service: State<'_, Arc<SettingsService>>,
    app_paths: State<'_, Arc<AppPaths>>,
    request: VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    // 设置页的「试一下」带着草稿设置来：不看是否已启用，直接按草稿转写。
    let settings = match request.settings_override.clone() {
        Some(mut draft) => {
            draft.merge_missing_defaults();
            draft
        }
        None => {
            let saved = settings_service.get_settings().voice;
            if !saved.enabled {
                return Err("Voice input is disabled".into());
            }
            saved
        }
    };
    let local_root = voice_local::root_dir(app_paths.data_dir());
    voice_service::transcribe(&settings, &request, &local_root).await
}

/// 本地转写组件（引擎 + 各模型）是否已下载、当前下载进度。设置页下载时轮询它。
#[tauri::command]
pub fn voice_local_status(app_paths: State<'_, Arc<AppPaths>>) -> LocalVoiceStatus {
    voice_local::status(&voice_local::root_dir(app_paths.data_dir()))
}

#[tauri::command]
pub fn voice_local_install(
    settings_service: State<'_, Arc<SettingsService>>,
    app_paths: State<'_, Arc<AppPaths>>,
    model_id: String,
) -> AppResult<()> {
    let model = voice_local::resolve_model(&model_id)?;
    let client = download_client(&settings_service.get_settings().proxy)?;
    install::start(voice_local::root_dir(app_paths.data_dir()), model, client).map_err(Into::into)
}

#[tauri::command]
pub fn voice_local_cancel_install() {
    install::cancel();
}

#[tauri::command]
pub fn voice_local_remove(app_paths: State<'_, Arc<AppPaths>>, model_id: String) -> AppResult<()> {
    let model = voice_local::resolve_model(&model_id)?;
    voice_local::remove_model(&voice_local::root_dir(app_paths.data_dir()), model)
}

/// 下载走用户在设置里配的代理（没配时 reqwest 读系统代理）。不设总超时：模型近 900MB。
fn download_client(proxy: &ProxySettings) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60));
    if proxy.enabled && !proxy.host.is_empty() {
        let scheme = if proxy.proxy_type == "socks5" {
            "socks5h"
        } else {
            "http"
        };
        let url = format!("{}://{}:{}", scheme, proxy.host, proxy.port);
        let mut p = reqwest::Proxy::all(&url).map_err(|e| format!("invalid proxy {url}: {e}"))?;
        if let Some(user) = proxy.username.as_deref().filter(|u| !u.is_empty()) {
            p = p.basic_auth(user, proxy.password.as_deref().unwrap_or(""));
        }
        if let Some(no_proxy) = proxy
            .no_proxy
            .as_deref()
            .and_then(reqwest::NoProxy::from_string)
        {
            p = p.no_proxy(Some(no_proxy));
        }
        builder = builder.proxy(p);
    }
    builder
        .build()
        .map_err(|e| format!("http client build failed: {e}").into())
}
