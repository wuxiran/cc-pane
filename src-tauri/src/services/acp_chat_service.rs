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
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    /// initialize 协商出的协议版本。现在只记录不分叉——v2 stabilize 且适配器
    /// 跟进后，双版本surface的选择依据就是它（v2 迁移指南要求按连接协商）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u64>,
    /// ACP SessionModeState（currentModeId + availableModes），引擎不支持时缺失。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    /// ACP SessionModelState（currentModelId + availableModels），引擎不支持时缺失。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    /// 当前自动放行的 ACP ToolKind 集合（`*` = 全部）。前端重挂载时据此
    /// 还原权限下拉的勾选态。
    #[serde(default)]
    pub auto_approve_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 通配：自动放行所有权限请求（Automations 无人值守 / 用户显式 YOLO）。
pub const AUTO_APPROVE_ALL: &str = "*";

/// 权限请求是否命中自动放行策略。`kinds` 是 ACP ToolKind 集合（read /
/// edit / execute / fetch …）；请求未带 kind 时归入 `other`——适配器省略
/// kind 的多半是自定义/MCP 工具，用户勾了「其他」才放。
pub fn auto_approves(kinds: &[String], tool_kind: Option<&str>) -> bool {
    if kinds.is_empty() {
        return false;
    }
    if kinds.iter().any(|kind| kind == AUTO_APPROVE_ALL) {
        return true;
    }
    let effective = tool_kind.filter(|kind| !kind.is_empty()).unwrap_or("other");
    kinds.iter().any(|kind| kind == effective)
}

/// 权限请求未带 kind 时按标题前缀推断（实测 Kimi CLI 的 ACP 全程不发 kind，
/// 标题形如 `Shell: echo hi` / `WriteFile: a.txt` / `StrReplaceFile: b.rs`）。
/// 只认冒号前的首个词，白名单外返回 None（→ other），不做模糊猜测。
pub fn infer_tool_kind_from_title(title: &str) -> Option<&'static str> {
    let head = title
        .split([':', ' ', '`'])
        .next()?
        .trim()
        .to_ascii_lowercase();
    match head.as_str() {
        "shell" | "bash" | "terminal" | "powershell" | "run_terminal_command" => Some("execute"),
        "writefile" | "write" | "strreplacefile" | "edit" | "search_replace" | "apply_patch"
        | "patch" | "notebookedit" => Some("edit"),
        "readfile" | "readmediafile" | "read" | "read_file" => Some("read"),
        "grep" | "glob" | "list_dir" | "search" => Some("search"),
        "fetchurl" | "webfetch" | "web_fetch" | "fetch" | "searchweb" | "websearch" => {
            Some("fetch")
        }
        _ => None,
    }
}

