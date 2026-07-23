use crate::services::{
    HistoryWatchManager, LaunchHistoryService, NotificationService, SettingsService,
};
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
    launch_history_service: Arc<LaunchHistoryService>,
    history_watch_manager: Arc<HistoryWatchManager>,
}

impl TauriSessionNotifier {
    pub fn new(
        app_handle: AppHandle,
        notification_service: Arc<NotificationService>,
        settings_service: Arc<SettingsService>,
        launch_history_service: Arc<LaunchHistoryService>,
        history_watch_manager: Arc<HistoryWatchManager>,
    ) -> Self {
        Self {
            app_handle,
            notification_service,
            settings_service,
            launch_history_service,
            history_watch_manager,
        }
    }
}

impl SessionNotifier for TauriSessionNotifier {
    fn notify_waiting_input(&self, session_id: &str) {
        self.notification_service.notify_waiting_input(
            &self.app_handle,
            &self.settings_service,
            session_id,
            None,
        );
    }

    fn notify_session_exited(&self, session_id: &str, exit_code: i32) {
        self.history_watch_manager.on_session_ended(session_id);
        self.notification_service.notify_session_exited(
            &self.app_handle,
            &self.settings_service,
            session_id,
            exit_code,
            None,
        );

        let record = self
            .launch_history_service
            .find_by_pty_session_id(session_id)
            .unwrap_or_default();

        if let Some(record) = record {
            if let Some(resume_session_id) = record.resume_session_id.as_deref() {
                if let Ok(Some(last_prompt)) = crate::services::extract_last_prompt(
                    &record.cli_tool,
                    Some(&record.runtime_kind),
                    record.wsl_distro.as_deref(),
                    &record.project_path,
                    resume_session_id,
                ) {
                    let _ = self
                        .launch_history_service
                        .update_last_prompt_by_pty_session_id(session_id, &last_prompt);
                    let _ = self.app_handle.emit(
                        "history-updated",
                        serde_json::json!({
                            "source": "session-exit",
                            "ptySessionId": session_id,
                        }),
                    );
                }
            }
        }
    }

    fn cleanup_session(&self, session_id: &str) {
        self.notification_service.cleanup_session(session_id);
    }
}
