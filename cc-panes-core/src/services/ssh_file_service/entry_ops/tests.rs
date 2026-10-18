use super::*;
use std::fs::{self, OpenOptions};

/// Execute the entry mutation contract against real files. The adapter maps the
/// remote POSIX namespace into a temporary directory on every test platform.
struct LocalFs {
    root: tempfile::TempDir,
}

impl LocalFs {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        Self { root }
    }

    fn local(&self, path: &Path) -> PathBuf {
        let path = display_path(path);
        self.root.path().join(if path == "." {
            "home"
        } else {
            path.trim_start_matches('/')
        })
    }

    fn remote(&self, path: &Path) -> Result<PathBuf> {
        let root = dunce::canonicalize(self.root.path())?;
        Ok(join_remote_path(
            Path::new("/"),
            &display_path(path.strip_prefix(root)?),
        ))
    }
}

impl EntryFs for LocalFs {
    fn realpath(&self, path: &Path) -> Result<PathBuf> {
        self.remote(&dunce::canonicalize(self.local(path))?)
    }

    fn is_directory_entry(&self, path: &Path) -> Result<bool> {
        Ok(fs::symlink_metadata(self.local(path))?.is_dir())
    }

    fn children(&self, path: &Path) -> Result<Vec<PathBuf>> {
        fs::read_dir(self.local(path))?
            .map(|entry| {
                Ok(join_remote_path(
                    path,
                    &entry?.file_name().to_string_lossy(),
                ))
            })
            .collect()
    }

    fn remove_directory(&self, path: &Path) -> Result<()> {
        Ok(fs::remove_dir(self.local(path))?)
    }

    fn unlink(&self, path: &Path) -> Result<()> {
        Ok(fs::remove_file(self.local(path))?)
    }

    fn open_file(&self, path: &Path, flags: OpenFlags) -> Result<()> {
        OpenOptions::new()
            .read(flags.contains(OpenFlags::READ))
            .write(flags.contains(OpenFlags::WRITE))
            .append(flags.contains(OpenFlags::APPEND))
            .create(flags.contains(OpenFlags::CREATE))
            .truncate(flags.contains(OpenFlags::TRUNCATE))
            .create_new(flags.contains(OpenFlags::EXCLUSIVE))
            .open(self.local(path))?;
        Ok(())
    }
}

#[test]
fn new_file_creation_rejects_an_existing_file_without_changing_content() {
    let remote = LocalFs::new();
    let path = Path::new("/file.txt");
    create_file(&remote, path).unwrap();
    assert_eq!(fs::read(remote.local(path)).unwrap(), b"");
    fs::write(remote.local(path), b"keep existing content").unwrap();

    assert!(create_file(&remote, path).is_err());
    assert_eq!(
        fs::read(remote.local(path)).unwrap(),
        b"keep existing content"
    );
}

#[test]
fn concurrent_creations_have_exactly_one_winner() {
    let remote = LocalFs::new();
    let barrier = std::sync::Barrier::new(8);
    let winners = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    create_file(&remote, Path::new("/racing.txt")).is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count()
    });
    assert_eq!(winners, 1);
}

#[test]
fn root_and_navigation_entries_are_rejected_without_deleting_files() {
    let remote = LocalFs::new();
    fs::write(remote.local(Path::new("/keep.txt")), "keep").unwrap();
    for path in ["/", "///", "~", "~/", "/home/.", "/home/..", "~/.."] {
        assert!(delete_entry(&remote, path).is_err(), "accepted {path}");
    }
    assert!(remote.local(Path::new("/home")).is_dir());
    assert_eq!(
        fs::read(remote.local(Path::new("/keep.txt"))).unwrap(),
        b"keep"
    );
}

#[test]
fn home_paths_and_whitespace_in_existing_names_keep_their_identity() {
    let remote = LocalFs::new();
    fs::write(remote.local(Path::new("/home/keep")), "untouched").unwrap();
    fs::write(remote.local(Path::new("/home/keep ")), "remove only this").unwrap();
    delete_entry(&remote, "~/keep ").unwrap();
    assert!(!remote.local(Path::new("/home/keep ")).exists());
    assert_eq!(
        fs::read(remote.local(Path::new("/home/keep"))).unwrap(),
        b"untouched"
    );
}

#[cfg(unix)]
#[test]
fn deleting_top_level_links_preserves_targets_and_supports_dangling_links() {
    use std::os::unix::fs::symlink;
    let remote = LocalFs::new();
    let target = remote.local(Path::new("/target"));
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), "keep").unwrap();
    for (name, destination, suffix) in [
        ("directory-link", target.clone(), ""),
        ("slash-link", target.clone(), "/"),
        ("file-link", target.join("keep.txt"), ""),
        ("dangling-link", target.join("missing"), ""),
    ] {
        let path = format!("/{name}");
        let local = remote.local(Path::new(&path));
        symlink(destination, &local).unwrap();
        delete_entry(&remote, &format!("{path}{suffix}")).unwrap();
        assert!(fs::symlink_metadata(&local).is_err());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
    }
}

#[cfg(unix)]
#[test]
fn recursive_directory_deletion_unlinks_child_links_without_traversing_them() {
    let remote = LocalFs::new();
    let target = remote.local(Path::new("/outside"));
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), "keep").unwrap();
    let tree = remote.local(Path::new("/tree"));
    fs::create_dir_all(tree.join("nested")).unwrap();
    fs::write(tree.join("nested/owned.txt"), "delete").unwrap();
    std::os::unix::fs::symlink(&target, tree.join("nested/link")).unwrap();
    delete_entry(&remote, "/tree").unwrap();
    assert!(!tree.exists());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn renaming_an_entry_keeps_the_leaf_link_even_when_its_parent_is_a_link() {
    let remote = LocalFs::new();
    let home = remote.local(Path::new("/home"));
    fs::write(home.join("target"), "keep").unwrap();
    std::os::unix::fs::symlink(&home, remote.local(Path::new("/alias"))).unwrap();
    std::os::unix::fs::symlink("target", home.join("link")).unwrap();
    let source = resolve_entry(&remote, "/alias/link/").unwrap();
    assert_eq!(source, Path::new("/home/link"));
    fs::rename(remote.local(&source), home.join("renamed")).unwrap();
    assert_eq!(
        fs::read_link(home.join("renamed")).unwrap(),
        Path::new("target")
    );
    assert_eq!(fs::read(home.join("target")).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn new_file_creation_rejects_links_including_dangling_links() {
    let remote = LocalFs::new();
    let target = remote.local(Path::new("/target"));
    fs::write(&target, "keep").unwrap();
    for (name, destination) in [
        ("link", target.clone()),
        ("dangling", target.with_extension("missing")),
    ] {
        let path = PathBuf::from(format!("/{name}"));
        std::os::unix::fs::symlink(&destination, remote.local(&path)).unwrap();
        assert!(create_file(&remote, &path).is_err());
        assert_eq!(fs::read_link(remote.local(&path)).unwrap(), destination);
    }
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    assert!(!target.with_extension("missing").exists());
}
