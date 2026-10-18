use cc_panes_core::models::{HistoryConfig, HistoryLabel, LabelFileSnapshot};
use cc_panes_core::repository::HistoryFileRepository;
use cc_panes_core::services::HistoryService;

fn label(repo: &HistoryFileRepository, id: &str, refs: Vec<LabelFileSnapshot>) {
    repo.put_label(&HistoryLabel {
        id: id.into(),
        name: id.into(),
        label_type: "manual".into(),
        source: "user".into(),
        timestamp: "2026-10-19T00:00:00Z".into(),
        file_snapshots: refs,
        branch: "main".into(),
    })
    .unwrap();
}

#[test]
fn all_retention_modes_expire_entire_broken_labels_and_preserve_valid_labels() {
    for mode in ["count", "age", "size"] {
        let dir = tempfile::tempdir().unwrap();
        let repo = HistoryFileRepository::open(dir.path()).unwrap();
        let old = repo
            .save_version("a.txt", b"1234", false, "main", 0)
            .unwrap()
            .unwrap();
        let latest = repo
            .save_version("a.txt", b"567890", false, "main", 0)
            .unwrap()
            .unwrap();
        let new_ref = LabelFileSnapshot {
            file_path: "a.txt".into(),
            version_id: latest.id.clone(),
        };
        label(
            &repo,
            "expired",
            vec![LabelFileSnapshot {
                file_path: "a.txt".into(),
                version_id: old.id.clone(),
            }],
        );
        label(&repo, "valid", vec![new_ref]);
        label(&repo, "empty", vec![]);
        let db = rusqlite::Connection::open(dir.path().join(".ccpanes/.cache/history/history.db"))
            .unwrap();
        match mode {
            "count" => repo
                .cleanup_old_versions(&HistoryConfig {
                    max_versions_per_file: 1,
                    ..Default::default()
                })
                .unwrap(),
            "age" => {
                db.execute(
                    "UPDATE file_versions SET created_at='2000-01-01T00:00:00Z' WHERE id=?1",
                    [&old.id],
                )
                .unwrap();
                repo.cleanup_old_versions(&HistoryConfig::default())
                    .unwrap();
            }
            _ => repo.cleanup_by_total_size(6).unwrap(),
        }
        let labels = repo.list_labels().unwrap();
        assert_eq!(labels.len(), 2, "{mode}");
        assert!(labels.iter().all(|l| l.id != "expired"), "{mode}");
        let orphans: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM label_snapshots WHERE label_id='expired'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        assert!(repo.get_version_content("a.txt", &old.id).is_err());
        assert_eq!(
            repo.get_version_content("a.txt", &latest.id).unwrap(),
            b"567890"
        );
        assert!(HistoryService::new()
            .restore_to_label(dir.path(), "expired")
            .is_err());
    }
}

#[test]
fn retention_cannot_commit_versions_without_expiring_their_labels() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = repo
        .save_version("a.txt", b"old", false, "main", 0)
        .unwrap()
        .unwrap();
    repo.save_version("a.txt", b"new", false, "main", 0)
        .unwrap();
    label(
        &repo,
        "old",
        vec![LabelFileSnapshot {
            file_path: "a.txt".into(),
            version_id: old.id.clone(),
        }],
    );
    let db =
        rusqlite::Connection::open(dir.path().join(".ccpanes/.cache/history/history.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_expiry BEFORE DELETE ON labels BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(repo
        .cleanup_old_versions(&HistoryConfig {
            max_versions_per_file: 1,
            ..Default::default()
        })
        .is_err());
    assert_eq!(repo.get_version_content("a.txt", &old.id).unwrap(), b"old");
    assert_eq!(repo.list_labels().unwrap().len(), 1);
}