/// 自动放行时选哪个选项。`wildcard`（Automations / 全部放行）= 必须推进：第一
/// 个 allow，没有 allow 就取第一个。按类放行则保守：只在恰好一个 `allow_once`
/// 时选它——Cursor 的 AskQuestion、Codex 的沙箱权限档都是 N 个 allow_once 并列，
/// 那是「让用户选」而不是「同意/拒绝」，自动挑第一个等于替用户乱答。
pub fn pick_auto_approve_option(options: &[Value], wildcard: bool) -> Option<Value> {
    fn kind_of(option: &Value) -> &str {
        option.get("kind").and_then(Value::as_str).unwrap_or("")
    }
    let allow_once: Vec<&Value> = options
        .iter()
        .filter(|option| kind_of(option) == "allow_once")
        .collect();
    let any_allow: Vec<&Value> = options
        .iter()
        .filter(|option| kind_of(option).starts_with("allow"))
        .collect();
    let chosen = if wildcard {
        any_allow.first().copied().or_else(|| options.first())
    } else if allow_once.len() == 1 {
        allow_once.first().copied()
    } else if allow_once.is_empty() && any_allow.len() == 1 {
        any_allow.first().copied()
    } else {
        None
    };
    chosen.and_then(|option| option.get("optionId")).cloned()
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
    /// ACP McpServer entries (http variants are filtered out when the agent
    /// does not advertise `mcpCapabilities.http`). Built in Rust — the WebView
    /// never supplies MCP endpoints or tokens.
    pub mcp_servers: Vec<Value>,
    /// Resume an existing ACP conversation via `session/load` when the agent
    /// advertises `loadSession`. Falls back to a fresh session otherwise.
    pub resume_acp_session_id: Option<String>,
    /// 自动放行的 ACP ToolKind 集合：命中的 `session/request_permission` 自动
    /// 选第一个 allow 选项，不弹审批卡。`*` = 全部（Automations 的 headless
    /// 会话）；交互式 chat 由用户在权限下拉里按类勾选，空 = 每次都问。
    pub auto_approve_kinds: Vec<String>,
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
    /// 自动放行策略（ToolKind 集合，`*` = 全部）。会话中可改，读写都在
    /// 微秒级临界区里，用同步锁即可。
    auto_approve_kinds: std::sync::RwLock<Vec<String>>,
    /// toolCallId → kind，从 `tool_call` / `tool_call_update` 流里记下来，供
    /// 权限请求自身不带 kind 时回查（有界，满了整体清空）。
    tool_kinds: std::sync::Mutex<HashMap<String, String>>,
    /// 历史 meta 目录（`session_info_update` 的 agent 标题要写回去）。
    chats_dir: PathBuf,
    /// 回合结束/失败的外部通知钩子（服务级共享，lib.rs 注入桌面通知）。
    turn_notifier: Arc<std::sync::RwLock<Option<AcpTurnNotifier>>>,
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
/// 回合结束/失败通知钩子。`detail`：成功 = stopReason，失败 = 错误文本。
pub struct AcpTurnNotice {
    pub chat_id: String,
    pub engine_id: String,
    pub detail: String,
    pub is_error: bool,
}

pub type AcpTurnNotifier = Box<dyn Fn(AcpTurnNotice) + Send + Sync>;

pub struct AcpChatService {
    sessions: RwLock<HashMap<String, Arc<AcpChatSession>>>,
    /// 会话历史元数据目录（`<data>/agent-chats/`）。按 **acpSessionId** 落
    /// 一个 JSON——那才是稳定的对话身份；chatId 是 tab 的运行时身份，
    /// 同一对话可以被不同 tab 先后续接（docs/69 的 id 语义教训）。
    chats_dir: PathBuf,
    turn_notifier: Arc<std::sync::RwLock<Option<AcpTurnNotifier>>>,
}

impl AcpChatService {
    pub fn new(chats_dir: PathBuf) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            chats_dir,
            turn_notifier: Arc::new(std::sync::RwLock::new(None)),
        }
    }

    /// 注入桌面通知钩子（setup 阶段一次）。Automations 的 headless 会话
    /// （chatId 以 `auto-` 开头）不打扰——结果进运行历史。
    pub fn set_turn_notifier(&self, notifier: AcpTurnNotifier) {
        *self
            .turn_notifier
            .write()
            .unwrap_or_else(|p| p.into_inner()) = Some(notifier);
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
                protocol_version: None,
                modes: None,
                models: None,
                auto_approve_kinds: spec.auto_approve_kinds.clone(),
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
            auto_approve_kinds: std::sync::RwLock::new(spec.auto_approve_kinds.clone()),
            tool_kinds: std::sync::Mutex::new(HashMap::new()),
            chats_dir: self.chats_dir.clone(),
            turn_notifier: self.turn_notifier.clone(),
        });
        self.sessions
            .write()
            .await
            .insert(chat_id_trimmed.to_string(), session.clone());

        tokio::spawn(read_stdout(session.clone(), stdout));
        tokio::spawn(read_stderr(session.clone(), stderr));
        session.emit_state().await;

        match self.handshake(&session, &spec).await {
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
        spec: &AcpLaunchSpec,
    ) -> AppResult<AcpChatSnapshot> {
        let cwd = spec.cwd.as_str();
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

        let capabilities = initialize.get("agentCapabilities").cloned();
        {
            let mut snapshot = session.snapshot.write().await;
            snapshot.agent_capabilities = capabilities.clone();
            snapshot.protocol_version = initialize.get("protocolVersion").and_then(Value::as_u64);
        }
        let capability = |path: &[&str]| -> bool {
            let mut node = capabilities.as_ref();
            for key in path {
                node = node.and_then(|value| value.get(key));
            }
            node.and_then(Value::as_bool).unwrap_or(false)
        };

        // http 形态的 MCP 服务器要求 agent 广告 mcpCapabilities.http，
        // 不支持的引擎直接过滤掉——传了会被拒或静默失败。
        let mcp_servers: Vec<Value> = spec
            .mcp_servers
            .iter()
            .filter(|server| {
                match server.get("type").and_then(Value::as_str) {
                    Some("http") => capability(&["mcpCapabilities", "http"]),
                    Some("sse") => capability(&["mcpCapabilities", "sse"]),
                    // stdio 是基线能力
                    _ => true,
                }
            })
            .cloned()
            .collect();

        // 优先续接：agent 广告 loadSession 且调用方带了会话 id。失败则降级
        // 新会话（旧会话可能已被 agent 侧清理），降级必须对用户可见。
        let mut resumed_session_id: Option<String> = None;
        let mut session_response: Option<Value> = None;
        if let Some(resume_id) = spec
            .resume_acp_session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if capability(&["loadSession"]) {
                let load = tokio::time::timeout(
                    HANDSHAKE_TIMEOUT,
                    session.request(
                        "session/load",
                        json!({
                            "sessionId": resume_id,
                            "cwd": cwd,
                            "mcpServers": mcp_servers,
                        }),
                    ),
                )
                .await
                .map_err(|_| {
                    AppError::coded("ACP_HANDSHAKE_TIMEOUT", "ACP session/load timed out")
                })?;
                match load {
                    Ok(response) => {
                        resumed_session_id = Some(resume_id.to_string());
                        session_response = Some(response);
                    }
                    Err(error) => {
                        warn!(chat_id = %session.chat_id, error = %error, "ACP session/load failed; starting a fresh session");
                        session.emit(
                            "notification",
                            json!({
                                "method": "ccpanes/load-failed",
                                "params": {"error": error.to_string()},
                            }),
                        );
                    }
                }
            } else {
                session.emit(
                    "notification",
                    json!({
                        "method": "ccpanes/load-unsupported",
                        "params": {"engineId": spec.engine_id},
                    }),
                );
            }
        }

        let (acp_session_id, response) = if let (Some(id), Some(response)) =
            (resumed_session_id, session_response)
        {
            (id, response)
        } else {
            let new_session = tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                session.request(
                    "session/new",
                    json!({"cwd": cwd, "mcpServers": mcp_servers}),
                ),
            )
            .await
            .map_err(|_| AppError::coded("ACP_HANDSHAKE_TIMEOUT", "ACP session/new timed out"))??;
            let id = new_session
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
            (id, new_session)
        };

        {
            let mut snapshot = session.snapshot.write().await;
            snapshot.acp_session_id = Some(acp_session_id.clone());
            snapshot.modes = response.get("modes").filter(|v| !v.is_null()).cloned();
            snapshot.models = response.get("models").filter(|v| !v.is_null()).cloned();
            snapshot.phase = AcpChatPhase::Ready;
        }
        self.write_chat_meta(&acp_session_id, &spec.engine_id, cwd, None);
        session.emit_state().await;
        Ok(session.snapshot().await)
    }

    /// Submit a prompt as ACP ContentBlock array (text / image / resource_link).
    /// Returns immediately; the turn streams through `session/update` events
    /// and finishes with a `turn_ended` event.
    pub async fn prompt(&self, chat_id: &str, blocks: Vec<Value>) -> AppResult<()> {
        if blocks.is_empty() {
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

        // 会话标题 = 第一条用户文本（截断），供历史列表显示。
        if let Some(text) = blocks.iter().find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        }) {
            self.note_chat_title(&acp_session_id, text);
        }

        session.set_phase(AcpChatPhase::Generating).await;
        session.emit_state().await;

        let turn_session = session.clone();
        tokio::spawn(async move {
            let _ = run_turn(&turn_session, acp_session_id, blocks).await;
        });
        Ok(())
    }

    /// 同步版 prompt：等整个回合结束并返回 stopReason。Automations 的
    /// headless 派发用（带超时由调用方包）。前置校验与 `prompt` 相同。
    pub async fn prompt_and_wait(&self, chat_id: &str, blocks: Vec<Value>) -> AppResult<String> {
        if blocks.is_empty() {
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
        if phase != AcpChatPhase::Ready {
            return Err(AppError::coded(
                "ACP_SESSION_NOT_READY",
                "ACP session is not ready for prompts",
            ));
        }
        session.set_phase(AcpChatPhase::Generating).await;
        session.emit_state().await;
        run_turn(&session, acp_session_id, blocks).await
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

    /// Switch the session mode (approval behavior / plan mode / …).
    /// The mode id must come from `modes.availableModes` advertised by the agent.
    pub async fn set_mode(&self, chat_id: &str, mode_id: String) -> AppResult<()> {
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
        session
            .request(
                "session/set_mode",
                json!({"sessionId": acp_session_id, "modeId": mode_id}),
            )
            .await?;
        {
            let mut snapshot = session.snapshot.write().await;
            if let Some(modes) = snapshot.modes.as_mut() {
                modes["currentModeId"] = json!(mode_id);
            }
        }
        session.emit_state().await;
        Ok(())
    }

    /// Switch the model. Only available when the agent advertised `models`.
    pub async fn set_model(&self, chat_id: &str, model_id: String) -> AppResult<()> {
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
        session
            .request(
                "session/set_model",
                json!({"sessionId": acp_session_id, "modelId": model_id}),
            )
            .await?;
        {
            let mut snapshot = session.snapshot.write().await;
            if let Some(models) = snapshot.models.as_mut() {
                models["currentModelId"] = json!(model_id);
            }
        }
        session.emit_state().await;
        Ok(())
    }

    /// 会话中改自动放行策略（立即对后续 `session/request_permission` 生效；
    /// 已弹出的审批卡不回收，仍由用户回答）。
    pub async fn set_auto_approve(&self, chat_id: &str, kinds: Vec<String>) -> AppResult<()> {
        let session = self.session(chat_id).await?;
        let kinds: Vec<String> = kinds
            .into_iter()
            .map(|kind| kind.trim().to_string())
            .filter(|kind| !kind.is_empty())
            .collect();
        *session
            .auto_approve_kinds
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = kinds.clone();
        session.snapshot.write().await.auto_approve_kinds = kinds;
        session.emit_state().await;
        Ok(())
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

    // ---- 会话历史元数据（按 acpSessionId 落盘） ----

    fn meta_path(&self, acp_session_id: &str) -> Option<PathBuf> {
        meta_path_in(&self.chats_dir, acp_session_id)
    }

    fn write_chat_meta(
        &self,
        acp_session_id: &str,
        engine_id: &str,
        cwd: &str,
        title: Option<&str>,
    ) {
        let Some(path) = self.meta_path(acp_session_id) else {
            return;
        };
        let now = unix_millis();
        let existing = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let created_at = existing
            .as_ref()
            .and_then(|meta| meta.get("createdAt"))
            .and_then(Value::as_i64)
            .unwrap_or(now);
        let kept_title = title
            .map(str::to_string)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|meta| meta.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let meta = json!({
            "acpSessionId": acp_session_id,
            "engineId": engine_id,
            "cwd": cwd,
            "title": kept_title,
            "createdAt": created_at,
            "updatedAt": now,
        });
        if std::fs::create_dir_all(&self.chats_dir).is_ok() {
            if let Err(error) = std::fs::write(&path, meta.to_string()) {
                warn!(error = %error, "failed to write ACP chat meta");
            }
        }
    }

    fn note_chat_title(&self, acp_session_id: &str, text: &str) {
        let Some(path) = self.meta_path(acp_session_id) else {
            return;
        };
        let Some(mut meta) = read_meta(&path) else {
            return;
        };
        let has_title = meta
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|title| !title.trim().is_empty());
        if !has_title {
            // 压掉换行/连续空白再截断，避免多行 prompt 的首行断句难读。
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let title: String = cleaned.chars().take(60).collect();
            meta["title"] = json!(title);
            meta["titleSource"] = json!(TITLE_SOURCE_AUTO);
        }
        meta["updatedAt"] = json!(unix_millis());
        if let Err(error) = std::fs::write(&path, meta.to_string()) {
            warn!(error = %error, "failed to update ACP chat meta");
        }
    }

    /// 重命名历史会话（写 meta 的 title；空标题恢复自动抓取行为）。
    pub fn rename_chat_history(&self, acp_session_id: &str, title: &str) -> AppResult<()> {
        let path = self
            .meta_path(acp_session_id)
            .ok_or_else(|| AppError::coded("ACP_BAD_SESSION_ID", "ACP session id is invalid"))?;
        let raw = std::fs::read_to_string(&path)
            .map_err(|error| AppError::from(format!("Unable to read ACP chat meta: {error}")))?;
        let mut meta: Value = serde_json::from_str(&raw)
            .map_err(|error| AppError::from(format!("Invalid ACP chat meta: {error}")))?;
        let trimmed: String = title.trim().chars().take(120).collect();
        // 清空 = 放弃手改，回到自动/agent 标题；非空 = 用户手改，之后 agent 不再覆盖。
        meta["titleSource"] = json!(if trimmed.is_empty() {
            TITLE_SOURCE_AUTO
        } else {
            TITLE_SOURCE_USER
        });
        meta["title"] = json!(trimmed);
        meta["updatedAt"] = json!(unix_millis());
        std::fs::write(&path, meta.to_string())
            .map_err(|error| AppError::from(format!("Unable to write ACP chat meta: {error}")))
    }

    /// 删除历史会话记录（只删 meta；agent 侧对话数据不动，仍可凭 id 手动续接）。
    pub fn delete_chat_history(&self, acp_session_id: &str) -> AppResult<()> {
        let path = self
            .meta_path(acp_session_id)
            .ok_or_else(|| AppError::coded("ACP_BAD_SESSION_ID", "ACP session id is invalid"))?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                AppError::from(format!("Unable to delete ACP chat meta: {error}"))
            })?;
        }
        Ok(())
    }

    /// 历史会话元数据（updatedAt 倒序，最多 100 条）。
    pub fn list_chat_history(&self) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(&self.chats_dir) else {
            return Vec::new();
        };
        let mut metas: Vec<Value> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .collect();
        metas.sort_by_key(|meta| {
            std::cmp::Reverse(meta.get("updatedAt").and_then(Value::as_i64).unwrap_or(0))
        });
        metas.truncate(100);
        metas
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
                // 命中自动放行策略就代答，不弹卡，但 emit 通知留痕。kind 解析三级：
                // 请求自带 → tool_call 流里同 id 报过的 → 标题前缀推断（Kimi）。
                let tool_call = params.get("toolCall");
                let tool_call_id = tool_call
                    .and_then(|call| call.get("toolCallId"))
                    .and_then(Value::as_str);
                let cached_kind = tool_call_id.and_then(|call_id| {
                    session
                        .tool_kinds
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .get(call_id)
                        .cloned()
                });
                let tool_kind: Option<String> = tool_call
                    .and_then(|call| call.get("kind"))
                    .and_then(Value::as_str)
                    .filter(|kind| !kind.is_empty())
                    .map(str::to_string)
                    .or(cached_kind)
                    .or_else(|| {
                        tool_call
                            .and_then(|call| call.get("title"))
                            .and_then(Value::as_str)
                            .and_then(infer_tool_kind_from_title)
                            .map(str::to_string)
                    });
                let (approved, wildcard) = {
                    let kinds = session
                        .auto_approve_kinds
                        .read()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    (
                        auto_approves(&kinds, tool_kind.as_deref()),
                        kinds.iter().any(|kind| kind == AUTO_APPROVE_ALL),
                    )
                };
                let option_id = if approved {
                    pick_auto_approve_option(
                        params
                            .get("options")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                        wildcard,
                    )
                } else {
                    None
                };
                // 通配下选不出选项也要推进（cancelled）；按类放行选不出（提问型
                // 多选）就退回弹卡，让用户自己答。
                if approved && (option_id.is_some() || wildcard) {
                    let outcome = match option_id {
                        Some(option_id) => {
                            json!({"outcome": {"outcome": "selected", "optionId": option_id}})
                        }
                        None => json!({"outcome": {"outcome": "cancelled"}}),
                    };
                    if let Err(error) = session.respond(&id, Ok(outcome)).await {
                        debug!(chat_id = %session.chat_id, error = %error, "failed to auto-approve ACP permission");
                    }
                    session.emit(
                        "notification",
                        json!({
                            "method": "ccpanes/auto-approved",
                            "params": params,
                            "resolvedKind": tool_kind,
                        }),
                    );
                    return;
                }
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
                // agent 可以自主换模式（例如 plan 模式跑完自动切回）；快照要跟上，
                // 否则头部的模式选择器显示陈旧值。
                sync_mode_update_into_snapshot(session, &params).await;
                remember_tool_kind(session, &params);
                sync_agent_title_into_meta(session, &params).await;
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

