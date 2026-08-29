//! ACP (Agent Client Protocol) chat transport.
//!
//! Owns adapter subprocesses (claude-agent-acp / codex-acp / grok agent stdio)
//! speaking newline-delimited JSON-RPC 2.0 over stdio. One session per chat
//! tab. This is deliberately app-process-only: no PTY, no daemon boundary —
//! the frontend renders `session/update` payloads as chat bubbles and tool
//! cards, and conversation continuity across app restarts is a later batch
//! (`session/load`).
//!
//! Prompt payloads are never logged; they may contain user code and secrets.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex, RwLock};
use tracing::{debug, warn};

use crate::services::process_guard::{self, ProcessGuard};
use crate::utils::{AppError, AppResult};
use cc_panes_core::utils::no_window_tokio_command;

pub const ACP_CHAT_EVENT: &str = "acp-chat-event";

/// ACP protocol major version this client speaks (v1 stable line).
const ACP_PROTOCOL_VERSION: u64 = 1;
/// First launch may go through `npx` package download; keep this generous.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(180);
const STDERR_TAIL_LINES: usize = 80;
/// JSON-RPC "method not found".
const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AcpChatPhase {
    Starting,
    Ready,
    Generating,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpChatSnapshot {
    /// CC-Panes chat identity (the pane tab id). Never a PTY session id.
    pub chat_id: String,
    pub engine_id: String,
    pub phase: AcpChatPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_capabilities: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Event envelope emitted to the WebView. `payload` stays close to the wire:
/// unknown ACP update variants must reach the frontend for honest degraded
/// rendering instead of being dropped here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpChatEvent {
    pub chat_id: String,
    pub kind: String,
    pub payload: Value,
}

/// Launch details resolved in Rust. Never accept an executable path from the
/// WebView; the command layer resolves a trusted engine registry entry.
#[derive(Debug, Clone)]
pub struct AcpLaunchSpec {
    pub engine_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

type PendingResult = Result<Value, Value>;

struct AcpChatSession {
    chat_id: String,
    app: AppHandle,
    snapshot: RwLock<AcpChatSnapshot>,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    /// Held for the session lifetime; dropping the Windows job handle kills
    /// the adapter tree if anything else fails to.
    _guard: Option<ProcessGuard>,
    /// Our outgoing JSON-RPC requests awaiting a response, keyed by id.
    pending: Mutex<HashMap<u64, oneshot::Sender<PendingResult>>>,
    next_request_id: AtomicU64,
    /// Incoming `session/request_permission` request ids awaiting the user.
    /// On cancel we MUST answer them all with the `cancelled` outcome.
    pending_permissions: Mutex<HashMap<String, Value>>,
    stderr_tail: Mutex<VecDeque<String>>,
}

impl AcpChatSession {
    async fn snapshot(&self) -> AcpChatSnapshot {
        self.snapshot.read().await.clone()
    }

    async fn write_line(&self, value: &Value) -> AppResult<()> {
        let mut encoded = serde_json::to_vec(value).map_err(|error| {
            AppError::coded(
                "ACP_SERIALIZE_FAILED",
                format!("Unable to encode ACP message: {error}"),
            )
        })?;
        // serde_json escapes newlines inside strings; keep the frame guard so
        // a serializer change can never break the ndjson framing.
        if encoded.contains(&b'\n') || encoded.contains(&b'\r') {
            return Err(AppError::coded(
                "ACP_INVALID_FRAME",
                "ACP message contains an unframed line delimiter",
            ));
        }
        encoded.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&encoded).await.map_err(|error| {
            AppError::coded(
                "ACP_WRITE_FAILED",
                format!("Unable to write to ACP agent: {error}"),
            )
        })?;
        stdin.flush().await.map_err(|error| {
            AppError::coded(
                "ACP_WRITE_FAILED",
                format!("Unable to flush ACP agent input: {error}"),
            )
        })
    }

    /// Send a JSON-RPC request and await its response without a deadline.
    /// Prompt turns are legitimately long-running; callers that need a
    /// deadline wrap this in `tokio::time::timeout`.
    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_line(&message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match receiver.await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(rpc_error)) => Err(AppError::coded(
                "ACP_AGENT_ERROR",
                format!(
                    "ACP agent rejected '{method}': {}",
                    rpc_error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                ),
            )),
            Err(_) => Err(AppError::coded(
                "ACP_PROCESS_EXITED",
                format!("ACP agent exited before responding to '{method}'"),
            )),
        }
    }

    async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn respond(&self, id: &Value, result: Result<Value, Value>) -> AppResult<()> {
        let message = match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        self.write_line(&message).await
    }

    async fn complete_pending_with_error(&self, message: &str) {
        let pending = {
            let mut pending = self.pending.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(json!({"message": message})));
        }
        self.pending_permissions.lock().await.clear();
    }

    /// Answer every outstanding permission request with `cancelled`, as the
    /// spec requires after `session/cancel`.
    async fn cancel_pending_permissions(&self) {
        let pending = {
            let mut pending = self.pending_permissions.lock().await;
            std::mem::take(&mut *pending)
        };
        for (_, id) in pending {
            let outcome = json!({"outcome": {"outcome": "cancelled"}});
            if let Err(error) = self.respond(&id, Ok(outcome)).await {
                debug!(chat_id = %self.chat_id, error = %error, "failed to cancel ACP permission request");
            }
        }
    }

    async fn mark_finished(
        &self,
        phase: AcpChatPhase,
        exit_code: Option<i32>,
        error: Option<String>,
    ) -> bool {
        let mut snapshot = self.snapshot.write().await;
        if matches!(snapshot.phase, AcpChatPhase::Exited | AcpChatPhase::Failed) {
            return false;
        }
        snapshot.phase = phase;
        snapshot.exit_code = exit_code;
        snapshot.error = error;
        true
    }

    async fn set_phase(&self, phase: AcpChatPhase) {
        let mut snapshot = self.snapshot.write().await;
        if matches!(snapshot.phase, AcpChatPhase::Exited | AcpChatPhase::Failed) {
            return;
        }
        snapshot.phase = phase;
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

    fn emit(&self, kind: &str, payload: Value) {
        if !crate::webview_reliability::webview_emits_allowed() {
            return;
        }
        let event = AcpChatEvent {
            chat_id: self.chat_id.clone(),
            kind: kind.to_string(),
            payload,
        };
        if let Err(error) = self.app.emit(ACP_CHAT_EVENT, &event) {
            debug!(chat_id = %self.chat_id, error = %error, "ACP chat event emit failed");
        }
    }

    async fn emit_state(&self) {
        let snapshot = self.snapshot().await;
        self.emit(
            "state",
            serde_json::to_value(&snapshot).unwrap_or(Value::Null),
        );
    }
}

