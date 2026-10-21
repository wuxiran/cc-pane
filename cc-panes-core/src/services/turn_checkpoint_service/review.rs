use super::*;
use crate::models::{RepositorySnapshot, SnapshotEntry, SnapshotFile};
use crate::services::fork_review_service::publish;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const MAX_PREVIEW_FILE: usize = 256 * 1024;
const MAX_PREVIEW_TOTAL: usize = 2 * 1024 * 1024;

impl TurnCheckpointService {
    pub fn review(&self, id: &str) -> AppResult<TurnCheckpointReview> {
        let active = self.lock()?;
        self.build_review(self.load(id)?, &active)
            .map(|(review, _)| review)
    }

    /// Revision binds both checkpoint snapshots and the current reviewed tree.
    /// Never offers force restore: every changed path must still equal the after
    /// snapshot, while unrelated edits are kept as-is.
    pub fn restore(&self, id: &str, revision: &str) -> AppResult<RestoreTurnCheckpointResult> {
        let active = self.lock()?;
        let (review, current) = self.build_review(self.load(id)?, &active)?;
        if revision.is_empty() || review.revision != revision {
            return Err(AppError::coded(
                "CHECKPOINT_CHANGED",
                "Files changed since review; reload the checkpoint",
            ));
        }
        if !review.can_restore {
            return Err(AppError::coded(
                "CHECKPOINT_RESTORE_BLOCKED",
                review.blocked_reason.unwrap_or_default(),
            ));
        }
        let current = current.ok_or("Current checkpoint snapshot is unavailable")?;
        let before = review
            .record
            .before
            .as_ref()
            .ok_or("Before snapshot unavailable")?;
        let after = review
            .record
            .after
            .as_ref()
            .ok_or("After snapshot unavailable")?;
        let mut changes = Vec::new();
        for file in &review.files {
            changes.push((
                file.path.clone(),
                self.snapshots.read_file(&current, &file.path)?,
                self.snapshots.read_file(before, &file.path)?,
            ));
        }
        let fresh = self
            .snapshots
            .capture_checkpoint(Path::new(&review.record.cwd), &[before, after])?;
        if fresh.fingerprint != current.fingerprint {
            return Err(AppError::coded(
                "CHECKPOINT_CHANGED",
                "Files changed while preparing restore; reload the checkpoint",
            ));
        }
        let recovery_id = self.recovery(id, &current)?;
        let restored_paths =
            publish::publish_guarded(Path::new(&current.repository_root), &changes, || {
                self.snapshots.ensure_current_head(&current)
            })
            .map_err(|error| {
                AppError::from(format!("{error}; recovery snapshot: {recovery_id}"))
            })?;
        let mut record = review.record;
        record.restored_at = Some(now());
        // Files have committed at this point. A metadata failure is a warning,
        // never a failed-operation response that could encourage a blind retry.
        let warning = self.save(&record).err().map(|error| error.to_string());
        Ok(RestoreTurnCheckpointResult {
            restored_paths,
            recovery_id,
            warning,
        })
    }

    fn build_review(
        &self,
        mut record: TurnCheckpointRecord,
        active: &HashMap<String, PathBuf>,
    ) -> AppResult<(TurnCheckpointReview, Option<RepositorySnapshot>)> {
        let Some(before) = record.before.as_ref() else {
            return Ok((unavailable(record, "Before snapshot is unavailable"), None));
        };
        let Some(after) = record.after.as_ref() else {
            if !active.contains_key(&record.id) && record.completed_at.is_none() {
                record.outcome = "interrupted".into();
            }
            return Ok((
                unavailable(
                    record,
                    "After snapshot is unavailable; an unfinished turn cannot be restored",
                ),
                None,
            ));
        };
        let current = self
            .snapshots
            .capture_checkpoint(Path::new(&record.cwd), &[before, after]);
        let (current, capture_error) = match current {
            Ok(snapshot) => (Some(snapshot), None),
            Err(error) => (None, Some(error.to_string())),
        };
        let files = self.changed_files(before, after, current.as_ref())?;
        let root = canonical_or_original(Path::new(&record.cwd));
        let busy = active
            .values()
            .any(|path| path.starts_with(&root) || root.starts_with(path));
        let blocked_reason = record
            .unavailable_reason
            .clone()
            .or(capture_error)
            .or_else(|| blocked(&record, &files, current.as_ref(), busy));
        let revision = current
            .as_ref()
            .map(|snapshot| revision(&record, snapshot))
            .unwrap_or_default();
        Ok((
            TurnCheckpointReview {
                record,
                revision,
                files,
                can_restore: blocked_reason.is_none(),
                blocked_reason,
            },
            current,
        ))
    }