/// 跑一个完整回合：request → 相位复位 → turn_ended 事件。返回 stopReason，
/// 协议层拒绝时返回 Err（进程退出的终态由 read loop 负责）。
async fn run_turn(
    session: &Arc<AcpChatSession>,
    acp_session_id: String,
    blocks: Vec<Value>,
) -> AppResult<String> {
    let result = session
        .request(
            "session/prompt",
            json!({
                "sessionId": acp_session_id,
                "prompt": blocks,
            }),
        )
        .await;
    let engine_id = session.snapshot.read().await.engine_id.clone();
    let notify = |detail: String, is_error: bool| {
        // Automations 的 headless 会话不打扰（结果进运行历史）。
        if session.chat_id.starts_with("auto-") {
            return;
        }
        if let Some(notifier) = session
            .turn_notifier
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            notifier(AcpTurnNotice {
                chat_id: session.chat_id.clone(),
                engine_id: engine_id.clone(),
                detail,
                is_error,
            });
        }
    };
    match result {
        Ok(response) => {
            let stop_reason = response
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_string();
            session.set_phase(AcpChatPhase::Ready).await;
            session.emit("turn_ended", json!({"stopReason": stop_reason}));
            session.emit_state().await;
            notify(stop_reason.clone(), false);
            Ok(stop_reason)
        }
        Err(error) => {
            // Process-exit already emitted a terminal state; only a
            // protocol-level rejection needs surfacing here.
            session.set_phase(AcpChatPhase::Ready).await;
            session.emit(
                "turn_ended",
                json!({"stopReason": "error", "error": error.to_string()}),
            );
            session.emit_state().await;
            notify(error.to_string(), true);
            Err(error)
        }
    }
}

