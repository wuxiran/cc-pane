use cc_panes_core::services::TurnCheckpointService;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}
struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    service: TurnCheckpointService,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        for (path, content) in [
            ("a.txt", "base a\n"),
            ("b.txt", "base b\n"),
            (".gitignore", "ignored/\n"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        let service = TurnCheckpointService::new(temp.path().join("data"));
        Self {
            temp,
            root,
            service,
        }
    }
    fn changed(&self) -> String {
        let record = self.service.begin("chat", "turn", &self.root).unwrap();
        fs::write(self.root.join("a.txt"), "changed a\n").unwrap();
        self.service.finish(&record.id, "completed").unwrap();
        record.id
    }
}

#[test]
fn restart_restores_whole_disk_turn_with_dirty_base_binary_add_delete_and_rename() {
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), "user's existing dirty edit\n").unwrap();
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let record = f.service.begin("chat", "turn-1", &f.root).unwrap();
    fs::write(f.root.join("a.txt"), "agent changed\n").unwrap();
    fs::rename(f.root.join("b.txt"), f.root.join("renamed.txt")).unwrap();
    fs::write(f.root.join("new.bin"), [0, 255, 1, 2]).unwrap();
    f.service.finish(&record.id, "completed").unwrap();
    let restarted = TurnCheckpointService::new(f.temp.path().join("data"));
    let listed = restarted.list("chat").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].turn_id, "turn-1");
    let review = restarted.review(&record.id).unwrap();
    assert!(review.can_restore);
    assert_eq!(review.files.len(), 4);
    assert!(
        review
            .files
            .iter()
            .find(|file| file.path == "new.bin")
            .unwrap()
            .binary
    );
    let result = restarted.restore(&record.id, &review.revision).unwrap();
    assert_eq!(result.restored_paths.len(), 4);
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "user's existing dirty edit\n"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "base b\n"
    );
    assert!(!f.root.join("renamed.txt").exists());
    assert!(!f.root.join("new.bin").exists());
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert!(restarted.list("chat").unwrap()[0].restored_at.is_some());
    assert!(!restarted.review(&record.id).unwrap().can_restore);
}

#[test]
fn later_edit_to_any_changed_file_blocks_the_entire_restore() {
    let f = Fixture::new();
    let record = f.service.begin("chat", "turn", &f.root).unwrap();
    fs::write(f.root.join("a.txt"), "agent a").unwrap();
    fs::write(f.root.join("b.txt"), "agent b").unwrap();
    f.service.finish(&record.id, "completed").unwrap();
    fs::write(f.root.join("b.txt"), "later user edit").unwrap();
    let review = f.service.review(&record.id).unwrap();
    assert!(!review.can_restore);
    assert!(f.service.restore(&record.id, &review.revision).is_err());
    assert_eq!(fs::read_to_string(f.root.join("a.txt")).unwrap(), "agent a");
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "later user edit"
    );
}

#[test]
fn unrelated_edits_are_preserved_and_stale_reviews_rejected() {
    let f = Fixture::new();
    let id = f.changed();
    let old_review = f.service.review(&id).unwrap();
    fs::write(f.root.join("b.txt"), "later unrelated edit").unwrap();
    assert_eq!(
        f.service
            .restore(&id, &old_review.revision)
            .unwrap_err()
            .code(),
        Some("CHECKPOINT_CHANGED")
    );
    let review = f.service.review(&id).unwrap();
    assert!(review.can_restore);
    f.service.restore(&id, &review.revision).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "later unrelated edit"
    );
}

#[test]
fn active_turn_in_another_chat_blocks_restore_until_finished() {
    let f = Fixture::new();
    let id = f.changed();
    fs::create_dir(f.root.join("sub")).unwrap();
    let active = f
        .service
        .begin("another-chat", "next", &f.root.join("sub"))
        .unwrap();
    let review = f.service.review(&id).unwrap();
    assert!(!review.can_restore);
    assert!(review.blocked_reason.unwrap().contains("active"));
    f.service.finish(&active.id, "cancelled").unwrap();
    assert!(f.service.review(&id).unwrap().can_restore);
}

