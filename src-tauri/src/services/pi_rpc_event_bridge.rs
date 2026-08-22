//! Tauri-side bridge for Pi's background RPC transport.
//!
//! The core RPC service owns process I/O. This adapter forwards its typed
//! events to the WebView and keeps an explicitly attached TaskBinding durable
//! while a background task runs.

use crate::models::task_binding::{TaskBindingStatus, UpdateTaskBindingRequest};
use crate::services::{
    PiRpcEvent, PiRpcService, PiRpcSessionPhase, PiRpcSessionSnapshot, TaskBindingService,
};
use crate::utils::{AppError, AppResult};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

pub const PI_RPC_EVENT: &str = "pi-rpc-event";
const PI_RPC_SESSION_FINISHED_EVENT: &str = "ccpanes_rpc_session_finished";
const PI_RPC_EVENT_LAGGED: &str = "ccpanes_rpc_event_lagged";
const PI_RPC_SUMMARY_MAX_CHARS: usize = 2_000;

/// Bridges one independently-owned Pi RPC process to desktop events.
///
/// A TaskBinding is optional because Pi RPC is also useful as a generic
/// structured transport. When supplied, the binding id is checked before the
/// process is exposed to callers and the bridge persists lifecycle updates in
/// the backend instead of relying on a mounted WebView.
pub struct PiRpcEventBridge {
    app_handle: AppHandle,
    rpc_service: Arc<PiRpcService>,
    task_binding_service: Arc<TaskBindingService>,
}

impl PiRpcEventBridge {
    pub fn new(
        app_handle: AppHandle,
        rpc_service: Arc<PiRpcService>,
        task_binding_service: Arc<TaskBindingService>,
    ) -> Self {
        Self {
            app_handle,
            rpc_service,
            task_binding_service,
        }
    }

