use crate::models::RepositorySnapshot;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpointRecord {
    pub id: String,
    pub chat_id: String,
    pub turn_id: String,
    pub cwd: String,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub outcome: String,
    /// Includes changes made by any process in this repository during the turn.
    pub before: Option<RepositorySnapshot>,
    pub after: Option<RepositorySnapshot>,
    pub unavailable_reason: Option<String>,
    pub restored_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpointFile {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub conflict: bool,
    pub supported: bool,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub preview_omitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpointReview {
    pub record: TurnCheckpointRecord,
    pub revision: String,
    pub files: Vec<TurnCheckpointFile>,
    pub can_restore: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTurnCheckpointResult {
    pub restored_paths: Vec<String>,
    pub recovery_id: String,
    pub warning: Option<String>,
}
