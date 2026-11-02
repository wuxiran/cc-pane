use cc_panes_core::models::{GitChangeStatus, GitDiffSpec};
use cc_panes_core::services::GitService;
use std::path::Path;
use std::process::Command;

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init(repo: &Path) {
    git(repo, &["init", "-q", "-b", "main"]);
    git(repo, &["config", "user.name", "Review Test"]);
    git(repo, &["config", "user.email", "review@example.invalid"]);
    git(repo, &["config", "core.autocrlf", "false"]);
}

fn commit(repo: &Path, file: &str, content: &[u8]) {
    let path = repo.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    git(repo, &["add", "--", file]);
    git(repo, &["commit", "-qm", "fixture"]);
}

#[test]
fn branch_review_uses_common_ancestor_and_pins_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init(repo);
    commit(repo, "file.txt", b"base\n");
    let service = GitService::new();
    let ancestor = service.resolve_commit(repo, "HEAD").unwrap();
    git(repo, &["checkout", "-qb", "topic"]);
    commit(repo, "file.txt", b"topic\n");
    let topic = service.resolve_commit(repo, "HEAD").unwrap();
    git(repo, &["checkout", "-q", "main"]);
    commit(repo, "main-only.txt", b"main only\n");
    git(repo, &["checkout", "-q", "topic"]);
    std::fs::write(repo.join("file.txt"), "uncommitted\n").unwrap();
    let review = service.branch_review(repo, "main").unwrap();
    assert_eq!(review.base_commit, ancestor);
    assert_eq!(review.head_commit, topic);
    assert_eq!(review.files.len(), 1);
    assert_eq!(review.files[0].new_path.as_deref(), Some("file.txt"));
    commit(repo, "file.txt", b"later\n");
    let diff = service
        .get_diff(
            repo,
            &GitDiffSpec::CommitVsCommit {
                old_rev: review.base_commit,
                new_rev: review.head_commit,
                file: review.files[0].clone(),
            },
        )
        .unwrap();
    let content = serde_json::to_string(&diff).unwrap();
    assert!(content.contains("topic"));
    assert!(!content.contains("later"));
    assert!(!content.contains("uncommitted"));
}

#[test]
fn branch_review_preserves_renames_and_binary_diffs() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init(repo);
    commit(repo, "old name.txt", b"same content\n");
    git(repo, &["checkout", "-qb", "topic"]);
    git(repo, &["mv", "old name.txt", "新名称.txt"]);
    commit(repo, "binary.dat", &[0, 1, 2]);
    let service = GitService::new();
    let review = service.branch_review(repo, "main").unwrap();
    assert_eq!(review.files.len(), 2);
    let renamed = review
        .files
        .iter()
        .find(|f| f.status == GitChangeStatus::Renamed)
        .unwrap();
    assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
    assert_eq!(renamed.new_path.as_deref(), Some("新名称.txt"));
    let binary = review
        .files
        .iter()
        .find(|f| f.new_path.as_deref() == Some("binary.dat"))
        .unwrap();
    assert!(
        service
            .get_diff(
                repo,
                &GitDiffSpec::CommitVsCommit {
                    old_rev: review.base_commit,
                    new_rev: review.head_commit,
                    file: binary.clone(),
                }
            )
            .unwrap()
            .is_binary
    );
}

#[test]
fn branch_review_respects_literal_subdirectory_scope() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init(repo);
    commit(repo, "packages/[app]/inside.txt", b"base\n");
    git(repo, &["checkout", "-qb", "topic"]);
    commit(repo, "packages/[app]/inside.txt", b"changed\n");
    commit(repo, "packages/a/outside.txt", b"outside\n");
    let review = GitService::new()
        .branch_review(&repo.join("packages/[app]"), "main")
        .unwrap();
    assert_eq!(review.files.len(), 1);
    assert_eq!(
        review.files[0].new_path.as_deref(),
        Some("packages/[app]/inside.txt")
    );
    let diff = GitService::new()
        .get_diff(
            &repo.join("packages/[app]"),
            &GitDiffSpec::CommitVsCommit {
                old_rev: review.base_commit,
                new_rev: review.head_commit,
                file: review.files[0].clone(),
            },
        )
        .unwrap();
    assert_eq!(diff.stats.additions, 1);
    assert_eq!(diff.stats.deletions, 1);
    std::fs::write(repo.join("packages/[app]/inside.txt"), "worktree\n").unwrap();
    let files = GitService::new()
        .status_files(&repo.join("packages/[app]"))
        .unwrap();
    assert_eq!(files.len(), 1);
}

#[test]
fn branch_review_rejects_missing_unborn_and_unrelated_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init(repo);
    let service = GitService::new();
    assert!(service.branch_review(repo, "main").is_err());
    commit(repo, "one.txt", b"one\n");
    for revision in ["", "missing", "--help", "main\n--all"] {
        assert!(service.branch_review(repo, revision).is_err(), "{revision}");
    }
    git(repo, &["checkout", "--orphan", "unrelated"]);
    git(repo, &["commit", "-qm", "unrelated root"]);
    assert!(service
        .branch_review(repo, "main")
        .unwrap_err()
        .contains("no common ancestor"));
}

#[test]
fn worktree_review_lists_files_inside_new_directories() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init(repo);
    std::fs::create_dir_all(repo.join("new/sub")).unwrap();
    std::fs::write(repo.join("new/sub/file.txt"), "new content\n").unwrap();
    let service = GitService::new();
    let files = service.status_files(repo).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].new_path.as_deref(), Some("new/sub/file.txt"));
    let diff = service
        .get_diff(
            repo,
            &GitDiffSpec::WorktreeVsHead {
                file: files[0].clone(),
            },
        )
        .unwrap();
    assert_eq!(diff.stats.additions, 1);
}
