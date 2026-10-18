mod observer;
mod process_tree;
mod runner;
mod storage;
#[cfg(unix)]
mod unix_cleanup;

use crate::models::task_verification::{
    RunTaskVerificationRequest, TaskVerificationEvidence, TaskVerificationReport,
    VerificationFreshness,
};
use crate::services::{RepositorySnapshotService, TaskBindingService};
use crate::utils::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub struct TaskVerificationService {
    data_dir: PathBuf,
    bindings: Arc<TaskBindingService>,
    snapshots: RepositorySnapshotService,
}

struct CompletedCheck {
    task_id: String,
    command: String,
    cwd: PathBuf,
    started_at: String,
    completed_at: String,
    timeout_secs: u64,
    original_head: String,
}

struct CodeObservation {
    original: String,
    final_fingerprint: Option<String>,
    changed: bool,
    error: Option<String>,
}

impl TaskVerificationService {
    pub fn new(data_dir: PathBuf, bindings: Arc<TaskBindingService>) -> Self {
        Self {
            snapshots: RepositorySnapshotService::new(data_dir.clone()),
            data_dir,
            bindings,
        }
    }

    pub fn list(&self, task_id: &str) -> AppResult<TaskVerificationReport> {
        let cwd = self.task_cwd(task_id)?;
        let directory = self.evidence_directory(task_id);
        let running = storage::try_lock(&directory)?.is_none();
        let mut evidence = storage::load(&directory, task_id)?;
        if evidence.is_empty() && !running {
            return Ok(TaskVerificationReport {
                task_id: task_id.to_string(),
                cwd: cwd.to_string_lossy().into_owned(),
                current_fingerprint: None,
                snapshot_error: None,
                running,
                evidence,
            });
        }
        let (fingerprint, snapshot_error) = match self.snapshots.capture(&cwd) {
            Ok(snapshot) => (Some(snapshot.fingerprint), None),
            Err(error) => (None, Some(error.to_string())),
        };
        for item in &mut evidence {
            item.freshness = freshness(item, &cwd, fingerprint.as_deref());
        }
        Ok(TaskVerificationReport {
            task_id: task_id.to_string(),
            cwd: cwd.to_string_lossy().into_owned(),
            current_fingerprint: fingerprint,
            snapshot_error,
            running,
            evidence,
        })
    }

    pub fn run(
        &self,
        task_id: &str,
        request: RunTaskVerificationRequest,
    ) -> AppResult<TaskVerificationReport> {
        let timeout_secs = validate_request(&request)?;
        let cwd = self.task_cwd(task_id)?;
        let directory = self.evidence_directory(task_id);
        let guard = storage::try_lock(&directory)?.ok_or_else(|| {
            AppError::coded(
                "VERIFICATION_RUNNING",
                "A verification check is already running for this task",
            )
        })?;
        let evidence = self.execute_check(task_id, request, &cwd, timeout_secs, &guard)?;
        storage::save(&directory, &evidence)?;
        drop(guard);
        self.list(task_id)
    }

    fn execute_check(
        &self,
        task_id: &str,
        request: RunTaskVerificationRequest,
        cwd: &Path,
        timeout_secs: u64,
        lease: &storage::TaskLock,
    ) -> AppResult<TaskVerificationEvidence> {
        let discovered = self.snapshots.capture(cwd)?;
        let observer = observer::CodeObserver::start(Path::new(&discovered.repository_root));
        let before = self.snapshots.capture(cwd)?;
        let started_at = chrono::Utc::now().to_rfc3339();
        let execution = runner::execute(
            &request.command,
            cwd,
            Duration::from_secs(timeout_secs),
            lease,
        );
        let completed_at = chrono::Utc::now().to_rfc3339();
        let after = self
            .snapshots
            .capture(cwd)
            .map(|snapshot| snapshot.fingerprint);
        let observed = observer.and_then(observer::CodeObserver::finish);
        let observation = code_observation(before.fingerprint, after, observed);
        let completed = CompletedCheck {
            task_id: task_id.to_string(),
            command: request.command,
            cwd: cwd.to_path_buf(),
            started_at,
            completed_at,
            timeout_secs,
            original_head: before.head,
        };
        Ok(make_evidence(completed, execution, observation))
    }

