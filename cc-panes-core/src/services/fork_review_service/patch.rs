use super::git;
use crate::models::{fork_review::ForkHunk, RepositorySnapshot, SnapshotFile};
use crate::utils::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path};

pub(super) fn diff(
    base: &RepositorySnapshot,
    child: &RepositorySnapshot,
    path: &str,
) -> AppResult<String> {
    let mut cmd = git::command(Path::new(&base.snapshot_repository), None);
    cmd.arg("--literal-pathspecs").args([
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        &base.tree,
        &child.tree,
        "--",
        path,
    ]);
    String::from_utf8(git::checked(&mut cmd)?).map_err(|e| AppError::from(e.to_string()))
}

pub(super) fn hunks(patch: &str) -> AppResult<Vec<ForkHunk>> {
    let mut result: Vec<ForkHunk> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            let (old_start, old_lines, new_start, new_lines) = coordinates(line)?;
            result.push(ForkHunk {
                id: String::new(),
                header: line.trim_end().into(),
                patch: line.into(),
                old_start,
                old_lines,
                new_start,
                new_lines,
            });
        } else if let Some(last) = result.last_mut() {
            last.patch.push_str(line);
        }
    }
    for (index, hunk) in result.iter_mut().enumerate() {
        hunk.id = format!(
            "{:x}",
            Sha256::digest(format!("{index}\n{}", hunk.patch).as_bytes())
        );
    }
    Ok(result)
}

fn coordinates(header: &str) -> AppResult<(usize, usize, usize, usize)> {
    let mut parts = header.split_whitespace().skip(1);
    let parse = |part: Option<&str>| -> AppResult<(usize, usize)> {
        let part = part
            .ok_or("Invalid diff hunk")?
            .get(1..)
            .ok_or("Invalid diff range")?;
        let (start, count) = part.split_once(',').unwrap_or((part, "1"));
        Ok((
            start
                .parse()
                .map_err(|_| AppError::from("Invalid diff position"))?,
            count
                .parse()
                .map_err(|_| AppError::from("Invalid diff count"))?,
        ))
    };
    let old = parse(parts.next())?;
    let new = parse(parts.next())?;
    Ok((old.0, old.1, new.0, new.1))
}

pub(super) fn select(
    base: &RepositorySnapshot,
    child: &RepositorySnapshot,
    path: &str,
    ids: &[String],
    directory: &Path,
) -> AppResult<SnapshotFile> {
    let patch = diff(base, child, path)?;
    let hunks = hunks(&patch)?;
    let selected: HashSet<_> = ids.iter().collect();
    if selected.is_empty()
        || selected.len() != ids.len()
        || selected
            .iter()
            .any(|id| !hunks.iter().any(|h| &h.id == *id))
    {
        return Err(AppError::coded(
            "FORK_INVALID_REQUEST",
            "Invalid or stale hunk selection",
        ));
    }
    let prefix = patch
        .split_inclusive('\n')
        .take_while(|line| !line.starts_with("@@ "))
        .collect::<String>();
    let selected_patch = prefix
        + &hunks
            .iter()
            .filter(|h| selected.contains(&h.id))
            .map(|h| h.patch.as_str())
            .collect::<String>();
    let scratch = git::Scratch::new(directory)?;
    let index = scratch.0.join("index");
    let file = scratch.0.join("selected.patch");
    fs::write(&file, selected_patch)?;
    let repo = Path::new(&base.snapshot_repository);
    git::checked(git::command(repo, Some(&index)).args(["read-tree", &base.tree]))?;
    git::checked(
        git::command(repo, Some(&index))
            .args(["apply", "--cached", "--recount", "--whitespace=nowarn"])
            .arg(&file),
    )?;
    let bytes = git::checked(
        git::command(repo, Some(&index))
            .arg("--literal-pathspecs")
            .args(["ls-files", "--stage", "-z", "--", path]),
    )?;
    let row = std::str::from_utf8(&bytes).map_err(|e| AppError::from(e.to_string()))?;
    let metadata = row
        .split_once('\t')
        .ok_or("Selected patch removed the file")?
        .0;
    let parts: Vec<_> = metadata.split_whitespace().collect();
    if parts.len() != 3 || parts[2] != "0" {
        return Err("Selected patch has unresolved stages".into());
    }
    Ok(SnapshotFile {
        mode: parts[0].into(),
        bytes: git::checked(git::command(repo, None).args(["cat-file", "blob", parts[1]]))?,
    })
}
