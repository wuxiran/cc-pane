use super::*;
use std::fs;

fn file(text: &str) -> Option<SnapshotFile> {
    Some(SnapshotFile {
        bytes: text.as_bytes().to_vec(),
        mode: "100644".into(),
    })
}

fn replacements(root: &Path, directory_to_file: bool) -> Vec<Change> {
    if directory_to_file {
        fs::create_dir_all(root.join("module/nested")).unwrap();
        fs::write(root.join("module/nested/item"), "before").unwrap();
        vec![
            ("module".into(), None, file("after")),
            ("module/nested/item".into(), file("before"), None),
        ]
    } else {
        fs::write(root.join("module"), "before").unwrap();
        vec![
            ("module/nested/item".into(), None, file("after")),
            ("module".into(), file("before"), None),
        ]
    }
}

#[test]
fn shape_replacement_rolls_back_files_and_directories_after_the_new_file_was_written() {
    for directory_to_file in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let changes = replacements(temp.path(), directory_to_file);
        let error = publish_with(temp.path(), &changes, |index| {
            if index == 0 {
                Err("injected after replacement".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(error.to_string().contains("rolled back"));
        let old_path = if directory_to_file {
            "module/nested/item"
        } else {
            "module"
        };
        assert_eq!(fs::read(temp.path().join(old_path)).unwrap(), b"before");
    }
}

#[test]
fn rollback_keeps_concurrent_unknown_files_inside_a_new_directory() {
    let temp = tempfile::tempdir().unwrap();
    let changes = replacements(temp.path(), false);
    let error = publish_with(temp.path(), &changes, |index| {
        if index == 0 {
            fs::write(temp.path().join("module/concurrent"), "keep").unwrap();
            Err("injected failure".into())
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(error.to_string().contains("partial rollback"));
    assert_eq!(
        fs::read(temp.path().join("module/concurrent")).unwrap(),
        b"keep"
    );
}

#[test]
fn failed_directory_restore_does_not_recreate_descendants_with_default_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let changes = replacements(temp.path(), true);
    let error = publish_with(temp.path(), &changes, |index| {
        if index == 0 {
            fs::remove_file(temp.path().join("module")).unwrap();
            fs::create_dir(temp.path().join("module")).unwrap();
            fs::write(temp.path().join("module/concurrent"), "keep").unwrap();
            Err("injected failure".into())
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(error.to_string().contains("partial rollback"));
    assert_eq!(
        fs::read(temp.path().join("module/concurrent")).unwrap(),
        b"keep"
    );
    assert!(!temp.path().join("module/nested").exists());
}

#[cfg(unix)]
#[test]
fn rollback_restores_permissions_of_removed_directories() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let changes = replacements(temp.path(), true);
    fs::set_permissions(
        temp.path().join("module"),
        fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    fs::set_permissions(
        temp.path().join("module/nested"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(publish_with(temp.path(), &changes, |index| {
        if index == 0 {
            Err("injected failure".into())
        } else {
            Ok(())
        }
    })
    .is_err());
    assert_eq!(
        fs::metadata(temp.path().join("module"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750
    );
    assert_eq!(
        fs::metadata(temp.path().join("module/nested"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::read(temp.path().join("module/nested/item")).unwrap(),
        b"before"
    );
}

#[cfg(unix)]
#[test]
fn unselected_symlink_blocks_shape_replacement_without_touching_its_target() {
    let temp = tempfile::tempdir().unwrap();
    let changes = replacements(temp.path(), true);
    let outside = temp.path().join("outside");
    fs::write(&outside, "keep").unwrap();
    std::os::unix::fs::symlink(&outside, temp.path().join("module/link")).unwrap();
    assert!(publish(temp.path(), &changes).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"keep");
    assert!(fs::symlink_metadata(temp.path().join("module/link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(temp.path().join("module/nested/item")).unwrap(),
        b"before"
    );
}

#[test]
fn selected_final_file_and_descendant_cannot_both_be_written() {
    let temp = tempfile::tempdir().unwrap();
    assert!(publish(
        temp.path(),
        &[
            ("module".into(), None, file("a")),
            ("module/item".into(), None, file("b"))
        ]
    )
    .is_err());
    assert!(!temp.path().join("module").exists());
}