/// 历史 meta 的 `titleSource`：auto = 首条 prompt 截取；agent = 引擎经
/// `session_info_update` 给的标题；user = 用户手改（agent 不得覆盖）。
const TITLE_SOURCE_AUTO: &str = "auto";
const TITLE_SOURCE_AGENT: &str = "agent";
const TITLE_SOURCE_USER: &str = "user";

/// acpSessionId 只允许 `[A-Za-z0-9_-]`（≤128）——它直接拼进文件名。
fn meta_path_in(chats_dir: &Path, acp_session_id: &str) -> Option<PathBuf> {
    let id = acp_session_id.trim();
    let safe = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| chats_dir.join(format!("{id}.json")))
}

fn read_meta(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

/// agent 标题是否应写入 meta：用户手改的不动，其余（无 title / auto / agent）
/// 都让 agent 的更好标题覆盖。旧 meta 没有 titleSource 视为 auto。
pub fn agent_title_should_apply(meta: &Value) -> bool {
    meta.get("titleSource").and_then(Value::as_str) != Some(TITLE_SOURCE_USER)
}

/// `session_info_update.title` → 历史 meta（Claude / Codex / Copilot / Cursor
/// 实测都会在首轮后发一次 agent 生成的标题）。
fn apply_agent_title(chats_dir: &Path, acp_session_id: &str, title: &str) {
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return;
    }
    let Some(path) = meta_path_in(chats_dir, acp_session_id) else {
        return;
    };
    let Some(mut meta) = read_meta(&path) else {
        return;
    };
    if !agent_title_should_apply(&meta) {
        return;
    }
    meta["title"] = json!(title.chars().take(120).collect::<String>());
    meta["titleSource"] = json!(TITLE_SOURCE_AGENT);
    meta["updatedAt"] = json!(unix_millis());
    if let Err(error) = std::fs::write(&path, meta.to_string()) {
        warn!(error = %error, "failed to write agent title into ACP chat meta");
    }
}

