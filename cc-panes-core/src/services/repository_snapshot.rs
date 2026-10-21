//! Raw working-tree snapshots in a private object store, without modifying the
//! user's Git index, refs, configuration, or object database.
mod files;
mod git;
mod initialization;
#[cfg(unix)]
mod scan;
#[cfg(windows)]
mod windows;

use crate::models::repository_snapshot::{RepositorySnapshot, SnapshotEntry, SnapshotFile};
use crate::utils::AppResult;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

pub struct RepositorySnapshotService {
    data_dir: PathBuf,
}

struct RepositoryIdentity {
    root: PathBuf,
    common: PathBuf,
    head: String,
    format: String,
}

impl RepositorySnapshotService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn capture(&self, cwd: &Path) -> AppResult<RepositorySnapshot> {
        self.capture_referencing(cwd, None)
    }

    /// Keep observing files already present in a baseline even if ignore rules
    /// later hide them from Git's untracked-file listing. New ignored files stay
    /// excluded, while actual deletion and changes to retained files remain visible.
    pub fn capture_with_baseline(
        &self,
        cwd: &Path,
        baseline: &RepositorySnapshot,
    ) -> AppResult<RepositorySnapshot> {
        self.capture_referencing(cwd, Some(baseline))
    }

    fn capture_referencing(
        &self,
        cwd: &Path,
        baseline: Option<&RepositorySnapshot>,
    ) -> AppResult<RepositorySnapshot> {
        let identity = repository_identity(cwd)?;
        let repository = self.prepare_repository(&identity)?;
        validate_file_types(&identity.root)?;
        let mut paths = source_paths(&identity.root)?;
        if let Some(baseline) = baseline {
            if self.validate_snapshot(baseline)? != repository {
                return Err("Snapshot baseline belongs to a different repository".into());
            }
            for entry in self.list_files(baseline)? {
                paths.entry(entry.path).or_insert(Some(entry.mode));
            }
        }
        let scratch = files::Scratch::new(&repository)?;
        let entries = capture_files(&identity.root, paths, &scratch)?;
        let tree = write_tree(&repository, &scratch, &entries)?;
        let mut check = git::command(&identity.root);
        check.args(["rev-parse", "--verify", "HEAD"]);
        if git::text(git::run(check, vec![])?)? != identity.head {
            return Err("Repository HEAD changed while capturing snapshot; retry capture".into());
        }
        Ok(RepositorySnapshot {
            repository_root: path_text(&identity.root)?,
            fingerprint: fingerprint(&identity.head, &tree),
            head: identity.head,
            tree,
            snapshot_repository: path_text(&repository)?,
        })
    }

    pub fn list_files(&self, snapshot: &RepositorySnapshot) -> AppResult<Vec<SnapshotEntry>> {
        let repository = self.validate_snapshot(snapshot)?;
        let mut command = git::private(&repository);
        command.args(["ls-tree", "-r", "-z", "--full-tree", &snapshot.tree]);
        parse_tree(&git::run(command, vec![])?)
    }

    pub fn read_file(
        &self,
        snapshot: &RepositorySnapshot,
        path: &str,
    ) -> AppResult<Option<SnapshotFile>> {
        files::validate_path(path)?;
        let repository = self.validate_snapshot(snapshot)?;
        let mut list = git::private(&repository);
        // Literal pathspec is necessary for filenames containing glob characters.
        list.arg("--literal-pathspecs").args([
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            &snapshot.tree,
            "--",
            path,
        ]);
        let entry = parse_tree(&git::run(list, vec![])?)?
            .into_iter()
            .find(|entry| entry.path == path);
        let Some(entry) = entry else { return Ok(None) };
        if !matches!(entry.mode.as_str(), "100644" | "100755" | "120000") {
            return Err(format!("Snapshot entry is not a readable blob: {path}").into());
        }
        let mut command = git::private(&repository);
        command.args(["cat-file", "blob", &entry.oid]);
        Ok(Some(SnapshotFile {
            bytes: git::run(command, vec![])?,
            mode: entry.mode,
        }))
    }

    /// Preserve a baseline across Git GC. Only application-generated IDs belong
    /// here; replacing a pin intentionally releases its old tree for future GC.
    pub fn pin(&self, snapshot: &RepositorySnapshot, id: &str) -> AppResult<()> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("Invalid repository snapshot pin ID".into());
        }
        let repository = self.validate_snapshot(snapshot)?;
        let mut command = git::private(&repository);
        command.args(["update-ref", &format!("refs/pins/{id}"), &snapshot.tree]);
        git::run(command, vec![])?;
        Ok(())
    }

    fn prepare_repository(&self, identity: &RepositoryIdentity) -> AppResult<PathBuf> {
        self.check_store_location(&identity.root)?;
        let base = self.store_root()?;
        if base.starts_with(&identity.root) {
            return Err("Snapshot data directory must be outside the source repository".into());
        }
        let key = format!(
            "{:x}",
            Sha256::digest(path_text(&identity.common)?.as_bytes())
        );
        let repository = base.join(format!("{key}.git"));
        if repository.exists() && fs::symlink_metadata(&repository)?.file_type().is_symlink() {
            return Err("Snapshot object store must not be a symlink".into());
        }
        fs::create_dir_all(&repository)?;
        restrict_directory(&repository)?;
        initialization::ensure(&repository, &identity.format)?;
        Ok(dunce::canonicalize(repository)?)
    }

    fn store_root(&self) -> AppResult<PathBuf> {
        let root = self.data_dir.join("repository-snapshots");
        match fs::symlink_metadata(&root) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Snapshot store root must not be a symlink".into())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&root)?;
        restrict_directory(&root)?;
        Ok(dunce::canonicalize(root)?)
    }

    fn check_store_location(&self, repository_root: &Path) -> AppResult<()> {
        let mut ancestor = if self.data_dir.is_absolute() {
            self.data_dir.clone()
        } else {
            std::env::current_dir()?.join(&self.data_dir)
        };
        let mut missing = Vec::new();
        while !ancestor.try_exists()? {
            missing.push(
                ancestor
                    .file_name()
                    .ok_or("Invalid snapshot data directory")?
                    .to_os_string(),
            );
            if !ancestor.pop() {
                return Err("Invalid snapshot data directory".into());
            }
        }
        let mut resolved = dunce::canonicalize(ancestor)?;
        for component in missing.into_iter().rev() {
            resolved.push(component);
        }
        if resolved.starts_with(repository_root) {
            return Err("Snapshot data directory must be outside the source repository".into());
        }
        Ok(())
    }

    fn validate_snapshot(&self, snapshot: &RepositorySnapshot) -> AppResult<PathBuf> {
        git::oid(&snapshot.tree)?;
        git::oid(&snapshot.head)?;
        if snapshot.fingerprint != fingerprint(&snapshot.head, &snapshot.tree) {
            return Err("Repository snapshot fingerprint does not match its contents".into());
        }
        let path = Path::new(&snapshot.snapshot_repository);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid snapshot repository path")?;
        let key = name
            .strip_suffix(".git")
            .ok_or("Invalid snapshot repository name")?;
        if key.len() != 64
            || !key.bytes().all(|c| c.is_ascii_hexdigit())
            || fs::symlink_metadata(path)?.file_type().is_symlink()
        {
            return Err("Invalid snapshot repository identity".into());
        }
        let repository = dunce::canonicalize(path)?;
        if repository.parent() != Some(self.store_root()?.as_path()) {
            return Err("Snapshot repository is outside the application's object store".into());
        }
        Ok(repository)
    }
}

