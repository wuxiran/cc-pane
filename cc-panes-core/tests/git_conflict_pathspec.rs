use cc_panes_core::models::GitResolveConflictRequest;
use cc_panes_core::services::GitService;
use std::fs;
use std::path::Path;
use std::process::{Command, Output};

fn run_git(root: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=.git/no-hooks",
        ])
        .args(args)
        .output()
        .unwrap()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = run_git(root, args);
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn conflicted_repo(names: &[&str], clean: Option<&str>) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "user.email", "test@example.test"]);
    git(root, &["config", "core.autocrlf", "false"]);
    for name in names {
        fs::write(root.join(name), format!("base:{name}\n")).unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    git(root, &["checkout", "-q", "-b", "other"]);
    for branch in ["theirs", "ours"] {
        for name in names.iter().filter(|name| Some(**name) != clean) {
            fs::write(root.join(name), format!("{branch}:{name}\n")).unwrap();
        }
        git(root, &["commit", "-qam", branch]);
        if branch == "theirs" {
            git(root, &["checkout", "-q", "main"]);
        }
    }
    let merge = run_git(root, &["merge", "other"]);
    assert!(!merge.status.success(), "fixture must contain conflicts");
    temp
}

fn assert_only_requested_file_is_resolved(target: &str, other: [&str; 2]) {
    let temp = conflicted_repo(&[target, other[0], other[1]], None);
    let root = temp.path();
    let service = GitService::new();
    let versions = service.conflict_versions(root, target).unwrap();
    assert_eq!(versions.ours.content, Some(format!("ours:{target}\n")));
    assert_eq!(versions.theirs.content, Some(format!("theirs:{target}\n")));
    let before = other.map(|name| fs::read(root.join(name)).unwrap());
    let result = service
        .resolve_conflict(&GitResolveConflictRequest {
            path: root.to_string_lossy().into_owned(),
            file: target.to_string(),
            content: "resolved only this file\n".to_string(),
        })
        .unwrap();
    assert!(result.staged);
    assert_eq!(result.remaining_conflicts, 2);
    assert_remaining_conflicts(root, other);
    assert_eq!(
        git(root, &["show", &format!(":0:{target}")]),
        "resolved only this file\n"
    );
    for (name, content) in other.into_iter().zip(before) {
        assert_eq!(fs::read(root.join(name)).unwrap(), content);
        assert_eq!(
            git(root, &["show", &format!(":2:{name}")]),
            format!("ours:{name}\n")
        );
        assert_eq!(
            git(root, &["show", &format!(":3:{name}")]),
            format!("theirs:{name}\n")
        );
    }
}

fn assert_remaining_conflicts(root: &Path, other: [&str; 2]) {
    let mut remaining: Vec<_> = GitService::new()
        .list_conflicts(root)
        .unwrap()
        .files
        .into_iter()
        .map(|file| file.path)
        .collect();
    remaining.sort();
    let mut expected = other.map(str::to_owned).to_vec();
    expected.sort();
    assert_eq!(remaining, expected);
}

#[test]
fn bracket_filename_resolution_keeps_other_two_conflicts_unmerged() {
    assert_only_requested_file_is_resolved("[ab].txt", ["a.txt", "b.txt"]);
}

#[cfg(unix)]
#[test]
fn pathspec_magic_filename_is_literal_for_query_and_staging() {
    assert_only_requested_file_is_resolved(":(glob)*.txt", ["a.txt", "b.txt"]);
}

#[test]
fn non_conflicted_glob_filename_cannot_borrow_other_files_conflicts() {
    let temp = conflicted_repo(&["[ab].txt", "a.txt", "b.txt"], Some("[ab].txt"));
    let root = temp.path();
    let service = GitService::new();
    assert!(service.conflict_versions(root, "[ab].txt").is_err());
    assert!(service
        .resolve_conflict(&GitResolveConflictRequest {
            path: root.to_string_lossy().into_owned(),
            file: "[ab].txt".to_string(),
            content: "should not be written".to_string(),
        })
        .is_err());
    assert_eq!(
        fs::read_to_string(root.join("[ab].txt")).unwrap(),
        "base:[ab].txt\n"
    );
    assert_eq!(service.list_conflicts(root).unwrap().files.len(), 2);
}
