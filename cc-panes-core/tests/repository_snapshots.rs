use cc_panes_core::services::RepositorySnapshotService;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .to_string()
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    service: RepositorySnapshotService,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(root.join("sub")).unwrap();
        git(&root, &["init", "-q"]);
        // 内容逐字节断言：Windows runner 默认 core.autocrlf=true 会改写检出换行。
        git(&root, &["config", "core.autocrlf", "false"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join("sub/file.txt"), "committed\n").unwrap();
        fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        let service = RepositorySnapshotService::new(temp.path().join("data"));
        Self {
            _temp: temp,
            root,
            service,
        }
    }
}

#[test]
fn captures_dirty_bytes_untracked_binary_and_deletion_without_touching_source_git() {
    let fixture = Fixture::new();
    let root = &fixture.root;
    fs::write(root.join("sub/file.txt"), "staged\n").unwrap();
    git(root, &["add", "sub/file.txt"]);
    fs::write(root.join("sub/file.txt"), "raw working\r\n").unwrap();
    fs::write(root.join("new[1].bin"), [0, 255, 1, 13, 10]).unwrap();
    fs::remove_file(root.join("deleted.txt")).unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/dependency"), "ignored").unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let head = git(root, &["rev-parse", "HEAD"]);
    let objects = git(root, &["count-objects", "-v"]);
    let snapshot = fixture.service.capture(&root.join("sub")).unwrap();
    assert_eq!(snapshot.head, head);
    assert_eq!(
        fixture
            .service
            .read_file(&snapshot, "sub/file.txt")
            .unwrap()
            .unwrap()
            .bytes,
        b"raw working\r\n"
    );
    assert_eq!(
        fixture
            .service
            .read_file(&snapshot, "new[1].bin")
            .unwrap()
            .unwrap()
            .bytes,
        [0, 255, 1, 13, 10]
    );
    assert!(fixture
        .service
        .read_file(&snapshot, "deleted.txt")
        .unwrap()
        .is_none());
    assert!(fixture
        .service
        .read_file(&snapshot, "ignored/dependency")
        .unwrap()
        .is_none());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(root, &["count-objects", "-v"]), objects);
    assert_eq!(git(root, &["show", ":sub/file.txt"]), "staged");
}

#[test]
fn fingerprint_tracks_content_and_head_but_ignores_dependencies() {
    let fixture = Fixture::new();
    let first = fixture.service.capture(&fixture.root).unwrap();
    fs::create_dir(fixture.root.join("ignored")).unwrap();
    fs::write(fixture.root.join("ignored/large-build"), "dependency").unwrap();
    assert_eq!(
        first.fingerprint,
        fixture.service.capture(&fixture.root).unwrap().fingerprint
    );
    fs::write(fixture.root.join("sub/file.txt"), "changed").unwrap();
    let changed = fixture.service.capture(&fixture.root).unwrap();
    assert_ne!(first.fingerprint, changed.fingerprint);
    assert_eq!(
        changed.fingerprint,
        fixture.service.capture(&fixture.root).unwrap().fingerprint
    );
    git(
        &fixture.root,
        &["commit", "--allow-empty", "-qm", "new head"],
    );
    let new_head = fixture.service.capture(&fixture.root).unwrap();
    assert_eq!(changed.tree, new_head.tree);
    assert_ne!(changed.fingerprint, new_head.fingerprint);
}

#[test]
fn baseline_capture_keeps_newly_ignored_paths_without_adding_new_ignored_files() {
    let fixture = Fixture::new();
    let root = &fixture.root;
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/existing.txt"), "original\n").unwrap();
    let baseline = fixture.service.capture(root).unwrap();
    fs::write(root.join(".gitignore"), "ignored/\nnotes/\n").unwrap();
    fs::write(root.join("notes/dependency.txt"), "never part of baseline").unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let capture = || {
        fixture
            .service
            .capture_with_baseline(root, &baseline)
            .unwrap()
    };
    let read = |snapshot, path| {
        fixture
            .service
            .read_file(snapshot, path)
            .unwrap()
            .map(|file| file.bytes)
    };
    let retained = capture();
    assert_eq!(
        read(&retained, "notes/existing.txt").unwrap(),
        b"original\n"
    );
    assert!(read(&retained, "notes/dependency.txt").is_none());
    fs::write(root.join("notes/existing.txt"), "changed while ignored\n").unwrap();
    let changed = capture();
    assert_ne!(retained.fingerprint, changed.fingerprint);
    assert_eq!(
        read(&changed, "notes/existing.txt").unwrap(),
        b"changed while ignored\n"
    );
    fs::remove_file(root.join("notes/existing.txt")).unwrap();
    assert!(read(&capture(), "notes/existing.txt").is_none());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}

