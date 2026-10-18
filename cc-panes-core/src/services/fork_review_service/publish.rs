//! Publish a prepared merge using rooted file operations and conditional rollback.
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix::SafeRoot;
#[cfg(windows)]
use windows::SafeRoot;

use crate::models::repository_snapshot::SnapshotFile;
use crate::utils::AppResult;
use std::collections::HashSet;
use std::path::{Component, Path};

type Change = (String, Option<SnapshotFile>, Option<SnapshotFile>);

pub(super) fn publish(root: &Path, changes: &[Change]) -> AppResult<Vec<String>> {
    publish_with(root, changes, |_| Ok(()))
}

fn publish_with(
    root: &Path,
    changes: &[Change],
    mut after_write: impl FnMut(usize) -> AppResult<()>,
) -> AppResult<Vec<String>> {
    validate_changes(changes)?;
    let root = SafeRoot::new(root)?;
    for (path, before, _) in changes {
        ensure_matches(&root, path, before)?;
    }
    let mut applied = Vec::new();
    let mut directories = Vec::new();
    for (index, (path, before, after)) in changes.iter().enumerate() {
        if before == after {
            continue;
        }
        if let Err(error) = root.apply(path, before, after, &mut directories) {
            return Err(rollback(&root, changes, &applied, &directories, error.to_string()).into());
        }
        applied.push(index);
        if let Err(error) = after_write(index) {
            return Err(rollback(&root, changes, &applied, &directories, error.to_string()).into());
        }
    }
    Ok(applied
        .into_iter()
        .map(|index| changes[index].0.clone())
        .collect())
}

fn rollback(
    root: &SafeRoot,
    changes: &[Change],
    applied: &[usize],
    directories: &[String],
    cause: String,
) -> String {
    let mut failures = Vec::new();
    let mut unused = Vec::new();
    for &index in applied.iter().rev() {
        let (path, before, after) = &changes[index];
        if let Err(error) = root.apply(path, after, before, &mut unused) {
            failures.push(format!("{path}: {error}"));
        }
    }
    for path in directories.iter().rev() {
        if let Err(error) = root.remove_empty_directory(path) {
            failures.push(format!("{path}: {error}"));
        }
    }
    if failures.is_empty() {
        format!("Publication failed; completed file changes were rolled back: {cause}")
    } else {
        format!("Publication failed with partial rollback; concurrent edits were preserved. Cause: {cause}. Rollback issues: {}", failures.join("; "))
    }
}

fn ensure_matches(root: &SafeRoot, path: &str, expected: &Option<SnapshotFile>) -> AppResult<()> {
    let current = root.read(path, expected.as_ref().map(|file| file.mode.as_str()))?;
    if current != *expected {
        return Err(format!("File changed since review: {path}").into());
    }
    Ok(())
}

fn validate_changes(changes: &[Change]) -> AppResult<()> {
    let mut paths = HashSet::new();
    for (path, before, after) in changes {
        validate_path(path)?;
        if !paths.insert(path.to_lowercase()) {
            return Err(format!("Duplicate or case-colliding publication path: {path}").into());
        }
        for file in before.iter().chain(after.iter()) {
            if !matches!(file.mode.as_str(), "100644" | "100755") {
                return Err(format!(
                    "Unsupported publication file mode for {path}: {}",
                    file.mode
                )
                .into());
            }
        }
        #[cfg(windows)]
        if after.as_ref().is_some_and(|file| {
            file.mode
                != before
                    .as_ref()
                    .map(|file| file.mode.as_str())
                    .unwrap_or("100644")
        }) {
            return Err(format!("Windows cannot apply an executable-bit change without changing the Git index: {path}").into());
        }
    }
    Ok(())
}

fn validate_path(path: &str) -> AppResult<()> {
    if path.is_empty()
        || path.contains(['\0', '\\', ':'])
        || path.starts_with('/')
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Unsafe publication path: {path}").into());
    }
    if path.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
    }) {
        return Err(format!("Unsafe publication path: {path}").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
