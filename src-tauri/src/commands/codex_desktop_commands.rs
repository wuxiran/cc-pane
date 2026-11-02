use cc_panes_core::services::codex_desktop::codex_chat_url;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::utils::{AppError, AppResult};

/// Opening a chat never submits a prompt and never starts/stops the desktop app's server.
#[tauri::command]
pub async fn open_in_codex(
    app: AppHandle,
    cwd: String,
    thread_id: Option<String>,
    prompt: Option<String>,
) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = codex_chat_url(&cwd, thread_id.as_deref(), prompt.as_deref())?;
        app.opener().open_url(&url, None::<&str>).map_err(|_| {
            AppError::coded(
                "CODEX_OPEN_FAILED",
                "Could not open Codex. Check that its desktop app is installed.",
            )
        })?;
        Ok(url)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}