#[test]
fn interrupted_turn_survives_restart_without_inventing_an_after_snapshot() {
    let f = Fixture::new();
    let record = f.service.begin("chat", "turn", &f.root).unwrap();
    fs::write(f.root.join("a.txt"), "unknown intermediate edit").unwrap();
    let restarted = TurnCheckpointService::new(f.temp.path().join("data"));
    assert_eq!(restarted.list("chat").unwrap()[0].outcome, "interrupted");
    assert!(!restarted.review(&record.id).unwrap().can_restore);
    assert!(restarted.finish(&record.id, "completed").is_err());
}

#[test]
fn ignored_new_files_are_excluded_but_baseline_files_remain_observed() {
    let f = Fixture::new();
    fs::write(f.root.join("scratch.txt"), "baseline untracked").unwrap();
    let record = f.service.begin("chat", "turn", &f.root).unwrap();
    fs::write(f.root.join(".gitignore"), "ignored/\nscratch.txt\n").unwrap();
    fs::write(f.root.join("scratch.txt"), "agent changed").unwrap();
    fs::create_dir(f.root.join("ignored")).unwrap();
    fs::write(f.root.join("ignored/private.txt"), "untouched private").unwrap();
    f.service.finish(&record.id, "completed").unwrap();
    let review = f.service.review(&record.id).unwrap();
    assert_eq!(review.files.len(), 2);
    f.service.restore(&record.id, &review.revision).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("scratch.txt")).unwrap(),
        "baseline untracked"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("ignored/private.txt")).unwrap(),
        "untouched private"
    );
}

#[test]
fn changed_head_blocks_restore_without_rewinding_git_history() {
    let f = Fixture::new();
    let id = f.changed();
    git(&f.root, &["add", "."]);
    git(&f.root, &["commit", "-qm", "later commit"]);
    let head = git(&f.root, &["rev-parse", "HEAD"]);
    let review = f.service.review(&id).unwrap();
    assert!(!review.can_restore);
    assert!(review.blocked_reason.unwrap().contains("HEAD"));
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), head);
}

#[test]
fn oversized_capture_records_unavailable_reason_instead_of_a_partial_tree() {
    let f = Fixture::new();
    fs::File::create(f.root.join("large.bin"))
        .unwrap()
        .set_len(32 * 1024 * 1024 + 1)
        .unwrap();
    let record = f.service.begin("chat", "turn", &f.root).unwrap();
    assert!(record.before.is_none());
    assert!(record
        .unavailable_reason
        .as_ref()
        .unwrap()
        .contains("32 MiB"));
    f.service.finish(&record.id, "completed").unwrap();
    assert!(!f.service.review(&record.id).unwrap().can_restore);
}

#[test]
fn oversized_escaped_metadata_never_creates_an_unreadable_record() {
    let f = Fixture::new();
    let invalid_path = PathBuf::from(format!("/{}", "\0".repeat(12_000)));
    assert!(f
        .service
        .begin("chat", "invalid-cwd", &invalid_path)
        .is_err());
    assert!(f.service.list("chat").unwrap().is_empty());
}

#[test]
fn failed_after_capture_keeps_before_and_releases_live_repository_lease() {
    let f = Fixture::new();
    let old_id = f.changed();
    let id = f
        .service
        .begin("chat", "oversized-turn", &f.root)
        .unwrap()
        .id;
    fs::File::create(f.root.join("large.bin"))
        .unwrap()
        .set_len(32 * 1024 * 1024 + 1)
        .unwrap();
    let record = f.service.finish(&id, "failed").unwrap();
    assert!(record.before.is_some());
    assert!(record.after.is_none());
    assert!(record.unavailable_reason.unwrap().contains("32 MiB"));
    fs::remove_file(f.root.join("large.bin")).unwrap();
    assert!(f.service.review(&old_id).unwrap().can_restore);
}