/// `session_info_update` → 把 agent 生成的标题写进历史 meta。文件 IO 极小
/// （一个 JSON），且每会话只来一两次，直接在读线程做。
async fn sync_agent_title_into_meta(session: &Arc<AcpChatSession>, params: &Value) {
    let Some(update) = params.get("update") else {
        return;
    };
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("session_info_update") {
        return;
    }
    let Some(title) = update.get("title").and_then(Value::as_str) else {
        return;
    };
    let acp_session_id = session.snapshot.read().await.acp_session_id.clone();
    if let Some(acp_session_id) = acp_session_id {
        apply_agent_title(&session.chats_dir, &acp_session_id, title);
    }
}

/// 记 toolCallId → kind（tool_call / tool_call_update 带 kind 时）。有界：超过
/// 上限整体清空——一轮对话的工具调用远到不了这个数，清空只影响极端长会话里
/// 早已结束的调用。
const TOOL_KIND_CACHE_LIMIT: usize = 512;

fn remember_tool_kind(session: &Arc<AcpChatSession>, params: &Value) {
    let Some(update) = params.get("update") else {
        return;
    };
    let variant = update.get("sessionUpdate").and_then(Value::as_str);
    if !matches!(variant, Some("tool_call") | Some("tool_call_update")) {
        return;
    }
    let (Some(call_id), Some(kind)) = (
        update.get("toolCallId").and_then(Value::as_str),
        update.get("kind").and_then(Value::as_str),
    ) else {
        return;
    };
    if kind.is_empty() {
        return;
    }
    let mut cache = session
        .tool_kinds
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() >= TOOL_KIND_CACHE_LIMIT && !cache.contains_key(call_id) {
        cache.clear();
    }
    cache.insert(call_id.to_string(), kind.to_string());
}

