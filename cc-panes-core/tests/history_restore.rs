use cc_panes_core::models::{HistoryLabel, LabelFileSnapshot};
use cc_panes_core::repository::HistoryFileRepository;
use cc_panes_core::services::HistoryService;
use std::{fs, path::Path};

fn label(repo: &HistoryFileRepository, id: &str, snapshots: Vec<LabelFileSnapshot>) {
    repo.put_label(&HistoryLabel {
        id: id.into(),
        name: id.into(),
        label_type: "manual".into(),
        source: "user".into(),
        timestamp: "2026-10-19T00:00:00Z".into(),
        file_snapshots: snapshots,
        branch: "main".into(),
    })
    .unwrap();
}
fn snapshot(
    repo: &HistoryFileRepository,
    file: &str,
    bytes: &[u8],
    deleted: bool,
) -> LabelFileSnapshot {
    let v = repo
        .save_version(file, bytes, deleted, "main", 0)
        .unwrap()
        .unwrap();
    LabelFileSnapshot {
        file_path: file.into(),
        version_id: v.id,
    }
}
fn undo(service: &HistoryService, project: &Path) {
    let label = service
        .list_labels(project)
        .unwrap()
        .into_iter()
        .find(|l| l.source == "restore")
        .unwrap();
    service.restore_to_label(project, &label.id).unwrap();
}

#[test]
fn single_file_restore_backs_up_latest_bytes_inside_snapshot_interval() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = snapshot(&repo, "file.txt", b"old", false);
    fs::write(dir.path().join("file.txt"), b"just edited").unwrap();
    assert!(repo
        .save_version("file.txt", b"just edited", false, "main", 300)
        .unwrap()
        .is_none());
    let service = HistoryService::new();
    service
        .restore_version(dir.path(), &old.file_path, &old.version_id)
        .unwrap();
    assert_eq!(fs::read(dir.path().join("file.txt")).unwrap(), b"old");
    undo(&service, dir.path());
    assert_eq!(
        fs::read(dir.path().join("file.txt")).unwrap(),
        b"just edited"
    );
}

#[test]
fn label_rollback_backs_up_current_bytes_of_every_affected_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let files = ["a.txt", "b.txt"];
    label(
        &repo,
        "target",
        files
            .iter()
            .map(|f| snapshot(&repo, f, b"old", false))
            .collect(),
    );
    for f in files {
        fs::write(dir.path().join(f), format!("current {f}")).unwrap();
    }
    let service = HistoryService::new();
    service.restore_to_label(dir.path(), "target").unwrap();
    undo(&service, dir.path());
    for f in files {
        assert_eq!(
            fs::read_to_string(dir.path().join(f)).unwrap(),
            format!("current {f}")
        );
    }
}

#[test]
fn backup_label_failure_prevents_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = snapshot(&repo, "file.txt", b"old", false);
    fs::write(dir.path().join("file.txt"), b"current").unwrap();
    let db =
        rusqlite::Connection::open(dir.path().join(".ccpanes/.cache/history/history.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_backup BEFORE INSERT ON labels BEGIN SELECT RAISE(ABORT, 'backup unavailable'); END;").unwrap();
    assert!(HistoryService::new()
        .restore_version(dir.path(), &old.file_path, &old.version_id)
        .is_err());
    assert_eq!(fs::read(dir.path().join("file.txt")).unwrap(), b"current");
}

#[test]
fn restore_rejects_traversal_absolute_and_windows_prefixed_paths() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    let outside = dir.path().join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    let repo = HistoryFileRepository::open(&project).unwrap();
    for path in [
        "../outside.txt",
        outside.to_str().unwrap(),
        r"C:\outside.txt",
        r"..\outside.txt",
        "file.txt:stream",
    ] {
        let v = snapshot(&repo, path, b"old", false);
        assert!(
            HistoryService::new()
                .restore_version(&project, path, &v.version_id)
                .is_err(),
            "{path}"
        );
    }
    assert_eq!(fs::read(outside).unwrap(), b"outside");
    assert!(repo.list_labels().unwrap().is_empty());
}

