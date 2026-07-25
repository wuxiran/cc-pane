use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub cli_tool: String,
    pub file_path: String,
    pub cwd: String,
    pub project_path_norm: String,
    pub project_name: String,
    pub workspace_name: Option<String>,
    pub first_prompt: String,
    pub last_summary: String,
    pub message_count: u64,
    pub mtime_ms: i64,
    pub size: u64,
    pub source: String,
    pub wsl_distro: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionIndexScope {
    All,
    Workspace(String),
    Project(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIndexQuery {
    pub scope: SessionIndexScope,
    pub query: Option<String>,
    pub cli_filter: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

impl Default for SessionIndexQuery {
    fn default() -> Self {
        Self {
            scope: SessionIndexScope::All,
            query: None,
            cli_filter: None,
            limit: 100,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionScanState {
    pub file_path: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub scanned_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSessionTranscript {
    pub session_id: String,
    pub cwd: String,
    pub first_prompt: String,
    pub last_summary: String,
    pub message_count: u64,
    pub bytes_read: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexScanReport {
    pub roots_scanned: u64,
    pub files_seen: u64,
    pub files_parsed: u64,
    pub files_skipped: u64,
    pub bytes_read: u64,
}
