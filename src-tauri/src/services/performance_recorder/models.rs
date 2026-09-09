use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Visible,
    #[default]
    Hidden,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Renderer {
    Webgl,
    Dom,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalMetric {
    pub session_id: Option<String>,
    pub visible: bool,
    pub renderer: Renderer,
    pub queued_chars: u64,
    pub in_flight_chars: u64,
    pub queued_writes: u32,
    pub received_chars: u64,
    pub write_calls: u64,
    pub failed_writes: u32,
    pub oldest_wait_ms: f64,
    pub callback_max_ms: f64,
    pub hidden_chars: u64,
    pub resync_active: bool,
    pub resync_count: u64,
    pub resync_chars: u64,
    pub resync_last_chars: u64,
    pub context_losses: u32,
    pub atlas_clears: u32,
    pub scrollback_lines: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererSchedulerMetric {
    pub queued_chars: u64,
    pub in_flight_chars: u64,
    pub queued_sessions: u32,
    pub dropped_chars: u64,
    pub flush_count: u64,
    pub yield_count: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendSnapshot {
    pub heap_used_bytes: Option<u64>,
    pub heap_total_bytes: Option<u64>,
    pub timer_lag_ms: f64,
    pub long_task_count: u32,
    pub long_task_supported: bool,
    pub playing_videos: u32,
    pub long_task_max_ms: f64,
    pub visibility: Visibility,
    pub terminal_count: u32,
    #[serde(default)]
    pub failed_terminal_sources: u32,
    #[serde(default)]
    pub renderer_scheduler: RendererSchedulerMetric,
    pub terminals: Vec<TerminalMetric>,
}

fn valid_duration(value: f64) -> bool {
    value.is_finite() && (0.0..=86_400_000.0).contains(&value)
}
pub(super) fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl FrontendSnapshot {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.terminals.len() > 32
            || !valid_duration(self.timer_lag_ms)
            || !valid_duration(self.long_task_max_ms)
        {
            return Err("invalid performance snapshot limits");
        }
        if self.terminals.iter().any(|t| {
            !valid_duration(t.oldest_wait_ms)
                || !valid_duration(t.callback_max_ms)
                || t.session_id
                    .as_deref()
                    .is_some_and(|id| !valid_session_id(id))
        }) {
            return Err("invalid terminal performance metrics");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Websocket,
    Polling,
    Resync,
    ManualMarker,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub kind: EventKind,
    pub session_id: Option<String>,
    pub end_seq: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub running: bool,
    pub directory: String,
    pub last_write_at_ms: u64,
    pub dropped_events: u64,
    pub last_error: Option<String>,
    pub sample_interval_seconds: u64,
    pub max_total_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_content_bearing_input() {
        let mut sample = FrontendSnapshot::default();
        sample.terminals = vec![TerminalMetric::default(); 33];
        assert!(sample.validate().is_err());
        sample.terminals = vec![TerminalMetric {
            session_id: Some("Bearer secret".into()),
            ..Default::default()
        }];
        assert!(sample.validate().is_err());
        sample.terminals.clear();
        sample.timer_lag_ms = f64::NAN;
        assert!(sample.validate().is_err());
        let mut json = serde_json::to_value(FrontendSnapshot::default()).unwrap();
        json["terminalOutput"] = "private text".into();
        assert!(serde_json::from_value::<FrontendSnapshot>(json).is_err());
    }
}
