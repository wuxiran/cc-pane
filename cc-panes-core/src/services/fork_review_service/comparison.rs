use super::{git, patch, regular, revision, text, ForkReviewService};
use crate::models::{fork_review::*, RepositorySnapshot, SnapshotEntry, SnapshotFile};
use crate::utils::{AppError, AppResult};
use std::{collections::BTreeMap, fs, path::Path};

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 16 * 1024 * 1024;
const CHANGE_LIMIT: usize = 200;

pub(super) enum MergeResult {
    Merged(Option<SnapshotFile>),
    Conflict,
}

impl ForkReviewService {
    pub(super) fn comparison(
        &self,
        record: ForkReviewRecord,
        parent: RepositorySnapshot,
        child: RepositorySnapshot,
    ) -> AppResult<ForkComparison> {
        let entries = |snapshot| {
            self.snapshots.list_files(snapshot).map(|items| {
                items
                    .into_iter()
                    .map(|e| (e.path.clone(), e))
                    .collect::<BTreeMap<_, _>>()
            })
        };
        let base_files = entries(&record.baseline)?;
        let child_files = entries(&child)?;
        let parent_files = entries(&parent)?;
        let mut paths: Vec<_> = base_files
            .keys()
            .chain(child_files.keys())
            .cloned()
            .collect();
        paths.sort();
        paths.dedup();
        paths.retain(|path| base_files.get(path) != child_files.get(path));
        if paths.len() > CHANGE_LIMIT {
            return Err("Too many changed files to safely preview (limit 200)".into());
        }
        let shared = parent.repository_root == child.repository_root;
        let mut files = Vec::new();
        let mut remaining = PREVIEW_LIMIT;
        for path in paths {
            files.push(self.preview_file(
                &record.baseline,
                &parent,
                &child,
                &path,
                [
                    base_files.get(&path),
                    parent_files.get(&path),
                    child_files.get(&path),
                ],
                shared,
                &mut remaining,
            )?);
        }
        Ok(ForkComparison {
            revision: revision(&record, &parent, &child),
            parent_fingerprint: parent.fingerprint,
            child_fingerprint: child.fingerprint,
            shared_directory: shared,
            record,
            files,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn preview_file(
        &self,
        base: &RepositorySnapshot,
        parent: &RepositorySnapshot,
        child: &RepositorySnapshot,
        path: &str,
        entries: [Option<&SnapshotEntry>; 3],
        shared: bool,
        remaining: &mut usize,
    ) -> AppResult<ForkChangedFile> {
        let status = if entries[0].is_none() {
            "added"
        } else if entries[2].is_none() {
            "deleted"
        } else {
            "modified"
        };
        let mut file = ForkChangedFile {
            path: path.into(),
            status: status.into(),
            binary: false,
            supported: true,
            reason: None,
            parent_changed: entries[0] != entries[1],
            conflict: false,
            base_content: None,
            parent_content: None,
            child_content: None,
            hunks: Vec::new(),
            whole_file_only: status != "modified",
        };
        let sizes = entries
            .iter()
            .map(|entry| blob_size(base, *entry))
            .collect::<AppResult<Vec<_>>>()?;
        if sizes.iter().any(|size| *size > FILE_LIMIT) || sizes.iter().sum::<usize>() > *remaining {
            file.supported = false;
            file.reason = Some("File exceeds safe preview limit".into());
            return Ok(file);
        }
        *remaining -= sizes.iter().sum::<usize>();
        let a = self.snapshots.read_file(base, path)?;
        let p = self.snapshots.read_file(parent, path)?;
        let b = self.snapshots.read_file(child, path)?;
        if [&a, &p, &b]
            .into_iter()
            .flatten()
            .any(|value| !regular(value))
        {
            file.supported = false;
            file.reason = Some("Symbolic links and special file modes cannot be adopted".into());
        }
        file.binary = [&a, &p, &b]
            .into_iter()
            .flatten()
            .any(|value| text(Some(value)).is_none());
        file.base_content = text(a.as_ref());
        file.parent_content = text(p.as_ref());
        file.child_content = text(b.as_ref());
        if file.supported && !shared {
            file.conflict = matches!(
                merge(a.as_ref(), p.as_ref(), b.as_ref(), &self.directory)?,
                MergeResult::Conflict
            );
        }
        file.whole_file_only = status != "modified"
            || file.binary
            || a.as_ref().map(|v| &v.mode) != b.as_ref().map(|v| &v.mode);
        if file.supported && !file.binary {
            file.hunks = patch::hunks(&patch::diff(base, child, path)?)?;
        }
        Ok(file)
    }
}

fn blob_size(snapshot: &RepositorySnapshot, entry: Option<&SnapshotEntry>) -> AppResult<usize> {
    let Some(entry) = entry else { return Ok(0) };
    let bytes = git::checked(
        git::command(Path::new(&snapshot.snapshot_repository), None)
            .args(["cat-file", "-s", &entry.oid]),
    )?;
    std::str::from_utf8(&bytes)
        .map_err(|e| AppError::from(e.to_string()))?
        .trim()
        .parse()
        .map_err(|_| "Invalid snapshot blob size".into())
}

pub(super) fn merge(
    base: Option<&SnapshotFile>,
    parent: Option<&SnapshotFile>,
    child: Option<&SnapshotFile>,
    directory: &Path,
) -> AppResult<MergeResult> {
    if child == base {
        return Ok(MergeResult::Merged(parent.cloned()));
    }
    if parent == base || parent == child {
        return Ok(MergeResult::Merged(child.cloned()));
    }
    let (Some(base), Some(parent), Some(child)) = (base, parent, child) else {
        return Ok(MergeResult::Conflict);
    };
    if [base, parent, child]
        .iter()
        .any(|file| !regular(file) || text(Some(file)).is_none())
    {
        return Ok(MergeResult::Conflict);
    }
    let scratch = git::Scratch::new(directory)?;
    for (name, file) in [("base", base), ("parent", parent), ("child", child)] {
        fs::write(scratch.0.join(name), &file.bytes)?;
    }
    let mut command = std::process::Command::new("git");
    command
        .args(["merge-file", "--stdout", "--diff3", "--"])
        .arg(scratch.0.join("parent"))
        .arg(scratch.0.join("base"))
        .arg(scratch.0.join("child"));
    let output = git::run(&mut command)?;
    if output
        .status
        .code()
        .is_some_and(|code| (1..=127).contains(&code))
    {
        return Ok(MergeResult::Conflict);
    }
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string().into());
    }
    let mode = if child.mode != base.mode {
        child.mode.clone()
    } else {
        parent.mode.clone()
    };
    Ok(MergeResult::Merged(Some(SnapshotFile {
        bytes: output.stdout,
        mode,
    })))
}