    fn changed_files(
        &self,
        before: &RepositorySnapshot,
        after: &RepositorySnapshot,
        current: Option<&RepositorySnapshot>,
    ) -> AppResult<Vec<TurnCheckpointFile>> {
        let before_entries = self.entries(before)?;
        let after_entries = self.entries(after)?;
        let current_entries = current
            .map(|snapshot| self.entries(snapshot))
            .transpose()?
            .unwrap_or_default();
        let paths: std::collections::BTreeSet<_> =
            before_entries.keys().chain(after_entries.keys()).collect();
        let mut remaining = MAX_PREVIEW_TOTAL;
        let mut files = Vec::new();
        for path in paths {
            let left = before_entries.get(path);
            let right = after_entries.get(path);
            if left == right {
                continue;
            }
            let old = self.snapshots.read_file(before, path)?;
            let new = self.snapshots.read_file(after, path)?;
            let binary = old
                .iter()
                .chain(new.iter())
                .any(|file| file.bytes.contains(&0) || std::str::from_utf8(&file.bytes).is_err());
            let supported = old
                .iter()
                .chain(new.iter())
                .all(|file| matches!(file.mode.as_str(), "100644" | "100755"));
            #[cfg(windows)]
            let supported = supported
                && old.as_ref().is_none_or(|file| {
                    file.mode
                        == new
                            .as_ref()
                            .map(|file| file.mode.as_str())
                            .unwrap_or("100644")
                });
            let size = old
                .iter()
                .chain(new.iter())
                .map(|file| file.bytes.len())
                .sum::<usize>();
            let omitted = binary || size > MAX_PREVIEW_FILE || size > remaining;
            // Restoring an old file in place of a turn-created directory must
            // not remove descendants added after the turn. Ignored descendants
            // are additionally protected by rooted publication's nonrecursive rmdir.
            let prefix = format!("{path}/");
            let later_descendant = left.is_some()
                && right.is_none()
                && current_entries
                    .range(prefix.clone()..)
                    .take_while(|(candidate, _)| candidate.starts_with(&prefix))
                    .any(|(candidate, _)| !after_entries.contains_key(candidate));
            let (before_content, after_content) = if omitted {
                (None, None)
            } else {
                remaining -= size;
                (content(old.as_ref()), content(new.as_ref()))
            };
            files.push(TurnCheckpointFile {
                path: path.clone(),
                status: if left.is_none() {
                    "added"
                } else if right.is_none() {
                    "deleted"
                } else {
                    "modified"
                }
                .into(),
                binary,
                conflict: current.is_none()
                    || current_entries.get(path) != right
                    || later_descendant,
                supported,
                before_content,
                after_content,
                preview_omitted: omitted,
            });
        }
        Ok(files)
    }

    fn entries(&self, snapshot: &RepositorySnapshot) -> AppResult<BTreeMap<String, SnapshotEntry>> {
        Ok(self
            .snapshots
            .list_files(snapshot)?
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect())
    }
}

fn blocked(
    record: &TurnCheckpointRecord,
    files: &[TurnCheckpointFile],
    current: Option<&RepositorySnapshot>,
    busy: bool,
) -> Option<String> {
    let reason = if busy {
        "An agent turn is active in this repository; stop it before restoring"
    } else if record.restored_at.is_some() {
        "This checkpoint has already been restored"
    } else if current.is_some_and(|snapshot| {
        record
            .before
            .as_ref()
            .is_some_and(|before| before.head != snapshot.head)
            || record
                .after
                .as_ref()
                .is_some_and(|after| after.head != snapshot.head)
    }) {
        "Repository HEAD changed; restoring working-tree files would not restore commits or the Git index"
    } else if files.iter().any(|file| file.conflict) {
        "A changed file has later edits; whole-turn restore is blocked to preserve them"
    } else if files.iter().any(|file| !file.supported) {
        "This turn includes symlinks or unsupported file modes; whole-turn restore is unavailable"
    } else if files.is_empty() {
        "This turn has no working-tree file changes"
    } else {
        return None;
    };
    Some(reason.into())
}

fn content(file: Option<&SnapshotFile>) -> Option<String> {
    file.and_then(|file| String::from_utf8(file.bytes.clone()).ok())
}
fn revision(record: &TurnCheckpointRecord, current: &RepositorySnapshot) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}\n{}\n{}\n{:?}",
            record.id,
            record
                .before
                .as_ref()
                .map(|snapshot| snapshot.fingerprint.as_str())
                .unwrap_or_default(),
            record
                .after
                .as_ref()
                .map(|snapshot| snapshot.fingerprint.as_str())
                .unwrap_or_default(),
            current.fingerprint,
            record.restored_at
        ))
    )
}
fn unavailable(record: TurnCheckpointRecord, fallback: &str) -> TurnCheckpointReview {
    let blocked_reason = Some(
        record
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| fallback.into()),
    );
    TurnCheckpointReview {
        record,
        revision: String::new(),
        files: Vec::new(),
        can_restore: false,
        blocked_reason,
    }
}
