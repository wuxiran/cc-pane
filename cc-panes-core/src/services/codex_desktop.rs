//! Safe, shared construction of public Codex desktop deep links.
//!
//! `prompt` fills the new-chat composer; it never submits or queues a task.
//! See https://learn.chatgpt.com/docs/app/commands#chats.

use std::path::Path;
use url::Url;

use crate::utils::{AppError, AppResult};

/// CC-Panes' own bound on desktop draft text, measured before URL encoding.
/// Longer task descriptions should be passed as a short summary and file path.
pub const MAX_DESKTOP_PROMPT_BYTES: usize = 8 * 1024;

/// Build only documented chat routes. Existing-thread links are navigation
/// only: reject a supplied prompt rather than silently discarding task text.
pub fn codex_chat_url(
    cwd: &str,
    thread_id: Option<&str>,
    prompt: Option<&str>,
) -> AppResult<String> {
    let prompt = prompt.filter(|text| !text.is_empty());
    if let Some(id) = thread_id {
        return existing_thread_url(id, prompt);
    }
    if prompt.is_some_and(|text| text.len() > MAX_DESKTOP_PROMPT_BYTES) {
        return Err(AppError::coded(
            "CODEX_DESKTOP_PROMPT_TOO_LARGE",
            format!("Codex desktop drafts are limited to {MAX_DESKTOP_PROMPT_BYTES} UTF-8 bytes; use a short summary and file references"),
        ));
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
    if let Some(prompt) = prompt {
        url.query_pairs_mut().append_pair("prompt", prompt);
    }
    Ok(url.into())
}

fn existing_thread_url(id: &str, prompt: Option<&str>) -> AppResult<String> {
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
    if prompt.is_some() {
        return Err(AppError::coded(
            "CODEX_DESKTOP_APPEND_UNSUPPORTED",
            "Existing Codex thread links cannot append a prompt; open a new desktop draft instead",
        ));
    }
    Ok(format!("codex://threads/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_thread_navigation_survives_deleted_workspace_but_never_drops_prompt() {
        for prompt in [None, Some("")] {
            assert_eq!(
                codex_chat_url("/missing", Some("thr_abc-123"), prompt).unwrap(),
                "codex://threads/thr_abc-123"
            );
        }
        for prompt in ["Run this task", " ", "\n"] {
            assert_eq!(
                codex_chat_url("/missing", Some("thr_abc-123"), Some(prompt))
                    .unwrap_err()
                    .code(),
                Some("CODEX_DESKTOP_APPEND_UNSUPPORTED")
            );
        }
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
    fn new_chat_round_trips_workspace_and_draft_without_inventing_send_parameter() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("工作 # & project");
        std::fs::create_dir(&folder).unwrap();
        let draft = "Review #1 & 你好\npath=/other?send=true";
        let url = Url::parse(&codex_chat_url(folder.to_str().unwrap(), None, Some(draft)).unwrap())
            .unwrap();
        assert_eq!(url.scheme(), "codex");
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
    fn draft_limit_counts_utf8_bytes_and_never_truncates() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().to_str().unwrap();
        let at_limit = "a".repeat(MAX_DESKTOP_PROMPT_BYTES);
        assert!(codex_chat_url(cwd, None, Some(&at_limit)).is_ok());
        for prompt in [
            "a".repeat(MAX_DESKTOP_PROMPT_BYTES + 1),
            "中".repeat(MAX_DESKTOP_PROMPT_BYTES / 3 + 1),
        ] {
            assert_eq!(
                codex_chat_url(cwd, None, Some(&prompt)).unwrap_err().code(),
                Some("CODEX_DESKTOP_PROMPT_TOO_LARGE")
            );
        }
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
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(codex_chat_url(file.path().to_str().unwrap(), None, None).is_err());
    }
}