#[cfg(any(unix, windows))]
fn symlink(target: &Path, link: &Path, directory: bool) {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, link).unwrap();
    }
    #[cfg(windows)]
    {
        if directory {
            std::os::windows::fs::symlink_dir(target, link).unwrap();
        } else {
            std::os::windows::fs::symlink_file(target, link).unwrap();
        }
    }
}

#[cfg(any(unix, windows))]
#[test]
fn both_restore_entry_points_reject_escaping_file_and_parent_links() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    let outside = dir.path().join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    symlink(&outside, &project.join("link.txt"), false);
    symlink(dir.path(), &project.join("parent"), true);
    let repo = HistoryFileRepository::open(&project).unwrap();
    let service = HistoryService::new();
    for file in ["link.txt", "parent/missing/new.txt"] {
        let v = snapshot(&repo, file, b"old", false);
        assert!(service
            .restore_version(&project, file, &v.version_id)
            .is_err());
        label(&repo, file, vec![v]);
        assert!(service.restore_to_label(&project, file).is_err());
    }
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert!(!dir.path().join("missing").exists());
}

#[test]
fn deleted_label_state_removes_recreated_file_and_undo_preserves_new_content() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let deleted = snapshot(&repo, "removed.txt", b"old removed content", true);
    label(&repo, "after-delete", vec![deleted.clone()]);
    fs::write(dir.path().join("removed.txt"), b"recreated later").unwrap();
    let service = HistoryService::new();
    service
        .restore_to_label(dir.path(), "after-delete")
        .unwrap();
    assert!(!dir.path().join("removed.txt").exists());
    undo(&service, dir.path());
    assert_eq!(
        fs::read(dir.path().join("removed.txt")).unwrap(),
        b"recreated later"
    );
    // Explicit recover-deleted-file still restores the tombstone's saved bytes.
    service
        .restore_version(dir.path(), &deleted.file_path, &deleted.version_id)
        .unwrap();
    assert_eq!(
        fs::read(dir.path().join("removed.txt")).unwrap(),
        b"old removed content"
    );
}

#[test]
fn restoring_deleted_label_is_idempotent_and_does_not_create_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    label(
        &repo,
        "deleted",
        vec![snapshot(&repo, "gone/file.txt", b"deleted", true)],
    );
    let service = HistoryService::new();
    service.restore_to_label(dir.path(), "deleted").unwrap();
    service.restore_to_label(dir.path(), "deleted").unwrap();
    assert!(!dir.path().join("gone").exists());
}

#[test]
fn undo_recovery_returns_a_previously_missing_file_to_absence() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = snapshot(&repo, "file.txt", b"old", false);
    let service = HistoryService::new();
    service
        .restore_version(dir.path(), &old.file_path, &old.version_id)
        .unwrap();
    assert!(dir.path().join("file.txt").exists());
    undo(&service, dir.path());
    assert!(!dir.path().join("file.txt").exists());
}

#[test]
fn missing_snapshot_or_blob_prevents_partial_restore_and_false_success() {
    for missing_blob in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let repo = HistoryFileRepository::open(dir.path()).unwrap();
        let a = snapshot(&repo, "a.txt", b"old a", false);
        let mut z = snapshot(&repo, "z.txt", b"old z", false);
        if missing_blob {
            let hash = HistoryFileRepository::calculate_hash(b"old z");
            fs::remove_file(dir.path().join(".ccpanes/.cache/history/blobs").join(hash)).unwrap();
        } else {
            z.version_id = "missing".into();
        }
        label(&repo, "broken", vec![a, z]);
        fs::write(dir.path().join("a.txt"), b"current a").unwrap();
        fs::write(dir.path().join("z.txt"), b"current z").unwrap();
        assert!(HistoryService::new()
            .restore_to_label(dir.path(), "broken")
            .is_err());
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"current a");
        assert_eq!(fs::read(dir.path().join("z.txt")).unwrap(), b"current z");
        assert_eq!(repo.list_labels().unwrap().len(), 1);
    }
}