#[test]
fn linked_worktrees_share_the_private_object_store() {
    let fixture = Fixture::new();
    let linked = fixture._temp.path().join("linked");
    git(
        &fixture.root,
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let first = fixture.service.capture(&fixture.root).unwrap();
    let second = fixture.service.capture(&linked).unwrap();
    assert_eq!(first.snapshot_repository, second.snapshot_repository);
    assert_eq!(first.fingerprint, second.fingerprint);
    fs::write(linked.join("only-linked"), "linked").unwrap();
    assert_ne!(
        first.fingerprint,
        fixture.service.capture(&linked).unwrap().fingerprint
    );
    assert_eq!(
        first.fingerprint,
        fixture.service.capture(&fixture.root).unwrap().fingerprint
    );
}

#[test]
fn raw_capture_does_not_invoke_clean_filters() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join(".gitattributes"),
        "*.txt filter=reject text eol=lf\n",
    )
    .unwrap();
    git(&fixture.root, &["config", "filter.reject.clean", "false"]);
    git(&fixture.root, &["config", "filter.reject.required", "true"]);
    fs::write(fixture.root.join("sub/file.txt"), b"raw\r\n\0\xff").unwrap();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    assert_eq!(
        fixture
            .service
            .read_file(&snapshot, "sub/file.txt")
            .unwrap()
            .unwrap()
            .bytes,
        b"raw\r\n\0\xff"
    );
}

#[test]
fn capture_is_unpinned_and_explicit_pin_preserves_tree_through_gc() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("new-file"), "keep this baseline").unwrap();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    let repository = Path::new(&snapshot.snapshot_repository);
    assert!(git(repository, &["for-each-ref", "--format=%(refname)"]).is_empty());
    fixture.service.pin(&snapshot, "fork-baseline-123").unwrap();
    git(repository, &["gc", "--quiet", "--prune=now"]);
    assert_eq!(
        fixture
            .service
            .read_file(&snapshot, "new-file")
            .unwrap()
            .unwrap()
            .bytes,
        b"keep this baseline"
    );
    assert!(fixture.service.pin(&snapshot, "../../escape").is_err());
}

#[test]
fn rejects_snapshot_store_and_read_path_escape() {
    let fixture = Fixture::new();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    for path in [
        "../file",
        "/etc/passwd",
        "a/../../file",
        ".git/config",
        "a\\b",
        "C:/file",
    ] {
        assert!(
            fixture.service.read_file(&snapshot, path).is_err(),
            "{path}"
        );
    }
    let mut forged = snapshot.clone();
    forged.snapshot_repository = fixture.root.join(".git").to_string_lossy().into_owned();
    assert!(fixture.service.list_files(&forged).is_err());
    forged = snapshot;
    forged.tree = "HEAD:../escape".into();
    assert!(fixture.service.list_files(&forged).is_err());
}

#[test]
fn rejects_submodule_entries_instead_of_losing_their_working_state() {
    let fixture = Fixture::new();
    let head = git(&fixture.root, &["rev-parse", "HEAD"]);
    git(
        &fixture.root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},submodule"),
        ],
    );
    let error = fixture.service.capture(&fixture.root).unwrap_err();
    assert!(error.to_string().contains("submodules/gitlinks"));
}

