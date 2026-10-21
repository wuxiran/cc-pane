//! Correlate an interactive capture with the chat draft active before it starts.
//! A drop guard publishes completion on cancel, error and thread-start failure.
use crate::models::ScreenshotResult;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureEvent {
    capture_id: String,
    result: Option<ScreenshotResult>,
    error: Option<String>,
}

pub(crate) struct ScreenshotEvents {
    app: AppHandle,
    event: CaptureEvent,
}

impl ScreenshotEvents {
    pub(crate) fn begin(app: &AppHandle) -> Self {
        let event = CaptureEvent {
            capture_id: uuid::Uuid::new_v4().to_string(),
            result: None,
            error: None,
        };
        if let Err(error) = app.emit("screenshot-started", &event) {
            tracing::warn!(%error, "failed to announce screenshot start");
        }
        Self {
            app: app.clone(),
            event,
        }
    }

    pub(crate) fn saved(&mut self, result: &ScreenshotResult) {
        self.event.result = Some(result.clone());
    }

    pub(crate) fn failed(&mut self, error: impl std::fmt::Display) {
        self.event.error = Some(error.to_string());
    }
}

impl Drop for ScreenshotEvents {
    fn drop(&mut self) {
        if let Err(error) = self.app.emit("screenshot-finished", &self.event) {
            tracing::warn!(%error, "failed to announce screenshot completion");
        }
    }
}
