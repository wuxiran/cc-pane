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
}
