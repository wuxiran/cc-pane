use super::*;

#[cfg(unix)]
#[test]
fn existing_executable_and_private_file_modes_survive_an_edit() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    for mode in [0o755, 0o600] {
        let path = dir.path().join(format!("mode-{mode:o}"));
        fs::write(&path, "before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        write_text(&path, "after").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            mode
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    }
}

#[cfg(unix)]
#[test]
fn new_files_use_the_same_umask_as_regular_file_creation() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let normal = dir.path().join("normal.txt");
    let acp = dir.path().join("acp.txt");
    fs::write(&normal, "normal").unwrap();
    write_text(&acp, "acp").unwrap();
    assert_eq!(
        fs::metadata(normal).unwrap().permissions().mode(),
        fs::metadata(acp).unwrap().permissions().mode()
    );
}

#[cfg(unix)]
#[test]
fn relative_symlink_chains_update_the_target_without_replacing_links() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("real.txt");
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&target, "before").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink("real.txt", &first).unwrap();
    symlink("first.txt", &second).unwrap();
    write_text(&second, "after").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "after");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(fs::symlink_metadata(first).unwrap().is_symlink());
    assert!(fs::symlink_metadata(second).unwrap().is_symlink());
}

#[cfg(unix)]
#[test]
fn dangling_links_create_the_linked_target_and_cycles_are_left_intact() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("dangling.txt");
    symlink("nested/created.txt", &link).unwrap();
    write_text(&link, "created").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("nested/created.txt")).unwrap(),
        "created"
    );
    assert!(fs::symlink_metadata(link).unwrap().is_symlink());
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    symlink("b", &a).unwrap();
    symlink("a", &b).unwrap();
    assert!(write_text(&a, "cannot write").is_err());
    assert!(fs::symlink_metadata(a).unwrap().is_symlink());
    assert!(fs::symlink_metadata(b).unwrap().is_symlink());
}

#[test]
fn preexisting_old_temporary_filename_is_never_used_or_removed() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let unrelated = dir.path().join("note.txt.ccpanes-tmp");
    fs::write(&unrelated, "user-owned file").unwrap();
    write_text(&target, "new contents").unwrap();
    assert_eq!(fs::read_to_string(unrelated).unwrap(), "user-owned file");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[tokio::test]
async fn parallel_writes_to_names_that_shared_the_old_temp_path_stay_independent() {
    use serde_json::json;
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(16));
    let mut tasks = tokio::task::JoinSet::new();
    for index in 0..16 {
        let path = dir
            .path()
            .join(if index % 2 == 0 { "note" } else { "note.txt" });
        let content = if index % 2 == 0 { "a" } else { "b" }.repeat(256 * 1024);
        let barrier = barrier.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            super::super::fs_write_text_file(&json!({"path":path,"content":content})).await
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap().unwrap();
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("note")).unwrap(),
        "a".repeat(256 * 1024)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("note.txt")).unwrap(),
        "b".repeat(256 * 1024)
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn failed_replace_retains_the_target_and_removes_the_owned_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("keep-directory");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("original"), "keep").unwrap();
    let temporary = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    let temporary_path = temporary.path().to_path_buf();
    #[cfg(windows)]
    {
        let mut permissions = temporary.as_file().metadata().unwrap().permissions();
        permissions.set_readonly(true);
        temporary.as_file().set_permissions(permissions).unwrap();
    }
    assert!(persist(temporary, &target).is_err());
    assert!(!temporary_path.exists());
    assert_eq!(fs::read_to_string(target.join("original")).unwrap(), "keep");
}
