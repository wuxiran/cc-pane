mod adoption;
mod comparison;
mod git;
mod patch;
mod publish;

use crate::models::fork_review::*;
use crate::models::{RepositorySnapshot, SnapshotFile};
use crate::services::{RepositorySnapshotService, WorktreeService};
use crate::utils::{atomic_file::write_atomic, AppError, AppResult};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct ForkReviewService {
    directory: PathBuf,
    snapshots: RepositorySnapshotService,
}

impl ForkReviewService {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            directory: data_dir.join("fork-reviews"),
            snapshots: RepositorySnapshotService::new(data_dir),
        }
    }

    pub fn prepare(&self, request: PrepareChatForkRequest) -> AppResult<PreparedChatFork> {
        let source = Path::new(&request.cwd);
        if !source.is_absolute() || !source.is_dir() {
            return Err(AppError::coded(
                "FORK_INVALID_REQUEST",
                "Fork source must be an existing local directory",
            ));
        }
        let source = dunce::canonicalize(source)?;
        let worktrees = WorktreeService::new();
        if request.mode == ForkReviewMode::SameDirectory && !worktrees.is_git_repo(&request.cwd) {
            return Ok(PreparedChatFork {
                cwd: request.cwd,
                record: None,
                unavailable_reason: Some("Code comparison requires a Git repository".into()),
            });
        }
        // Reject unsupported source trees and unavailable storage before adding
        // a worktree or branch. The target is captured again after copying.
        let source_baseline = self.snapshots.capture(&source)?;
        self.preflight_storage()?;
        let isolated = request.mode == ForkReviewMode::Worktree;
        let cwd = if isolated {
            worktrees
                .fork_chat_worktree(&request.cwd)
                .map_err(AppError::from)?
        } else {
            source.to_string_lossy().into_owned()
        };
        self.finish_prepare(request, source, cwd.clone(), source_baseline)
            .map_err(|error| {
                if isolated {
                    retained_worktree_error(&cwd, error)
                } else {
                    error
                }
            })
    }

    fn preflight_storage(&self) -> AppResult<()> {
        git::prepare_directory(&self.directory)?;
        let probe = self
            .directory
            .join(format!(".prepare-{}.probe", uuid::Uuid::new_v4()));
        write_atomic(&probe, b"fork record storage probe\n")?;
        fs::remove_file(probe)?;
        Ok(())
    }

    fn finish_prepare(
        &self,
        request: PrepareChatForkRequest,
        source: PathBuf,
        cwd: String,
        source_baseline: RepositorySnapshot,
    ) -> AppResult<PreparedChatFork> {
        let baseline = if request.mode == ForkReviewMode::Worktree {
            self.snapshots.capture(Path::new(&cwd))?
        } else {
            source_baseline
        };
        let record = self.new_record(request, source, cwd.clone(), baseline);
        self.snapshots
            .pin(&record.baseline, &format!("fork-{}", record.id))?;
        git::prepare_directory(&self.directory)?;
        write_atomic(&self.record_path(&record.id)?, encode(&record)?)?;
        Ok(PreparedChatFork {
            cwd,
            record: Some(record),
            unavailable_reason: None,
        })
    }

    fn new_record(
        &self,
        request: PrepareChatForkRequest,
        source: PathBuf,
        cwd: String,
        baseline: RepositorySnapshot,
    ) -> ForkReviewRecord {
        ForkReviewRecord {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            mode: request.mode,
            source_cwd: source.to_string_lossy().into_owned(),
            target_cwd: cwd,
            source_tab_id: request.source_tab_id,
            child_tab_id: request.child_tab_id,
            source_session_id: request.source_session_id,
            child_session_id: None,
            title: request.title,
            engine_id: request.engine_id,
            baseline,
        }
    }

    pub fn list(&self) -> AppResult<Vec<ForkReviewRecord>> {
        if !self.directory.exists() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let path = entry?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            records.push(decode::<ForkReviewRecord>(&fs::read(path)?)?);
        }
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(records)
    }

    pub fn compare(&self, id: &str) -> AppResult<ForkComparison> {
        let record = self.load(id)?;
        let (parent, child) = self.current(&record)?;
        self.comparison(record, parent, child)
    }

    fn load(&self, id: &str) -> AppResult<ForkReviewRecord> {
        let bytes = fs::read(self.record_path(id)?).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("Fork review record not found: {id}"))
            } else {
                error.into()
            }
        })?;
        decode(&bytes)
    }

    fn record_path(&self, id: &str) -> AppResult<PathBuf> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| AppError::coded("FORK_INVALID_REQUEST", "Invalid fork record ID"))?;
        Ok(self.directory.join(format!("{id}.json")))
    }

    fn current(
        &self,
        record: &ForkReviewRecord,
    ) -> AppResult<(RepositorySnapshot, RepositorySnapshot)> {
        let parent = self.snapshots.capture(Path::new(&record.source_cwd))?;
        let child = self.snapshots.capture(Path::new(&record.target_cwd))?;
        if parent.snapshot_repository != record.baseline.snapshot_repository
            || child.snapshot_repository != record.baseline.snapshot_repository
        {
            return Err(
                "Fork repository identity changed; refusing to compare unrelated repositories"
                    .into(),
            );
        }
        Ok((parent, child))
    }
}

fn retained_worktree_error(cwd: &str, error: AppError) -> AppError {
    AppError::coded("FORK_PREPARATION_INCOMPLETE", format!(
        "Fork preparation could not finish: {error}. The new worktree and branch were preserved at {cwd}. Open this directory to recover or continue its files; inspect any changes before explicitly removing the worktree with Git."
    ))
}

fn revision(
    record: &ForkReviewRecord,
    parent: &RepositorySnapshot,
    child: &RepositorySnapshot,
) -> String {
    let data = format!(
        "{}\n{}\n{}\n{}",
        record.id, record.baseline.tree, parent.fingerprint, child.fingerprint
    );
    format!("{:x}", Sha256::digest(data.as_bytes()))
}

fn regular(file: &SnapshotFile) -> bool {
    matches!(file.mode.as_str(), "100644" | "100755")
}
fn text(file: Option<&SnapshotFile>) -> Option<String> {
    file.and_then(|v| {
        if v.bytes.contains(&0) {
            None
        } else {
            String::from_utf8(v.bytes.clone()).ok()
        }
    })
}

fn encode(value: &impl serde::Serialize) -> AppResult<Vec<u8>> {
    serde_json::to_vec_pretty(value).map_err(|e| AppError::from(e.to_string()))
}
fn decode<T: serde::de::DeserializeOwned>(value: &[u8]) -> AppResult<T> {
    serde_json::from_slice(value).map_err(|e| AppError::from(e.to_string()))
}