async fn sync_mode_update_into_snapshot(session: &Arc<AcpChatSession>, params: &Value) {
    let update = params.get("update");
    let is_mode_update = update
        .and_then(|u| u.get("sessionUpdate"))
        .and_then(Value::as_str)
        == Some("current_mode_update");
    if !is_mode_update {
        return;
    }
    let Some(mode_id) = update
        .and_then(|u| u.get("currentModeId"))
        .and_then(Value::as_str)
    else {
        return;
    };
    {
        let mut snapshot = session.snapshot.write().await;
        if let Some(modes) = snapshot.modes.as_mut() {
            modes["currentModeId"] = json!(mode_id);
        }
    }
    session.emit_state().await;
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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

    fn kinds(list: &[&str]) -> Vec<String> {
        list.iter().map(|kind| kind.to_string()).collect()
    }

    #[test]
    fn auto_approve_empty_policy_always_asks() {
        assert!(!auto_approves(&[], Some("read")));
        assert!(!auto_approves(&[], None));
    }

    #[test]
    fn auto_approve_wildcard_covers_everything() {
        let policy = kinds(&["*"]);
        assert!(auto_approves(&policy, Some("execute")));
        assert!(auto_approves(&policy, None));
    }

    #[test]
    fn auto_approve_matches_listed_kinds_only() {
        let policy = kinds(&["read", "search"]);
        assert!(auto_approves(&policy, Some("read")));
        assert!(auto_approves(&policy, Some("search")));
        assert!(!auto_approves(&policy, Some("edit")));
        assert!(!auto_approves(&policy, Some("execute")));
    }

    #[test]
    fn auto_approve_missing_kind_is_other() {
        assert!(!auto_approves(&kinds(&["read"]), None));
        assert!(auto_approves(&kinds(&["other"]), None));
        assert!(auto_approves(&kinds(&["other"]), Some("")));
    }

    /// Kimi CLI 实测：权限请求与 tool_call 均不带 kind，标题为 `工具名: 参数`。
    #[test]
    fn infer_kind_from_kimi_style_titles() {
        assert_eq!(
            infer_tool_kind_from_title("Shell: echo acp-probe-ok"),
            Some("execute")
        );
        assert_eq!(
            infer_tool_kind_from_title("WriteFile: probe.txt"),
            Some("edit")
        );
        assert_eq!(
            infer_tool_kind_from_title("StrReplaceFile: existing.txt"),
            Some("edit")
        );
        assert_eq!(
            infer_tool_kind_from_title("ReadFile: existing.txt"),
            Some("read")
        );
        assert_eq!(infer_tool_kind_from_title("Grep: hello"), Some("search"));
        assert_eq!(
            infer_tool_kind_from_title("FetchURL: https://x"),
            Some("fetch")
        );
        assert_eq!(infer_tool_kind_from_title("TaskStop: 3"), None);
        assert_eq!(
            infer_tool_kind_from_title("Print the required shell marker"),
            None
        );
        assert_eq!(infer_tool_kind_from_title(""), None);
    }

    fn options(kinds: &[&str]) -> Vec<Value> {
        kinds
            .iter()
            .enumerate()
            .map(|(index, kind)| json!({"optionId": format!("o{index}"), "kind": kind}))
            .collect()
    }

    /// Claude / Kimi / OpenCode / Copilot 实测的标准三选项：恰好一个 allow_once。
    #[test]
    fn pick_option_standard_approval_selects_allow_once() {
        let claude = options(&["reject_once", "allow_once", "allow_always"]);
        assert_eq!(pick_auto_approve_option(&claude, false), Some(json!("o1")));
        let copilot = options(&["allow_once", "allow_always", "reject_once"]);
        assert_eq!(pick_auto_approve_option(&copilot, false), Some(json!("o0")));
    }

    /// Cursor AskQuestion / Codex 沙箱权限档：多个 allow_once 并列 = 提问，不代答。
    #[test]
    fn pick_option_refuses_multi_choice_questions_per_kind() {
        let question = options(&["allow_once", "allow_once", "allow_once", "reject_once"]);
        assert_eq!(pick_auto_approve_option(&question, false), None);
        let codex_profile = options(&["allow_once", "allow_once", "allow_always", "reject_once"]);
        assert_eq!(pick_auto_approve_option(&codex_profile, false), None);
    }

    /// 通配（Automations）必须推进：多选也取第一个 allow，全拒绝集取第一个。
    #[test]
    fn pick_option_wildcard_always_progresses() {
        let question = options(&["allow_once", "allow_once", "reject_once"]);
        assert_eq!(pick_auto_approve_option(&question, true), Some(json!("o0")));
        let rejects = options(&["reject_once", "reject_always"]);
        assert_eq!(pick_auto_approve_option(&rejects, true), Some(json!("o0")));
        assert_eq!(pick_auto_approve_option(&rejects, false), None);
        assert_eq!(pick_auto_approve_option(&[], true), None);
    }

    #[test]
    fn agent_title_overrides_auto_but_not_user() {
        assert!(agent_title_should_apply(&json!({"title": ""})));
        assert!(agent_title_should_apply(&json!({"title": "first prompt…"})));
        assert!(agent_title_should_apply(&json!({"titleSource": "auto"})));
        assert!(agent_title_should_apply(&json!({"titleSource": "agent"})));
        assert!(!agent_title_should_apply(&json!({"titleSource": "user"})));
    }

    #[test]
    fn apply_agent_title_writes_meta_and_respects_user_rename() {
        let dir = std::env::temp_dir().join(format!(
            "acp-meta-test-{}-{}",
            std::process::id(),
            unix_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sess-1.json");
        std::fs::write(
            &path,
            json!({"title": "帮我看看这个仓库…", "createdAt": 1}).to_string(),
        )
        .unwrap();

        apply_agent_title(&dir, "sess-1", "  Repo walkthrough\n and data flow  ");
        let meta = read_meta(&path).unwrap();
        assert_eq!(meta["title"], json!("Repo walkthrough and data flow"));
        assert_eq!(meta["titleSource"], json!("agent"));

        // 用户手改后 agent 再发标题不得覆盖。
        std::fs::write(
            &path,
            json!({"title": "我的命名", "titleSource": "user"}).to_string(),
        )
        .unwrap();
        apply_agent_title(&dir, "sess-1", "Agent title");
        assert_eq!(read_meta(&path).unwrap()["title"], json!("我的命名"));

        // 非法 id / 空标题 / 不存在的 meta 都静默不写。
        apply_agent_title(&dir, "../evil", "x");
        apply_agent_title(&dir, "sess-1", "   ");
        apply_agent_title(&dir, "missing", "x");
        assert!(!dir.join("missing.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pick_option_single_allow_always_is_accepted() {
        let only_always = options(&["allow_always", "reject_once"]);
        assert_eq!(
            pick_auto_approve_option(&only_always, false),
            Some(json!("o0"))
        );
    }

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