#[cfg(unix)]
#[test]
fn atomic_restore_keeps_existing_executable_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = snapshot(&repo, "run.sh", b"old", false);
    let path = dir.path().join("run.sh");
    fs::write(&path, b"current").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    HistoryService::new()
        .restore_version(dir.path(), &old.file_path, &old.version_id)
        .unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn label_restores_absence_but_explicit_deleted_file_recovery_restores_contents() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let deleted = snapshot(&repo, "gone.txt", b"recover me", true);
    label(&repo, "after-delete", vec![deleted.clone()]);
    let service = HistoryService::new();
    service
        .restore_to_label(dir.path(), "after-delete")
        .unwrap();
    assert!(!dir.path().join("gone.txt").exists());
    fs::write(dir.path().join("gone.txt"), b"recreated").unwrap();
    service
        .restore_to_label(dir.path(), "after-delete")
        .unwrap();
    assert!(!dir.path().join("gone.txt").exists());
    service
        .restore_version(dir.path(), "gone.txt", &deleted.version_id)
        .unwrap();
    assert_eq!(
        fs::read(dir.path().join("gone.txt")).unwrap(),
        b"recover me"
    );
}

#[test]
fn undo_restoring_a_missing_file_removes_the_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let old = snapshot(&repo, "nested/gone.txt", b"old", false);
    let service = HistoryService::new();
    service
        .restore_version(dir.path(), &old.file_path, &old.version_id)
        .unwrap();
    undo(&service, dir.path());
    assert!(!dir.path().join(&old.file_path).exists());
}

#[test]
fn incomplete_label_fails_before_restoring_any_file() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let first = snapshot(&repo, "a.txt", b"old", false);
    label(
        &repo,
        "broken",
        vec![
            first,
            LabelFileSnapshot {
                file_path: "z.txt".into(),
                version_id: "missing".into(),
            },
        ],
    );
    fs::write(dir.path().join("a.txt"), b"current").unwrap();
    assert!(HistoryService::new()
        .restore_to_label(dir.path(), "broken")
        .is_err());
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"current");
    assert_eq!(repo.list_labels().unwrap().len(), 1);
}

#[test]
fn retention_expires_whole_labels_and_preserves_complete_and_empty_labels() {
    for by_size in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let repo = HistoryFileRepository::open(dir.path()).unwrap();
        let old = snapshot(&repo, "file.txt", b"old", false);
        let current = snapshot(&repo, "file.txt", b"new", false);
        let other = snapshot(&repo, "other.txt", b"also retained", false);
        label(&repo, "partial", vec![old.clone(), other]);
        label(&repo, "valid", vec![current]);
        label(&repo, "empty", vec![]);
        if by_size {
            repo.cleanup_by_total_size(16).unwrap(); // total 19 bytes: remove only old's 3 bytes
        } else {
            repo.cleanup_old_versions(&cc_panes_core::models::HistoryConfig {
                max_versions_per_file: 1,
                ..Default::default()
            })
            .unwrap();
        }
        let labels = repo.list_labels().unwrap();
        assert!(!labels.iter().any(|l| l.id == "partial"));
        assert!(labels.iter().any(|l| l.id == "valid"));
        assert!(labels.iter().any(|l| l.id == "empty"));
        assert!(repo
            .get_version_content("file.txt", &old.version_id)
            .is_err());
        assert!(HistoryService::new()
            .restore_to_label(dir.path(), "partial")
            .is_err());
    }
}

#[test]
fn restored_state_updates_deleted_files_and_new_labels_without_a_watcher() {
    let dir = tempfile::tempdir().unwrap();
    let repo = HistoryFileRepository::open(dir.path()).unwrap();
    let deleted = snapshot(&repo, "gone.txt", b"recover me", true);
    label(&repo, "deleted", vec![deleted.clone()]);
    let service = HistoryService::new();
    service
        .restore_version(dir.path(), &deleted.file_path, &deleted.version_id)
        .unwrap();
    assert!(service.list_deleted_files(dir.path()).unwrap().is_empty());
    let recovered = service
        .create_auto_label(dir.path(), "recovered", "user")
        .unwrap();
    let label = service
        .list_labels(dir.path())
        .unwrap()
        .into_iter()
        .find(|l| l.id == recovered)
        .unwrap();
    let version = &label.file_snapshots[0];
    assert_eq!(
        repo.get_version_content(&version.file_path, &version.version_id)
            .unwrap(),
        b"recover me"
    );
    service.restore_to_label(dir.path(), "deleted").unwrap();
    assert_eq!(service.list_deleted_files(dir.path()).unwrap().len(), 1);
    assert!(!dir.path().join("gone.txt").exists());
}
