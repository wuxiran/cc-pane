use super::*;
use super::super::{file_identity, modified_mtime_ms, ContextFileCache};

fn service() -> UsageStatsService {
    let db = Arc::new(Database::new_in_memory().unwrap());
    UsageStatsService::new(
        Arc::new(UsageStatsRepository::new(db.clone())),
        Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(db)))),
    )
}

#[test]
fn clear_to_empty_transcript_never_reuses_old_81_percent() {
    for cli in ["claude", "codex"] {
        let temp = tempfile::tempdir().unwrap();
        let old_path = temp.path().join("old.jsonl");
        let new_path = temp.path().join("new.jsonl");
        fs::write(&old_path, "{}\n").unwrap();
        fs::write(&new_path, "{}\n").unwrap();
        let service = service();
        let mut request = context_request(cli, None);
        let metadata = fs::metadata(&old_path).unwrap();
        service.context_file_cache.lock().unwrap().insert(
            request.pty_session_id.clone(),
            ContextFileCache {
                path: old_path,
                resume_id: request.resume_id.clone(),
                file_identity: file_identity(&metadata),
                file_len: metadata.len(),
                modified_at_ms: modified_mtime_ms(&metadata),
                byte_offset: metadata.len(),
                observation: Some(ContextObservation {
                    used_tokens: 812_167,
                    window_tokens: Some(1_000_000),
                    window_diagnostic: None,
                    model: None,
                }),
            },
        );
        request.resume_id = "new-agent".to_string();
        let result = service.read_context_snapshot(&request, &new_path, 1);
        assert_eq!(result.used_tokens, None, "{cli}: leaked old context");
        assert_eq!(result.used_percentage, None);
        assert_eq!(result.agent_session_id.as_deref(), Some("new-agent"));
    }
}

#[test]
fn shrinking_or_replaced_transcript_drops_old_observation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("session.jsonl");
    fs::write(&path, "{}\n").unwrap();
    let service = service();
    let request = context_request("claude", None);
    let metadata = fs::metadata(&path).unwrap();
    service.context_file_cache.lock().unwrap().insert(
        request.pty_session_id.clone(),
        ContextFileCache {
            path: path.clone(), resume_id: request.resume_id.clone(),
            file_identity: file_identity(&metadata), file_len: 999,
            modified_at_ms: modified_mtime_ms(&metadata), byte_offset: 999,
            observation: Some(ContextObservation {
                used_tokens: 812_167, window_tokens: Some(1_000_000),
                window_diagnostic: None, model: None,
            }),
        },
    );
    let result = service.read_context_snapshot(&request, &path, 1);
    assert_eq!(result.used_tokens, None);
}

#[test]
fn terminal_visibility_settings_are_backward_compatible_and_default_off() {
    use crate::models::settings::TerminalSettings;
    let defaults = TerminalSettings::default();
    assert!(!defaults.auto_close_completed_tasks);
    assert!(defaults.cursor_color.is_none());
    let mut legacy = serde_json::to_value(defaults).unwrap();
    legacy.as_object_mut().unwrap().remove("autoCloseCompletedTasks");
    let decoded: TerminalSettings = serde_json::from_value(legacy).unwrap();
    assert!(!decoded.auto_close_completed_tasks);
    let custom = TerminalSettings {
        cursor_color: Some("#ffffff".into()),
        selection_background: Some("#526e96".into()),
        ..decoded
    };
    let encoded = toml::to_string(&custom).unwrap();
    let restored: TerminalSettings = toml::from_str(&encoded).unwrap();
    assert_eq!(restored.cursor_color.as_deref(), Some("#ffffff"));
    assert_eq!(restored.selection_background.as_deref(), Some("#526e96"));
    assert_eq!(restored.renderer_mode, "auto");
}
