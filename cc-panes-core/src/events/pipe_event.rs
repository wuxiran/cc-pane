use serde::{Deserialize, Serialize};

pub const ORCHESTRATION_PIPE_EVENT: &str = "orchestration-pipe-event";
pub const PIPE_EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PipeEventKind {
    Dispatch,
    Message,
    Report,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PipeEventPhase {
    Queued,
    Flowing,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipeEvent {
    pub schema_version: u32,
    pub event_id: String,
    pub correlation_id: String,
    pub attempt: u32,
    pub sequence: u64,
    pub workspace_id: String,
    pub kind: PipeEventKind,
    pub phase: PipeEventPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_binding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_binding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_session: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: String,
}
