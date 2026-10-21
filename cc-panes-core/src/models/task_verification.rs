use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTaskVerificationRequest {
    pub command: String,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationFreshness {
    Current,
    Stale,
    Unknown,
}

/// Immutable execution facts. Freshness is recomputed against the current repository on reads.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskVerificationEvidence {
    pub id: String,
    pub task_id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub timeout_secs: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    pub execution_error: Option<String>,
    #[serde(default)]
    pub original_head: String,
    pub original_fingerprint: String,
    pub final_fingerprint: Option<String>,
    pub code_changed_during_run: bool,
    pub observation_error: Option<String>,
    pub freshness: VerificationFreshness,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskVerificationReport {
    pub task_id: String,
    pub cwd: String,
    pub current_fingerprint: Option<String>,
    pub snapshot_error: Option<String>,
    /// Includes a Unix check whose host crashed but whose child-held lease remains.
    /// An interrupted execution has no completed evidence and cannot count as passed.
    pub running: bool,
    pub evidence: Vec<TaskVerificationEvidence>,
    pub completion: TaskCompletionReport,
}

/// Commands are explicit acceptance criteria, never inferred from an agent's prose.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCompletionCriteria {
    #[serde(default)]
    pub definition_of_done: String,
    #[serde(default)]
    pub required_commands: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTaskCompletionCriteriaRequest {
    pub expected_revision: i64,
    pub criteria: TaskCompletionCriteria,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptTaskCompletionRequest {
    pub expected_criteria_revision: i64,
    pub expected_report_revision: i64,
    pub expected_fingerprint: Option<String>,
    #[serde(default)]
    pub expected_evidence_ids: Vec<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionAcceptance {
    pub accepted_at: String,
    pub note: String,
    pub criteria_revision: i64,
    pub report_revision: i64,
    pub fingerprint: Option<String>,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionCheckStatus {
    NotConfigured,
    Missing,
    Running,
    Passed,
    Failed,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionCheck {
    pub command: String,
    pub evidence_id: Option<String>,
    pub status: CompletionCheckStatus,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionRecord {
    pub revision: i64,
    pub criteria: TaskCompletionCriteria,
    pub acceptance: Option<TaskCompletionAcceptance>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionReport {
    pub criteria: TaskCompletionCriteria,
    pub criteria_revision: i64,
    pub report_revision: i64,
    /// Existing task status describes execution only, never verification or acceptance.
    pub agent_finished: bool,
    pub code_fingerprint: Option<String>,
    pub checks_status: CompletionCheckStatus,
    pub checks: Vec<TaskCompletionCheck>,
    pub acceptance: Option<TaskCompletionAcceptance>,
    /// Recomputed from current code, latest evidence and task/criteria revisions.
    pub user_accepted: bool,
    pub can_accept: bool,
}
