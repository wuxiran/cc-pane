use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextUsageStatus {
    Ready,
    Waiting,
    Stale,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageSnapshot {
    pub status: ContextUsageStatus,
    pub used_tokens: Option<u64>,
    pub effective_used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
    pub effective_window_tokens: Option<u64>,
    pub used_percentage: Option<u8>,
    pub remaining_percentage: Option<u8>,
    pub model: Option<String>,
    pub usage_source: Option<String>,
    pub window_source: Option<String>,
    pub agent_session_id: Option<String>,
    pub parser_version: Option<String>,
    pub observed_at: i64,
    pub diagnostic_code: Option<String>,
}

impl ContextUsageSnapshot {
    pub fn waiting(diagnostic_code: &str, observed_at: i64) -> Self {
        Self {
            status: ContextUsageStatus::Waiting,
            used_tokens: None,
            effective_used_tokens: None,
            window_tokens: None,
            effective_window_tokens: None,
            used_percentage: None,
            remaining_percentage: None,
            model: None,
            usage_source: None,
            window_source: None,
            agent_session_id: None,
            parser_version: None,
            observed_at,
            diagnostic_code: Some(diagnostic_code.to_string()),
        }
    }

    pub fn error(diagnostic_code: &str, observed_at: i64) -> Self {
        Self {
            status: ContextUsageStatus::Error,
            used_tokens: None,
            effective_used_tokens: None,
            window_tokens: None,
            effective_window_tokens: None,
            used_percentage: None,
            remaining_percentage: None,
            model: None,
            usage_source: None,
            window_source: None,
            agent_session_id: None,
            parser_version: None,
            observed_at,
            diagnostic_code: Some(diagnostic_code.to_string()),
        }
    }
}
