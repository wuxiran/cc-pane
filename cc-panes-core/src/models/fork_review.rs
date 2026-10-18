use crate::models::RepositorySnapshot;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForkReviewMode {
    SameDirectory,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareChatForkRequest {
    pub cwd: String,
    pub mode: ForkReviewMode,
    pub source_tab_id: Option<String>,
    pub child_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub title: Option<String>,
    pub engine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkReviewRecord {
    pub id: String,
    pub created_at: String,
    pub mode: ForkReviewMode,
    pub source_cwd: String,
    pub target_cwd: String,
    pub source_tab_id: Option<String>,
    pub child_tab_id: Option<String>,
    pub source_session_id: Option<String>,
    pub child_session_id: Option<String>,
    pub title: Option<String>,
    pub engine_id: Option<String>,
    pub baseline: RepositorySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedChatFork {
    pub cwd: String,
    pub record: Option<ForkReviewRecord>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkHunk {
    pub id: String,
    pub header: String,
    pub patch: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkChangedFile {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub supported: bool,
    pub reason: Option<String>,
    pub parent_changed: bool,
    pub conflict: bool,
    pub base_content: Option<String>,
    pub child_content: Option<String>,
    pub parent_content: Option<String>,
    pub hunks: Vec<ForkHunk>,
    pub whole_file_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkComparison {
    pub record: ForkReviewRecord,
    pub revision: String,
    pub parent_fingerprint: String,
    pub child_fingerprint: String,
    pub shared_directory: bool,
    pub files: Vec<ForkChangedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkSelection {
    pub path: String,
    pub hunk_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyForkChangesRequest {
    pub revision: String,
    pub selections: Vec<ForkSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyForkChangesResult {
    pub applied_paths: Vec<String>,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_warning: Option<String>,
}
