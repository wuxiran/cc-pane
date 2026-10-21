use cc_panes_core::models::fork_review::*;
use cc_panes_core::services::ForkReviewService;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=.git/no-hooks",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Fixture {
    _temp: tempfile::TempDir,
    source: PathBuf,
    child: PathBuf,
    service: ForkReviewService,
    record: ForkReviewRecord,
}

fn initialize_source(source: &Path, directory_to_file: bool, second_file: bool) {
    fs::create_dir(source).unwrap();
    git(source, &["init", "-q"]);
    git(source, &["config", "core.autocrlf", "false"]);
    git(source, &["config", "user.name", "Fixture"]);
    git(source, &["config", "user.email", "fixture@example.invalid"]);
    if directory_to_file {
        fs::create_dir_all(source.join("module/nested")).unwrap();
        fs::write(source.join("module/nested/item"), "before").unwrap();
        if second_file {
            fs::write(source.join("module/unselected"), "keep").unwrap();
        }
    } else {
        fs::write(source.join("module"), "before").unwrap();
    }
    git(source, &["add", "."]);
    git(source, &["commit", "-qm", "base"]);
}

impl Fixture {
    fn new(directory_to_file: bool, second_file: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        initialize_source(&source, directory_to_file, second_file);
        let service = ForkReviewService::new(temp.path().join("data"));
        let record = service
            .prepare(PrepareChatForkRequest {
                cwd: source.to_string_lossy().into_owned(),
                mode: ForkReviewMode::Worktree,
                source_tab_id: None,
                child_tab_id: None,
                source_session_id: None,
                title: None,
                engine_id: None,
            })
            .unwrap()
            .record
            .unwrap();
        let child = PathBuf::from(&record.target_cwd);
        if directory_to_file {
            fs::remove_dir_all(child.join("module")).unwrap();
            fs::write(child.join("module"), "after").unwrap();
        } else {
            fs::remove_file(child.join("module")).unwrap();
            fs::create_dir_all(child.join("module/nested")).unwrap();
            fs::write(child.join("module/nested/item"), "after").unwrap();
        }
        Self {
            _temp: temp,
            source,
            child,
            service,
            record,
        }
    }

    fn apply(
        &self,
        omit: Option<&str>,
        reverse: bool,
    ) -> cc_panes_core::utils::AppResult<ApplyForkChangesResult> {
        let view = self.service.compare(&self.record.id)?;
        assert!(view
            .files
            .iter()
            .all(|file| file.supported && !file.conflict));
        let mut selections: Vec<_> = view
            .files
            .iter()
            .filter(|file| Some(file.path.as_str()) != omit)
            .map(|file| ForkSelection {
                path: file.path.clone(),
                hunk_ids: None,
            })
            .collect();
        if reverse {
            selections.reverse();
        }
        self.service.apply(
            &self.record.id,
            ApplyForkChangesRequest {
                revision: view.revision,
                selections,
            },
        )
    }
}

#[test]
fn both_replacement_directions_work_unstaged_staged_and_in_either_selection_order() {
    for directory_to_file in [false, true] {
        for staged in [false, true] {
            for reverse in [false, true] {
                let f = Fixture::new(directory_to_file, false);
                if staged {
                    git(&f.child, &["add", "-A"]);
                }
                let index = fs::read(f.source.join(".git/index")).unwrap();
                assert_eq!(f.apply(None, reverse).unwrap().applied_paths.len(), 2);
                let leaf = if directory_to_file {
                    "module"
                } else {
                    "module/nested/item"
                };
                assert_eq!(fs::read(f.source.join(leaf)).unwrap(), b"after");
                assert_eq!(fs::read(f.source.join(".git/index")).unwrap(), index);
            }
        }
    }
}

#[test]
fn replacement_never_removes_unselected_files_or_an_unselected_ancestor() {
    let f = Fixture::new(true, true);
    assert!(f.apply(Some("module/unselected"), false).is_err());
    assert_eq!(
        fs::read(f.source.join("module/unselected")).unwrap(),
        b"keep"
    );
    assert_eq!(
        fs::read(f.source.join("module/nested/item")).unwrap(),
        b"before"
    );
    let f = Fixture::new(false, false);
    assert!(f.apply(Some("module"), false).is_err());
    assert_eq!(fs::read(f.source.join("module")).unwrap(), b"before");
}

#[test]
fn ignored_files_absent_from_the_preview_block_directory_replacement() {
    let f = Fixture::new(true, false);
    fs::write(f.source.join(".git/info/exclude"), "/module/unknown\n").unwrap();
    fs::write(f.source.join("module/unknown"), "ignored user data").unwrap();
    let view = f.service.compare(&f.record.id).unwrap();
    assert!(view.files.iter().all(|file| file.path != "module/unknown"));
    assert!(f.apply(None, false).is_err());
    assert_eq!(
        fs::read(f.source.join("module/unknown")).unwrap(),
        b"ignored user data"
    );
    assert_eq!(
        fs::read(f.source.join("module/nested/item")).unwrap(),
        b"before"
    );
}