    fn task_cwd(&self, task_id: &str) -> AppResult<PathBuf> {
        let binding = self
            .bindings
            .get(task_id)?
            .ok_or_else(|| AppError::NotFound("Task binding not found".into()))?;
        let path = binding.project_path.trim();
        if path.contains("://")
            || path.starts_with("\\\\")
            || path.starts_with("//")
            || !Path::new(path).is_absolute()
        {
            return Err(invalid_request(
                "Verification requires an absolute local task project directory",
            ));
        }
        let path = dunce::canonicalize(path).map_err(|error| {
            AppError::from(format!("Task project directory is unavailable: {error}"))
        })?;
        if !std::fs::metadata(&path)?.is_dir() {
            return Err(invalid_request("Task project path is not a directory"));
        }
        Ok(path)
    }

    fn evidence_directory(&self, task_id: &str) -> PathBuf {
        self.data_dir
            .join("task-verification")
            .join(format!("{:x}", Sha256::digest(task_id.as_bytes())))
    }
}

fn invalid_request(message: &str) -> AppError {
    AppError::coded("VERIFICATION_INVALID_REQUEST", message)
}

fn validate_request(request: &RunTaskVerificationRequest) -> AppResult<u64> {
    if request.command.trim().is_empty()
        || request.command.len() > 8192
        || request.command.contains('\0')
    {
        return Err(invalid_request(
            "Verification command must contain 1–8192 bytes without NUL characters",
        ));
    }
    let timeout = request.timeout_secs.unwrap_or(300);
    if !(1..=600).contains(&timeout) {
        return Err(invalid_request(
            "Verification timeout must be between 1 and 600 seconds",
        ));
    }
    Ok(timeout)
}

fn freshness(
    item: &TaskVerificationEvidence,
    cwd: &Path,
    fingerprint: Option<&str>,
) -> VerificationFreshness {
    if item.code_changed_during_run || Path::new(&item.cwd) != cwd {
        return VerificationFreshness::Stale;
    }
    if item.observation_error.is_some() || fingerprint.is_none() || item.final_fingerprint.is_none()
    {
        return VerificationFreshness::Unknown;
    }
    if fingerprint == Some(item.original_fingerprint.as_str())
        && item.final_fingerprint.as_deref() == fingerprint
    {
        VerificationFreshness::Current
    } else {
        VerificationFreshness::Stale
    }
}

fn code_observation(
    original: String,
    after: AppResult<String>,
    observed: AppResult<bool>,
) -> CodeObservation {
    let (final_fingerprint, snapshot_error) = match after {
        Ok(fingerprint) => (Some(fingerprint), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let changed = observed.as_ref().is_ok_and(|changed| *changed)
        || final_fingerprint
            .as_ref()
            .is_some_and(|value| value != &original);
    CodeObservation {
        original,
        final_fingerprint,
        changed,
        error: observed
            .err()
            .map(|error| error.to_string())
            .or(snapshot_error),
    }
}

fn make_evidence(
    completed: CompletedCheck,
    execution: AppResult<runner::Execution>,
    observation: CodeObservation,
) -> TaskVerificationEvidence {
    let result = execution.unwrap_or_else(|error| runner::Execution {
        exit_code: None,
        signal: None,
        timed_out: false,
        stdout: String::new(),
        stderr: String::new(),
        output_truncated: false,
        error: Some(error.to_string()),
        duration_ms: 0,
    });
    TaskVerificationEvidence {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: completed.task_id,
        command: completed.command,
        cwd: completed.cwd.to_string_lossy().into_owned(),
        started_at: completed.started_at,
        completed_at: completed.completed_at,
        timeout_secs: completed.timeout_secs,
        duration_ms: result.duration_ms,
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out,
        stdout: result.stdout,
        stderr: result.stderr,
        output_truncated: result.output_truncated,
        execution_error: result.error,
        original_head: completed.original_head,
        original_fingerprint: observation.original,
        final_fingerprint: observation.final_fingerprint,
        code_changed_during_run: observation.changed,
        observation_error: observation.error,
        freshness: VerificationFreshness::Unknown,
    }
}
