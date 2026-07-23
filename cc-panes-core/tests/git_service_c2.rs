use cc_panes_core::models::{DiffTruncationReason, GitChangeStatus, GitDiffSpec, GitLogQuery};
use cc_panes_core::services::GitService;
use std::path::Path;
use std::process::Command;

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .expect("git must be available");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q"]);
    git(path, &["config", "user.email", "test@example.com"]);
    git(path, &["config", "user.name", "Test User"]);
    git(path, &["config", "core.autocrlf", "false"]);
}

fn commit_file(path: &Path, file: &str, content: &[u8], subject: &str) {
    let target = path.join(file);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(target, content).unwrap();
    git(path, &["add", "--", file]);
    git(path, &["commit", "-q", "-m", subject]);
}

#[test]
fn log_uses_fixed_nul_fields_and_explicit_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    commit_file(&repo, "one.txt", b"one\n", "first");
    commit_file(
        &repo,
        "two.txt",
        b"two\n",
        "subject\u{1f}with\u{1e}controls",
    );
    commit_file(&repo, "three.txt", b"three\n", "third");

    let service = GitService::new();
    let first = service
        .get_log(
            &repo,
            &GitLogQuery {
                limit: 2,
                ..GitLogQuery::default()
            },
        )
        .unwrap();
    assert_eq!(first.commits.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.next_offset, Some(2));

    let second = service
        .get_log(
            &repo,
            &GitLogQuery {
                limit: 2,
                offset: 2,
                ..GitLogQuery::default()
            },
        )
        .unwrap();
    assert_eq!(second.commits.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.next_offset, None);
    assert_eq!(second.commits[0].subject, "first");

    let all = service
        .get_log(
            &repo,
            &GitLogQuery {
                limit: 10,
                ..GitLogQuery::default()
            },
        )
        .unwrap();
    assert!(all
        .commits
        .iter()
        .any(|commit| commit.subject == "subject\u{1f}with\u{1e}controls"));
}

#[test]
fn branches_are_local_only() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    commit_file(&repo, "README.md", b"initial\n", "initial");
    git(&repo, &["branch", "feature/local"]);
    git(
        &repo,
        &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
    );

    let branches = GitService::new().list_local_branches(&repo).unwrap();
    assert!(branches.iter().any(|branch| branch == "feature/local"));
    assert!(!branches.iter().any(|branch| branch == "remote-only"));
    assert!(!branches.iter().any(|branch| branch.contains("origin/")));
}

#[test]
fn commit_files_preserve_root_rename_and_modes() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    commit_file(&repo, "old.txt", b"initial\n", "root");

    let service = GitService::new();
    let root = service
        .get_log(&repo, &GitLogQuery::default())
        .unwrap()
        .commits
        .pop()
        .unwrap();
    let root_files = service.list_commit_files(&repo, &root.hash, None).unwrap();
    assert_eq!(root_files.len(), 1);
    assert_eq!(root_files[0].status, GitChangeStatus::Added);
    assert_eq!(root_files[0].old_path, None);
    assert_eq!(root_files[0].new_path.as_deref(), Some("old.txt"));
    assert_eq!(root_files[0].old_mode.as_deref(), Some("000000"));
    assert_eq!(root_files[0].new_mode.as_deref(), Some("100644"));

    git(&repo, &["mv", "old.txt", "new.txt"]);
    git(&repo, &["commit", "-q", "-m", "rename"]);
    let rename = service
        .get_log(&repo, &GitLogQuery::default())
        .unwrap()
        .commits
        .remove(0);
    let rename_files = service
        .list_commit_files(&repo, &rename.hash, None)
        .unwrap();
    assert_eq!(rename_files.len(), 1);
    assert_eq!(rename_files[0].status, GitChangeStatus::Renamed);
    assert_eq!(rename_files[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(rename_files[0].new_path.as_deref(), Some("new.txt"));
}

#[test]
fn merge_files_default_to_first_parent_and_allow_parent_switch() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    commit_file(&repo, "base.txt", b"base\n", "base");
    let main_branch = GitService::new().get_branch_compat(&repo).unwrap().unwrap();

    git(&repo, &["checkout", "-q", "-b", "topic"]);
    commit_file(&repo, "topic.txt", b"topic\n", "topic");
    git(&repo, &["checkout", "-q", &main_branch]);
    commit_file(&repo, "main.txt", b"main\n", "main");
    git(&repo, &["merge", "-q", "--no-ff", "topic", "-m", "merge"]);

    let service = GitService::new();
    let merge = service
        .get_log(&repo, &GitLogQuery::default())
        .unwrap()
        .commits
        .remove(0);
    assert_eq!(merge.parents.len(), 2);

    let first_parent = service.list_commit_files(&repo, &merge.hash, None).unwrap();
    assert!(first_parent
        .iter()
        .any(|file| file.new_path.as_deref() == Some("topic.txt")));
    let second_parent = service
        .list_commit_files(&repo, &merge.hash, Some(1))
        .unwrap();
    assert!(second_parent
        .iter()
        .any(|file| file.new_path.as_deref() == Some("main.txt")));
}

