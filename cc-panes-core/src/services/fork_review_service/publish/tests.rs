use super::*;
use std::fs;

fn file(text: &str) -> Option<SnapshotFile> {
    Some(SnapshotFile {
        bytes: text.as_bytes().to_vec(),
        mode: "100644".into(),
    })
}

#[test]
fn publishes_add_edit_and_delete_after_preflighting_every_path() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("edited"), "before").unwrap();
    fs::write(temp.path().join("deleted"), "delete").unwrap();
    let changes = vec![
        ("edited".into(), file("before"), file("after")),
        ("new/nested/file".into(), None, file("new")),
        ("deleted".into(), file("delete"), None),
    ];
    assert_eq!(
        publish(temp.path(), &changes).unwrap(),
        ["edited", "new/nested/file", "deleted"]
    );
    assert_eq!(fs::read(temp.path().join("edited")).unwrap(), b"after");
    assert_eq!(
        fs::read(temp.path().join("new/nested/file")).unwrap(),
        b"new"
    );
    assert!(!temp.path().join("deleted").exists());
}

#[test]
fn failed_preflight_does_not_touch_earlier_targets() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("first"), "before").unwrap();
    fs::write(temp.path().join("second"), "external edit").unwrap();
    let changes = vec![
        ("first".into(), file("before"), file("after")),
        ("second".into(), file("expected"), file("after")),
    ];
    assert!(publish(temp.path(), &changes).is_err());
    assert_eq!(fs::read(temp.path().join("first")).unwrap(), b"before");
    assert_eq!(
        fs::read(temp.path().join("second")).unwrap(),
        b"external edit"
    );
}

#[test]
fn later_failure_restores_written_files_and_removes_new_empty_directories() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("first"), "before").unwrap();
    let changes = vec![
        ("first".into(), file("before"), file("after")),
        ("new/deep/file".into(), None, file("created")),
    ];
    let result = publish_with(temp.path(), &changes, |index| {
        if index == 1 {
            return Err("injected publication failure".into());
        }
        Ok(())
    });
    assert!(result.unwrap_err().to_string().contains("rolled back"));
    assert_eq!(fs::read(temp.path().join("first")).unwrap(), b"before");
    assert!(!temp.path().join("new").exists());
}

#[test]
fn rollback_preserves_concurrent_edits_and_reports_partial_result() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("first"), "before").unwrap();
    let changes = vec![("first".into(), file("before"), file("after"))];
    let result = publish_with(temp.path(), &changes, |_| {
        fs::write(temp.path().join("first"), "third party").unwrap();
        Err("injected failure".into())
    });
    assert!(result.unwrap_err().to_string().contains("partial rollback"));
    assert_eq!(fs::read(temp.path().join("first")).unwrap(), b"third party");
}

#[test]
fn rechecks_next_file_and_restores_previous_file_after_intervening_edit() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("first"), "before").unwrap();
    fs::write(temp.path().join("second"), "before").unwrap();
    let changes = vec![
        ("first".into(), file("before"), file("after")),
        ("second".into(), file("before"), file("after")),
    ];
    let result = publish_with(temp.path(), &changes, |index| {
        if index == 0 {
            fs::write(temp.path().join("second"), "intervening edit").unwrap();
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(temp.path().join("first")).unwrap(), b"before");
    assert_eq!(
        fs::read(temp.path().join("second")).unwrap(),
        b"intervening edit"
    );
}

#[test]
fn rejects_traversal_git_paths_unsupported_modes_and_colliding_names() {
    let temp = tempfile::tempdir().unwrap();
    for path in [
        "../outside",
        ".git/config",
        "a/../../outside",
        "a\\b",
        "C:/outside",
    ] {
        assert!(publish(temp.path(), &[(path.into(), None, file("new"))]).is_err());
    }
    let symlink = Some(SnapshotFile {
        bytes: b"outside".to_vec(),
        mode: "120000".into(),
    });
    assert!(publish(temp.path(), &[("link".into(), None, symlink)]).is_err());
    assert!(publish(
        temp.path(),
        &[
            ("file".into(), None, file("new")),
            ("FILE".into(), None, file("new"))
        ]
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_leaf_and_ancestor_without_touching_outside_file() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file"), "outside").unwrap();
    symlink(outside.join("file"), root.join("leaf")).unwrap();
    symlink(&outside, root.join("parent")).unwrap();
    for path in ["leaf", "parent/file"] {
        assert!(publish(&root, &[(path.into(), file("outside"), file("overwrite"))]).is_err());
    }
    assert_eq!(fs::read(outside.join("file")).unwrap(), b"outside");
}

#[cfg(unix)]
#[test]
fn replaces_atomically_and_preserves_executable_mode() {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("script");
    fs::write(&path, "before").unwrap();
    let mut old = fs::File::open(&path).unwrap();
    let executable = Some(SnapshotFile {
        bytes: b"after".to_vec(),
        mode: "100755".into(),
    });
    publish(
        temp.path(),
        &[("script".into(), file("before"), executable)],
    )
    .unwrap();
    let mut old_contents = String::new();
    old.read_to_string(&mut old_contents).unwrap();
    assert_eq!(old_contents, "before");
    assert_eq!(fs::read(&path).unwrap(), b"after");
    assert_ne!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
}

#[cfg(unix)]
#[test]
fn preserves_private_permissions_and_keeps_new_files_private() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let existing = temp.path().join("private");
    fs::write(&existing, "private before").unwrap();
    fs::set_permissions(&existing, fs::Permissions::from_mode(0o600)).unwrap();
    let changes = vec![
        (
            "private".into(),
            file("private before"),
            file("private after"),
        ),
        ("new".into(), None, file("new private")),
    ];
    publish(temp.path(), &changes).unwrap();
    for path in [&existing, &temp.path().join("new")] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn deletion_rollback_restores_original_read_write_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("shared");
    fs::write(&path, "before").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let changes = vec![("shared".into(), file("before"), None)];
    assert!(publish_with(temp.path(), &changes, |_| Err("injected failure".into())).is_err());
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
}