#[cfg(unix)]
#[test]
fn executable_mode_changes_the_fingerprint() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let first = fixture.service.capture(&fixture.root).unwrap();
    fs::set_permissions(
        fixture.root.join("sub/file.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let executable = fixture.service.capture(&fixture.root).unwrap();
    assert_ne!(first.fingerprint, executable.fingerprint);
    assert_eq!(
        fixture
            .service
            .read_file(&executable, "sub/file.txt")
            .unwrap()
            .unwrap()
            .mode,
        "100755"
    );
}

#[cfg(unix)]
#[test]
fn captures_symlink_target_bytes_without_reading_the_target() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture._temp.path().join("outside-secret");
    fs::write(&outside, "must not be read").unwrap();
    symlink(&outside, fixture.root.join("link")).unwrap();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    let file = fixture
        .service
        .read_file(&snapshot, "link")
        .unwrap()
        .unwrap();
    assert_eq!(file.mode, "120000");
    assert_eq!(file.bytes, outside.as_os_str().as_encoded_bytes());
    assert_eq!(
        fixture
            .service
            .list_files(&snapshot)
            .unwrap()
            .iter()
            .filter(|entry| entry.path == "link")
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlink_parent_escape_and_special_files() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture._temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file.txt"), "must not be captured").unwrap();
    fs::remove_dir_all(fixture.root.join("sub")).unwrap();
    symlink(outside, fixture.root.join("sub")).unwrap();
    assert!(fixture.service.capture(&fixture.root).is_err());
    fs::remove_file(fixture.root.join("sub")).unwrap();
    fs::create_dir(fixture.root.join("sub")).unwrap();
    let fifo =
        std::ffi::CString::new(fixture.root.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(fixture.service.capture(&fixture.root).is_err());
}

#[cfg(unix)]
#[test]
fn supports_git_filenames_with_whitespace_and_literal_pathspec_characters() {
    let fixture = Fixture::new();
    let filename = "line\nbreak\t[1]*.txt";
    fs::write(fixture.root.join(filename), "literal").unwrap();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    assert_eq!(
        fixture
            .service
            .read_file(&snapshot, filename)
            .unwrap()
            .unwrap()
            .bytes,
        b"literal"
    );
}

#[cfg(unix)]
#[test]
fn private_store_permissions_do_not_change_or_create_source_directories() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    let before = fs::metadata(&fixture.root).unwrap().permissions().mode();
    let snapshot = fixture.service.capture(&fixture.root).unwrap();
    let repository = Path::new(&snapshot.snapshot_repository);
    for path in [repository, repository.parent().unwrap()] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let inside = fixture.root.join("private-data");
    assert!(RepositorySnapshotService::new(inside.clone())
        .capture(&fixture.root)
        .is_err());
    assert!(!inside.exists());
    let outside = fixture._temp.path().join("symlink-store");
    fs::create_dir(&outside).unwrap();
    symlink(&fixture.root, outside.join("repository-snapshots")).unwrap();
    assert!(RepositorySnapshotService::new(outside)
        .capture(&fixture.root)
        .is_err());
    assert_eq!(
        fs::metadata(&fixture.root).unwrap().permissions().mode(),
        before
    );
}

#[test]
fn independent_services_can_capture_concurrently_during_first_initialization() {
    use std::sync::{Arc, Barrier};
    let fixture = Fixture::new();
    fs::write(fixture.root.join("sub/file.txt"), "dirty working contents").unwrap();
    fs::write(fixture.root.join("untracked"), "untracked contents").unwrap();
    let index = fs::read(fixture.root.join(".git/index")).unwrap();
    let head = git(&fixture.root, &["rev-parse", "HEAD"]);
    for attempt in 0..4 {
        let data = fixture
            ._temp
            .path()
            .join(format!("concurrent-data-{attempt}"));
        let barrier = Arc::new(Barrier::new(2));
        let snapshots = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    let root = fixture.root.clone();
                    let barrier = Arc::clone(&barrier);
                    let service = RepositorySnapshotService::new(data.clone());
                    scope.spawn(move || {
                        barrier.wait();
                        service.capture(&root).unwrap()
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            snapshots[0].snapshot_repository,
            snapshots[1].snapshot_repository
        );
        assert_eq!(snapshots[0].fingerprint, snapshots[1].fingerprint);
        assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
        assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), head);
    }
}
