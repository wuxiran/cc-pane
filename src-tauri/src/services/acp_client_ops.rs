//! ACP **client-side** capabilities served to the agent (docs/94): the `fs/*` and
//! `terminal/*` JSON-RPC methods an agent may call once we advertise them in
//! `clientCapabilities`.
//!
//! - `fs/read_text_file` / `fs/write_text_file`: absolute paths only; `line`/`limit`
//!   windowing per spec. The agent already has full filesystem reach through its own
//!   tools, so this is about giving it *our* view (and letting the UI see the calls),
//!   not about sandboxing.
//! - `terminal/create|output|wait_for_exit|kill|release`: one subprocess per
//!   terminalId, stdout+stderr merged into a bounded buffer (`outputByteLimit`,
//!   truncated from the front on a UTF-8 boundary). Output is also pushed to the
//!   WebView as `terminal_output` events (debounced) so `{type:"terminal"}` tool-call
//!   content can render live. Every terminal is job/process-group guarded and killed
//!   on `release` or session shutdown.

use super::acp_chat_service::process::AcpProcess;
use crate::services::process_guard;
use cc_panes_core::utils::no_window_tokio_command;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{watch, Notify, RwLock};
use tokio::task::JoinSet;

pub const JSONRPC_INVALID_PARAMS: i64 = -32602;
pub const JSONRPC_INTERNAL_ERROR: i64 = -32603;
/// Hard ceiling regardless of what the agent asks for.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_EMIT_DEBOUNCE: Duration = Duration::from_millis(80);
const MAX_TERMINALS_PER_SESSION: usize = 32;

pub type RpcResult = Result<Value, Value>;

fn rpc_error(code: i64, message: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into()})
}

fn require_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, Value> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| rpc_error(JSONRPC_INVALID_PARAMS, format!("missing '{key}'")))
}

fn require_absolute_path(params: &Value) -> Result<&Path, Value> {
    let raw = require_str(params, "path")?;
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(rpc_error(
            JSONRPC_INVALID_PARAMS,
            format!("'path' must be absolute: {raw}"),
        ));
    }
    Ok(path)
}

// ---------------------------------------------------------------- fs/*

/// `fs/read_text_file` → `{ content }`. `line` is 1-based; `limit` counts lines.
pub async fn fs_read_text_file(params: &Value) -> RpcResult {
    let path = require_absolute_path(params)?;
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| rpc_error(JSONRPC_INTERNAL_ERROR, format!("read failed: {error}")))?;
    let line = params.get("line").and_then(Value::as_u64);
    let limit = params.get("limit").and_then(Value::as_u64);
    let content = window_lines(&content, line, limit);
    Ok(json!({"content": content}))
}

/// Apply the spec's `line`/`limit` window. Line numbers are 1-based; a `line`
/// past EOF yields an empty string rather than an error.
pub fn window_lines(content: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let end = match limit {
        Some(limit) => (start + limit as usize).min(lines.len()),
        None => lines.len(),
    };
    if start >= lines.len() {
        return String::new();
    }
    lines[start..end].concat()
}