/// Manages independent ACP adapter subprocesses, one per chat tab.
#[derive(Default)]
pub struct AcpChatService {
    sessions: RwLock<HashMap<String, Arc<AcpChatSession>>>,
}

impl AcpChatService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn the adapter, run the `initialize` + `session/new` handshake and
    /// return the ready snapshot. On any failure the child is torn down.
    pub async fn start(
        &self,
        app: AppHandle,
        chat_id: String,
        spec: AcpLaunchSpec,
    ) -> AppResult<AcpChatSnapshot> {
        let chat_id_trimmed = chat_id.trim();
        if chat_id_trimmed.is_empty() {
            return Err(AppError::coded(
                "ACP_CHAT_ID_REQUIRED",
                "ACP chat id cannot be empty",
            ));
        }
        // portable-pty style silent-HOME-fallback bug class: validate cwd
        // before spawning so the agent never runs in the wrong repository.
        let cwd = Path::new(&spec.cwd);
        if !cwd.is_dir() {
            return Err(AppError::coded_with_params(
                "ACP_CWD_INVALID",
                format!(
                    "ACP chat cwd does not exist or is not a directory: {}",
                    spec.cwd
                ),
                HashMap::from([("cwd".to_string(), spec.cwd.clone())]),
            ));
        }
        if self.sessions.read().await.contains_key(chat_id_trimmed) {
            // Replace semantics keep the tab as the single owner of one live
            // conversation: restarting a chat stops the previous process.
            self.stop(chat_id_trimmed).await.ok();
        }

        let mut command = no_window_tokio_command(&spec.command);
        command
            .args(&spec.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // A CC-Panes dev instance may itself run under a Claude session; these
        // block or reshape nested CLI startup.
        command.env_remove("CLAUDECODE");
        command.env_remove("CLAUDE_CODE_ENTRYPOINT");
        process_guard::configure_command(command.as_std_mut());

        let mut child = command.spawn().map_err(|error| {
            AppError::coded(
                "ACP_SPAWN_FAILED",
                format!("Unable to start ACP agent '{}': {error}", spec.engine_id),
            )
        })?;
        let guard = match attach_guard(&child) {
            Ok(guard) => guard,
            Err(error) => {
                // Fail closed like web-access: an unguarded adapter could
                // outlive the app together with the CLI tree it spawned.
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::coded("ACP_SPAWN_FAILED", "ACP agent stdin was not captured")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::coded("ACP_SPAWN_FAILED", "ACP agent stdout was not captured")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::coded("ACP_SPAWN_FAILED", "ACP agent stderr was not captured")
        })?;

        let session = Arc::new(AcpChatSession {
            chat_id: chat_id_trimmed.to_string(),
            app,
            snapshot: RwLock::new(AcpChatSnapshot {
                chat_id: chat_id_trimmed.to_string(),
                engine_id: spec.engine_id.clone(),
                phase: AcpChatPhase::Starting,
                acp_session_id: None,
                agent_capabilities: None,
                exit_code: None,
                error: None,
            }),
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            _guard: guard,
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            pending_permissions: Mutex::new(HashMap::new()),
            stderr_tail: Mutex::new(VecDeque::new()),
        });
        self.sessions
            .write()
            .await
            .insert(chat_id_trimmed.to_string(), session.clone());

        tokio::spawn(read_stdout(session.clone(), stdout));
        tokio::spawn(read_stderr(session.clone(), stderr));
        session.emit_state().await;

        match self.handshake(&session, &spec.cwd).await {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                warn!(chat_id = %chat_id_trimmed, engine = %spec.engine_id, error = %error, "ACP handshake failed");
                let stderr_tail = session.stderr_tail().await;
                let detail = if stderr_tail.trim().is_empty() {
                    error.to_string()
                } else {
                    format!("{error}\n{stderr_tail}")
                };
                self.teardown(&session, AcpChatPhase::Failed, Some(detail.clone()))
                    .await;
                Err(AppError::coded("ACP_HANDSHAKE_FAILED", detail))
            }
        }
    }

    async fn handshake(
        &self,
        session: &Arc<AcpChatSession>,
        cwd: &str,
    ) -> AppResult<AcpChatSnapshot> {
        let initialize = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session.request(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                        "terminal": false,
                    },
                }),
            ),
        )
        .await
        .map_err(|_| AppError::coded("ACP_HANDSHAKE_TIMEOUT", "ACP initialize timed out"))??;

        {
            let mut snapshot = session.snapshot.write().await;
            snapshot.agent_capabilities = initialize.get("agentCapabilities").cloned();
        }

        let new_session = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session.request("session/new", json!({"cwd": cwd, "mcpServers": []})),
        )
        .await
        .map_err(|_| AppError::coded("ACP_HANDSHAKE_TIMEOUT", "ACP session/new timed out"))??;

        let acp_session_id = new_session
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::coded(
                    "ACP_HANDSHAKE_FAILED",
                    "ACP session/new returned no sessionId",
                )
            })?;

        {
            let mut snapshot = session.snapshot.write().await;
            snapshot.acp_session_id = Some(acp_session_id);
            snapshot.phase = AcpChatPhase::Ready;
        }
        session.emit_state().await;
        Ok(session.snapshot().await)
    }

    /// Submit a prompt. Returns immediately; the turn streams through
    /// `session/update` events and finishes with a `turn_ended` event.
    pub async fn prompt(&self, chat_id: &str, message: String) -> AppResult<()> {
        if message.trim().is_empty() {
            return Err(AppError::coded(
                "ACP_PROMPT_REQUIRED",
                "ACP prompt cannot be empty",
            ));
        }
        let session = self.session(chat_id).await?;
        let (phase, acp_session_id) = {
            let snapshot = session.snapshot.read().await;
            (snapshot.phase, snapshot.acp_session_id.clone())
        };
        let acp_session_id = acp_session_id.ok_or_else(|| {
            AppError::coded(
                "ACP_SESSION_NOT_READY",
                "ACP session has not finished starting",
            )
        })?;
        match phase {
            AcpChatPhase::Ready => {}
            AcpChatPhase::Generating => {
                return Err(AppError::coded(
                    "ACP_TURN_IN_PROGRESS",
                    "ACP agent is still working on the previous message",
                ));
            }
            _ => {
                return Err(AppError::coded(
                    "ACP_SESSION_NOT_READY",
                    "ACP session is not ready for prompts",
                ));
            }
        }

        session.set_phase(AcpChatPhase::Generating).await;
        session.emit_state().await;

        let turn_session = session.clone();
        tokio::spawn(async move {
            let result = turn_session
                .request(
                    "session/prompt",
                    json!({
                        "sessionId": acp_session_id,
                        "prompt": [{"type": "text", "text": message}],
                    }),
                )
                .await;
            match result {
                Ok(response) => {
                    let stop_reason = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn")
                        .to_string();
                    turn_session.set_phase(AcpChatPhase::Ready).await;
                    turn_session.emit("turn_ended", json!({"stopReason": stop_reason}));
                    turn_session.emit_state().await;
                }
                Err(error) => {
                    // Process-exit already emitted a terminal state; only a
                    // protocol-level rejection needs surfacing here.
                    turn_session.set_phase(AcpChatPhase::Ready).await;
                    turn_session.emit(
                        "turn_ended",
                        json!({"stopReason": "error", "error": error.to_string()}),
                    );
                    turn_session.emit_state().await;
                }
            }
        });
        Ok(())
    }

    /// Cancel the in-flight turn. The agent responds to the outstanding
    /// `session/prompt` with `cancelled`, which ends the turn on our side.
    pub async fn cancel(&self, chat_id: &str) -> AppResult<()> {
        let session = self.session(chat_id).await?;
        let acp_session_id = session
            .snapshot
            .read()
            .await
            .acp_session_id
            .clone()
            .ok_or_else(|| {
                AppError::coded(
                    "ACP_SESSION_NOT_READY",
                    "ACP session has not finished starting",
                )
            })?;
        session.cancel_pending_permissions().await;
        session
            .notify("session/cancel", json!({"sessionId": acp_session_id}))
            .await
    }

    /// Relay the user's decision for a `session/request_permission` request.
    pub async fn respond_permission(
        &self,
        chat_id: &str,
        request_key: String,
        option_id: Option<String>,
    ) -> AppResult<()> {
        let session = self.session(chat_id).await?;
        let id = session
            .pending_permissions
            .lock()
            .await
            .remove(&request_key)
            .ok_or_else(|| {
                AppError::coded(
                    "ACP_PERMISSION_NOT_PENDING",
                    "ACP permission request is no longer pending",
                )
            })?;
        let outcome = match option_id {
            Some(option_id) => json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
            None => json!({"outcome": {"outcome": "cancelled"}}),
        };
        session.respond(&id, Ok(outcome)).await
    }

    pub async fn snapshot(&self, chat_id: &str) -> Option<AcpChatSnapshot> {
        let session = self.sessions.read().await.get(chat_id.trim()).cloned()?;
        Some(session.snapshot().await)
    }

    /// Stop the adapter process and forget the chat. Used by tab close and by
    /// explicit conversation restarts.
    pub async fn stop(&self, chat_id: &str) -> AppResult<()> {
        let session = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(chat_id.trim())
        };
        let Some(session) = session else {
            return Ok(());
        };
        self.teardown(&session, AcpChatPhase::Exited, None).await;
        Ok(())
    }

    async fn teardown(
        &self,
        session: &Arc<AcpChatSession>,
        phase: AcpChatPhase,
        error: Option<String>,
    ) {
        let exit_code = {
            let mut child_guard = session.child.lock().await;
            match child_guard.as_mut() {
                None => None,
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => status.code(),
                    _ => {
                        let _ = child.kill().await;
                        child.wait().await.ok().and_then(|status| status.code())
                    }
                },
            }
        };
        if session.mark_finished(phase, exit_code, error).await {
            session.emit_state().await;
        }
        session
            .complete_pending_with_error("ACP chat session was stopped")
            .await;
        // Drop the map entry if it still points at this session (start() may
        // have already replaced it).
        let mut sessions = self.sessions.write().await;
        if sessions
            .get(&session.chat_id)
            .is_some_and(|existing| Arc::ptr_eq(existing, session))
        {
            sessions.remove(&session.chat_id);
        }
    }

    /// Stop every adapter during application shutdown.
    pub async fn cleanup_all(&self) {
        let chat_ids = self
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for chat_id in chat_ids {
            if let Err(error) = self.stop(&chat_id).await {
                warn!(chat_id = %chat_id, error = %error, "failed to stop ACP chat during cleanup");
            }
        }
    }

    async fn session(&self, chat_id: &str) -> AppResult<Arc<AcpChatSession>> {
        self.sessions
            .read()
            .await
            .get(chat_id.trim())
            .cloned()
            .ok_or_else(|| {
                AppError::coded_with_params(
                    "ACP_SESSION_NOT_FOUND",
                    "ACP chat session was not found",
                    HashMap::from([("chatId".to_string(), chat_id.to_string())]),
                )
            })
    }
}