#[test]
fn worktree_diff_handles_unborn_content_and_does_not_create_history_db() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    std::fs::write(repo.join("new.txt"), "new content\n").unwrap();
    let file = GitService::new().status_files(&repo).unwrap().remove(0);

    let diff = GitService::new()
        .get_diff(&repo, &GitDiffSpec::WorktreeVsHead { file })
        .unwrap();
    assert!(!diff.is_binary);
    assert_eq!(diff.stats.additions, 1);
    assert_eq!(diff.old_size, 0);
    assert_eq!(diff.new_size, 12);
    assert!(!repo.join(".ccpanes/history/history.db").exists());
}

#[test]
fn diff_reports_binary_file_size_and_line_limit_separately() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);

    std::fs::write(repo.join("binary.dat"), [0, 1, 2, 3]).unwrap();
    let binary_file = GitService::new().status_files(&repo).unwrap().remove(0);
    let binary = GitService::new()
        .get_diff(&repo, &GitDiffSpec::WorktreeVsHead { file: binary_file })
        .unwrap();
    assert!(binary.is_binary);
    assert_eq!(binary.truncation_reason, None);

    std::fs::remove_file(repo.join("binary.dat")).unwrap();
    std::fs::create_dir_all(repo.join(".ccpanes")).unwrap();
    std::fs::write(
        repo.join(".ccpanes/config.toml"),
        "[history]\nmaxFileSize = 4\n",
    )
    .unwrap();
    std::fs::write(repo.join("large.txt"), "12345").unwrap();
    let large_file = GitService::new()
        .status_files(&repo)
        .unwrap()
        .into_iter()
        .find(|file| file.new_path.as_deref() == Some("large.txt"))
        .unwrap();
    let large = GitService::new()
        .get_diff(&repo, &GitDiffSpec::WorktreeVsHead { file: large_file })
        .unwrap();
    assert!(large.truncated);
    assert_eq!(
        large.truncation_reason,
        Some(DiffTruncationReason::FileSize)
    );
    assert_eq!(large.new_size, 5);
    assert!(!repo.join(".ccpanes/history/history.db").exists());

    let old = "old\n";
    let new = "line\n".repeat(10_001);
    let line_limited = cc_panes_core::repository::HistoryFileRepository::compute_diff(old, &new);
    assert!(line_limited.truncated);
    assert_eq!(
        line_limited.truncation_reason,
        Some(DiffTruncationReason::LineCount)
    );
    assert_eq!(line_limited.old_size, old.len() as u64);
    assert_eq!(line_limited.new_size, new.len() as u64);
}

#[cfg(unix)]
#[test]
fn worktree_symlink_diff_compares_link_target() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo);
    std::fs::write(repo.join("target-a.txt"), "same target contents\n").unwrap();
    std::fs::write(repo.join("target-b.txt"), "same target contents\n").unwrap();
    symlink("target-a.txt", repo.join("link.txt")).unwrap();
    git(&repo, &["add", "link.txt"]);
    git(&repo, &["commit", "-q", "-m", "add symlink"]);
    std::fs::remove_file(repo.join("link.txt")).unwrap();
    symlink("target-b.txt", repo.join("link.txt")).unwrap();

    let file = GitService::new().status_files(&repo).unwrap().remove(0);
    let diff = GitService::new()
        .get_diff(&repo, &GitDiffSpec::WorktreeVsHead { file })
        .unwrap();
    assert!(diff.hunks.iter().flat_map(|hunk| &hunk.lines).any(|line| {
        line.content.contains("target-a.txt") || line.content.contains("target-b.txt")
    }));
}

#[cfg(unix)]
#[test]
fn worktree_diff_rejects_parent_symlink_escape() {
    use cc_panes_core::models::GitChangedFile;
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let outside = temp.path().join("outside");
    init_repo(&repo);
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside\n").unwrap();
    symlink(&outside, repo.join("escape")).unwrap();

    let result = GitService::new().get_diff(
        &repo,
        &GitDiffSpec::WorktreeVsHead {
            file: GitChangedFile {
                status: GitChangeStatus::Added,
                old_path: None,
                new_path: Some("escape/secret.txt".to_string()),
                old_mode: None,
                new_mode: None,
            },
        },
    );

    assert!(result.unwrap_err().contains("escapes the Git repository"));
}
