//! Durable before/after working-tree checkpoints, independent of agent tool diffs.
mod cli;
mod review;
mod storage;

use crate::models::turn_checkpoint::*;
use crate::services::RepositorySnapshotService;
use crate::utils::{AppError, AppResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Capture/restore share one service lock. It is used only on blocking workers;
/// active turns release this lock while the agent runs, keeping a repository lease.
pub struct TurnCheckpointService {
    directory: PathBuf,
    snapshots: RepositorySnapshotService,
    active: Mutex<HashMap<String, PathBuf>>,
}

impl TurnCheckpointService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            directory: data_dir.join("turn-checkpoints"),
            snapshots: RepositorySnapshotService::new(data_dir),
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Call before sending the prompt, and retain the returned ID until finish.
    /// Capture failures are persisted explicitly and do not prevent the agent turn.
    pub fn begin(
        &self,
        chat_id: &str,
        turn_id: &str,
        cwd: &Path,
    ) -> AppResult<TurnCheckpointRecord> {
        self.begin_inner(chat_id, turn_id, cwd, false)
    }

    fn begin_inner(
        &self,
        chat_id: &str,
        turn_id: &str,
        cwd: &Path,
        manual_cli: bool,
    ) -> AppResult<TurnCheckpointRecord> {
        if chat_id.is_empty()
            || chat_id.len() > 1024
            || turn_id.is_empty()
            || turn_id.len() > 1024
            || !cwd.is_absolute()
            || cwd.to_string_lossy().len() > 16 * 1024
        {
            return Err("Invalid checkpoint chat or turn identity".into());
        }
        let mut active = self.lock()?;
        if manual_cli
            && self
                .read_records(chat_id)?
                .iter()
                .any(|record| active.contains_key(&record.id))
        {
            return Err(AppError::coded(
                "CHECKPOINT_ALREADY_RECORDING",
                "This CLI session is already recording; finish that interval first",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut record = TurnCheckpointRecord {
            id: id.clone(),
            chat_id: chat_id.into(),
            turn_id: turn_id.into(),
            cwd: cwd.to_string_lossy().into_owned(),
            created_at: now(),
            completed_at: None,
            outcome: "running".into(),
            before: None,
            after: None,
            unavailable_reason: None,
            restored_at: None,
        };
        self.capture_before(&mut record, cwd)?;
        // A manual start must never look successful when its before capture
        // failed. Retain the reason, but do not leave a recording lease behind.
        if manual_cli && record.before.is_none() {
            record.outcome = "unavailable".into();
            record.completed_at = Some(now());
        }
        self.save(&record)?;
        if record.completed_at.is_none() {
            active.insert(id, canonical_or_original(Path::new(&record.cwd)));
        }
        Ok(record)
    }

    fn capture_before(&self, record: &mut TurnCheckpointRecord, cwd: &Path) -> AppResult<()> {
        match self.snapshots.capture_checkpoint(cwd, &[]) {
            Ok(snapshot) => {
                self.snapshots
                    .pin(&snapshot, &format!("turn-{}-before", record.id))?;
                record.cwd = snapshot.repository_root.clone();
                record.before = Some(snapshot);
            }
            Err(error) => record.unavailable_reason = Some(bounded_reason(&error)),
        }
        Ok(())
    }

    /// Finish before admitting another prompt. Even an after-capture failure must
    /// release the live lease; the durable before snapshot stays available for review.
    pub fn finish(&self, id: &str, outcome: &str) -> AppResult<TurnCheckpointRecord> {
        self.finish_inner(id, outcome, None)
    }

    /// Retain the observed before/after files for review, but do not claim the
    /// after snapshot is stable while managed background tools can still write.
    pub fn finish_unavailable(
        &self,
        id: &str,
        outcome: &str,
        reason: &str,
    ) -> AppResult<TurnCheckpointRecord> {
        self.finish_inner(id, outcome, Some(reason))
    }

    fn finish_inner(
        &self,
        id: &str,
        outcome: &str,
        unavailable_reason: Option<&str>,
    ) -> AppResult<TurnCheckpointRecord> {
        let mut active = self.lock()?;
        let registered = active.remove(id).is_some();
        let mut record = self.load(id)?;
        if record.completed_at.is_some() {
            if let Some(reason) = unavailable_reason {
                mark_unavailable(&mut record, reason);
                self.save(&record)?;
            }
            return Ok(record);
        }
        if !registered {
            return Err("Cannot finalize a checkpoint from a previous application run".into());
        }
        record.outcome = outcome.chars().take(128).collect();
        record.completed_at = Some(now());
        if let Some(before) = &record.before {
            match self
                .snapshots
                .capture_checkpoint(Path::new(&record.cwd), &[before])
            {
                Ok(after) => {
                    if let Err(error) = self.snapshots.pin(&after, &format!("turn-{id}-after")) {
                        record.unavailable_reason = Some(bounded_reason(&error));
                    } else {
                        record.after = Some(after);
                    }
                }
                Err(error) => record.unavailable_reason = Some(bounded_reason(&error)),
            }
        }
        if let Some(reason) = unavailable_reason {
            mark_unavailable(&mut record, reason);
        }
        self.save(&record)?;
        Ok(record)
    }

    pub fn list(&self, chat_id: &str) -> AppResult<Vec<TurnCheckpointRecord>> {
        let active = self.lock()?;
        let mut records = self.read_records(chat_id)?;
        for record in &mut records {
            if record.completed_at.is_none() && !active.contains_key(&record.id) {
                record.outcome = "interrupted".into();
                record.unavailable_reason.get_or_insert_with(||
                    "Application stopped before the after snapshot was saved; restore is unavailable".into());
            }
        }
        Ok(records)
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, HashMap<String, PathBuf>>> {
        self.active
            .lock()
            .map_err(|_| AppError::from("Checkpoint service lock is unavailable"))
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn bounded_reason(error: &AppError) -> String {
    bounded_text(error.to_string())
}

fn bounded_text(text: String) -> String {
    if text.len() <= 8 * 1024 {
        return text;
    }
    let mut end = 8 * 1024;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [error truncated]", &text[..end])
}

fn mark_unavailable(record: &mut TurnCheckpointRecord, reason: &str) {
    let reason = if reason.trim().is_empty() {
        "Managed background processes may still write files; this checkpoint cannot be restored"
    } else {
        reason
    };
    let combined = match record.unavailable_reason.take() {
        Some(previous) if previous != reason => format!("{reason}. {previous}"),
        _ => reason.into(),
    };
    record.unavailable_reason = Some(bounded_text(combined));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_errors_are_bounded_without_breaking_utf8() {
        let reason = bounded_reason(&AppError::from("错误".repeat(10_000)));
        assert!(reason.len() < 8 * 1024 + 32);
        assert!(reason.ends_with("[error truncated]"));
        let json = serde_json::to_vec(&reason).unwrap();
        assert_eq!(serde_json::from_slice::<String>(&json).unwrap(), reason);
    }
}