fn attach_guard(child: &Child) -> AppResult<Option<ProcessGuard>> {
    #[cfg(windows)]
    {
        let Some(handle) = child.raw_handle() else {
            return Err(AppError::coded(
                "ACP_GUARD_FAILED",
                "ACP agent process handle was unavailable for the job guard",
            ));
        };
        ProcessGuard::attach_raw_handle(handle).map(Some)
    }
    #[cfg(unix)]
    {
        let Some(pid) = child.id() else {
            return Err(AppError::coded(
                "ACP_GUARD_FAILED",
                "ACP agent pid was unavailable for the process-group guard",
            ));
        };
        ProcessGuard::attach_pid(pid as i32).map(Some)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child;
        Ok(None)
    }
}

async fn read_stdout(session: Arc<AcpChatSession>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut record = Vec::new();
    loop {
        record.clear();
        match reader.read_until(b'\n', &mut record).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = trim_record_ending(&record);
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<Value>(trimmed) {
                    Ok(message) => route_message(&session, message).await,
                    Err(error) => {
                        // Adapters occasionally write banners to stdout.
                        // Surface it without logging the raw payload.
                        session.emit("protocol_noise", json!({"error": error.to_string()}));
                    }
                }
            }
            Err(error) => {
                finish_after_stdout_closed(
                    session,
                    Some(format!("Failed to read ACP output: {error}")),
                )
                .await;
                return;
            }
        }
    }
    finish_after_stdout_closed(session, None).await;
}

