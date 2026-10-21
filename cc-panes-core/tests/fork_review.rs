use cc_panes_core::models::fork_review::*;
use cc_panes_core::services::ForkReviewService;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture {
    _temp: tempfile::TempDir,
    source: PathBuf,
    data: PathBuf,
    service: ForkReviewService,
}
fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]);
        // 内容逐字节断言：Windows runner 默认 core.autocrlf=true 会改写检出换行。
        git(&source, &["config", "core.autocrlf", "false"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(
            &source,
            &["config", "user.email", "fixture@example.invalid"],
        );
        fs::write(source.join("file.txt"), lines()).unwrap();
        fs::write(source.join("other.txt"), "other\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-qm", "base"]);
        let data = temp.path().join("data");
        let service = ForkReviewService::new(data.clone());
        Self {
            _temp: temp,
            source,
            data,
            service,
        }
    }
    fn prepare(&self, mode: ForkReviewMode) -> ForkReviewRecord {
        self.service
            .prepare(PrepareChatForkRequest {
                cwd: self.source.to_string_lossy().into_owned(),
                mode,
                source_tab_id: Some("parent-tab".into()),
                child_tab_id: Some("child-tab".into()),
                source_session_id: Some("parent-session".into()),
                title: Some("Plan A".into()),
                engine_id: Some("codex".into()),
            })
            .unwrap()
            .record
            .unwrap()
    }
    fn apply(
        &self,
        view: &ForkComparison,
        selections: Vec<ForkSelection>,
    ) -> cc_panes_core::utils::AppResult<ApplyForkChangesResult> {
        self.service.apply(
            &view.record.id,
            ApplyForkChangesRequest {
                revision: view.revision.clone(),
                selections,
            },
        )
    }
}
fn lines() -> String {
    (0..90).map(|i| format!("line-{i}\n")).collect()
}
fn edit(path: &Path, index: usize, value: &str) {
    let text = fs::read_to_string(path).unwrap();
    fs::write(
        path,
        text.replace(&format!("line-{index}\n"), &format!("{value}\n")),
    )
    .unwrap();
}
fn whole(path: &str) -> ForkSelection {
    ForkSelection {
        path: path.into(),
        hunk_ids: None,
    }
}

#[test]
fn dirty_baseline_and_origin_survive_restart_without_polluting_source_index() {
    let f = Fixture::new();
    fs::write(f.source.join("file.txt"), "staged\n").unwrap();
    git(&f.source, &["add", "file.txt"]);
    fs::write(f.source.join("file.txt"), "inherited working\n").unwrap();
    fs::write(f.source.join("new.txt"), "inherited new\n").unwrap();
    let record = f.prepare(ForkReviewMode::Worktree);
    assert!(f.service.compare(&record.id).unwrap().files.is_empty());
    fs::write(
        Path::new(&record.target_cwd).join("file.txt"),
        "fork only\n",
    )
    .unwrap();
    let restarted = ForkReviewService::new(f.data.clone());
    let view = restarted.compare(&record.id).unwrap();
    assert_eq!(view.files.len(), 1);
    assert_eq!(
        view.files[0].base_content.as_deref(),
        Some("inherited working\n")
    );
    assert_eq!(
        restarted.list().unwrap()[0].source_session_id.as_deref(),
        Some("parent-session")
    );
    f.apply(&view, vec![whole("file.txt")]).unwrap();
    assert_eq!(
        fs::read_to_string(f.source.join("file.txt")).unwrap(),
        "fork only\n"
    );
    assert_eq!(git(&f.source, &["show", ":file.txt"]), "staged\n");
    assert_eq!(
        fs::read_to_string(f.source.join("new.txt")).unwrap(),
        "inherited new\n"
    );
}

#[test]
fn adopting_ignore_rules_does_not_delete_inherited_untracked_files() {
    let f = Fixture::new();
    fs::write(f.source.join("notes.txt"), "keep inherited notes\n").unwrap();
    let record = f.prepare(ForkReviewMode::Worktree);
    let child = Path::new(&record.target_cwd);
    fs::write(child.join(".gitignore"), "notes.txt\nnew-secret.txt\n").unwrap();
    fs::write(child.join("new-secret.txt"), "new ignored data").unwrap();
    let view = f.service.compare(&record.id).unwrap();
    assert_eq!(
        view.files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        [".gitignore"]
    );
    f.apply(&view, vec![whole(".gitignore")]).unwrap();
    for root in [f.source.as_path(), child] {
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "keep inherited notes\n"
        );
    }
    assert!(!f.source.join("new-secret.txt").exists());
    assert!(f
        .service
        .compare(&record.id)
        .unwrap()
        .files
        .iter()
        .all(|file| file.path == ".gitignore"));
}

