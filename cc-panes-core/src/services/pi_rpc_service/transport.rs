use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tracing::{debug, warn};

use super::{PiRpcCommandResponse, PiRpcEvent, PiRpcSession, PiRpcSessionPhase};

const PROCESS_EXIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

pub(super) async fn read_stdout(session: Arc<PiRpcSession>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut record = Vec::new();

    loop {
        record.clear();
        match reader.read_until(b'\n', &mut record).await {
            Ok(0) => break,
            Ok(_) => match parse_jsonl_record(&record) {
                Ok(payload) => route_payload(session.clone(), payload).await,
                Err(error) => {
                    // Pi should only emit JSON records in RPC mode. Preserve a
                    // parse failure as an event without logging raw payloads.
                    let _ = session.events.send(PiRpcEvent {
                        rpc_session_id: session.rpc_session_id.clone(),
                        payload: serde_json::json!({
                            "type": "ccpanes_rpc_parse_error",
                            "error": error,
                        }),
                    });
                }
            },
            Err(error) => {
                finish_after_stdout_closed(
                    session,
                    Some(format!("Failed to read Pi RPC output: {error}")),
                )
                .await;
                return;
            }
        }
    }

    finish_after_stdout_closed(session, None).await;
}

/// An RPC child is allowed to close stdout before it exits. Keep polling the
/// process with short, unlocked intervals so `stop()` can still acquire the
/// child handle and force a shutdown while the stdout reader is waiting.
async fn wait_for_child_exit(session: &PiRpcSession) -> Result<Option<i32>, String> {
    loop {
        let poll: Result<Option<Option<i32>>, String> = {
            let mut child_guard = session.child.lock().await;
            match child_guard.as_mut() {
                None => Ok(Some(None)),
                Some(child) => child
                    .try_wait()
                    .map(|status| status.map(|status| status.code()))
                    .map_err(|error| format!("Unable to inspect Pi RPC process: {error}")),
            }
        };
        match poll {
            Ok(Some(exit_code)) => return Ok(exit_code),
            Ok(None) => tokio::time::sleep(PROCESS_EXIT_POLL_INTERVAL).await,
            Err(error) => return Err(error),
        }
    }
}

/// A stdout read failure leaves the child state unknown, so force termination
/// and reap it before its adapter-owned state becomes eligible for cleanup.
async fn terminate_and_reap_child(session: &PiRpcSession) -> Result<Option<i32>, String> {
    let mut child_guard = session.child.lock().await;
    let Some(child) = child_guard.as_mut() else {
        return Ok(None);
    };
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Unable to inspect Pi RPC process: {error}"))?
    {
        return Ok(status.code());
    }
    if let Err(error) = child.kill().await {
        if error.kind() != std::io::ErrorKind::InvalidInput {
            return Err(format!(
                "Unable to stop Pi RPC after stdout failure: {error}"
            ));
        }
    }
    child
        .wait()
        .await
        .map(|status| status.code())
        .map_err(|error| format!("Unable to reap Pi RPC after stdout failure: {error}"))
}

async fn finish_after_stdout_closed(session: Arc<PiRpcSession>, stdout_error: Option<String>) {
    let exit_result = if stdout_error.is_some() {
        terminate_and_reap_child(&session).await
    } else {
        wait_for_child_exit(&session).await
    };
    let exit_code = match exit_result {
        Ok(exit_code) => exit_code,
        Err(process_error) => {
            let message = stdout_error.map_or_else(
                || format!("Pi RPC output closed before process exit could be confirmed: {process_error}"),
                |stdout_error| format!("{stdout_error}; {process_error}"),
            );
            let finished = session
                .mark_finished(PiRpcSessionPhase::Failed, None, Some(message.clone()))
                .await;
            if finished {
                emit_session_finished(&session).await;
                session.schedule_finished_reap();
            }
            // A process which could not be inspected or reaped may still be
            // running. Preserve its state rather than invalidating a live Pi
            // process; shutdown or an explicit stop will retry cleanup.
            session.complete_pending_with_error(message).await;
            return;
        }
    };
    let had_stdout_error = stdout_error.is_some();
    let stderr_tail = session.stderr_tail().await;
    // Stderr may contain provider diagnostics. Keep it out of the serializable
    // snapshot and WebView event surface because provider failures sometimes
    // echo request context. The generic state remains actionable without
    // turning diagnostics into a credential leak.
    let error = if let Some(stdout_error) = stdout_error {
        Some(stdout_error)
    } else if !stderr_tail.trim().is_empty() {
        Some("Pi RPC process exited with diagnostics on stderr".to_string())
    } else if exit_code.is_some_and(|code| code != 0) {
        Some(format!(
            "Pi RPC process exited with code {}",
            exit_code.expect("checked above")
        ))
    } else {
        None
    };
    let phase = if had_stdout_error || exit_code.is_some_and(|code| code != 0) {
        PiRpcSessionPhase::Failed
    } else {
        PiRpcSessionPhase::Exited
    };
    let finished = session.mark_finished(phase, exit_code, error.clone()).await;
    if finished {
        emit_session_finished(&session).await;
        session.schedule_finished_reap();
    }
    session.cleanup_managed_state();
    session
        .complete_pending_with_error(error.unwrap_or_else(|| "Pi RPC output closed".to_string()))
        .await;
}