fn repository_identity(cwd: &Path) -> AppResult<RepositoryIdentity> {
    let mut command = git::command(cwd);
    command.args([
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--show-object-format",
        "HEAD",
    ]);
    let output = git::text(git::run(command, vec![])?)?;
    let lines: Vec<_> = output.lines().collect();
    if lines.len() != 4 || !matches!(lines[2], "sha1" | "sha256") {
        return Err("Unsupported repository identity (a committed Git worktree with UTF-8 paths is required)".into());
    }
    git::oid(lines[3])?;
    Ok(RepositoryIdentity {
        root: dunce::canonicalize(lines[0])?,
        common: dunce::canonicalize(lines[1])?,
        format: lines[2].to_string(),
        head: lines[3].to_string(),
    })
}

fn source_paths(root: &Path) -> AppResult<BTreeMap<String, Option<String>>> {
    let mut command = git::command(root);
    command.args(["ls-files", "--cached", "--stage", "-z"]);
    let output = git::run(command, vec![])?;
    let mut paths = BTreeMap::new();
    for line in output
        .split(|byte| *byte == 0)
        .filter(|line| !line.is_empty())
    {
        let (metadata, path) = split_entry(line)?;
        let fields: Vec<_> = metadata.split(' ').collect();
        if fields.len() != 3 || fields[2] != "0" {
            return Err("Cannot snapshot a repository with unmerged index entries".into());
        }
        if fields[0] == "160000" {
            return Err(
                format!("Repository snapshots do not support submodules/gitlinks: {path}").into(),
            );
        }
        if !matches!(fields[0], "100644" | "100755" | "120000") {
            return Err(format!("Unsupported tracked snapshot file mode: {}", fields[0]).into());
        }
        paths.insert(path, Some(fields[0].to_string()));
    }
    let mut command = git::command(root);
    command.args(["ls-files", "--others", "--exclude-standard", "-z"]);
    for path in git::run(command, vec![])?
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = std::str::from_utf8(path)
            .map_err(|_| "Repository snapshots require UTF-8 filenames")?;
        files::validate_path(path)?;
        paths.entry(path.to_string()).or_insert(None);
    }
    Ok(paths)
}

