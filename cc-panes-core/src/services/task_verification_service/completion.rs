use super::*;
use crate::models::task_binding::{TaskBinding, TaskBindingStatus};
use crate::models::task_verification::{
    AcceptTaskCompletionRequest, CompletionCheckStatus as Status, SetTaskCompletionCriteriaRequest,
    TaskCompletionAcceptance, TaskCompletionCheck, TaskCompletionCriteria, TaskCompletionRecord,
    TaskCompletionReport,
};

impl TaskVerificationService {
    pub fn set_criteria(
        &self,
        task_id: &str,
        request: SetTaskCompletionCriteriaRequest,
    ) -> AppResult<TaskVerificationReport> {
        let criteria = validate_criteria(request.criteria)?;
        self.with_completion_lock(task_id, || {
            self.task_cwd(task_id)?;
            self.bindings
                .completion_repository()
                .set_completion_criteria(task_id, request.expected_revision, &criteria)?;
            self.list_with_running(task_id, false)
        })
    }

    /// This is an explicit user action. Agent status updates cannot write this record.
    pub fn accept(
        &self,
        task_id: &str,
        request: AcceptTaskCompletionRequest,
    ) -> AppResult<TaskVerificationReport> {
        if request.note.len() > 8192 || request.note.contains('\0') {
            return Err(invalid_request(
                "Acceptance note must be at most 8192 bytes without NUL characters",
            ));
        }
        self.with_completion_lock(task_id, || self.accept_locked(task_id, request))
    }

    fn accept_locked(
        &self,
        task_id: &str,
        request: AcceptTaskCompletionRequest,
    ) -> AppResult<TaskVerificationReport> {
        let report = self.list_with_running(task_id, false)?;
        let completion = &report.completion;
        if completion.criteria_revision != request.expected_criteria_revision
            || completion.report_revision != request.expected_report_revision
        {
            return Err(AppError::coded(
                "COMPLETION_CONFLICT",
                "Task or criteria changed; refresh before accepting",
            ));
        }
        if !completion.can_accept {
            return Err(AppError::coded(
                "COMPLETION_NOT_READY",
                "Agent must finish and every configured check must pass against current code; \
                 refresh or rerun missing, failed or outdated checks",
            ));
        }
        let evidence_ids: Vec<_> = completion
            .checks
            .iter()
            .filter_map(|check| check.evidence_id.clone())
            .collect();
        if request.expected_fingerprint != report.current_fingerprint
            || request.expected_evidence_ids != evidence_ids
        {
            return Err(AppError::coded(
                "COMPLETION_CONFLICT",
                "Code or check evidence changed since review; refresh before accepting",
            ));
        }
        let acceptance = TaskCompletionAcceptance {
            accepted_at: chrono::Utc::now().to_rfc3339(),
            note: request.note.trim().to_string(),
            criteria_revision: completion.criteria_revision,
            report_revision: completion.report_revision,
            fingerprint: report.current_fingerprint.clone(),
            evidence_ids,
        };
        self.bindings
            .completion_repository()
            .accept_completion(task_id, &acceptance)?;
        self.list_with_running(task_id, false)
    }

    fn with_completion_lock<T>(
        &self,
        task_id: &str,
        action: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = storage::try_lock(&self.evidence_directory(task_id))?.ok_or_else(|| {
            AppError::coded(
                "VERIFICATION_RUNNING",
                "Wait for the running check before changing criteria or accepting",
            )
        })?;
        guard.finish(action())
    }
}

pub(super) fn report(
    binding: &TaskBinding,
    record: TaskCompletionRecord,
    evidence: &[TaskVerificationEvidence],
    fingerprint: Option<&str>,
    running: bool,
    snapshot_error: bool,
) -> TaskCompletionReport {
    let checks: Vec<_> = record
        .criteria
        .required_commands
        .iter()
        .map(|command| {
            // Only the latest execution of a required command counts; a later failure
            // cannot be hidden by selecting an older successful result.
            let item = evidence.iter().find(|item| item.command.trim() == command);
            TaskCompletionCheck {
                command: command.clone(),
                evidence_id: item.map(|item| item.id.clone()),
                status: check_status(item, running, snapshot_error),
            }
        })
        .collect();
    let checks_status = aggregate(&checks, running);
    let agent_finished = binding.status == TaskBindingStatus::Completed;
    let can_accept = agent_finished
        && !running
        && !snapshot_error
        && matches!(checks_status, Status::Passed | Status::NotConfigured);
    let ids: Vec<_> = checks
        .iter()
        .filter_map(|check| check.evidence_id.clone())
        .collect();
    let user_accepted = can_accept
        && record.acceptance.as_ref().is_some_and(|accepted| {
            accepted.criteria_revision == record.revision
                && accepted.report_revision == binding.report_revision
                && accepted.fingerprint.as_deref() == fingerprint
                && accepted.evidence_ids == ids
        });
    TaskCompletionReport {
        criteria: record.criteria,
        criteria_revision: record.revision,
        report_revision: binding.report_revision,
        agent_finished,
        code_fingerprint: fingerprint.map(str::to_string),
        checks_status,
        checks,
        acceptance: record.acceptance,
        user_accepted,
        can_accept,
    }
}

fn check_status(
    item: Option<&TaskVerificationEvidence>,
    running: bool,
    snapshot_error: bool,
) -> Status {
    if running {
        return Status::Running;
    }
    let Some(item) = item else {
        return Status::Missing;
    };
    if item.freshness == VerificationFreshness::Stale || item.code_changed_during_run {
        return Status::Stale;
    }
    if snapshot_error
        || item.freshness != VerificationFreshness::Current
        || item.observation_error.is_some()
    {
        return Status::Unknown;
    }
    if item.exit_code == Some(0)
        && item.signal.is_none()
        && !item.timed_out
        && item.execution_error.is_none()
    {
        Status::Passed
    } else {
        Status::Failed
    }
}

fn aggregate(checks: &[TaskCompletionCheck], running: bool) -> Status {
    if running {
        return Status::Running;
    }
    if checks.is_empty() {
        return Status::NotConfigured;
    }
    for status in [
        Status::Failed,
        Status::Stale,
        Status::Unknown,
        Status::Missing,
    ] {
        if checks.iter().any(|check| check.status == status) {
            return status;
        }
    }
    Status::Passed
}

fn validate_criteria(mut criteria: TaskCompletionCriteria) -> AppResult<TaskCompletionCriteria> {
    if criteria.definition_of_done.len() > 8192
        || criteria.definition_of_done.contains('\0')
        || criteria.required_commands.len() > 16
        || criteria
            .required_commands
            .iter()
            .map(String::len)
            .sum::<usize>()
            > 32768
    {
        return Err(invalid_request(
            "Use at most 16 required commands (32 KiB total) and an 8 KiB completion definition",
        ));
    }
    criteria.definition_of_done = criteria.definition_of_done.trim().to_string();
    let mut commands = Vec::new();
    for command in criteria.required_commands {
        validate_request(&RunTaskVerificationRequest {
            command: command.clone(),
            timeout_secs: None,
        })?;
        let command = command.trim().to_string();
        if !commands.contains(&command) {
            commands.push(command);
        }
    }
    criteria.required_commands = commands;
    Ok(criteria)
}
