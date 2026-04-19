use crate::services::{
    NotificationRequest, NotificationService, NotificationTriggerResult, SettingsService,
};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tracing::debug;

#[tauri::command]
pub fn trigger_notification(
    app: AppHandle,
    notification_service: State<'_, Arc<NotificationService>>,
    settings_service: State<'_, Arc<SettingsService>>,
    mut request: NotificationRequest,
) -> AppResult<NotificationTriggerResult> {
    debug!(kind = %request.kind, "cmd::trigger_notification");
    if request.source.is_none() {
        request.source = Some("tauri".to_string());
    }
    Ok(notification_service.trigger(&app, settings_service.inner(), request)?)
}
