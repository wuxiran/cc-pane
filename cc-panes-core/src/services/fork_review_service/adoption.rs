use super::{
    comparison::{merge, MergeResult},
    patch, revision, ForkReviewService,
};
use crate::models::{fork_review::*, RepositorySnapshot, SnapshotFile};
use crate::utils::{atomic_file::write_atomic, AppError, AppResult};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path, time::Duration};

type Change = (String, Option<SnapshotFile>, Option<SnapshotFile>);

impl ForkReviewService {
    pub fn apply(
        &self,
        id: &str,
        request: ApplyForkChangesRequest,
    ) -> AppResult<ApplyForkChangesResult> {
        let record = self.load(id)?;
        let _lock = self.apply_lock(&record.source_cwd)?;
        let (parent, child) = self.current(&record)?;
        let comparison = self.comparison(record.clone(), parent.clone(), child.clone())?;
        validate_selection(&comparison, &request)?;
        let changes = self.prepare_changes(&comparison, &parent, &child, &request.selections)?;
        let (fresh_parent, fresh_child) = self.current(&record)?;
        if revision(&record, &fresh_parent, &fresh_child) != request.revision {
            return Err(stale());
        }
        let backup_id = format!("adopt-{}", uuid::Uuid::new_v4());
        self.snapshots.pin(&parent, &backup_id)?;
        fs::create_dir_all(self.directory.join("adoptions"))?;
        write_atomic(
            &self
                .directory
                .join("adoptions")
                .join(format!("{backup_id}.json")),
            super::encode(
                &serde_json::json!({"forkId":id,"before":parent,"selection":request.selections}),
            )?,
        )?;
        let applied_paths =
            super::publish::publish(Path::new(&fresh_parent.repository_root), &changes).map_err(
                |error| AppError::from(format!("{error}; recovery snapshot: {backup_id}")),
            )?;
        // Publication is the commit point. A refresh failure cannot turn a
        // successful write into an apparent failed/unchanged operation.
        Ok(published_result(
            applied_paths,
            self.current(&record)
                .map(|(parent, child)| revision(&record, &parent, &child)),
        ))
    }

    fn prepare_changes(
        &self,
        comparison: &ForkComparison,
        parent: &RepositorySnapshot,
        child: &RepositorySnapshot,
        selections: &[ForkSelection],
    ) -> AppResult<Vec<Change>> {
        selections
            .iter()
            .map(|selection| {
                let file = comparison
                    .files
                    .iter()
                    .find(|file| file.path == selection.path)
                    .ok_or_else(|| invalid("Selected file is not in preview"))?;
                if !file.supported {
                    return Err(invalid("Selected file is not safely adoptable"));
                }
                let base = self
                    .snapshots
                    .read_file(&comparison.record.baseline, &selection.path)?;
                let before = self.snapshots.read_file(parent, &selection.path)?;
                let desired = if let Some(ids) = &selection.hunk_ids {
                    if file.whole_file_only
                        || file.binary
                        || file.status != "modified"
                        || file.hunks.is_empty()
                    {
                        return Err(invalid("This file requires whole-file adoption"));
                    }
                    Some(patch::select(
                        &comparison.record.baseline,
                        child,
                        &selection.path,
                        ids,
                        &self.directory,
                    )?)
                } else {
                    self.snapshots.read_file(child, &selection.path)?
                };
                let after = match merge(
                    base.as_ref(),
                    before.as_ref(),
                    desired.as_ref(),
                    &self.directory,
                )? {
                    MergeResult::Merged(value) => value,
                    MergeResult::Conflict => {
                        return Err(AppError::coded(
                            "FORK_CONFLICT",
                            format!(
                                "Conflict in {}; parent files were not changed",
                                selection.path
                            ),
                        ))
                    }
                };
                Ok((selection.path.clone(), before, after))
            })
            .collect()
    }

    fn apply_lock(&self, source: &str) -> AppResult<Connection> {
        let path = self.directory.join("locks");
        fs::create_dir_all(&path)?;
        let root = crate::services::GitService::discover_repo_root(Path::new(source))
            .map_err(|state| AppError::from(format!("Parent repository unavailable: {state:?}")))?;
        let root = dunce::canonicalize(root)?;
        let key = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        let connection = Connection::open(path.join(format!("{key}.sqlite3")))?;
        connection.busy_timeout(Duration::from_secs(0))?;
        connection.execute_batch("BEGIN IMMEDIATE").map_err(|_| {
            AppError::coded(
                "FORK_APPLY_BUSY",
                "Another adoption is running for this parent directory",
            )
        })?;
        Ok(connection)
    }
}

fn published_result(
    applied_paths: Vec<String>,
    refreshed: AppResult<String>,
) -> ApplyForkChangesResult {
    let (revision, refresh_warning) = match refreshed {
        Ok(revision) => (revision, None),
        Err(error) => (String::new(), Some(error.to_string())),
    };
    ApplyForkChangesResult {
        applied_paths,
        revision,
        refresh_warning,
    }
}

fn validate_selection(
    comparison: &ForkComparison,
    request: &ApplyForkChangesRequest,
) -> AppResult<()> {
    if comparison.shared_directory {
        return Err(invalid(
            "Shared-directory forks already share file changes; adoption is unavailable",
        ));
    }
    if comparison.revision != request.revision {
        return Err(stale());
    }
    let paths: HashSet<_> = request
        .selections
        .iter()
        .map(|item| item.path.as_str())
        .collect();
    if paths.is_empty() || paths.len() != request.selections.len() {
        return Err(invalid("Select each changed file at most once"));
    }
    Ok(())
}
fn invalid(message: &str) -> AppError {
    AppError::coded("FORK_INVALID_REQUEST", message)
}
fn stale() -> AppError {
    AppError::coded(
        "FORK_CHANGED",
        "Parent or fork code changed; reload the comparison before adopting",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_failure_after_publication_is_success_with_an_explicit_warning() {
        let result = published_result(vec!["changed.txt".into()], Err("repository moved".into()));
        assert_eq!(result.applied_paths, ["changed.txt"]);
        assert!(result.revision.is_empty());
        assert!(result.refresh_warning.unwrap().contains("repository moved"));
    }

    #[test]
    fn subdirectories_of_one_parent_repository_share_the_adoption_lock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        fs::create_dir_all(root.join("sub")).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&root)
            .status()
            .unwrap()
            .success());
        let a = ForkReviewService::new(dir.path().join("data"));
        let b = ForkReviewService::new(dir.path().join("data"));
        let guard = a.apply_lock(root.to_str().unwrap()).unwrap();
        assert_eq!(
            b.apply_lock(root.join("sub").to_str().unwrap())
                .unwrap_err()
                .code(),
            Some("FORK_APPLY_BUSY")
        );
        drop(guard);
        assert!(b.apply_lock(root.join("sub").to_str().unwrap()).is_ok());
    }
}
