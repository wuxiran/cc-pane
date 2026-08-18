//! Pi RPC process transport.
//!
//! Pi's RPC mode is an LF-framed JSONL protocol over stdin/stdout. This module
//! owns background Pi processes without sharing a PTY with the interactive
//! terminal transport. Command payloads are intentionally never logged because
//! they can contain prompts and provider credentials.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};
use tracing::warn;
use uuid::Uuid;

use crate::utils::error::{AppError, AppResult};
use crate::utils::no_window_tokio_command;

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const EVENT_CHANNEL_CAPACITY: usize = 256;
const FINISHED_SESSION_RETENTION: Duration = Duration::from_secs(5 * 60);
const STDERR_TAIL_LINES: usize = 80;

mod transport;

/// Identifies the isolated Pi configuration created for one managed launch.
/// Native Pi launches never create this value, so their user-owned state is
/// never eligible for cleanup.
#[derive(Debug, Clone)]
pub struct PiManagedStateCleanup {
    data_dir: PathBuf,
    session_id: String,
}

impl PiManagedStateCleanup {
    pub fn new(data_dir: PathBuf, session_id: impl Into<String>) -> Self {
        Self {
            data_dir,
            session_id: session_id.into(),
        }
    }

    pub fn cleanup(&self) {
        if let Err(error) =
            cc_cli_adapters::cleanup_pi_managed_state(&self.data_dir, &self.session_id)
        {
            warn!(
                session_id = %self.session_id,
                error = %error,
                "failed to clean managed Pi state"
            );
        }
    }
}

/// Retains ownership of managed state while an RPC child is being launched.
/// Tokio cancellation can occur at the session-map await after a child has
/// been spawned, so cleanup cannot rely only on explicit error branches.
struct PendingPiRpcManagedStateCleanup {
    cleanup: Option<PiManagedStateCleanup>,
}

impl PendingPiRpcManagedStateCleanup {
    fn new(cleanup: Option<PiManagedStateCleanup>) -> Self {
        Self { cleanup }
    }

    fn disarm(&mut self) {
        self.cleanup = None;
    }
}

impl Drop for PendingPiRpcManagedStateCleanup {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup.cleanup();
        }
    }
}

