use crate::services::notification_preferences::{
    LayoutSound, NotificationPreferenceService, NotificationPreferences,
};
use crate::utils::{AppError, AppResult};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, State};

fn publish(app: &AppHandle, result: NotificationPreferences) -> AppResult<NotificationPreferences> {
    app.emit("notification-preferences-changed", &result)
        .map_err(|e| AppError::from(e.to_string()))?;
    Ok(result)
}

#[tauri::command]
pub fn get_notification_preferences(
    service: State<'_, Arc<NotificationPreferenceService>>,
) -> NotificationPreferences {
    service.get()
}

#[tauri::command]
pub async fn set_notification_snooze(
    app: AppHandle,
    service: State<'_, Arc<NotificationPreferenceService>>,
    session_id: String,
    until: Option<u64>,
) -> AppResult<NotificationPreferences> {
    let service = service.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || service.set_snooze(&session_id, until))
            .await
            .map_err(|e| AppError::from(e.to_string()))??;
    publish(&app, result)
}

#[tauri::command]
pub async fn set_layout_notification_sound(
    app: AppHandle,
    service: State<'_, Arc<NotificationPreferenceService>>,
    layout_id: String,
    sound: LayoutSound,
) -> AppResult<NotificationPreferences> {
    let service = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || service.set_sound(&layout_id, sound))
        .await
        .map_err(|e| AppError::from(e.to_string()))??;
    publish(&app, result)
}

#[tauri::command]
pub async fn import_notification_sound(
    service: State<'_, Arc<NotificationPreferenceService>>,
    path: String,
) -> AppResult<LayoutSound> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.import_sound(&PathBuf::from(path)))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub fn get_notification_sound_path(
    service: State<'_, Arc<NotificationPreferenceService>>,
    asset: String,
) -> AppResult<String> {
    Ok(service.sound_path(&asset)?.to_string_lossy().into_owned())
}
