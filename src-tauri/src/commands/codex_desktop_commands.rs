use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::utils::{AppError, AppResult};

/// Only construct documented chat links. Never accept an arbitrary URI from the WebView.
fn codex_chat_url(cwd: &str, thread_id: Option<&str>, prompt: Option<&str>) -> AppResult<String> {
    if let Some(id) = thread_id {
        if id.is_empty()
            || id.len() > 128
            || id == "new"
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(AppError::coded(
                "CODEX_INVALID_THREAD",
                "Invalid Codex thread identity",
            ));
        }
        return Ok(format!("codex://threads/{id}"));
    }
    let path = Path::new(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(AppError::coded(
            "CODEX_INVALID_WORKSPACE",
            "Codex needs an existing absolute local directory",
        ));
    }
    let canonical = dunce::canonicalize(path).map_err(|_| {
        AppError::coded(
            "CODEX_INVALID_WORKSPACE",
            "The Codex workspace is unavailable",
        )
    })?;
    let path_text = canonical.to_str().ok_or_else(|| {
        AppError::coded(
            "CODEX_INVALID_WORKSPACE",
            "The workspace path is not valid UTF-8",
        )
    })?;
    let mut url = Url::parse("codex://new").expect("static Codex URL");
    url.query_pairs_mut().append_pair("path", path_text);
    if let Some(prompt) = prompt.filter(|text| !text.is_empty()) {
        url.query_pairs_mut().append_pair("prompt", prompt);
    }
    Ok(url.into())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_thread_does_not_depend_on_deleted_workspace() {
        assert_eq!(
            codex_chat_url("/missing", Some("thr_abc-123"), Some("ignored")).unwrap(),
            "codex://threads/thr_abc-123"
        );
    }

    #[test]
    fn rejects_routes_and_query_injection_in_thread_ids() {
        for id in [
            "",
            "new",
            "../settings",
            "id?prompt=run",
            "id#fragment",
            "id/foo",
            " id",
            "id\n",
        ] {
            assert!(codex_chat_url("/", Some(id), None).is_err(), "{id:?}");
        }
    }

    #[test]
    fn new_chat_round_trips_workspace_and_draft_without_uri_injection() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("工作 # & project");
        std::fs::create_dir(&folder).unwrap();
        let draft = "Review #1 & 你好\npath=/other?send=true";
        let url = Url::parse(&codex_chat_url(folder.to_str().unwrap(), None, Some(draft)).unwrap())
            .unwrap();
        assert_eq!(url.host_str(), Some("new"));
        assert!(url.fragment().is_none());
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs["prompt"], draft);
        assert_eq!(
            pairs["path"],
            dunce::canonicalize(folder).unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn rejects_nonlocal_or_missing_workspace() {
        for cwd in [
            ".",
            "ssh://host/project",
            "https://example.com",
            "/missing-ccpanes-codex-workspace",
        ] {
            assert!(codex_chat_url(cwd, None, None).is_err());
        }
    }
}
