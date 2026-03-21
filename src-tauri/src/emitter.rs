use crate::services::{NotificationService, SettingsService};
use cc_panes_core::events::{EventEmitter, SessionNotifier};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Tauri implementation of EventEmitter — wraps AppHandle.emit()
pub struct TauriEmitter {
    app_handle: AppHandle,
}

impl TauriEmitter {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

impl EventEmitter for TauriEmitter {
    fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
        self.app_handle.emit(event, payload)?;
        Ok(())
    }
}

/// Tauri implementation of SessionNotifier — wraps NotificationService + AppHandle
pub struct TauriSessionNotifier {
    app_handle: AppHandle,
    notification_service: Arc<NotificationService>,
    settings_service: Arc<SettingsService>,
}

impl TauriSessionNotifier {
    pub fn new(
        app_handle: AppHandle,
        notification_service: Arc<NotificationService>,
        settings_service: Arc<SettingsService>,
    ) -> Self {
        Self {
            app_handle,
            notification_service,
            settings_service,
        }
    }
}

impl SessionNotifier for TauriSessionNotifier {
    fn notify_waiting_input(&self, session_id: &str) {
        self.notification_service.notify_waiting_input(
            &self.app_handle,
            &self.settings_service,
            session_id,
        );
    }

    fn notify_session_exited(&self, session_id: &str, exit_code: i32) {
        self.notification_service.notify_session_exited(
            &self.app_handle,
            &self.settings_service,
            session_id,
            exit_code,
        );
    }

    fn cleanup_session(&self, session_id: &str) {
        self.notification_service.cleanup_session(session_id);
    }
}