#[test]
fn ignored_baseline_file_edits_are_reviewed_and_invalidate_stale_adoption() {
    let f = Fixture::new();
    fs::write(f.source.join("notes.txt"), "inherited\n").unwrap();
    let record = f.prepare(ForkReviewMode::Worktree);
    let child = Path::new(&record.target_cwd);
    fs::write(child.join(".gitignore"), "notes.txt\n").unwrap();
    fs::write(child.join("notes.txt"), "first change\n").unwrap();
    let view = f.service.compare(&record.id).unwrap();
    let changed = view
        .files
        .iter()
        .find(|file| file.path == "notes.txt")
        .unwrap();
    assert_eq!(changed.status, "modified");
    assert_eq!(changed.child_content.as_deref(), Some("first change\n"));
    fs::write(child.join("notes.txt"), "second change\n").unwrap();
    assert_eq!(
        f.apply(&view, vec![whole("notes.txt")]).unwrap_err().code(),
        Some("FORK_CHANGED")
    );
    assert_eq!(
        fs::read_to_string(f.source.join("notes.txt")).unwrap(),
        "inherited\n"
    );
    let refreshed = f.service.compare(&record.id).unwrap();
    f.apply(&refreshed, vec![whole(".gitignore"), whole("notes.txt")])
        .unwrap();
    assert_eq!(
        fs::read_to_string(f.source.join("notes.txt")).unwrap(),
        "second change\n"
    );
}

#[test]
fn actually_deleted_ignored_baseline_files_remain_adoptable_deletions() {
    let f = Fixture::new();
    fs::write(f.source.join("notes.txt"), "inherited\n").unwrap();
    let record = f.prepare(ForkReviewMode::Worktree);
    let child = Path::new(&record.target_cwd);
    fs::write(child.join(".gitignore"), "notes.txt\n").unwrap();
    fs::remove_file(child.join("notes.txt")).unwrap();
    let view = f.service.compare(&record.id).unwrap();
    let removed = view
        .files
        .iter()
        .find(|file| file.path == "notes.txt")
        .unwrap();
    assert_eq!(removed.status, "deleted");
    assert!(removed.supported && !removed.conflict);
    f.apply(&view, vec![whole(".gitignore"), whole("notes.txt")])
        .unwrap();
    assert!(!f.source.join("notes.txt").exists());
}

#[test]
fn selective_hunks_preserve_both_unselected_fork_changes_and_compatible_parent_changes() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    let child = Path::new(&record.target_cwd).join("file.txt");
    edit(&child, 5, "fork-first");
    edit(&child, 65, "fork-second");
    edit(&f.source.join("file.txt"), 85, "parent-only");
    let view = f.service.compare(&record.id).unwrap();
    let file = &view.files[0];
    assert!(file.parent_changed);
    assert!(!file.conflict);
    assert_eq!(file.hunks.len(), 2);
    f.apply(
        &view,
        vec![ForkSelection {
            path: "file.txt".into(),
            hunk_ids: Some(vec![file.hunks[0].id.clone()]),
        }],
    )
    .unwrap();
    let content = fs::read_to_string(f.source.join("file.txt")).unwrap();
    assert!(content.contains("fork-first\n"));
    assert!(content.contains("line-65\n"));
    assert!(content.contains("parent-only\n"));
    assert!(fs::read_to_string(&child)
        .unwrap()
        .contains("fork-second\n"));
}

#[test]
fn conflicting_selection_does_not_apply_any_selected_file() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    edit(
        &Path::new(&record.target_cwd).join("file.txt"),
        5,
        "fork-change",
    );
    edit(&f.source.join("file.txt"), 5, "parent-change");
    fs::write(
        Path::new(&record.target_cwd).join("other.txt"),
        "fork other\n",
    )
    .unwrap();
    let view = f.service.compare(&record.id).unwrap();
    assert!(
        view.files
            .iter()
            .find(|v| v.path == "file.txt")
            .unwrap()
            .conflict
    );
    assert_eq!(
        f.apply(&view, vec![whole("other.txt"), whole("file.txt")])
            .unwrap_err()
            .code(),
        Some("FORK_CONFLICT")
    );
    assert_eq!(
        fs::read_to_string(f.source.join("other.txt")).unwrap(),
        "other\n"
    );
    assert!(fs::read_to_string(f.source.join("file.txt"))
        .unwrap()
        .contains("parent-change"));
}