fn capture_files(
    root: &Path,
    paths: BTreeMap<String, Option<String>>,
    scratch: &files::Scratch,
) -> AppResult<Vec<(String, String)>> {
    let root = open_root(root)?;
    let mut entries = Vec::new();
    for (path, index_mode) in paths {
        if let Some(file) = files::read(&root, &path, index_mode.as_deref())? {
            fs::write(scratch.path.join(entries.len().to_string()), &file.bytes)?;
            entries.push((path, file.mode.to_string()));
        }
    }
    Ok(entries)
}

#[cfg(unix)]
fn validate_file_types(root: &Path) -> AppResult<()> {
    let mut command = git::command(root);
    command.args([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    ]);
    let output = git::run(command, vec![])?;
    let ignored = output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| std::str::from_utf8(path).map(str::to_string))
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|_| "Repository snapshots require UTF-8 filenames")?;
    scan::validate(&open_root(root)?, &ignored)
}

#[cfg(not(unix))]
fn validate_file_types(_root: &Path) -> AppResult<()> {
    // Windows has no Unix FIFO/socket/device nodes. Reparse points are checked
    // by the relative-handle file reader before opening any contents.
    Ok(())
}

fn write_tree(
    repository: &Path,
    scratch: &files::Scratch,
    entries: &[(String, String)],
) -> AppResult<String> {
    let mut hash = git::private(repository);
    hash.current_dir(&scratch.path)
        .args(["hash-object", "-w", "--no-filters", "--stdin-paths"]);
    let paths = (0..entries.len())
        .map(|index| format!("{index}\n"))
        .collect::<String>();
    let output = git::text(git::run(hash, paths.into_bytes())?)?;
    let objects: Vec<_> = output.lines().collect();
    if objects.len() != entries.len() {
        return Err("Snapshot blob count does not match captured file count".into());
    }
    let mut input = Vec::new();
    for ((path, mode), object) in entries.iter().zip(objects) {
        git::oid(object)?;
        input.extend_from_slice(format!("{mode} {object}\t{path}\0").as_bytes());
    }
    let index = scratch.path.join("index");
    let mut update = git::private(repository);
    update
        .env("GIT_INDEX_FILE", &index)
        .args(["update-index", "-z", "--index-info"]);
    git::run(update, input)?;
    let mut tree = git::private(repository);
    tree.env("GIT_INDEX_FILE", &index).arg("write-tree");
    let tree = git::text(git::run(tree, vec![])?)?;
    git::oid(&tree)?;
    Ok(tree)
}

fn parse_tree(output: &[u8]) -> AppResult<Vec<SnapshotEntry>> {
    let mut entries = Vec::new();
    for line in output
        .split(|byte| *byte == 0)
        .filter(|line| !line.is_empty())
    {
        let (metadata, path) = split_entry(line)?;
        let fields: Vec<_> = metadata.split(' ').collect();
        if fields.len() != 3 || !matches!(fields[0], "100644" | "100755" | "120000" | "160000") {
            return Err("Unsupported repository snapshot tree entry".into());
        }
        git::oid(fields[2])?;
        entries.push(SnapshotEntry {
            path,
            mode: fields[0].to_string(),
            oid: fields[2].to_string(),
        });
    }
    Ok(entries)
}

fn split_entry(line: &[u8]) -> AppResult<(String, String)> {
    let separator = line
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or("Malformed Git snapshot entry")?;
    let metadata =
        std::str::from_utf8(&line[..separator]).map_err(|_| "Invalid Git snapshot metadata")?;
    let path = std::str::from_utf8(&line[separator + 1..])
        .map_err(|_| "Repository snapshots require UTF-8 filenames")?;
    files::validate_path(path)?;
    Ok((metadata.to_string(), path.to_string()))
}

fn path_text(path: &Path) -> AppResult<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Repository snapshots require UTF-8 filesystem paths".into())
}

fn restrict_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn fingerprint(head: &str, tree: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("repository-snapshot-v1\0{head}\0{tree}"))
    )
}

fn open_root(path: &Path) -> AppResult<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0200_0000 | 0x0020_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}