    /// Attach a pre-existing Pi TaskBinding to a newly created RPC process.
    pub fn attach_task_binding(&self, binding_id: &str, rpc_session_id: &str) -> AppResult<()> {
        let binding_id = binding_id.trim();
        if binding_id.is_empty() {
            return Err(AppError::coded(
                "PI_RPC_TASK_BINDING_REQUIRED",
                "Pi RPC task binding id cannot be empty",
            ));
        }
        let binding = self.task_binding_service.get(binding_id)?.ok_or_else(|| {
            AppError::coded(
                "PI_RPC_TASK_BINDING_NOT_FOUND",
                "Pi RPC task binding was not found",
            )
        })?;
        if binding.cli_tool != "pi" {
            return Err(AppError::coded(
                "PI_RPC_TASK_BINDING_TOOL_MISMATCH",
                "Pi RPC can only attach to a TaskBinding whose cliTool is 'pi'",
            ));
        }

        let mut metadata = binding.metadata.unwrap_or_else(|| json!({}));
        let Some(object) = metadata.as_object_mut() else {
            return Err(AppError::coded(
                "PI_RPC_TASK_BINDING_METADATA_INVALID",
                "Pi RPC task binding metadata must be an object",
            ));
        };
        object.insert(
            "piRpcSessionId".to_string(),
            Value::String(rpc_session_id.to_string()),
        );

        self.task_binding_service.update(
            binding_id,
            UpdateTaskBindingRequest {
                session_id: Some(rpc_session_id.to_string()),
                status: Some(TaskBindingStatus::Running),
                progress: Some(0),
                completion_summary: Some("Pi RPC session started".to_string()),
                metadata: Some(metadata),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Start forwarding events after the caller has attached any TaskBinding.
    ///
    /// This awaits the broadcast subscription before spawning the relay task.
    /// The command layer can therefore submit Pi's initial prompt only after
    /// this returns, so an immediate `agent_start` cannot be lost.
    pub async fn start_session(
        &self,
        rpc_session_id: String,
        task_binding_id: Option<String>,
    ) -> AppResult<()> {
        let receiver = self.rpc_service.subscribe(&rpc_session_id).await?;
        // A process can finish before the broadcast subscription is created.
        // Capture the snapshot after subscribing so a terminal state can be
        // reconciled without creating a window in which the first prompt is
        // sent before the relay is ready.
        let terminal_snapshot = self.rpc_service.snapshot(&rpc_session_id).await?;
        let app_handle = self.app_handle.clone();
        let task_binding_service = self.task_binding_service.clone();
        tauri::async_runtime::spawn(async move {
            let mut receiver = receiver;
            let mut latest_outcome = None;

            if terminal_snapshot_event(&terminal_snapshot).is_some() {
                // Drain events already buffered after the subscription. This
                // preserves an agent_end/agent_settled result when the process
                // reached a terminal state just before the snapshot read.
                loop {
                    match receiver.try_recv() {
                        Ok(event) => {
                            if process_rpc_event(
                                &app_handle,
                                task_binding_service.as_ref(),
                                task_binding_id.as_deref(),
                                &mut latest_outcome,
                                event,
                            ) {
                                return;
                            }
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Lagged(count)) => {
                            emit_lagged_event(&app_handle, &rpc_session_id, count);
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
                        | Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                    }
                }

                // No finished event was observed, so the terminal snapshot is
                // the source of truth for the missed process-exit transition.
                if let Some(event) = terminal_snapshot_event(&terminal_snapshot) {
                    process_rpc_event(
                        &app_handle,
                        task_binding_service.as_ref(),
                        task_binding_id.as_deref(),
                        &mut latest_outcome,
                        event,
                    );
                }
                return;
            }

            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        if process_rpc_event(
                            &app_handle,
                            task_binding_service.as_ref(),
                            task_binding_id.as_deref(),
                            &mut latest_outcome,
                            event,
                        ) {
                            return;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        emit_lagged_event(&app_handle, &rpc_session_id, count);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        Ok(())
    }
}

fn process_rpc_event(
    app_handle: &AppHandle,
    task_binding_service: &TaskBindingService,
    task_binding_id: Option<&str>,
    latest_outcome: &mut Option<PiRpcTaskOutcome>,
    event: PiRpcEvent,
) -> bool {
    let event_type = event.payload.get("type").and_then(Value::as_str);
    match event_type {
        Some("agent_start") => {
            update_running(task_binding_service, task_binding_id);
        }
        Some("agent_end") => {
            *latest_outcome = task_outcome_from_agent_end(&event.payload);
        }
        Some("agent_settled") => {
            update_settled(task_binding_service, task_binding_id, latest_outcome.take());
        }
        Some(PI_RPC_SESSION_FINISHED_EVENT) => {
            record_process_exit(task_binding_service, task_binding_id, &event.payload);
        }
        _ => {}
    }

    emit_rpc_event(app_handle, &event);
    event_type == Some(PI_RPC_SESSION_FINISHED_EVENT)
}

fn emit_lagged_event(app_handle: &AppHandle, rpc_session_id: &str, count: u64) {
    emit_rpc_event(
        app_handle,
        &PiRpcEvent {
            rpc_session_id: rpc_session_id.to_string(),
            payload: json!({
                "type": PI_RPC_EVENT_LAGGED,
                "droppedEventCount": count,
            }),
        },
    );
}

fn terminal_snapshot_event(snapshot: &PiRpcSessionSnapshot) -> Option<PiRpcEvent> {
    if !matches!(
        snapshot.phase,
        PiRpcSessionPhase::Exited | PiRpcSessionPhase::Failed
    ) {
        return None;
    }
    Some(PiRpcEvent {
        rpc_session_id: snapshot.rpc_session_id.clone(),
        payload: json!({
            "type": PI_RPC_SESSION_FINISHED_EVENT,
            "phase": snapshot.phase,
            "exitCode": snapshot.exit_code,
        }),
    })
}

fn emit_rpc_event(app_handle: &AppHandle, event: &PiRpcEvent) {
    if !crate::webview_reliability::webview_emits_allowed() {
        return;
    }
    if let Err(error) = app_handle.emit(PI_RPC_EVENT, event) {
        debug!(rpc_session_id = %event.rpc_session_id, error = %error, "Pi RPC event emit failed");
    }
}

fn update_running(service: &TaskBindingService, binding_id: Option<&str>) {
    let Some(binding_id) = binding_id else {
        return;
    };
    if let Err(error) = service.update(
        binding_id,
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Running),
            progress: Some(0),
            completion_summary: Some("Pi agent is running".to_string()),
            ..Default::default()
        },
    ) {
        warn!(binding_id, error = %error, "Pi RPC could not mark TaskBinding running");
    }
}

fn update_settled(
    service: &TaskBindingService,
    binding_id: Option<&str>,
    outcome: Option<PiRpcTaskOutcome>,
) {
    let Some(binding_id) = binding_id else {
        return;
    };
    let outcome = outcome.unwrap_or_else(PiRpcTaskOutcome::completed_without_message);
    if let Err(error) = service.update(
        binding_id,
        UpdateTaskBindingRequest {
            status: Some(outcome.status.clone()),
            progress: Some(if outcome.is_completed() { 100 } else { 0 }),
            completion_summary: Some(outcome.summary),
            ..Default::default()
        },
    ) {
        warn!(binding_id, error = %error, "Pi RPC could not persist TaskBinding result");
    }
}

fn record_process_exit(service: &TaskBindingService, binding_id: Option<&str>, payload: &Value) {
    let Some(binding_id) = binding_id else {
        return;
    };
    let exit_code = payload
        .get("exitCode")
        .and_then(Value::as_i64)
        .and_then(|code| i32::try_from(code).ok())
        .unwrap_or(-1);
    let Some(binding) = service.get(binding_id).unwrap_or_else(|error| {
        warn!(binding_id, error = %error, "Pi RPC could not load TaskBinding after process exit");
        None
    }) else {
        return;
    };
    let Some(rpc_session_id) = binding
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("piRpcSessionId"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if let Err(error) = service.record_terminal_exit(rpc_session_id, exit_code) {
        warn!(binding_id, rpc_session_id, exit_code, error = %error, "Pi RPC could not persist process exit");
    }
}

#[derive(Debug, Clone, PartialEq)]
struct PiRpcTaskOutcome {
    status: TaskBindingStatus,
    summary: String,
}

impl PiRpcTaskOutcome {
    fn completed_without_message() -> Self {
        Self {
            status: TaskBindingStatus::Completed,
            summary: "Pi agent settled".to_string(),
        }
    }

    fn is_completed(&self) -> bool {
        self.status == TaskBindingStatus::Completed
    }
}

fn task_outcome_from_agent_end(payload: &Value) -> Option<PiRpcTaskOutcome> {
    if payload.get("type").and_then(Value::as_str) != Some("agent_end") {
        return None;
    }
    let messages = payload.get("messages").and_then(Value::as_array);
    let assistant = messages.and_then(|messages| {
        messages
            .iter()
            .rev()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    });
    let stop_reason = assistant
        .and_then(|message| {
            message
                .get("stopReason")
                .or_else(|| message.get("stop_reason"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let failed = matches!(stop_reason, "error" | "aborted");
    let text = assistant
        .map(assistant_text)
        .filter(|text| !text.is_empty());
    let summary = match (failed, text) {
        (true, Some(text)) => clip_summary(format!("Pi {stop_reason}: {text}")),
        (true, None) => format!("Pi agent {stop_reason}"),
        (false, Some(text)) => clip_summary(text),
        (false, None) => "Pi agent settled".to_string(),
    };
    Some(PiRpcTaskOutcome {
        status: if failed {
            TaskBindingStatus::Failed
        } else {
            TaskBindingStatus::Completed
        },
        summary,
    })
}

fn assistant_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn clip_summary(summary: String) -> String {
    let mut chars = summary.chars();
    let clipped = chars
        .by_ref()
        .take(PI_RPC_SUMMARY_MAX_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{clipped}...")
    } else {
        clipped
    }
}

#[cfg(test)]
mod tests {
    use super::{
        task_outcome_from_agent_end, terminal_snapshot_event, PI_RPC_SESSION_FINISHED_EVENT,
        PI_RPC_SUMMARY_MAX_CHARS,
    };
    use crate::models::task_binding::TaskBindingStatus;
    use crate::services::{PiRpcSessionPhase, PiRpcSessionSnapshot};
    use serde_json::json;

    #[test]
    fn terminal_snapshot_replays_a_missed_process_finished_event() {
        let snapshot = PiRpcSessionSnapshot {
            rpc_session_id: "rpc-finished-before-subscribe".to_string(),
            phase: PiRpcSessionPhase::Failed,
            pi_session_id: None,
            session_file: None,
            message_count: None,
            exit_code: Some(23),
            error: Some("Pi exited".to_string()),
        };

        let event = terminal_snapshot_event(&snapshot).expect("terminal snapshot event");

        assert_eq!(event.rpc_session_id, snapshot.rpc_session_id);
        assert_eq!(event.payload["type"], PI_RPC_SESSION_FINISHED_EVENT);
        assert_eq!(event.payload["phase"], "failed");
        assert_eq!(event.payload["exitCode"], 23);
    }

    #[test]
    fn active_snapshot_does_not_synthesize_a_process_finished_event() {
        let snapshot = PiRpcSessionSnapshot {
            rpc_session_id: "rpc-still-running".to_string(),
            phase: PiRpcSessionPhase::Running,
            pi_session_id: None,
            session_file: None,
            message_count: None,
            exit_code: None,
            error: None,
        };

        assert!(terminal_snapshot_event(&snapshot).is_none());
    }

    #[test]
    fn persists_the_final_assistant_text_after_a_settled_run() {
        let outcome = task_outcome_from_agent_end(&json!({
            "type": "agent_end",
            "messages": [
                {"role": "user", "content": "implement it"},
                {"role": "assistant", "stopReason": "stop", "content": [
                    {"type": "thinking", "thinking": "hidden"},
                    {"type": "text", "text": "Implemented the change."}
                ]}
            ]
        }))
        .expect("agent outcome");

        assert_eq!(outcome.status, TaskBindingStatus::Completed);
        assert_eq!(outcome.summary, "Implemented the change.");
    }

    #[test]
    fn maps_terminal_agent_errors_to_failed_bindings() {
        let outcome = task_outcome_from_agent_end(&json!({
            "type": "agent_end",
            "messages": [{
                "role": "assistant",
                "stopReason": "error",
                "content": "Provider rejected the request"
            }]
        }))
        .expect("agent outcome");

        assert_eq!(outcome.status, TaskBindingStatus::Failed);
        assert_eq!(outcome.summary, "Pi error: Provider rejected the request");
    }

    #[test]
    fn bounds_a_large_assistant_summary_before_persistence() {
        let outcome = task_outcome_from_agent_end(&json!({
            "type": "agent_end",
            "messages": [{
                "role": "assistant",
                "content": "x".repeat(PI_RPC_SUMMARY_MAX_CHARS + 1)
            }]
        }))
        .expect("agent outcome");

        assert_eq!(
            outcome.summary.chars().count(),
            PI_RPC_SUMMARY_MAX_CHARS + 3
        );
        assert!(outcome.summary.ends_with("..."));
    }
}