#[test]
fn stale_parent_or_child_previews_are_rejected_before_writes() {
    for change_parent in [true, false] {
        let f = Fixture::new();
        let record = f.prepare(ForkReviewMode::Worktree);
        edit(
            &Path::new(&record.target_cwd).join("file.txt"),
            5,
            "fork-change",
        );
        let view = f.service.compare(&record.id).unwrap();
        let changed = if change_parent {
            f.source.clone()
        } else {
            PathBuf::from(&record.target_cwd)
        };
        fs::write(changed.join("other.txt"), "after preview\n").unwrap();
        assert_eq!(
            f.apply(&view, vec![whole("file.txt")]).unwrap_err().code(),
            Some("FORK_CHANGED")
        );
        assert_eq!(
            fs::read_to_string(f.source.join("file.txt")).unwrap(),
            lines()
        );
    }
}

#[test]
fn binary_additions_and_deletions_are_adopted_without_touching_source_index() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    let target = Path::new(&record.target_cwd);
    fs::write(target.join("binary.dat"), [0, 1, 255, 2]).unwrap();
    fs::remove_file(target.join("other.txt")).unwrap();
    let view = f.service.compare(&record.id).unwrap();
    assert!(
        view.files
            .iter()
            .find(|v| v.path == "binary.dat")
            .unwrap()
            .binary
    );
    f.apply(&view, vec![whole("binary.dat"), whole("other.txt")])
        .unwrap();
    assert_eq!(
        fs::read(f.source.join("binary.dat")).unwrap(),
        [0, 1, 255, 2]
    );
    assert!(!f.source.join("other.txt").exists());
    assert_eq!(git(&f.source, &["show", ":other.txt"]), "other\n");
}

#[test]
fn shared_directory_and_invalid_selections_are_read_only() {
    let f = Fixture::new();
    let shared = f.prepare(ForkReviewMode::SameDirectory);
    edit(&f.source.join("file.txt"), 5, "shared");
    let view = f.service.compare(&shared.id).unwrap();
    assert!(view.shared_directory);
    assert!(f.apply(&view, vec![whole("file.txt")]).is_err());
    let isolated = f.prepare(ForkReviewMode::Worktree);
    edit(
        &Path::new(&isolated.target_cwd).join("file.txt"),
        20,
        "isolated",
    );
    let view = f.service.compare(&isolated.id).unwrap();
    for selection in [
        vec![],
        vec![whole("../escape")],
        vec![whole("file.txt"), whole("file.txt")],
        vec![ForkSelection {
            path: "file.txt".into(),
            hunk_ids: Some(vec!["stale".into()]),
        }],
    ] {
        assert!(f.apply(&view, selection).is_err());
    }
    assert!(!fs::read_to_string(f.source.join("file.txt"))
        .unwrap()
        .contains("isolated"));
}

#[cfg(unix)]
#[test]
fn symlinks_are_visible_but_cannot_overwrite_external_files() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    let outside = f._temp.path().join("outside");
    fs::write(&outside, "outside").unwrap();
    let child = Path::new(&record.target_cwd).join("file.txt");
    fs::remove_file(&child).unwrap();
    std::os::unix::fs::symlink(&outside, &child).unwrap();
    let view = f.service.compare(&record.id).unwrap();
    assert!(!view.files[0].supported);
    assert!(f.apply(&view, vec![whole("file.txt")]).is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    assert_eq!(
        fs::read_to_string(f.source.join("file.txt")).unwrap(),
        lines()
    );
}

#[test]
fn second_hunk_selection_recounts_offsets_after_an_unselected_insertion() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    let path = Path::new(&record.target_cwd).join("file.txt");
    let changed = lines()
        .replace("line-3\n", "extra-a\nextra-b\nline-3\n")
        .replace("line-70\n", "chosen-second\n");
    fs::write(path, changed).unwrap();
    let view = f.service.compare(&record.id).unwrap();
    assert_eq!(view.files[0].hunks.len(), 2);
    f.apply(
        &view,
        vec![ForkSelection {
            path: "file.txt".into(),
            hunk_ids: Some(vec![view.files[0].hunks[1].id.clone()]),
        }],
    )
    .unwrap();
    let actual = fs::read_to_string(f.source.join("file.txt")).unwrap();
    assert!(!actual.contains("extra-a"));
    assert!(actual.contains("chosen-second"));
}