pub(super) async fn emit_session_finished(session: &PiRpcSession) {
    let snapshot = session.snapshot().await;
    let _ = session.events.send(PiRpcEvent {
        rpc_session_id: session.rpc_session_id.clone(),
        payload: serde_json::json!({
            "type": "ccpanes_rpc_session_finished",
            "phase": snapshot.phase,
            "exitCode": snapshot.exit_code,
        }),
    });
}

pub(super) async fn read_stderr(session: Arc<PiRpcSession>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut record = Vec::new();
    loop {
        record.clear();
        match reader.read_until(b'\n', &mut record).await {
            Ok(0) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(trim_record_ending(&record))
                    .trim()
                    .to_string();
                if !line.is_empty() {
                    session.push_stderr_line(line).await;
                }
            }
            Err(error) => {
                debug!(error = %error, "Pi RPC stderr reader stopped");
                return;
            }
        }
    }
}

async fn route_payload(session: Arc<PiRpcSession>, payload: Value) {
    if let Some(response) = response_from_payload(&payload) {
        let sender = session.pending.lock().await.remove(&response.id);
        if let Some(sender) = sender {
            let _ = sender.send(Ok(response));
            return;
        }
    }

    session.update_state_from_event(&payload).await;
    let auto_cancel = extension_ui_auto_cancel_response(&payload);
    let _ = session.events.send(PiRpcEvent {
        rpc_session_id: session.rpc_session_id.clone(),
        payload,
    });
    if let Some(response) = auto_cancel {
        if let Err(error) = session.write_value(&response).await {
            warn!(error = %error, "failed to auto-cancel Pi RPC extension dialog");
        }
    }
}

pub(super) fn parse_jsonl_record(record: &[u8]) -> Result<Value, String> {
    let record = trim_record_ending(record);
    if record.is_empty() {
        return Err("Received an empty Pi RPC record".to_string());
    }
    serde_json::from_slice(record).map_err(|error| format!("Invalid Pi RPC JSON record: {error}"))
}

fn trim_record_ending(record: &[u8]) -> &[u8] {
    let record = record.strip_suffix(b"\n").unwrap_or(record);
    record.strip_suffix(b"\r").unwrap_or(record)
}

pub(super) fn response_from_payload(payload: &Value) -> Option<PiRpcCommandResponse> {
    if payload.get("type").and_then(Value::as_str) != Some("response") {
        return None;
    }
    let id = payload.get("id")?.as_str()?.trim();
    let command = payload.get("command")?.as_str()?.trim();
    if id.is_empty() || command.is_empty() {
        return None;
    }
    Some(PiRpcCommandResponse {
        id: id.to_string(),
        command: command.to_string(),
        success: payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        data: payload.get("data").cloned(),
        error: payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub(super) fn extension_ui_auto_cancel_response(payload: &Value) -> Option<Value> {
    if payload.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return None;
    }
    let method = payload.get("method").and_then(Value::as_str)?;
    if !matches!(method, "select" | "confirm" | "input" | "editor") {
        return None;
    }
    let id = payload.get("id").and_then(Value::as_str)?.trim();
    (!id.is_empty()).then(|| {
        serde_json::json!({
            "type": "extension_ui_response",
            "id": id,
            "cancelled": true,
        })
    })
}
