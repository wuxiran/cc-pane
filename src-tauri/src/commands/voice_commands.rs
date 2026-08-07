use crate::services::voice_service;
use crate::services::SettingsService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

pub use crate::services::voice_service::{VoiceTranscribeRequest, VoiceTranscribeResponse};

#[tauri::command]
pub async fn transcribe_voice_input(
    settings_service: State<'_, Arc<SettingsService>>,
    request: VoiceTranscribeRequest,
) -> AppResult<VoiceTranscribeResponse> {
    let settings = settings_service.get_settings().voice;
    if !settings.enabled {
        return Err("Voice input is disabled".into());
    }
    voice_service::transcribe(&settings, &request).await
}
