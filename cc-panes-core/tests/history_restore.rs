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