#[test]
fn background_process_checkpoint_remains_reviewable_but_unrestorable_after_restart() {
    let f = Fixture::new();
    let previous = f.changed();
    let record = f.service.begin("chat", "background-turn", &f.root).unwrap();
    fs::write(f.root.join("b.txt"), "background command output").unwrap();
    let reason =
        "Managed background terminals are still running; this checkpoint cannot be restored";
    let finished = f
        .service
        .finish_unavailable(&record.id, "completed", reason)
        .unwrap();
    assert!(finished.before.is_some());
    assert!(finished.after.is_some());
    assert_eq!(finished.outcome, "completed");
    assert_eq!(finished.unavailable_reason.as_deref(), Some(reason));
    // The turn lease is released; live background-process guards belong to the app.
    assert!(f.service.review(&previous).unwrap().can_restore);
    let restarted = TurnCheckpointService::new(f.temp.path().join("data"));
    let review = restarted.review(&record.id).unwrap();
    assert_eq!(review.files.len(), 1);
    assert_eq!(
        review.files[0].after_content.as_deref(),
        Some("background command output")
    );
    assert!(!review.can_restore);
    assert_eq!(review.blocked_reason.as_deref(), Some(reason));
    assert_eq!(
        restarted
            .restore(&record.id, &review.revision)
            .unwrap_err()
            .code(),
        Some("CHECKPOINT_RESTORE_BLOCKED")
    );
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "background command output"
    );
    assert_eq!(
        restarted.list("chat").unwrap()[0]
            .unavailable_reason
            .as_deref(),
        Some(reason)
    );
}

#[test]
fn a_late_unavailability_notice_cannot_be_cleared_by_repeated_normal_finish() {
    let f = Fixture::new();
    let id = f.changed();
    let stable = f.service.review(&id).unwrap();
    assert!(stable.can_restore);
    let marked = f
        .service
        .finish_unavailable(&id, "completed", "Background writer still running")
        .unwrap();
    assert!(marked.after.is_some());
    f.service.finish(&id, "completed").unwrap();
    let review = f.service.review(&id).unwrap();
    assert!(!review.can_restore);
    assert_eq!(
        review.blocked_reason.as_deref(),
        Some("Background writer still running")
    );
    assert!(f.service.restore(&id, &stable.revision).is_err());
}

#[test]
fn restores_file_directory_shape_changes_without_deleting_unrelated_children() {
    let f = Fixture::new();
    let record = f.service.begin("chat", "shape-turn", &f.root).unwrap();
    fs::remove_file(f.root.join("a.txt")).unwrap();
    fs::create_dir(f.root.join("a.txt")).unwrap();
    fs::write(f.root.join("a.txt/new.txt"), "nested change").unwrap();
    f.service.finish(&record.id, "completed").unwrap();
    let review = f.service.review(&record.id).unwrap();
    assert!(review.can_restore);
    fs::write(f.root.join("a.txt/unrelated.txt"), "keep me").unwrap();
    let review = f.service.review(&record.id).unwrap();
    assert!(!review.can_restore);
    assert!(f.service.restore(&record.id, &review.revision).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt/new.txt")).unwrap(),
        "nested change"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt/unrelated.txt")).unwrap(),
        "keep me"
    );
    fs::remove_file(f.root.join("a.txt/unrelated.txt")).unwrap();
    fs::create_dir(f.root.join("a.txt/ignored")).unwrap();
    fs::write(f.root.join("a.txt/ignored/private.txt"), "keep ignored").unwrap();
    let review = f.service.review(&record.id).unwrap();
    assert!(f.service.restore(&record.id, &review.revision).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt/new.txt")).unwrap(),
        "nested change"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt/ignored/private.txt")).unwrap(),
        "keep ignored"
    );
    fs::remove_file(f.root.join("a.txt/ignored/private.txt")).unwrap();
    fs::remove_dir(f.root.join("a.txt/ignored")).unwrap();
    let review = f.service.review(&record.id).unwrap();
    f.service.restore(&record.id, &review.revision).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "base a\n"
    );
}

#[cfg(unix)]
#[test]
fn changed_symlinks_are_shown_but_never_followed_or_restored() {
    let f = Fixture::new();
    let id = f.service.begin("chat", "turn", &f.root).unwrap().id;
    std::os::unix::fs::symlink("../outside", f.root.join("link")).unwrap();
    f.service.finish(&id, "completed").unwrap();
    let review = f.service.review(&id).unwrap();
    assert_eq!(review.files.len(), 1);
    assert!(!review.files[0].supported);
    assert!(!review.can_restore);
}