async fn route_message(session: &Arc<AcpChatSession>, message: Value) {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id");
    match (method, id) {
        // Incoming request from the agent.
        (Some(method), Some(id)) => {
            let id = id.clone();
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if method == "session/request_permission" {
                let request_key = permission_request_key(&id);
                session
                    .pending_permissions
                    .lock()
                    .await
                    .insert(request_key.clone(), id);
                session.emit(
                    "permission_request",
                    json!({"requestKey": request_key, "params": params}),
                );
            } else {
                // fs/* and terminal/* are disabled in our clientCapabilities;
                // anything landing here is out of contract.
                let error = json!({
                    "code": JSONRPC_METHOD_NOT_FOUND,
                    "message": format!("CC-Panes does not support '{method}'"),
                });
                if let Err(write_error) = session.respond(&id, Err(error)).await {
                    debug!(chat_id = %session.chat_id, error = %write_error, "failed to reject ACP request");
                }
            }
        }
        // Notification from the agent.
        (Some(method), None) => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if method == "session/update" {
                session.emit("update", params);
            } else {
                // Unknown notifications stay visible for protocol drift.
                session.emit("notification", json!({"method": method, "params": params}));
            }
        }
        // Response to one of our requests.
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return;
            };
            let sender = session.pending.lock().await.remove(&id);
            if let Some(sender) = sender {
                let result = match message.get("error") {
                    Some(error) if !error.is_null() => Err(error.clone()),
                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(result);
            }
        }
        (None, None) => {
            session.emit(
                "protocol_noise",
                json!({"error": "ACP message had neither method nor id"}),
            );
        }
    }
}

