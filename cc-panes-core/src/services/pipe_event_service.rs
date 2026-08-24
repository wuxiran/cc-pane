use crate::events::{
    EventEmitter, PipeEvent, PipeEventKind, PipeEventPhase, ORCHESTRATION_PIPE_EVENT,
    PIPE_EVENT_SCHEMA_VERSION,
};
use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use uuid::Uuid;

/// Canvas 视觉旁路事件发送器；事件失败不会传播到业务调用方。
pub struct PipeEventService {
    emitter: Arc<dyn EventEmitter>,
    sequence: AtomicU64,
}

#[derive(Debug, Clone)]
pub struct PipeEventRequest {
    pub correlation_id: String,
    pub attempt: u32,
    pub workspace_id: String,
    pub kind: PipeEventKind,
    pub phase: PipeEventPhase,
    pub from_binding: Option<String>,
    pub to_binding: Option<String>,
    pub from_session: Option<String>,
    pub to_session: Option<String>,
    pub summary: String,
    pub reason: Option<String>,
}

impl PipeEventRequest {
    pub fn new(
        correlation_id: impl Into<String>,
        workspace_id: impl Into<String>,
        kind: PipeEventKind,
        phase: PipeEventPhase,
    ) -> Self {
        Self {
            correlation_id: correlation_id.into(),
            attempt: 0,
            workspace_id: workspace_id.into(),
            kind,
            phase,
            from_binding: None,
            to_binding: None,
            from_session: None,
            to_session: None,
            summary: String::new(),
            reason: None,
        }
    }
}

impl PipeEventService {
    pub fn new(emitter: Arc<dyn EventEmitter>) -> Self {
        Self {
            emitter,
            sequence: AtomicU64::new(0),
        }
    }

    pub fn emit(&self, request: PipeEventRequest) -> PipeEvent {
        let event = PipeEvent {
            schema_version: PIPE_EVENT_SCHEMA_VERSION,
            event_id: Uuid::new_v4().to_string(),
            correlation_id: request.correlation_id,
            attempt: request.attempt,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            workspace_id: request.workspace_id,
            kind: request.kind,
            phase: request.phase,
            from_binding: request.from_binding,
            to_binding: request.to_binding,
            from_session: request.from_session,
            to_session: request.to_session,
            summary: request.summary,
            reason: request.reason,
            created_at: Utc::now().to_rfc3339(),
        };
        match serde_json::to_value(&event) {
            Ok(payload) => {
                if let Err(error) = self.emitter.emit(ORCHESTRATION_PIPE_EVENT, payload) {
                    tracing::warn!(error = %error, event_id = %event.event_id, "failed to emit orchestration pipe event");
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, event_id = %event.event_id, "failed to serialize orchestration pipe event")
            }
        }
        event
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::Value;

    #[derive(Default)]
    struct RecordingEmitter(Mutex<Vec<(String, Value)>>);

    impl EventEmitter for RecordingEmitter {
        fn emit(&self, event: &str, payload: Value) -> anyhow::Result<()> {
            self.0.lock().push((event.to_string(), payload));
            Ok(())
        }
    }

    #[test]
    fn serializes_contract_and_monotonic_sequence() {
        let emitter = Arc::new(RecordingEmitter::default());
        let service = PipeEventService::new(emitter.clone());
        let first = service.emit(PipeEventRequest::new(
            "c",
            "ws",
            PipeEventKind::Message,
            PipeEventPhase::Queued,
        ));
        let second = service.emit(PipeEventRequest::new(
            "c",
            "ws",
            PipeEventKind::Message,
            PipeEventPhase::Delivered,
        ));
        assert_eq!(first.schema_version, 1);
        assert_eq!(first.sequence + 1, second.sequence);
        assert_eq!(first.correlation_id, second.correlation_id);
        let events = emitter.0.lock();
        assert_eq!(events[0].0, ORCHESTRATION_PIPE_EVENT);
        assert_eq!(events[0].1["phase"], "queued");
        assert_eq!(events[1].1["phase"], "delivered");
        assert!(events[0].1.get("createdAt").is_some());
    }

    #[test]
    fn serializes_flowing_phase_without_collapsing_it_to_running() {
        let emitter = Arc::new(RecordingEmitter::default());
        let service = PipeEventService::new(emitter.clone());
        service.emit(PipeEventRequest::new(
            "c",
            "ws",
            PipeEventKind::Dispatch,
            PipeEventPhase::Flowing,
        ));
        assert_eq!(emitter.0.lock()[0].1["phase"], "flowing");
    }
}