/// `fs/write_text_file` → `null`. Creates parent directories; overwrites atomically
/// enough for our purposes (write to temp + rename) so a crash never leaves a
/// half-written file the agent then reads back.
pub async fn fs_write_text_file(params: &Value) -> RpcResult {
    let path = require_absolute_path(params)?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_error(JSONRPC_INVALID_PARAMS, "missing 'content'"))?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| rpc_error(JSONRPC_INTERNAL_ERROR, format!("mkdir failed: {error}")))?;
    }
    let tmp = path.with_extension(format!(
        "{}.ccpanes-tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("txt")
    ));
    {
        let mut file = tokio::fs::File::create(&tmp).await.map_err(|error| {
            rpc_error(JSONRPC_INTERNAL_ERROR, format!("create failed: {error}"))
        })?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|error| rpc_error(JSONRPC_INTERNAL_ERROR, format!("write failed: {error}")))?;
        file.flush()
            .await
            .map_err(|error| rpc_error(JSONRPC_INTERNAL_ERROR, format!("flush failed: {error}")))?;
    }
    if let Err(error) = tokio::fs::rename(&tmp, path).await {
        // Windows: rename over an open/readonly target can fail; fall back to a plain write.
        let _ = tokio::fs::remove_file(&tmp).await;
        tokio::fs::write(path, content)
            .await
            .map_err(|write_error| {
                rpc_error(
                    JSONRPC_INTERNAL_ERROR,
                    format!("write failed: {write_error} (rename: {error})"),
                )
            })?;
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------- terminal/*

#[derive(Debug, Clone, Default)]
pub struct TerminalOutputState {
    pub output: Vec<u8>,
    pub truncated: bool,
    /// `Some` once the process exited: `{exitCode?, signal?}` in ACP shape.
    pub exit_status: Option<Value>,
}

impl TerminalOutputState {
    fn push(&mut self, chunk: &[u8], limit: usize) {
        self.output.extend_from_slice(chunk);
        if self.output.len() > limit {
            let cut = self.output.len() - limit;
            // 从前面截断，且停在 UTF-8 字符边界上，避免首字符是半个多字节序列。
            let mut boundary = cut;
            while boundary < self.output.len()
                && (self.output[boundary] & 0b1100_0000) == 0b1000_0000
            {
                boundary += 1;
            }
            self.output.drain(..boundary);
            self.truncated = true;
        }
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "output": String::from_utf8_lossy(&self.output),
            "truncated": self.truncated,
        });
        if let Some(exit) = &self.exit_status {
            value["exitStatus"] = exit.clone();
        }
        value
    }
}

pub struct AcpTerminal {
    pub terminal_id: String,
    state: RwLock<TerminalOutputState>,
    process: AcpProcess,
    exited: watch::Sender<Option<Value>>,
    dirty: Notify,
    released: AtomicBool,
}

impl AcpTerminal {
    pub async fn output_json(&self) -> Value {
        self.state.read().await.to_json()
    }

    async fn wait_for_exit(&self) -> Value {
        let mut exited = self.exited.subscribe();
        loop {
            if let Some(exit) = exited.borrow_and_update().clone() {
                return exit;
            }
            if exited.changed().await.is_err() {
                return json!({"signal": "terminal monitor stopped"});
            }
        }
    }

    async fn kill(&self) {
        self.process.request_kill();
        // Exit is published only after output readers have drained their pipes.
        self.wait_for_exit().await;
    }
}

/// Emits `terminal_output` events for a session. Boxed so the manager stays free of the
/// session type (the session module owns the WebView emit plumbing).
pub type TerminalEmitter = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
pub struct AcpTerminalManager {
    terminals: RwLock<TerminalRegistry>,
}

#[derive(Default)]
struct TerminalRegistry {
    closed: bool,
    entries: HashMap<String, Arc<AcpTerminal>>,
}

impl AcpTerminalManager {
    /// `terminal/create` → `{ terminalId }`. Spawns immediately; output collection and
    /// exit tracking run in background tasks.
    pub async fn create(
        &self,
        params: &Value,
        session_cwd: &Path,
        emitter: TerminalEmitter,
    ) -> RpcResult {
        let program = require_str(params, "command")?;
        let args: Vec<String> = params
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(Path::new)
            .unwrap_or(session_cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(rpc_error(
                JSONRPC_INVALID_PARAMS,
                format!(
                    "'cwd' must be an existing absolute directory: {}",
                    cwd.display()
                ),
            ));
        }
        let limit = params
            .get("outputByteLimit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_OUTPUT_BYTES)
            .min(MAX_OUTPUT_BYTES);

        let mut command = no_window_tokio_command(program);
        command
            .args(&args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(env) = params.get("env").and_then(Value::as_array) {
            for entry in env {
                if let (Some(name), Some(value)) = (
                    entry.get("name").and_then(Value::as_str),
                    entry.get("value").and_then(Value::as_str),
                ) {
                    command.env(name, value);
                }
            }
        }
        // Serialize spawn/registration with shutdown. Once closed, queued
        // terminal/create requests must not bring commands back to life.
        let mut registry = self.terminals.write().await;
        if registry.closed {
            return Err(rpc_error(JSONRPC_INTERNAL_ERROR, "ACP session is closed"));
        }
        if registry.entries.len() >= MAX_TERMINALS_PER_SESSION {
            return Err(rpc_error(
                JSONRPC_INTERNAL_ERROR,
                "too many live terminals; release some first",
            ));
        }
        process_guard::configure_command(command.as_std_mut());
        let mut child = command.spawn().map_err(|error| {
            rpc_error(
                JSONRPC_INTERNAL_ERROR,
                format!("failed to spawn '{program}': {error}"),
            )
        })?;
        let guard = match super::acp_chat_service::attach_guard(&child) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill().await;
                return Err(rpc_error(JSONRPC_INTERNAL_ERROR, error.to_string()));
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let terminal_id = format!("term-{}", uuid::Uuid::new_v4().simple());
        let terminal = Arc::new(AcpTerminal {
            terminal_id: terminal_id.clone(),
            state: RwLock::new(TerminalOutputState::default()),
            process: AcpProcess::new(child, guard),
            exited: watch::channel(None).0,
            dirty: Notify::new(),
            released: AtomicBool::new(false),
        });
        registry
            .entries
            .insert(terminal_id.clone(), terminal.clone());
        drop(registry);
        let mut readers = JoinSet::new();

        // stdout / stderr → 合并进有界缓冲；每块标脏，flusher 去抖后 emit。
        if let Some(mut stdout) = stdout {
            let owner = terminal.clone();
            readers.spawn(async move {
                let mut buffer = [0u8; 8192];
                while let Ok(read) = stdout.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    owner.state.write().await.push(&buffer[..read], limit);
                    owner.dirty.notify_one();
                }
            });
        }
        if let Some(mut stderr) = stderr {
            let owner = terminal.clone();
            readers.spawn(async move {
                let mut buffer = [0u8; 8192];
                while let Ok(read) = stderr.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    owner.state.write().await.push(&buffer[..read], limit);
                    owner.dirty.notify_one();
                }
            });
        }
        // Keep the process cancellable while waiting. Drain both pipes before
        // publishing exit, rather than guessing how much 30ms can read.
        {
            let owner = terminal.clone();
            tokio::spawn(async move {
                let exit = match owner.process.wait().await {
                    Ok(status) => exit_status_json(status),
                    Err(error) => json!({"signal": format!("wait failed: {error}")}),
                };
                // Normal descendants are already stopped by AcpProcess. Bound
                // cleanup if a detached process escaped the group but kept a pipe.
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    while readers.join_next().await.is_some() {}
                })
                .await;
                readers.shutdown().await;
                owner.state.write().await.exit_status = Some(exit.clone());
                owner.exited.send_replace(Some(exit));
                owner.dirty.notify_one();
            });
        }
        // 去抖 emitter：直到退出且最后一次 flush 完成。
        {
            let owner = terminal.clone();
            tokio::spawn(async move {
                loop {
                    owner.dirty.notified().await;
                    tokio::time::sleep(OUTPUT_EMIT_DEBOUNCE).await;
                    let mut payload = owner.output_json().await;
                    payload["terminalId"] = json!(owner.terminal_id);
                    let done = payload.get("exitStatus").is_some();
                    if !owner.released.load(Ordering::Acquire) {
                        emitter(payload);
                    }
                    if done {
                        break;
                    }
                }
            });
        }
        Ok(json!({"terminalId": terminal_id}))
    }

    async fn get(&self, params: &Value) -> Result<Arc<AcpTerminal>, Value> {
        let id = require_str(params, "terminalId")?;
        self.terminals
            .read()
            .await
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| rpc_error(JSONRPC_INVALID_PARAMS, format!("unknown terminalId '{id}'")))
    }

    /// `terminal/output` → `{ output, truncated, exitStatus? }`.
    pub async fn output(&self, params: &Value) -> RpcResult {
        Ok(self.get(params).await?.output_json().await)
    }

    /// `terminal/wait_for_exit` → `{ exitCode?, signal? }` (blocks until exit).
    pub async fn wait_for_exit(&self, params: &Value) -> RpcResult {
        Ok(self.get(params).await?.wait_for_exit().await)
    }

    /// `terminal/kill` → `null`. The terminal stays readable until `release`.
    pub async fn kill(&self, params: &Value) -> RpcResult {
        self.get(params).await?.kill().await;
        Ok(Value::Null)
    }

    /// `terminal/release` → `null`. Kills if still running and forgets the id.
    pub async fn release(&self, params: &Value) -> RpcResult {
        let id = require_str(params, "terminalId")?;
        let removed = self.terminals.write().await.entries.remove(id);
        match removed {
            Some(terminal) => {
                terminal.released.store(true, Ordering::Release);
                terminal.kill().await;
                Ok(Value::Null)
            }
            None => Err(rpc_error(
                JSONRPC_INVALID_PARAMS,
                format!("unknown terminalId '{id}'"),
            )),
        }
    }

    /// Session shutdown: kill everything still alive.
    pub async fn release_all(&self) {
        let drained = {
            let mut registry = self.terminals.write().await;
            registry.closed = true;
            registry.entries.drain().map(|(_, t)| t).collect::<Vec<_>>()
        };
        // Signal every process first; output draining then runs concurrently.
        for terminal in &drained {
            terminal.released.store(true, Ordering::Release);
            terminal.process.request_kill();
        }
        for terminal in drained {
            terminal.wait_for_exit().await;
        }
    }
}

fn exit_status_json(status: std::process::ExitStatus) -> Value {
    let mut value = json!({});
    if let Some(code) = status.code() {
        value["exitCode"] = json!(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            value["signal"] = json!(signal_name(signal));
        }
    }
    value
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        2 => "SIGINT".to_string(),
        9 => "SIGKILL".to_string(),
        15 => "SIGTERM".to_string(),
        other => format!("SIG{other}"),
    }
}

#[cfg(test)]
#[path = "acp_client_ops_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_lines_is_one_based_and_clamps() {
        let text = "a\nb\nc\nd\n";
        assert_eq!(window_lines(text, None, None), text);
        assert_eq!(window_lines(text, Some(2), Some(2)), "b\nc\n");
        assert_eq!(window_lines(text, Some(4), None), "d\n");
        assert_eq!(window_lines(text, Some(9), Some(1)), "");
        assert_eq!(window_lines(text, None, Some(1)), "a\n");
        assert_eq!(
            window_lines(text, Some(0), Some(1)),
            "a\n",
            "line 0 treated as 1"
        );
    }

    #[test]
    fn output_buffer_truncates_from_front_on_utf8_boundary() {
        let mut state = TerminalOutputState::default();
        state.push("héllo".as_bytes(), 5);
        // "héllo" 是 6 字节；上限 5 → 砍 1 字节正好落在 'é' 的首字节前，边界合法
        assert!(state.truncated);
        assert_eq!(String::from_utf8(state.output.clone()).unwrap(), "éllo");
        // 再进 1 字节 → 又要砍 1 字节，这次会落在 'é' 中间，必须继续砍到边界
        state.push(b"!", 5);
        assert_eq!(String::from_utf8(state.output.clone()).unwrap(), "llo!");
    }

    #[tokio::test]
    async fn fs_read_and_write_round_trip_with_windowing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("note.txt");
        let path_str = path.to_string_lossy().to_string();
        fs_write_text_file(
            &json!({"sessionId": "s", "path": path_str, "content": "one\ntwo\nthree\n"}),
        )
        .await
        .unwrap();
        let full = fs_read_text_file(&json!({"sessionId": "s", "path": path_str}))
            .await
            .unwrap();
        assert_eq!(full["content"], "one\ntwo\nthree\n");
        let window =
            fs_read_text_file(&json!({"sessionId": "s", "path": path_str, "line": 2, "limit": 1}))
                .await
                .unwrap();
        assert_eq!(window["content"], "two\n");
        // 覆盖写：临时文件不残留
        fs_write_text_file(&json!({"sessionId": "s", "path": path_str, "content": "x"}))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        // 相对路径拒绝
        let err = fs_read_text_file(&json!({"path": "relative.txt"}))
            .await
            .unwrap_err();
        assert_eq!(err["code"], JSONRPC_INVALID_PARAMS);
    }

    #[tokio::test]
    async fn terminal_lifecycle_captures_output_and_exit() {
        let manager = AcpTerminalManager::default();
        let emitted = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = emitted.clone();
        let emitter: TerminalEmitter = Arc::new(move |payload| sink.lock().unwrap().push(payload));
        let cwd = std::env::temp_dir();
        #[cfg(windows)]
        let params = json!({"sessionId": "s", "command": "cmd", "args": ["/C", "echo hello"], "outputByteLimit": 4096});
        #[cfg(not(windows))]
        let params = json!({"sessionId": "s", "command": "sh", "args": ["-c", "echo hello"], "outputByteLimit": 4096});

        let created = manager.create(&params, &cwd, emitter).await.unwrap();
        let terminal_id = created["terminalId"].as_str().unwrap().to_string();
        let exit = manager
            .wait_for_exit(&json!({"terminalId": terminal_id}))
            .await
            .unwrap();
        assert_eq!(exit["exitCode"], 0);
        let output = manager
            .output(&json!({"terminalId": terminal_id}))
            .await
            .unwrap();
        assert!(output["output"].as_str().unwrap().contains("hello"));
        assert_eq!(output["truncated"], false);
        assert_eq!(output["exitStatus"]["exitCode"], 0);

        // emitter 至少收到一次带 exitStatus 的最终快照
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(emitted
            .lock()
            .unwrap()
            .iter()
            .any(|p| p["terminalId"] == terminal_id && p.get("exitStatus").is_some()));

        manager
            .release(&json!({"terminalId": terminal_id}))
            .await
            .unwrap();
        let err = manager
            .output(&json!({"terminalId": terminal_id}))
            .await
            .unwrap_err();
        assert_eq!(err["code"], JSONRPC_INVALID_PARAMS);
    }
}
