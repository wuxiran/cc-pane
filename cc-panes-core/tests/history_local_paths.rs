use cc_panes_core::services::HistoryService;
use std::path::Path;

#[test]
fn every_history_entry_point_rejects_non_host_locations() {
    let service = HistoryService::new();
    for raw in [
        "ssh://review@example.invalid/srv/app",
        "ssh:/review@example.invalid/srv/app",
        "file:///tmp/example",
        "https://example.invalid/app",
    ] {
        let path = Path::new(raw);
        assert!(service
            .init_project_history(path)
            .unwrap_err()
            .to_string()
            .contains("HISTORY_LOCAL_PATH_REQUIRED"));
        assert!(service.create_auto_label(path, "label", "test").is_err());
        assert!(service.get_config(path).is_err());
        assert!(service.list_versions(path, "file.txt").is_err());
        assert!(service.start_watching(path).is_err());
    }
}

#[test]
fn history_does_not_create_a_missing_project_or_accept_a_file() {
    let root = tempfile::tempdir().unwrap();
    let service = HistoryService::new();
    let missing = root.path().join("missing");
    assert!(service.init_project_history(&missing).is_err());
    assert!(!missing.exists());
    let file = root.path().join("file.txt");
    std::fs::write(&file, "fixture").unwrap();
    assert!(service.init_project_history(&file).is_err());
    service.init_project_history(root.path()).unwrap();
    assert!(root
        .path()
        .join(".ccpanes/.cache/history/history.db")
        .is_file());
}
