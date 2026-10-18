use cc_panes_core::services::WorktreeService;
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn repository(root: &Path) {
    fs::create_dir_all(root.join("sub")).unwrap();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.name", "Fixture"]);
    git(root, &["config", "user.email", "fixture@example.invalid"]);
    fs::write(root.join("sub/file.txt"), "base\n").unwrap();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "base"]);
}
#[test]
fn fork_preserves_subdirectory_context_and_uncommitted_files_without_changing_source() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    repository(&root);
    fs::write(root.join("sub/file.txt"), "staged\n").unwrap();
    git(&root, &["add", "sub/file.txt"]);
    fs::write(root.join("sub/file.txt"), "working\n").unwrap();
    fs::write(root.join("sub/new.txt"), "new file\n").unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/private"), "ignored").unwrap();
    let before = git(&root, &["status", "--porcelain"]);
    let cwd = WorktreeService::new()
        .fork_chat_worktree(root.join("sub").to_str().unwrap())
        .unwrap();
    let target = Path::new(&cwd);
    assert_eq!(
        fs::read_to_string(target.join("file.txt")).unwrap(),
        "working\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("new.txt")).unwrap(),
        "new file\n"
    );
    assert!(!target.parent().unwrap().join("ignored").exists());
    assert_ne!(
        git(target, &["branch", "--show-current"]),
        git(&root, &["branch", "--show-current"])
    );
    assert_eq!(before, git(&root, &["status", "--porcelain"]));
    assert_eq!(git(&root, &["show", ":sub/file.txt"]), "staged\n");
}
#[cfg(unix)]
#[test]
fn failed_copy_removes_only_the_new_worktree_and_branch() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    repository(&root);
    std::os::unix::fs::symlink("missing", root.join("untracked-link")).unwrap();
    let service = WorktreeService::new();
    let before = git(&root, &["branch", "--list"]);
    assert!(service.fork_chat_worktree(root.to_str().unwrap()).is_err());
    assert_eq!(
        service
            .list_worktrees(root.to_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(before, git(&root, &["branch", "--list"]));
    assert!(fs::symlink_metadata(root.join("untracked-link")).is_ok());
}
#[test]
fn non_git_directory_fails_before_creating_a_worktree() {
    let temp = tempfile::tempdir().unwrap();
    assert!(WorktreeService::new()
        .fork_chat_worktree(temp.path().to_str().unwrap())
        .is_err());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}