#[test]
fn a_nonconflicting_hunk_can_be_adopted_even_if_an_unselected_hunk_conflicts() {
    let f = Fixture::new();
    let record = f.prepare(ForkReviewMode::Worktree);
    let child = Path::new(&record.target_cwd).join("file.txt");
    edit(&child, 5, "fork-conflict");
    edit(&child, 70, "fork-safe");
    edit(&f.source.join("file.txt"), 5, "parent-conflict");
    let view = f.service.compare(&record.id).unwrap();
    assert!(view.files[0].conflict);
    assert_eq!(view.files[0].hunks.len(), 2);
    f.apply(
        &view,
        vec![ForkSelection {
            path: "file.txt".into(),
            hunk_ids: Some(vec![view.files[0].hunks[1].id.clone()]),
        }],
    )
    .unwrap();
    let actual = fs::read_to_string(f.source.join("file.txt")).unwrap();
    assert!(actual.contains("parent-conflict"));
    assert!(actual.contains("fork-safe"));
}

fn prepare_request(source: &Path) -> PrepareChatForkRequest {
    PrepareChatForkRequest {
        cwd: source.to_string_lossy().into_owned(),
        mode: ForkReviewMode::Worktree,
        source_tab_id: None,
        child_tab_id: None,
        source_session_id: None,
        title: None,
        engine_id: None,
    }
}

#[test]
fn unsupported_source_is_rejected_before_creating_a_worktree_or_branch() {
    let f = Fixture::new();
    let head = git(&f.source, &["rev-parse", "HEAD"]);
    git(
        &f.source,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{},submodule", head.trim()),
        ],
    );
    let index = fs::read(f.source.join(".git/index")).unwrap();
    let worktrees = git(&f.source, &["worktree", "list", "--porcelain"]);
    let branches = git(&f.source, &["branch", "--list"]);
    assert!(f.service.prepare(prepare_request(&f.source)).is_err());
    assert_eq!(
        git(&f.source, &["worktree", "list", "--porcelain"]),
        worktrees
    );
    assert_eq!(git(&f.source, &["branch", "--list"]), branches);
    assert_eq!(fs::read(f.source.join(".git/index")).unwrap(), index);
}

#[test]
fn unavailable_record_storage_is_rejected_before_creating_a_worktree() {
    let f = Fixture::new();
    fs::create_dir_all(&f.data).unwrap();
    fs::write(f.data.join("fork-reviews"), "storage is blocked by a file").unwrap();
    let worktrees = git(&f.source, &["worktree", "list", "--porcelain"]);
    let branches = git(&f.source, &["branch", "--list"]);
    assert!(f.service.prepare(prepare_request(&f.source)).is_err());
    assert_eq!(
        git(&f.source, &["worktree", "list", "--porcelain"]),
        worktrees
    );
    assert_eq!(git(&f.source, &["branch", "--list"]), branches);
}

#[test]
fn malformed_inputs_and_missing_records_keep_their_http_error_categories() {
    let f = Fixture::new();
    assert_eq!(
        f.service.compare("invalid-id").unwrap_err().code(),
        Some("FORK_INVALID_REQUEST")
    );
    assert_eq!(
        f.service
            .compare(&uuid::Uuid::new_v4().to_string())
            .unwrap_err()
            .code(),
        Some("NOT_FOUND")
    );
    assert_eq!(
        f.service
            .prepare(prepare_request(Path::new("relative/path")))
            .unwrap_err()
            .code(),
        Some("FORK_INVALID_REQUEST")
    );
}

#[cfg(unix)]
#[test]
fn unexpected_failure_after_creation_preserves_the_worktree_and_reports_recovery_path() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let hook = f.source.join(".git/hooks/post-checkout");
    fs::write(&hook, "#!/bin/sh\nprintf 'preserve this user work' > hook-user-change\nmkfifo hook-unsupported-node\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let error = f.service.prepare(prepare_request(&f.source)).unwrap_err();
    assert_eq!(error.code(), Some("FORK_PREPARATION_INCOMPLETE"));
    let source = dunce::canonicalize(&f.source).unwrap();
    let output = git(&f.source, &["worktree", "list", "--porcelain"]);
    let paths: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .collect();
    assert_eq!(paths.len(), 2);
    let retained = paths
        .iter()
        .map(Path::new)
        .find(|path| dunce::canonicalize(path).unwrap() != source)
        .unwrap();
    assert_eq!(
        fs::read(retained.join("hook-user-change")).unwrap(),
        b"preserve this user work"
    );
    assert!(fs::symlink_metadata(retained.join("hook-unsupported-node")).is_ok());
    assert!(error.to_string().contains(retained.to_str().unwrap()));
    assert!(error.to_string().contains("recover"));
}
