use std::path::{Path, PathBuf};
use std::process::Command;

use cc_panes_core::models::{GitChangeStatus, GitRepoState};
use cc_panes_core::services::GitService;

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git must be installed");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test User"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("tracked.txt"), b"initial\n").unwrap();
    std::fs::write(repo.join("root-only.txt"), b"root\n").unwrap();
    std::fs::create_dir(repo.join("nested")).unwrap();
    std::fs::write(repo.join("nested/inside.txt"), b"inside\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "initial"]);
    (temp, repo)
}

#[test]
fn repo_info_distinguishes_missing_plain_and_git_paths() {
    let service = GitService::new();
    let temp = tempfile::tempdir().unwrap();

    let missing = service.repo_info(&temp.path().join("missing"));
    assert_eq!(missing.state, GitRepoState::PathNotFound);

    let plain = service.repo_info(temp.path());
    assert_eq!(plain.state, GitRepoState::NotARepo);

    let (_guard, repo) = init_repo();
    let info = service.repo_info(&repo.join("nested"));
    assert_eq!(info.state, GitRepoState::Ok);
    assert_eq!(
        info.repo_root.as_deref(),
        Some(repo.to_string_lossy().as_ref())
    );
    assert!(info.branch.is_some());
    assert_eq!(info.has_changes, Some(false));
}

#[test]
fn legacy_branch_and_status_keep_ok_none_for_invalid_repositories() {
    let service = GitService::new();
    let temp = tempfile::tempdir().unwrap();

    assert_eq!(
        service
            .get_branch_compat(&temp.path().join("missing"))
            .unwrap(),
        None
    );
    assert_eq!(service.get_status_compat(temp.path()).unwrap(), None);
}

#[test]
fn status_is_scoped_to_registered_subdirectory_and_uses_repo_relative_paths() {
    let (_guard, repo) = init_repo();
    std::fs::write(repo.join("root-only.txt"), b"changed root\n").unwrap();
    std::fs::write(repo.join("nested/inside.txt"), b"changed nested\n").unwrap();
    std::fs::write(repo.join("nested/untracked.txt"), b"new\n").unwrap();

    let files = GitService::new()
        .status_files(&repo.join("nested"))
        .unwrap();

    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|file| {
        file.new_path
            .as_deref()
            .or(file.old_path.as_deref())
            .is_some_and(|path| path.starts_with("nested/"))
    }));
    assert!(files.iter().any(|file| {
        file.status == GitChangeStatus::Modified
            && file.new_path.as_deref() == Some("nested/inside.txt")
    }));
    assert!(files.iter().any(|file| {
        file.status == GitChangeStatus::Untracked
            && file.new_path.as_deref() == Some("nested/untracked.txt")
    }));
}

#[test]
fn porcelain_z_preserves_arrow_newline_and_rename_paths() {
    let (_guard, repo) = init_repo();
    let old_name = "old -> name\nline.txt";
    let new_name = "new -> name\nline.txt";
    std::fs::write(repo.join(old_name), b"rename me\n").unwrap();
    git(&repo, &["add", old_name]);
    git(&repo, &["commit", "-q", "-m", "add odd name"]);
    std::fs::rename(repo.join(old_name), repo.join(new_name)).unwrap();
    git(&repo, &["add", "-A"]);

    let files = GitService::new().status_files(&repo).unwrap();
    let renamed = files
        .iter()
        .find(|file| file.status == GitChangeStatus::Renamed)
        .expect("rename must be parsed structurally");
    assert_eq!(renamed.old_path.as_deref(), Some(old_name));
    assert_eq!(renamed.new_path.as_deref(), Some(new_name));
}

#[test]
fn revision_and_path_guards_reject_option_and_traversal_injection() {
    let (_guard, repo) = init_repo();
    let service = GitService::new();

    let oid = service.resolve_commit(&repo, "HEAD").unwrap();
    assert_eq!(oid.len(), 40);
    assert!(oid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(service.resolve_commit(&repo, "--help").is_err());
    assert!(GitService::validate_repo_relative_path(Path::new("../outside")).is_err());
    assert!(GitService::validate_repo_relative_path(&repo.join("tracked.txt")).is_err());
    assert!(GitService::validate_repo_relative_path(Path::new("nested/inside.txt")).is_ok());
}

#[test]
fn blob_read_checks_size_before_loading_content() {
    let (_guard, repo) = init_repo();
    let service = GitService::new();

    let content = service
        .read_blob_at_commit(&repo, "HEAD", Path::new("tracked.txt"), 64)
        .unwrap();
    assert_eq!(content, b"initial\n");

    let error = service
        .read_blob_at_commit(&repo, "HEAD", Path::new("tracked.txt"), 4)
        .expect_err("oversized blob must be rejected before cat-file output is read");
    assert!(error.contains("exceeds"));
}