fn permission_request_key(id: &Value) -> String {
    match id {
        Value::Number(number) => format!("n{number}"),
        Value::String(text) => format!("s{text}"),
        other => format!("v{other}"),
    }
}

async fn finish_after_stdout_closed(session: Arc<AcpChatSession>, stdout_error: Option<String>) {
    let exit_code = {
        let mut child_guard = session.child.lock().await;
        match child_guard.as_mut() {
            None => None,
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => status.code(),
                _ => {
                    let _ = child.kill().await;
                    child.wait().await.ok().and_then(|status| status.code())
                }
            },
        }
    };
    let stderr_tail = session.stderr_tail().await;
    let error = if let Some(stdout_error) = stdout_error {
        Some(stdout_error)
    } else if exit_code.is_some_and(|code| code != 0) {
        if stderr_tail.trim().is_empty() {
            Some(format!(
                "ACP agent exited with code {}",
                exit_code.unwrap_or(-1)
            ))
        } else {
            Some(format!(
                "ACP agent exited with code {}:\n{stderr_tail}",
                exit_code.unwrap_or(-1)
            ))
        }
    } else {
        None
    };
    let phase = if error.is_some() {
        AcpChatPhase::Failed
    } else {
        AcpChatPhase::Exited
    };
    if session.mark_finished(phase, exit_code, error.clone()).await {
        session.emit_state().await;
    }
    session
        .complete_pending_with_error(&error.unwrap_or_else(|| "ACP agent exited".to_string()))
        .await;
}

async fn read_stderr(session: Arc<AcpChatSession>, stderr: ChildStderr) {
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
                debug!(error = %error, "ACP stderr reader stopped");
                return;
            }
        }
    }
}

fn trim_record_ending(record: &[u8]) -> &[u8] {
    let record = record.strip_suffix(b"\n").unwrap_or(record);
    record.strip_suffix(b"\r").unwrap_or(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_request_keys_distinguish_id_types() {
        assert_eq!(permission_request_key(&json!(7)), "n7");
        assert_eq!(permission_request_key(&json!("7")), "s7");
        assert_ne!(
            permission_request_key(&json!(7)),
            permission_request_key(&json!("7"))
        );
    }

    #[test]
    fn trim_record_ending_strips_crlf() {
        assert_eq!(trim_record_ending(b"{}\r\n"), b"{}");
        assert_eq!(trim_record_ending(b"{}\n"), b"{}");
        assert_eq!(trim_record_ending(b"{}"), b"{}");
    }
}