/// Process launch details prepared by the Pi adapter / launch resolver.
///
/// This type deliberately is not serializable. Callers must resolve a trusted
/// adapter command and Provider environment in Rust rather than accepting an
/// arbitrary executable or credentials from the WebView.
#[derive(Debug, Clone)]
pub struct PiRpcLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub env_remove: Vec<String>,
    /// Present only when the adapter created an isolated state directory for a
    /// managed Pi Provider.
    pub managed_state_cleanup: Option<PiManagedStateCleanup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PiRpcSessionPhase {
    Starting,
    Idle,
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcSessionSnapshot {
    /// CC-Panes-owned RPC process identity. This is distinct from Pi's durable
    /// conversation id and must never be used as a PTY session id.
    pub rpc_session_id: String,
    pub phase: PiRpcSessionPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PiRpcSessionSnapshot {
    fn starting(rpc_session_id: String) -> Self {
        Self {
            rpc_session_id,
            phase: PiRpcSessionPhase::Starting,
            pi_session_id: None,
            session_file: None,
            message_count: None,
            exit_code: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcEvent {
    pub rpc_session_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcCommandResponse {
    pub id: String,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type PendingResult = Result<PiRpcCommandResponse, String>;

struct PiRpcSession {
    rpc_session_id: String,
    session_registry: Weak<RwLock<HashMap<String, Arc<PiRpcSession>>>>,
    snapshot: RwLock<PiRpcSessionSnapshot>,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, oneshot::Sender<PendingResult>>>,
    events: broadcast::Sender<PiRpcEvent>,
    stderr_tail: Mutex<VecDeque<String>>,
    managed_state_cleanup: Option<PiManagedStateCleanup>,
    finished_reap_scheduled: AtomicBool,
    finished_session_retention: Duration,
}

impl PiRpcSession {
    async fn snapshot(&self) -> PiRpcSessionSnapshot {
        self.snapshot.read().await.clone()
    }

    async fn write_value(&self, value: &Value) -> AppResult<()> {
        let mut encoded = serde_json::to_vec(value).map_err(|error| {
            AppError::coded(
                "PI_RPC_SERIALIZE_FAILED",
                format!("Unable to encode Pi RPC command: {error}"),
            )
        })?;
        // serde_json escapes literal newlines in string values. Retain this
        // guard so a future serializer replacement cannot violate JSONL.
        if encoded.contains(&b'\n') || encoded.contains(&b'\r') {
            return Err(AppError::coded(
                "PI_RPC_INVALID_FRAME",
                "Pi RPC command contains an unframed line delimiter",
            ));
        }
        encoded.push(b'\n');

        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&encoded).await.map_err(|error| {
            AppError::coded(
                "PI_RPC_WRITE_FAILED",
                format!("Unable to write to Pi RPC: {error}"),
            )
        })?;
        stdin.flush().await.map_err(|error| {
            AppError::coded(
                "PI_RPC_WRITE_FAILED",
                format!("Unable to flush Pi RPC input: {error}"),
            )
        })
    }

    async fn complete_pending_with_error(&self, message: String) {
        let pending = {
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(message.clone()));
        }
    }

    async fn mark_finished(
        &self,
        phase: PiRpcSessionPhase,
        exit_code: Option<i32>,
        error: Option<String>,
    ) -> bool {
        let mut snapshot = self.snapshot.write().await;
        if matches!(
            snapshot.phase,
            PiRpcSessionPhase::Exited | PiRpcSessionPhase::Failed
        ) {
            return false;
        }
        snapshot.phase = phase;
        snapshot.exit_code = exit_code;
        snapshot.error = error;
        true
    }

    async fn update_state_from_response(&self, response: &PiRpcCommandResponse) {
        if response.command != "get_state" || !response.success {
            return;
        }
        let Some(data) = response.data.as_ref() else {
            return;
        };
        let mut snapshot = self.snapshot.write().await;
        snapshot.pi_session_id = string_field(data, "sessionId").map(str::to_string);
        snapshot.session_file = string_field(data, "sessionFile").map(str::to_string);
        snapshot.message_count = data.get("messageCount").and_then(Value::as_u64);
        snapshot.phase = if data
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            PiRpcSessionPhase::Running
        } else {
            PiRpcSessionPhase::Idle
        };
    }

    async fn update_state_from_event(&self, payload: &Value) {
        let event_type = payload.get("type").and_then(Value::as_str);
        let mut snapshot = self.snapshot.write().await;
        match event_type {
            Some("agent_start") => snapshot.phase = PiRpcSessionPhase::Running,
            Some("agent_settled") => snapshot.phase = PiRpcSessionPhase::Idle,
            _ => {}
        }
    }

    async fn push_stderr_line(&self, line: String) {
        let mut tail = self.stderr_tail.lock().await;
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    async fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .await
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn cleanup_managed_state(&self) {
        if let Some(cleanup) = self.managed_state_cleanup.as_ref() {
            cleanup.cleanup();
        }
    }

    fn schedule_finished_reap(self: &Arc<Self>) {
        if self.finished_reap_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let session = Arc::downgrade(self);
        tokio::spawn(async move {
            let Some(session) = session.upgrade() else {
                return;
            };
            tokio::time::sleep(session.finished_session_retention).await;
            let Some(registry) = session.session_registry.upgrade() else {
                return;
            };
            let mut sessions = registry.write().await;
            if sessions
                .get(&session.rpc_session_id)
                .is_some_and(|existing| Arc::ptr_eq(existing, &session))
            {
                sessions.remove(&session.rpc_session_id);
            }
        });
    }
}

/// Manages independent Pi RPC subprocesses. A session cannot attach to an
/// existing PTY-backed Pi process; callers must choose one transport at launch.
#[derive(Clone)]
pub struct PiRpcService {
    sessions: Arc<RwLock<HashMap<String, Arc<PiRpcSession>>>>,
    finished_session_retention: Duration,
}

impl Default for PiRpcService {
    fn default() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            finished_session_retention: FINISHED_SESSION_RETENTION,
        }
    }
}

impl PiRpcService {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn with_finished_session_retention(finished_session_retention: Duration) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            finished_session_retention,
        }
    }

    pub async fn start(&self, launch: PiRpcLaunchSpec) -> AppResult<PiRpcSessionSnapshot> {
        let managed_state_cleanup = launch.managed_state_cleanup.clone();
        let mut pending_managed_state_cleanup =
            PendingPiRpcManagedStateCleanup::new(managed_state_cleanup.clone());
        if launch.command.trim().is_empty() {
            return Err(AppError::coded(
                "PI_RPC_COMMAND_REQUIRED",
                "Pi RPC launch command cannot be empty",
            ));
        }
        if launch.cwd.trim().is_empty() {
            return Err(AppError::coded(
                "PI_RPC_CWD_REQUIRED",
                "Pi RPC launch cwd cannot be empty",
            ));
        }

        let mut command = no_window_tokio_command(&launch.command);
        command
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in &launch.env_remove {
            command.env_remove(key);
        }
        command.envs(&launch.env);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Err(AppError::coded(
                    "PI_RPC_SPAWN_FAILED",
                    format!("Unable to start Pi RPC: {error}"),
                ));
            }
        };
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill().await;
                return Err(AppError::coded(
                    "PI_RPC_SPAWN_FAILED",
                    "Pi RPC stdin was not captured",
                ));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill().await;
                return Err(AppError::coded(
                    "PI_RPC_SPAWN_FAILED",
                    "Pi RPC stdout was not captured",
                ));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child.kill().await;
                return Err(AppError::coded(
                    "PI_RPC_SPAWN_FAILED",
                    "Pi RPC stderr was not captured",
                ));
            }
        };

        let rpc_session_id = Uuid::new_v4().to_string();
        let snapshot = PiRpcSessionSnapshot::starting(rpc_session_id.clone());
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let session = Arc::new(PiRpcSession {
            rpc_session_id: rpc_session_id.clone(),
            session_registry: Arc::downgrade(&self.sessions),
            snapshot: RwLock::new(snapshot.clone()),
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            events,
            stderr_tail: Mutex::new(VecDeque::new()),
            managed_state_cleanup,
            finished_reap_scheduled: AtomicBool::new(false),
            finished_session_retention: self.finished_session_retention,
        });

        self.sessions
            .write()
            .await
            .insert(rpc_session_id, session.clone());
        pending_managed_state_cleanup.disarm();
        tokio::spawn(transport::read_stdout(session.clone(), stdout));
        tokio::spawn(transport::read_stderr(session, stderr));

        Ok(snapshot)
    }

    pub async fn snapshot(&self, rpc_session_id: &str) -> AppResult<PiRpcSessionSnapshot> {
        Ok(self.session(rpc_session_id).await?.snapshot().await)
    }

    pub async fn list_sessions(&self) -> Vec<PiRpcSessionSnapshot> {
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut snapshots = Vec::with_capacity(sessions.len());
        for session in sessions {
            snapshots.push(session.snapshot().await);
        }
        snapshots.sort_by(|left, right| left.rpc_session_id.cmp(&right.rpc_session_id));
        snapshots
    }

    pub async fn subscribe(
        &self,
        rpc_session_id: &str,
    ) -> AppResult<broadcast::Receiver<PiRpcEvent>> {
        Ok(self.session(rpc_session_id).await?.events.subscribe())
    }

    pub async fn request(
        &self,
        rpc_session_id: &str,
        command: Value,
    ) -> AppResult<PiRpcCommandResponse> {
        self.request_with_timeout(rpc_session_id, command, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        rpc_session_id: &str,
        mut command: Value,
        timeout: Duration,
    ) -> AppResult<PiRpcCommandResponse> {
        let session = self.session(rpc_session_id).await?;
        let command_name = command
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::coded("PI_RPC_INVALID_COMMAND", "Pi RPC command type is required")
            })?
            .to_string();
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        command["id"] = Value::String(id.clone());

        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = session.pending.lock().await;
            if pending.contains_key(&id) {
                return Err(AppError::coded(
                    "PI_RPC_DUPLICATE_REQUEST",
                    "Pi RPC command id is already pending",
                ));
            }
            pending.insert(id.clone(), sender);
        }

        if let Err(error) = session.write_value(&command).await {
            session.pending.lock().await.remove(&id);
            return Err(error);
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(response))) => {
                session.update_state_from_response(&response).await;
                Ok(response)
            }
            Ok(Ok(Err(error))) => Err(AppError::coded("PI_RPC_PROCESS_EXITED", error)),
            Ok(Err(_)) => Err(AppError::coded(
                "PI_RPC_RESPONSE_DROPPED",
                "Pi RPC response channel closed unexpectedly",
            )),
            Err(_) => {
                session.pending.lock().await.remove(&id);
                Err(AppError::coded_with_params(
                    "PI_RPC_COMMAND_TIMEOUT",
                    format!("Pi RPC command '{command_name}' did not respond in time"),
                    HashMap::from([("command".to_string(), command_name)]),
                ))
            }
        }
    }

    pub async fn prompt(
        &self,
        rpc_session_id: &str,
        message: String,
    ) -> AppResult<PiRpcCommandResponse> {
        self.request(
            rpc_session_id,
            serde_json::json!({"type": "prompt", "message": message}),
        )
        .await
    }

    pub async fn abort(&self, rpc_session_id: &str) -> AppResult<PiRpcCommandResponse> {
        self.request(rpc_session_id, serde_json::json!({"type": "abort"}))
            .await
    }

    pub async fn get_state(&self, rpc_session_id: &str) -> AppResult<PiRpcCommandResponse> {
        self.request(rpc_session_id, serde_json::json!({"type": "get_state"}))
            .await
    }

    /// Relay an extension dialog result. Background callers normally use the
    /// automatic cancellation path in `read_stdout` instead.
    pub async fn respond_extension_ui(
        &self,
        rpc_session_id: &str,
        response: Value,
    ) -> AppResult<()> {
        let session = self.session(rpc_session_id).await?;
        if response.get("type").and_then(Value::as_str) != Some("extension_ui_response") {
            return Err(AppError::coded(
                "PI_RPC_INVALID_EXTENSION_RESPONSE",
                "Expected a Pi extension_ui_response payload",
            ));
        }
        session.write_value(&response).await
    }

    pub async fn stop(&self, rpc_session_id: &str) -> AppResult<PiRpcSessionSnapshot> {
        let session = self.session(rpc_session_id).await?;
        // Best effort protocol abort first. Do not wait for its response here:
        // a wedged extension or provider must still be killable.
        let _ = session
            .write_value(&serde_json::json!({
                "id": Uuid::new_v4().to_string(),
                "type": "abort"
            }))
            .await;

        let exit_result: AppResult<Option<i32>> = {
            let mut child_guard = session.child.lock().await;
            match child_guard.as_mut() {
                None => Ok(None),
                Some(child) => match child.try_wait() {
                    Err(error) => Err(AppError::coded(
                        "PI_RPC_STOP_FAILED",
                        format!("Unable to inspect Pi RPC process: {error}"),
                    )),
                    Ok(Some(status)) => Ok(status.code()),
                    Ok(None) => match child.kill().await {
                        Err(error) => Err(AppError::coded(
                            "PI_RPC_STOP_FAILED",
                            format!("Unable to stop Pi RPC: {error}"),
                        )),
                        Ok(()) => Ok(child.wait().await.ok().and_then(|status| status.code())),
                    },
                },
            }
        };
        let exit_code = match exit_result {
            Ok(exit_code) => exit_code,
            Err(error) => {
                session.cleanup_managed_state();
                return Err(error);
            }
        };
        let finished = session
            .mark_finished(PiRpcSessionPhase::Exited, exit_code, None)
            .await;
        if finished {
            transport::emit_session_finished(&session).await;
            session.schedule_finished_reap();
        }
        session
            .complete_pending_with_error("Pi RPC process was stopped".to_string())
            .await;
        session.cleanup_managed_state();
        Ok(session.snapshot().await)
    }

    /// Stop all background RPC children during application shutdown. `stop`
    /// reaps each child before clearing its managed state directory.
    pub async fn cleanup_all(&self) {
        let session_ids = self
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for rpc_session_id in session_ids {
            if let Err(error) = self.stop(&rpc_session_id).await {
                warn!(
                    rpc_session_id = %rpc_session_id,
                    error = %error,
                    "failed to stop Pi RPC session during cleanup"
                );
            }
        }
    }

    async fn session(&self, rpc_session_id: &str) -> AppResult<Arc<PiRpcSession>> {
        self.sessions
            .read()
            .await
            .get(rpc_session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::coded_with_params(
                    "PI_RPC_SESSION_NOT_FOUND",
                    "Pi RPC session was not found",
                    HashMap::from([("rpcSessionId".to_string(), rpc_session_id.to_string())]),
                )
            })
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests;
