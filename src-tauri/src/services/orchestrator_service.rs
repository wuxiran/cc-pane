//! Orchestrator Service — HTTP API + MCP Server
//!
//! 提供 REST API 和 MCP Streamable HTTP 端点，让 PTY 中运行的 Claude 实例
//! 通过 HTTP/MCP 调用 CC-Panes 功能（创建标签、启动 Claude、注入 prompt）。
//!
//! 安全措施：
//! - 绑定 0.0.0.0（供本机与 WSL 访问）
//! - 随机 Bearer Token 认证
//! - 项目路径白名单校验
//! - 请求频率限制

use crate::ccchan_service::{CCChanService, CCChanWindowMode};
use crate::models::task_binding::{TaskBinding, TaskBindingStatus};
use crate::models::todo::{
    CreateTodoRequest, TodoPriority, TodoQuery, TodoScope, TodoStatus, UpdateTodoRequest,
};
use crate::models::{
    CliTool, LaunchProfile, LaunchProfileDraft, LaunchProfileMcpMode, LaunchProfileMcpPolicy,
    LaunchProfilePreviewRequest, LaunchProfileResolution, LaunchProfileSkillMode,
    LaunchProfileSkillPolicy, LaunchProviderSelection, SshConnectionInfo, Workspace,
    WorkspaceLaunchEnvironment, WslLaunchInfo,
};
use crate::services::{
    ExternalSkillRegistry, LaunchHistoryService, LaunchProfileService, MemoryService,
    NotificationRequest, NotificationService, ProjectService, ProviderService, SettingsService,
    SharedMcpService, SkillService, SpecService, SshMachineService, TerminalBackendState,
    TerminalService, TodoService, WorkspaceService,
};
use crate::utils::{validate_command, validate_mcp_name, validate_path, AppPaths};
use anyhow::Result;
use axum::{
    extract::{DefaultBodyLimit, Json, Path as AxumPath, Query, Request, State},
    http::{self, HeaderMap, Method, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use cc_cli_adapters::normalize_cli_command;
use cc_memory::models::{
    MemoryCategory, MemoryQuery, MemoryScope, StoreMemoryRequest, UpdateMemoryRequest,
};
use cc_panes_core::models::settings::CliLauncherOverride;
use cc_panes_core::models::shared_mcp::{
    BridgeMode, SharedMcpConfig, SharedMcpServerConfig, SharedMcpServerStatus,
};
use cc_panes_core::models::{
    CreateSessionRequest as CoreCreateSessionRequest, PortReservation, RunnerInstance,
    RunnerInstanceStatus, RunnerProfile, RunnerStartResult, RunnerStartStatus,
};
use cc_panes_core::services::mcp_config_service::McpServerConfig;
use cc_panes_core::services::terminal_service::{KillReason, SessionStatus, SessionStatusInfo};
use cc_panes_core::services::TerminalBackend;
#[cfg(target_os = "windows")]
use cc_panes_core::utils::canonical_project_path;
use cc_panes_core::utils::orchestrator_manifest;
use cc_panes_core::utils::{project_identity_key, simplify_path_str};
use rmcp::{
    handler::server::router::tool::ToolRouter,
    handler::server::wrapper::Parameters,
    model::{Extensions, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ServerHandler,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, LogicalSize, Manager};
use tracing::{debug, error, info, warn};

// ============ 数据模型 ============

/// 启动任务请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTaskRequest {
    pub project_path: String,
    /// 要注入的 prompt（任务描述）。resume 时可不传。
    pub prompt: Option<String>,
    pub provider_id: Option<String>,
    pub provider_selection: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    /// 本次启动运行环境：local / wsl / ssh。未传时保持旧行为，使用 workspace.defaultEnvironment。
    #[serde(alias = "runtime", alias = "environment")]
    pub runtime_kind: Option<String>,
    pub title: Option<String>,
    /// 恢复指定 Claude 会话（传入 session UUID）
    pub resume_id: Option<String>,
    /// 指定目标面板 ID（可选，不指定则使用活跃面板。通过 list_panes 获取可用面板）
    pub pane_id: Option<String>,
    /// 指定目标布局 ID（可选，通过 list_panes 获取可用布局）
    pub layout_id: Option<String>,
    /// 指定目标布局名称（可选；前端不存在时会自动创建）
    pub layout_name: Option<String>,
    /// CLI 工具类型：`"claude"` | `"codex"` | `"opencode"`，默认 `"claude"`。
    /// 其余已注册工具（gemini/kimi/glm/cursor）请通过直接终端启动。
    pub cli_tool: Option<String>,
    /// 新会话落位方式：`"beside"`（默认，调用者 pane 旁边分屏）| `"tab"`（调用者 pane 标签页）。
    pub placement: Option<String>,
}

/// 启动任务响应
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTaskResponse {
    pub task_id: String,
    pub session_id: String,
    pub status: String,
    pub runtime_kind: String,
    pub runtime_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// 项目信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspace_name: Option<String>,
}

/// 项目列表响应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsResponse {
    pub projects: Vec<ProjectInfo>,
}

/// 任务状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub task_id: String,
    pub session_id: String,
    pub status: String,
    pub error: Option<String>,
    /// 创建时间，用于定期清理已完成任务（不序列化）
    #[serde(skip)]
    pub created_at: std::time::Instant,
}

/// 前端事件 payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorLaunchEvent {
    pub task_id: String,
    pub session_id: String,
    pub project_path: String,
    pub project_id: String,
    pub workspace_name: Option<String>,
    pub provider_id: Option<String>,
    pub provider_selection: Option<String>,
    pub workspace_path: Option<String>,
    pub title: Option<String>,
    pub resume_id: Option<String>,
    pub pane_id: Option<String>,
    pub layout_id: Option<String>,
    pub layout_name: Option<String>,
    pub cli_tool: Option<String>,
    pub runtime_kind: String,
    pub runtime_source: String,
    pub notice: Option<String>,
    pub wsl: Option<WslLaunchInfo>,
    pub ssh: Option<SshConnectionInfo>,
    /// 新会话落位方式：`"beside"`（默认，调用者 pane 旁边分屏）| `"tab"`（调用者 pane 标签页）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<String>,
    /// 调用方（caller）所在 PTY 会话 id。
    /// 仅当本次 launch_task 由某个已知 Claude 实例发起、且能解析出其 launchId
    /// 时才会被设置；前端据此在已有 tab 中找到父 tab，给新建 tab 设置
    /// `parentTabId`，从而渲染层级编号 `#N.M`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

/// 文件浏览器导航事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorOpenFolderEvent {
    pub path: String,
}

/// 编辑器打开文件事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorOpenFileEvent {
    pub file_path: String,
    pub project_path: String,
    pub title: String,
}

fn parse_launch_cli_tool(cli_tool: Option<&str>) -> std::result::Result<CliTool, String> {
    match cli_tool.unwrap_or("claude") {
        "claude" => Ok(CliTool::Claude),
        "codex" => Ok(CliTool::Codex),
        "opencode" => Ok(CliTool::Opencode),
        "grok" => Ok(CliTool::Grok),
        "kimi" | "glm" | "gemini" | "cursor" => Err(format!(
            "CLI tool '{}' is not supported by launch_task yet; use direct terminal launch instead",
            cli_tool.unwrap_or("claude")
        )),
        other => Err(format!("Unknown cliTool '{}'", other)),
    }
}

fn parse_provider_selection(
    provider_selection: Option<&str>,
) -> std::result::Result<LaunchProviderSelection, String> {
    match provider_selection.unwrap_or("inherit") {
        "inherit" => Ok(LaunchProviderSelection::Inherit),
        "explicit" => Ok(LaunchProviderSelection::Explicit),
        "none" => Ok(LaunchProviderSelection::None),
        other => Err(format!("Unknown providerSelection '{}'", other)),
    }
}

fn parse_memory_scope(scope: Option<&str>) -> std::result::Result<Option<MemoryScope>, String> {
    scope
        .map(|value| {
            MemoryScope::parse(value).ok_or_else(|| {
                format!(
                    "Unknown memory scope '{}'; expected global, workspace, project, or session",
                    value
                )
            })
        })
        .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchRuntimeKind {
    Local,
    Wsl,
    Ssh,
}

impl LaunchRuntimeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Wsl => "wsl",
            Self::Ssh => "ssh",
        }
    }
}

fn parse_launch_runtime_kind(value: &str) -> std::result::Result<LaunchRuntimeKind, String> {
    match value {
        "local" => Ok(LaunchRuntimeKind::Local),
        "wsl" => Ok(LaunchRuntimeKind::Wsl),
        "ssh" => Ok(LaunchRuntimeKind::Ssh),
        other => Err(format!(
            "Unknown runtimeKind '{}'; expected local, wsl, or ssh",
            other
        )),
    }
}

fn workspace_environment_to_runtime_kind(
    environment: WorkspaceLaunchEnvironment,
) -> LaunchRuntimeKind {
    match environment {
        WorkspaceLaunchEnvironment::Local => LaunchRuntimeKind::Local,
        WorkspaceLaunchEnvironment::Wsl => LaunchRuntimeKind::Wsl,
        WorkspaceLaunchEnvironment::Ssh => LaunchRuntimeKind::Ssh,
    }
}

fn workspace_runtime_kind(workspace: &Workspace) -> LaunchRuntimeKind {
    workspace_environment_to_runtime_kind(workspace.default_environment)
}

fn cli_workspace_default(workspace: &Workspace, cli_tool: &str) -> Option<LaunchRuntimeKind> {
    workspace
        .cli_environment_defaults
        .as_ref()?
        .get(cli_tool)
        .map(workspace_environment_to_runtime_kind)
}

fn effective_cli_default_key(cli_tool: Option<&str>) -> &str {
    cli_tool.unwrap_or("claude")
}

#[derive(Debug, Clone)]
struct ResolvedLaunchRuntime {
    kind: LaunchRuntimeKind,
    source: &'static str,
    notice: Option<String>,
    wsl: Option<WslLaunchInfo>,
    ssh: Option<SshConnectionInfo>,
}

fn parse_runtime_mcp_mode(mode: Option<&str>) -> std::result::Result<LaunchProfileMcpMode, String> {
    match mode.unwrap_or("default") {
        "default" => Ok(LaunchProfileMcpMode::Default),
        "custom" => Ok(LaunchProfileMcpMode::Custom),
        "disabled" => Ok(LaunchProfileMcpMode::Disabled),
        other => Err(format!("Unknown mcpPolicy.mode '{}'", other)),
    }
}

fn parse_runtime_skill_mode(
    mode: Option<&str>,
) -> std::result::Result<LaunchProfileSkillMode, String> {
    match mode.unwrap_or("core") {
        "core" => Ok(LaunchProfileSkillMode::Core),
        "custom" => Ok(LaunchProfileSkillMode::Custom),
        "disabled" => Ok(LaunchProfileSkillMode::Disabled),
        other => Err(format!("Unknown skillPolicy.mode '{}'", other)),
    }
}

fn parse_bridge_mode(mode: Option<&str>) -> std::result::Result<BridgeMode, String> {
    match mode.unwrap_or("mcp-proxy") {
        "mcp-proxy" | "mcpProxy" => Ok(BridgeMode::McpProxy),
        "native-http" | "nativeHttp" => Ok(BridgeMode::NativeHttp),
        other => Err(format!("Unknown sharedMcpServers[].bridgeMode '{}'", other)),
    }
}

/// 编辑器关闭文件事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCloseFileEvent {
    pub file_path: String,
}

/// 前端查询请求事件（携带 request_id 用于匹配响应）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorQueryEvent {
    pub request_id: String,
}

/// API 错误响应
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
}

// ============ 共享状态 ============

/// Per-profile start locks prevent duplicate runner launches between the
/// active-instance check and PTY/session registration.
#[derive(Default)]
pub struct StartLocks {
    locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl StartLocks {
    async fn acquire(&self, profile_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(profile_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }
}

/// axum 路由共享状态
#[derive(Clone)]
pub struct AppState {
    pub token: String,
    pub local_terminal_service: Arc<TerminalService>,
    pub terminal_backend: Arc<TerminalBackendState>,
    pub provider_service: Arc<ProviderService>,
    pub launch_profile_service: Arc<LaunchProfileService>,
    pub shared_mcp_service: Arc<SharedMcpService>,
    pub mcp_config_service: Arc<crate::services::McpConfigService>,
    pub project_service: Arc<ProjectService>,
    pub workspace_service: Arc<WorkspaceService>,
    pub ssh_machine_service: Arc<SshMachineService>,
    pub todo_service: Arc<TodoService>,
    pub memory_service: Arc<MemoryService>,
    pub task_binding_service: Arc<crate::services::TaskBindingService>,
    pub spec_service: Arc<SpecService>,
    pub skill_service: Arc<SkillService>,
    pub external_skill_registry: Arc<ExternalSkillRegistry>,
    pub launch_history_service: Arc<LaunchHistoryService>,
    pub history_watch_manager: Arc<cc_panes_core::services::HistoryWatchManager>,
    pub notification_service: Arc<NotificationService>,
    pub ccchan_service: Arc<CCChanService>,
    pub settings_service: Arc<SettingsService>,
    pub plan_archive_service: Arc<crate::services::PlanArchiveService>,
    /// Runner Registry：项目运行实例 + 端口/PID 跟踪
    pub runner_service: Arc<cc_panes_core::services::RunnerService>,
    pub start_locks: Arc<StartLocks>,
    /// hook 驱动的会话状态机（阶段 2.2 引入）
    pub session_state_machine: Arc<cc_panes_core::services::SessionStateMachine>,
    pub app_handle: AppHandle,
    pub app_paths: Arc<AppPaths>,
    pub tasks: Arc<Mutex<HashMap<String, TaskStatus>>>,
    /// 简易频率限制：最近请求时间戳
    pub last_request_times: Arc<Mutex<Vec<std::time::Instant>>>,
    /// 前端查询的 pending 请求（request_id → oneshot 发送端）
    pub pending_queries: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    /// leader busy 时排队的 worker report（key = leader 的 PTY session_id），
    /// leader 状态跃迁回 Idle/WaitingInput 时由状态机 listener 补投
    pub pending_worker_reports: Arc<Mutex<PendingReportMap>>,
}

async fn backend_call_for_state<T, F>(
    terminal_backend: Arc<TerminalBackendState>,
    operation: F,
) -> std::result::Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<dyn TerminalBackend>) -> cc_panes_core::utils::AppResult<T> + Send + 'static,
{
    let backend = terminal_backend.backend();
    tokio::task::spawn_blocking(move || operation(backend))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

async fn backend_call<T, F>(state: &AppState, operation: F) -> std::result::Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<dyn TerminalBackend>) -> cc_panes_core::utils::AppResult<T> + Send + 'static,
{
    backend_call_for_state(state.terminal_backend.clone(), operation).await
}

fn adjust_session_status_info_for_query(
    state_machine: &cc_panes_core::services::SessionStateMachine,
    status: &mut SessionStatusInfo,
) {
    let effective = state_machine.status_for_query(&status.session_id, status.status);
    if effective != status.status {
        status.status = effective;
        status.current_tool_name = None;
        status.current_tool_use_id = None;
        status.current_tool_summary = None;
    }
}

async fn query_all_session_statuses(
    state: &AppState,
) -> std::result::Result<Vec<SessionStatusInfo>, String> {
    let mut statuses = backend_call(state, |backend| backend.get_all_status()).await?;
    for status in &mut statuses {
        adjust_session_status_info_for_query(&state.session_state_machine, status);
    }
    Ok(statuses)
}

async fn query_session_status(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<Option<SessionStatusInfo>, String> {
    let sid = session_id.to_string();
    let mut status = backend_call(state, move |backend| backend.get_session_status(&sid)).await?;
    if let Some(status) = status.as_mut() {
        adjust_session_status_info_for_query(&state.session_state_machine, status);
    }
    Ok(status)
}

const WAIT_FOR_SESSION_DEFAULT_TIMEOUT_MS: u64 = 180_000;
const WAIT_FOR_SESSION_MIN_TIMEOUT_MS: u64 = 1_000;
const WAIT_FOR_SESSION_MAX_TIMEOUT_MS: u64 = 570_000;
const WAIT_FOR_SESSION_RECHECK_SECS: u64 = 15;

fn normalized_wait_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(WAIT_FOR_SESSION_DEFAULT_TIMEOUT_MS)
        .clamp(
            WAIT_FOR_SESSION_MIN_TIMEOUT_MS,
            WAIT_FOR_SESSION_MAX_TIMEOUT_MS,
        )
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WaitForSessionResult {
    satisfied: bool,
    final_status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<String>,
    waited_ms: u64,
    turn_seq: u64,
}

enum WaitObservation {
    Done(WaitForSessionResult),
    Continue {
        final_status: SessionStatus,
        turn_seq: u64,
    },
}

fn observe_wait_status(
    state_machine: &cc_panes_core::services::SessionStateMachine,
    session_id: &str,
    wait_for: &[SessionStatus],
    status: Option<SessionStatusInfo>,
    waited_ms: u64,
) -> std::result::Result<WaitObservation, String> {
    let turn_seq = state_machine
        .snapshot(session_id)
        .map_or(0, |entry| entry.turn_seq);
    let Some(status) = status else {
        if wait_for.contains(&SessionStatus::Exited) {
            return Ok(WaitObservation::Done(WaitForSessionResult {
                satisfied: true,
                final_status: SessionStatus::Exited,
                blocked_reason: None,
                waited_ms,
                turn_seq,
            }));
        }
        return Err(format!("会话 '{}' 不存在", session_id));
    };

    if wait_for.contains(&status.status) {
        return Ok(WaitObservation::Done(WaitForSessionResult {
            satisfied: true,
            final_status: status.status,
            blocked_reason: None,
            waited_ms,
            turn_seq,
        }));
    }

    let blocked_reason = match status.status {
        SessionStatus::WaitingInput => Some("waiting-input"),
        SessionStatus::Error => Some("error"),
        _ => None,
    };
    if let Some(blocked_reason) = blocked_reason {
        return Ok(WaitObservation::Done(WaitForSessionResult {
            satisfied: false,
            final_status: status.status,
            blocked_reason: Some(blocked_reason.to_string()),
            waited_ms,
            turn_seq,
        }));
    }

    Ok(WaitObservation::Continue {
        final_status: status.status,
        turn_seq,
    })
}

async fn wait_for_session_with_query<F, Fut>(
    state_machine: Arc<cc_panes_core::services::SessionStateMachine>,
    session_id: String,
    wait_for: Vec<SessionStatus>,
    timeout: std::time::Duration,
    mut query: F,
) -> std::result::Result<WaitForSessionResult, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<Option<SessionStatusInfo>, String>>,
{
    let started = std::time::Instant::now();
    if let WaitObservation::Done(result) =
        observe_wait_status(&state_machine, &session_id, &wait_for, query().await?, 0)?
    {
        return Ok(result);
    }

    // 先订阅再重查，覆盖第一次快照与订阅建立之间发生的跃迁。
    let mut transitions = state_machine.subscribe_transitions();
    if let WaitObservation::Done(result) = observe_wait_status(
        &state_machine,
        &session_id,
        &wait_for,
        query().await?,
        started.elapsed().as_millis() as u64,
    )? {
        return Ok(result);
    }

    let deadline = tokio::time::Instant::now() + timeout;
    let mut recheck = tokio::time::interval(std::time::Duration::from_secs(
        WAIT_FOR_SESSION_RECHECK_SECS,
    ));
    recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    recheck.tick().await;

    loop {
        enum Wake {
            Transition(
                std::result::Result<
                    cc_panes_core::services::StateTransition,
                    tokio::sync::broadcast::error::RecvError,
                >,
            ),
            Recheck,
            Timeout,
        }

        let wake = tokio::select! {
            transition = transitions.recv() => Wake::Transition(transition),
            _ = recheck.tick() => Wake::Recheck,
            _ = tokio::time::sleep_until(deadline) => Wake::Timeout,
        };
        let timed_out = matches!(&wake, Wake::Timeout);
        match wake {
            Wake::Transition(Ok(transition)) if transition.pty_session_id != session_id => {
                continue;
            }
            Wake::Transition(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                return Err("会话状态广播已关闭".to_string());
            }
            Wake::Transition(Ok(_))
            | Wake::Transition(Err(tokio::sync::broadcast::error::RecvError::Lagged(_)))
            | Wake::Recheck
            | Wake::Timeout => {}
        }

        let waited_ms = started.elapsed().as_millis() as u64;
        match observe_wait_status(
            &state_machine,
            &session_id,
            &wait_for,
            query().await?,
            waited_ms,
        )? {
            WaitObservation::Done(result) => return Ok(result),
            WaitObservation::Continue {
                final_status,
                turn_seq,
            } if timed_out => {
                return Ok(WaitForSessionResult {
                    satisfied: false,
                    final_status,
                    blocked_reason: None,
                    waited_ms,
                    turn_seq,
                });
            }
            WaitObservation::Continue { .. } => {}
        }
    }
}

async fn query_session_status_for_automatic_submit(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<Option<SessionStatus>, String> {
    let sid = session_id.to_string();
    let status = backend_call(state, move |backend| backend.get_session_status(&sid)).await?;
    Ok(status.map(|status| {
        state.session_state_machine.status_for_automatic_submit(
            &status.session_id,
            status.status,
            status.last_output_at,
        )
    }))
}

// ============ OrchestratorService ============

/// 监听绑定决策（供状态查询与 WSL 安全网提示）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorBindDecision {
    /// 实际绑定地址："127.0.0.1" 或 "0.0.0.0"
    pub host: String,
    /// 设置值："auto" | "loopback" | "all"
    pub mode: String,
    /// 决策原因（面向 UI 展示）
    pub reason: String,
    /// WSL 是否为 mirrored 网络（None = 未检测/无 .wslconfig）。
    /// mirrored 下 WSL 内 127.0.0.1 直达 Windows 服务，回环绑定不影响 WSL MCP。
    pub wsl_mirrored: Option<bool>,
}

/// 按设置解析 orchestrator 绑定地址。auto 模式：
/// - 无 WSL 使用信号 → 回环
/// - 有 WSL 信号且 WSL 为 mirrored 网络 → 回环（mirrored 下 WSL 访问 127.0.0.1 直达宿主，
///   当前 WSL MCP URL 注入本就是 127.0.0.1，见 wsl_codex::resolve_reachable_wsl_windows_host）
/// - 有 WSL 信号且 NAT/未知网络 → 0.0.0.0（保持旧行为；NAT 下注入的 127.0.0.1 URL 本身不可达，
///   属既有问题，此处宁开勿关）
pub fn resolve_bind_decision(
    settings_service: &SettingsService,
    workspace_service: &WorkspaceService,
    launch_history_service: &LaunchHistoryService,
) -> OrchestratorBindDecision {
    let mode = settings_service.get_settings().orchestrator.bind_mode;
    let mirrored = wsl_networking_mirrored();
    let wsl_signal = if mode == "auto" {
        Some(wsl_usage_detected(
            workspace_service,
            launch_history_service,
        ))
    } else {
        None
    };
    decide_bind(&mode, wsl_signal, mirrored)
}

/// 读取 %USERPROFILE%\.wslconfig 判断 WSL2 是否启用 mirrored 网络。
/// None = 文件不存在/不可读（按 NAT 保守处理）。
fn wsl_networking_mirrored() -> Option<bool> {
    let home = std::env::var("USERPROFILE").ok()?;
    let content = std::fs::read_to_string(std::path::Path::new(&home).join(".wslconfig")).ok()?;
    Some(parse_wsl_networking_mirrored(&content))
}

fn parse_wsl_networking_mirrored(config: &str) -> bool {
    config.lines().any(|line| {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            return false;
        }
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        key.trim().eq_ignore_ascii_case("networkingMode")
            && value.trim().eq_ignore_ascii_case("mirrored")
    })
}

/// 纯决策：mode + WSL 使用信号 + WSL 网络模式 → 绑定地址（信号仅 auto 模式提供）
fn decide_bind(
    mode: &str,
    wsl_signal: Option<Result<Option<String>, String>>,
    wsl_mirrored: Option<bool>,
) -> OrchestratorBindDecision {
    let mode = mode.to_string();
    match mode.as_str() {
        "loopback" => OrchestratorBindDecision {
            host: "127.0.0.1".to_string(),
            mode,
            reason: "settings: loopback".to_string(),
            wsl_mirrored,
        },
        "all" => OrchestratorBindDecision {
            host: "0.0.0.0".to_string(),
            mode,
            reason: "settings: all interfaces".to_string(),
            wsl_mirrored,
        },
        _ => match wsl_signal.unwrap_or(Ok(None)) {
            Ok(Some(signal)) if wsl_mirrored == Some(true) => OrchestratorBindDecision {
                host: "127.0.0.1".to_string(),
                mode,
                reason: format!(
                    "auto: WSL usage ({signal}) with mirrored networking; loopback reachable from WSL"
                ),
                wsl_mirrored,
            },
            Ok(Some(signal)) => OrchestratorBindDecision {
                host: "0.0.0.0".to_string(),
                mode,
                reason: format!("auto: WSL usage detected ({signal}), NAT/unknown networking"),
                wsl_mirrored,
            },
            Ok(None) => OrchestratorBindDecision {
                host: "127.0.0.1".to_string(),
                mode,
                reason: "auto: no WSL usage detected".to_string(),
                wsl_mirrored,
            },
            Err(error) => {
                warn!(
                    "[orchestrator] WSL usage detection failed ({error}); \
                     falling back to 0.0.0.0 to keep WSL MCP reachable"
                );
                OrchestratorBindDecision {
                    host: "0.0.0.0".to_string(),
                    mode,
                    reason: format!("auto: detection failed ({error}), fail-open"),
                    wsl_mirrored,
                }
            }
        },
    }
}

/// WSL 使用信号：Ok(Some(描述)) 命中，Ok(None) 未命中，Err 读取失败
fn wsl_usage_detected(
    workspace_service: &WorkspaceService,
    launch_history_service: &LaunchHistoryService,
) -> Result<Option<String>, String> {
    let workspaces = workspace_service.list_workspaces()?;
    for workspace in &workspaces {
        let cli_default_wsl = workspace
            .cli_environment_defaults
            .as_ref()
            .is_some_and(|defaults| {
                defaults.claude == Some(WorkspaceLaunchEnvironment::Wsl)
                    || defaults.codex == Some(WorkspaceLaunchEnvironment::Wsl)
            });
        if workspace.default_environment == WorkspaceLaunchEnvironment::Wsl
            || workspace.wsl.is_some()
            || cli_default_wsl
            || workspace
                .projects
                .iter()
                .any(|project| project.wsl_remote_path.is_some())
        {
            return Ok(Some(format!("workspace '{}'", workspace.name)));
        }
    }
    let records = launch_history_service.list(500)?;
    if records.iter().any(|record| record.runtime_kind == "wsl") {
        return Ok(Some("launch history".to_string()));
    }
    Ok(None)
}

/// 决定本次要监听的端口：默认固定端口，`CC_PANES_ORCHESTRATOR_PORT` 是逃生阀。
///
/// 逃生阀非法（含 `0`）时报错并退回固定端口——绝不静默走 OS 随机分配。
fn decide_port() -> u16 {
    let raw = std::env::var(orchestrator_manifest::ORCHESTRATOR_PORT_ENV).ok();
    match orchestrator_manifest::resolve_orchestrator_port(raw.as_deref()) {
        Ok(port) => {
            if port != orchestrator_manifest::ORCHESTRATOR_FIXED_PORT {
                info!(
                    "[orchestrator] port overridden to {} via {}",
                    port,
                    orchestrator_manifest::ORCHESTRATOR_PORT_ENV
                );
            }
            port
        }
        Err(message) => {
            error!(
                "[orchestrator] {}；本次退回固定端口 {}",
                message,
                orchestrator_manifest::ORCHESTRATOR_FIXED_PORT
            );
            orchestrator_manifest::ORCHESTRATOR_FIXED_PORT
        }
    }
}

/// 绑定固定端口。**失败不回退 `:0`**——端口一漂移，已运行 CLI 会话的 MCP client
/// （只在进程启动时解析一次端点）会永久失联，静默换端口比起不来更难排查。
async fn bind_fixed_port(bind_host: &str, port: u16) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind(format!("{bind_host}:{port}"))
        .await
        .map_err(|error| {
            format!(
                "无法绑定 {bind_host}:{port}（{error}）。本构建为 {build}，固定端口 {fixed}。排查：\
                 1) 是否已有另一个同类型（{build}）的 CC-Panes 实例在跑——dev 与 release 端口本就错开，\
                 只有同类型重复启动才会撞；\
                 2) `netstat -ano | findstr :{port}`（Windows）/ `lsof -i :{port}`（macOS/Linux）看占用进程；\
                 3) 确实被别的程序长期占用时，设 {env}=<另一个确定端口> 后重启应用\
                 （不要填 0，那是 OS 随机分配，会让已运行的 CLI 会话重启后永久失联）。\
                 macOS 上还需确认系统设置 > 隐私与安全性 > 防火墙已放行本应用。",
                build = if cfg!(debug_assertions) { "dev" } else { "release" },
                fixed = orchestrator_manifest::ORCHESTRATOR_FIXED_PORT,
                env = orchestrator_manifest::ORCHESTRATOR_PORT_ENV,
            )
        })
}

pub struct OrchestratorService {
    port: Mutex<Option<u16>>,
    token: String,
    /// 本次要监听的端口：固定端口，或逃生阀 `CC_PANES_ORCHESTRATOR_PORT` 指定的确定值。
    /// **不再来自 manifest**——manifest 里可能残留旧版本 `:0` 分配的 ephemeral 端口。
    listen_port: u16,
    bind_decision: Mutex<Option<OrchestratorBindDecision>>,
    pending_queries: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    pending_worker_reports: Arc<Mutex<PendingReportMap>>,
    /// hook 驱动状态机：进程级单例，所有 session 共享
    session_state_machine: Arc<cc_panes_core::services::SessionStateMachine>,
}

impl OrchestratorService {
    /// 端口来自固定常量（或逃生阀），token 仍复用上一轮 mcp-orchestrator.json，
    /// 让重启/更新后仍在跑的 CLI 会话注入的 `CC_PANES_API_*` 不失效。
    ///
    /// manifest 与端口的 dev/release 对应关系见 `ORCHESTRATOR_FIXED_PORT` 的文档表格：
    /// 本进程只读写自己数据目录（`AppPaths` 由 `APP_DIR_NAME` 决定）下的 manifest。
    pub fn new(app_paths: &AppPaths) -> Self {
        let token = match orchestrator_manifest::read_endpoint(app_paths.data_dir()) {
            Some((persisted_port, token)) => {
                info!(
                    "[orchestrator] reusing persisted token from mcp-orchestrator.json \
                     (persisted port {} ignored; port is fixed now)",
                    persisted_port
                );
                token
            }
            None => generate_token(),
        };
        Self {
            port: Mutex::new(None),
            token,
            listen_port: decide_port(),
            bind_decision: Mutex::new(None),
            pending_queries: Arc::new(Mutex::new(HashMap::new())),
            pending_worker_reports: Arc::new(Mutex::new(HashMap::new())),
            session_state_machine: Arc::new(cc_panes_core::services::SessionStateMachine::new()),
        }
    }

    /// 获取服务器端口
    pub fn port(&self) -> Option<u16> {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 获取当前监听绑定决策（None = 尚未启动）
    pub fn bind_decision(&self) -> Option<OrchestratorBindDecision> {
        self.bind_decision
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 获取认证 token
    pub fn token(&self) -> &str {
        &self.token
    }

    /// 获取 SessionStateMachine 共享引用（terminal_service::set_state_machine 用）
    pub fn session_state_machine(&self) -> Arc<cc_panes_core::services::SessionStateMachine> {
        self.session_state_machine.clone()
    }

    /// 校正用户可见的状态查询结果；不改写 backend 或状态机中的原始状态。
    pub fn adjust_terminal_statuses_for_query(&self, statuses: &mut [SessionStatusInfo]) {
        for status in statuses {
            adjust_session_status_info_for_query(&self.session_state_machine, status);
        }
    }

    /// 获取 pending_queries 引用（用于 respond command）
    pub fn pending_queries(
        &self,
    ) -> Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>> {
        self.pending_queries.clone()
    }

    /// 启动 HTTP + MCP 服务器（在 tokio runtime 中运行）
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        local_terminal_service: Arc<TerminalService>,
        terminal_backend: Arc<TerminalBackendState>,
        provider_service: Arc<ProviderService>,
        launch_profile_service: Arc<LaunchProfileService>,
        shared_mcp_service: Arc<SharedMcpService>,
        mcp_config_service: Arc<crate::services::McpConfigService>,
        project_service: Arc<ProjectService>,
        workspace_service: Arc<WorkspaceService>,
        ssh_machine_service: Arc<SshMachineService>,
        todo_service: Arc<TodoService>,
        memory_service: Arc<MemoryService>,
        task_binding_service: Arc<crate::services::TaskBindingService>,
        spec_service: Arc<SpecService>,
        skill_service: Arc<SkillService>,
        external_skill_registry: Arc<ExternalSkillRegistry>,
        launch_history_service: Arc<LaunchHistoryService>,
        history_watch_manager: Arc<cc_panes_core::services::HistoryWatchManager>,
        notification_service: Arc<NotificationService>,
        ccchan_service: Arc<CCChanService>,
        settings_service: Arc<SettingsService>,
        plan_archive_service: Arc<crate::services::PlanArchiveService>,
        runner_service: Arc<cc_panes_core::services::RunnerService>,
        start_locks: Arc<StartLocks>,
        app_handle: AppHandle,
        app_paths: Arc<AppPaths>,
    ) -> Result<()> {
        let app_paths_for_config = app_paths.clone();
        let bind = resolve_bind_decision(
            &settings_service,
            &workspace_service,
            &launch_history_service,
        );
        info!(
            "[orchestrator] bind decision: host={} mode={} ({})",
            bind.host, bind.mode, bind.reason
        );
        *self.bind_decision.lock().unwrap_or_else(|e| e.into_inner()) = Some(bind.clone());
        let bind_host = bind.host;
        let state = AppState {
            token: self.token.clone(),
            local_terminal_service,
            terminal_backend,
            provider_service,
            launch_profile_service,
            shared_mcp_service,
            mcp_config_service,
            project_service,
            workspace_service,
            ssh_machine_service,
            todo_service,
            memory_service,
            task_binding_service,
            spec_service,
            skill_service,
            external_skill_registry,
            launch_history_service,
            history_watch_manager,
            notification_service,
            ccchan_service,
            settings_service,
            plan_archive_service,
            runner_service,
            start_locks,
            session_state_machine: self.session_state_machine.clone(),
            app_handle,
            app_paths,
            tasks: Arc::new(Mutex::new(HashMap::new())),
            last_request_times: Arc::new(Mutex::new(Vec::new())),
            pending_queries: self.pending_queries.clone(),
            pending_worker_reports: self.pending_worker_reports.clone(),
        };

        // ============ 阶段 2.6：把 SessionStateMachine 的状态跃迁桥接到 NotificationService ============
        //
        // 注册一个 listener：每次状态跃迁
        //   (a) 写回 TerminalService::apply_hook_status → 让 status Mutex + emit
        //       TERMINAL_STATUS 事件给前端看到新状态（这是端到端能通的关键，修 P0）
        //   (b) 判断要不要发通知（NotificationService）
        // listener 闭包持有 app_handle / notification_service / settings_service / terminal_service
        // 的 Arc / clone。
        {
            let app_handle_for_listener = state.app_handle.clone();
            let notif_svc = state.notification_service.clone();
            let settings_svc = state.settings_service.clone();
            // 走 backend：daemon 模式下会话在 daemon 进程，状态回写必须打到 daemon，
            // 否则前端桥接轮询 get_session_status 看不到 hook 细分状态（Thinking/ToolRunning…）。
            let backend_for_status = state.terminal_backend.backend();
            let runner_svc_listener = state.runner_service.clone();
            let state_machine_for_timer = state.session_state_machine.clone();
            state.session_state_machine.subscribe(Arc::new(
                move |transition: &cc_panes_core::services::StateTransition| {
                    use cc_panes_core::services::terminal_service::SessionStatus;

                    // 第一步：写回 TerminalSession.status + emit TERMINAL_STATUS
                    let _ = backend_for_status
                        .apply_hook_status(&transition.pty_session_id, transition.to);

                    // 第二步：按状态决定通知 / 启动 timer
                    match &transition.to {
                        SessionStatus::Idle => {
                            // TurnEnd → Idle："✅ 完成"
                            notif_svc.notify_turn_end(
                                &app_handle_for_listener,
                                &settings_svc,
                                &transition.pty_session_id,
                                transition.turn_seq,
                                None, // 摘要在未来阶段从 transcript 读取
                                None,
                            );
                        }
                        SessionStatus::WaitingInput => {
                            // hook 上报 WaitingInput → "🟡 需授权"
                            notif_svc.notify_waiting_input(
                                &app_handle_for_listener,
                                &settings_svc,
                                &transition.pty_session_id,
                                None,
                            );
                        }
                        SessionStatus::Error => {
                            notif_svc.notify_error(
                                &app_handle_for_listener,
                                &settings_svc,
                                &transition.pty_session_id,
                                transition.error_type.as_deref(),
                                None,
                            );
                        }
                        SessionStatus::Exited => {
                            if transition.trigger_event == "pty-exit" {
                                if let Err(e) = runner_svc_listener
                                    .mark_exited_by_session(&transition.pty_session_id, None)
                                {
                                    tracing::warn!(
                                        session_id = %transition.pty_session_id,
                                        err = %e,
                                        "runner mark_exited_by_session failed for pty-exit"
                                    );
                                }
                                return;
                            }
                            // 通过 SessionEnd hook 进入 → 默认 exit_code = 0
                            // PTY 自然退出由 terminal_service 单独负责（见现有 notify_session_exited）
                            notif_svc.notify_session_exited(
                                &app_handle_for_listener,
                                &settings_svc,
                                &transition.pty_session_id,
                                0,
                                None,
                            );
                            // Runner Registry：若该 session 关联了 active runner instance，
                            // 把它从 running 标记为 exited（避免下次 plan_runner_launch 把它
                            // 误算成"自身上次残留"）
                            if let Err(e) = runner_svc_listener
                                .mark_exited_by_session(&transition.pty_session_id, Some(0))
                            {
                                tracing::debug!(
                                    session_id = %transition.pty_session_id,
                                    err = %e,
                                    "runner mark_exited_by_session failed"
                                );
                            }
                        }
                        // ============ 阶段 2.7：长工具 60s timer ============
                        //
                        // 进入 ToolRunning 时：spawn tokio task 等 60s；到时通过状态机 snapshot
                        // 判断 (session, tool_use_id) 是否仍是同一个 ToolRunning。若是，发通知；
                        // 否则该工具已结束，自然过期。不需要显式取消机制。
                        SessionStatus::ToolRunning => {
                            let session_id = transition.pty_session_id.clone();
                            let tool_use_id = transition.tool_use_id.clone();
                            let tool_name = transition
                                .tool_name
                                .clone()
                                .unwrap_or_else(|| "tool".to_string());
                            let app2 = app_handle_for_listener.clone();
                            let notif2 = notif_svc.clone();
                            let settings2 = settings_svc.clone();
                            let sm = state_machine_for_timer.clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                                let Some(snap) = sm.snapshot(&session_id) else {
                                    return;
                                };
                                // 仍在 ToolRunning 且 tool_use_id 未变
                                let still_running =
                                    matches!(snap.status, SessionStatus::ToolRunning)
                                        && snap.current_tool_use_id == tool_use_id;
                                if !still_running {
                                    return;
                                }
                                notif2.notify_slow_tool(
                                    &app2,
                                    &settings2,
                                    &session_id,
                                    &tool_name,
                                    tool_use_id.as_deref(),
                                    60,
                                    None,
                                );
                            });
                        }
                        _ => {}
                    }
                },
            ));
        }

        // ============ worker report 补投 listener ============
        //
        // 必须注册在上面的通知 listener **之后**（SessionStateMachine 按注册顺序遍历）：
        // 补投里 send_worker_report_to_leader 会重读 get_all_status，依赖前一个 listener
        // 的 apply_hook_status 先把新状态写回 TerminalService。
        // 回调在 hook/PTY 线程同步执行：这里只做锁内 O(1) 检查 + spawn，重活在异步任务里。
        {
            let state_for_flush = state.clone();
            state.session_state_machine.subscribe(Arc::new(
                move |transition: &cc_panes_core::services::StateTransition| {
                    match pending_flush_action(transition.to) {
                        PendingFlushAction::Flush => {
                            let has_pending = {
                                let map = state_for_flush
                                    .pending_worker_reports
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                map.get(&transition.pty_session_id)
                                    .is_some_and(|queue| !queue.is_empty())
                            };
                            if has_pending {
                                let flush_state = state_for_flush.clone();
                                let sid = transition.pty_session_id.clone();
                                tauri::async_runtime::spawn(flush_pending_reports(
                                    flush_state,
                                    sid,
                                ));
                            }
                        }
                        PendingFlushAction::Clear => {
                            let dropped = {
                                let mut map = state_for_flush
                                    .pending_worker_reports
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                clear_pending_reports(&mut map, &transition.pty_session_id)
                            };
                            if dropped > 0 {
                                warn!(
                                    session_id = %transition.pty_session_id,
                                    to = ?transition.to,
                                    dropped,
                                    "leader session terminated; dropped pending worker reports"
                                );
                            }
                        }
                        PendingFlushAction::None => {}
                    }
                },
            ));
        }

        {
            let mut port_guard = self.port.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(port) = *port_guard {
                if local_orchestrator_endpoint_reachable(port) {
                    warn!("[orchestrator] Server already running on port {}", port);
                    return Ok(());
                }
                warn!(
                    "[orchestrator] Stored port {} is not reachable; restarting server",
                    port
                );
                *port_guard = None;
            }
        }

        let port_mutex = Arc::new(Mutex::new(None::<u16>));
        let port_mutex_clone = port_mutex.clone();
        // 绑定失败要让主线程立刻知道并醒目报错，而不是干等 5 秒超时。
        let bind_error = Arc::new(Mutex::new(None::<String>));
        let bind_error_clone = bind_error.clone();
        let listen_port = self.listen_port;

        // 在独立线程中启动 tokio runtime + axum 服务器
        std::thread::spawn(move || {
            info!("[orchestrator] Creating dedicated tokio runtime (2 worker threads)...");
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => {
                    info!("[orchestrator] Tokio runtime created successfully");
                    rt
                }
                Err(e) => {
                    error!("[orchestrator] Failed to create tokio runtime: {}", e);
                    return;
                }
            };

            rt.block_on(async move {
                let level_scan_state = state.clone();
                let app = build_router(state);

                // 固定端口（跨重启稳定：让重启/更新后仍在跑的 CLI 会话里写死的 MCP 端点依旧有效）。
                // 绑不上就报错退出，不静默漂移到随机端口。
                // auto/all 下绑 0.0.0.0 供 WSL 访问；loopback 只绑回环，缩小 LAN 暴露面。
                // macOS Ventura+ 首次绑定非回环可能触发防火墙授权弹窗，这是正常行为
                let listener = match bind_fixed_port(&bind_host, listen_port).await {
                    Ok(l) => l,
                    Err(message) => {
                        error!("[orchestrator] {}", message);
                        if let Ok(mut slot) = bind_error_clone.lock() {
                            *slot = Some(message);
                        }
                        return;
                    }
                };

                let addr = match listener.local_addr() {
                    Ok(a) => a,
                    Err(e) => {
                        error!("[orchestrator] Failed to get local addr: {}", e);
                        return;
                    }
                };
                let port = addr.port();
                info!(
                    "[orchestrator] HTTP + MCP server listening on {}:{}",
                    bind_host, port
                );

                // 通知主线程端口号
                if let Ok(mut p) = port_mutex_clone.lock() {
                    *p = Some(port);
                }

                tokio::spawn(run_pending_report_level_scan(level_scan_state));

                // 启动服务器
                info!("[orchestrator] axum::serve starting...");
                if let Err(e) = axum::serve(listener, app).await {
                    error!("[orchestrator] Server error: {}", e);
                }
                warn!("[orchestrator] axum::serve returned — server stopped");
            });
            warn!("[orchestrator] rt.block_on returned — runtime thread exiting");
        });

        // 等待端口绑定完成（最多 5 秒）；绑定失败则立即返回 Err，让调用方/用户看见
        let start = std::time::Instant::now();
        loop {
            if let Ok(slot) = bind_error.lock() {
                if let Some(message) = slot.clone() {
                    return Err(anyhow::anyhow!("orchestrator 未能启动：{message}"));
                }
            }
            if start.elapsed() > std::time::Duration::from_secs(5) {
                error!("[orchestrator] Timeout waiting for port assignment");
                break;
            }
            if let Ok(p) = port_mutex.lock() {
                if let Some(port) = *p {
                    let mut self_port = self.port.lock().unwrap_or_else(|e| e.into_inner());
                    *self_port = Some(port);

                    // 启动时立即写入 mcp-orchestrator.json，确保 token 与端口同步。
                    // 端口固定后 manifest 依然必要：token 跨重启复用，且逃生阀覆盖端口时
                    // 这里记录的是**实际**监听端口。写入的是本进程数据目录下的 manifest——
                    // dev 写 ~/.cc-panes-dev/、release 写 ~/.cc-panes/，与端口一一对应
                    // （见 ORCHESTRATOR_FIXED_PORT 文档表格）。
                    let config = serde_json::json!({
                        "mcpServers": {
                            "ccpanes": {
                                "type": "http",
                                "url": format!("http://127.0.0.1:{}/mcp?token={}", port, self.token),
                                "headers": {
                                    "Authorization": format!("Bearer {}", self.token)
                                }
                            }
                        }
                    });
                    let config_path = app_paths_for_config
                        .data_dir()
                        .join(orchestrator_manifest::ORCHESTRATOR_MANIFEST_FILE);
                    // 原子写：裸 fs::write 在崩溃/断电时可能留下截断的 manifest，
                    // 下次启动 read_endpoint 返回 None → token 丢失。
                    match cc_panes_core::utils::atomic_file::write_atomic(
                        &config_path,
                        serde_json::to_string_pretty(&config).unwrap_or_default(),
                    ) {
                        Ok(_) => info!(
                            "[orchestrator] MCP config written to {}",
                            config_path.display()
                        ),
                        Err(e) => error!("[orchestrator] Failed to write MCP config: {}", e),
                    }

                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        Ok(())
    }
}

// ============ 路由构建 ============

fn build_router(state: AppState) -> Router {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpService,
    };

    // M1: 收紧 CORS — 仅允许本地 Origin
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(|origin, _| {
            let s = origin.as_bytes();
            s.starts_with(b"http://localhost")
                || s.starts_with(b"https://localhost")
                || s.starts_with(b"http://127.0.0.1")
                || s.starts_with(b"https://127.0.0.1")
                || s == b"tauri://localhost"
        }))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    // MCP Server 层
    let mcp_state = state.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(McpToolHandler::new(mcp_state.clone())),
        Arc::new(LocalSessionManager::default()),
        Default::default(),
    );

    // M2: MCP 路由通过 auth middleware 校验 Bearer token
    Router::new()
        .route("/api/launch-task", post(handle_launch_task))
        .route("/api/projects", get(handle_list_projects))
        .route("/api/task-status/{task_id}", get(handle_task_status))
        .route("/api/sessions", get(handle_list_sessions))
        .route(
            "/api/session-status/{session_id}",
            get(handle_session_status),
        )
        .route("/api/write-to-session", post(handle_write_to_session))
        .route("/api/submit-to-session", post(handle_submit_to_session))
        .route("/api/kill-session", post(handle_kill_session))
        .route(
            "/api/terminal/session-started",
            post(handle_session_started),
        )
        .route(
            "/api/notifications/trigger",
            post(handle_trigger_notification),
        )
        .route("/api/ccchan/say", post(handle_ccchan_say))
        .route("/api/hook-event", post(handle_hook_event))
        .route("/api/memory/recall", post(handle_memory_recall))
        .route("/api/plan/tag", post(handle_plan_tag))
        .route("/api/plan/recent", get(handle_plan_recent))
        .route("/api/plan/search", post(handle_plan_search))
        .route("/api/plan/archive", post(handle_plan_set_archived))
        .route("/api/health", get(handle_health))
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn(inject_mcp_accept_headers))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            mcp_auth_middleware,
        ))
        .layer(cors)
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024)) // 10MB — 最后加 = 最外层最先执行
        .with_state(state)
}

/// M2: MCP 路由认证中间件 — /mcp 请求必须携带有效 Bearer token
async fn mcp_auth_middleware(
    State(state): State<AppState>,
    request: Request,
    next: middleware::Next,
) -> axum::response::Response {
    // 仅对 /mcp 路由校验 token（REST handlers 各自校验；OPTIONS 预检由 CORS 层处理）
    if request.uri().path().starts_with("/mcp") && request.method() != Method::OPTIONS {
        let header_ok = verify_token(request.headers(), &state.token);
        // 后备：从 URL query ?token=xxx 读取（Claude Code 某些版本忽略 headers — Issue #7290）
        let query_ok = request
            .uri()
            .query()
            .and_then(|q| q.split('&').find(|p| p.starts_with("token=")))
            .map(|p| p[6..] == *state.token)
            .unwrap_or(false);

        if !header_ok && !query_ok {
            warn!("[orchestrator] MCP request rejected: invalid or missing Bearer token");
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Invalid or missing Bearer token"})),
            )
                .into_response();
        }
    }
    next.run(request).await
}

/// 补全 Codex CLI 缺少的 Accept 头，避免 rmcp 1.3.0 对 POST /mcp 的 406 检查
async fn inject_mcp_accept_headers(
    mut request: Request,
    next: middleware::Next,
) -> axum::response::Response {
    if request.uri().path().starts_with("/mcp") && request.method() == Method::POST {
        let needs_injection = request
            .headers()
            .get(http::header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .map(|v| !v.contains("application/json") || !v.contains("text/event-stream"))
            .unwrap_or(true);
        if needs_injection {
            request.headers_mut().insert(
                http::header::ACCEPT,
                http::HeaderValue::from_static("application/json, text/event-stream"),
            );
        }
    }
    next.run(request).await
}

// ============ MCP Server 层 ============

/// MCP 工具参数

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpLaunchTaskParams {
    /// 项目路径（必须是已注册的项目）
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 要注入的 prompt（任务描述）。resume 时可不传。
    prompt: Option<String>,
    /// 可选的 Provider ID
    #[serde(rename = "providerId")]
    provider_id: Option<String>,
    /// Provider 选择模式：inherit / explicit / none
    #[serde(rename = "providerSelection")]
    provider_selection: Option<String>,
    /// 自定义标签名（不指定则使用默认 "${目录名} (Claude)"）
    title: Option<String>,
    /// 工作空间名称（自动解析 workspace_path 和 provider）
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// 本次启动运行环境：local / wsl / ssh。优先级高于 workspace.defaultEnvironment。
    #[serde(rename = "runtimeKind", alias = "runtime", alias = "environment")]
    runtime_kind: Option<String>,
    /// 恢复指定 Claude 会话（传入 session UUID，可从 list_launch_history 获取 claudeSessionId）
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// 指定目标面板 ID（可选，不指定则使用活跃面板。通过 list_panes 获取可用面板）
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// 指定目标布局 ID（可选，通过 list_panes 获取可用布局）
    #[serde(rename = "layoutId")]
    layout_id: Option<String>,
    /// 指定目标布局名称（可选；前端不存在时会自动创建）
    #[serde(rename = "layoutName")]
    layout_name: Option<String>,
    /// CLI 工具类型：`"claude"` | `"codex"` | `"opencode"`，默认 `"claude"`。
    /// 其余已注册工具（gemini/kimi/glm/cursor）请通过直接终端启动。
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
    /// 新会话落位方式（可选，默认 `"beside"`）：
    /// - `"beside"`：在**调用者**（发起本次 launch_task 的会话）所在 pane **旁边分屏**打开并聚焦（默认，推荐——用户能立刻看到新会话）。
    /// - `"tab"`：作为**标签页**加入调用者所在 pane，不额外分屏。仅当用户**明确要求**“在后台/同一窗格里以标签打开”时才用。
    ///
    /// 仅在未显式指定 `paneId` 时生效；指定了 `paneId` 则按 `paneId` 落位。
    #[serde(rename = "placement")]
    placement: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetTaskStatusParams {
    /// 任务 ID
    #[serde(rename = "taskId")]
    task_id: String,
}

// ---- Workspace MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetWorkspaceParams {
    /// 工作空间名称
    #[serde(rename = "workspaceName")]
    workspace_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCreateWorkspaceParams {
    /// 工作空间名称
    name: String,
    /// 可选的根目录路径
    path: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpAddProjectToWorkspaceParams {
    /// 工作空间名称
    #[serde(rename = "workspaceName")]
    workspace_name: String,
    /// 项目路径（必须是存在的目录）
    #[serde(rename = "projectPath")]
    project_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpScanDirectoryParams {
    /// 要扫描的目录路径
    path: String,
}

// ---- Todo MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpQueryTodosParams {
    /// 按状态筛选：todo, in_progress, done
    status: Option<String>,
    /// 按优先级筛选：high, medium, low
    priority: Option<String>,
    /// 按范围筛选：global, workspace, project
    scope: Option<String>,
    /// 范围引用（如工作空间名称或项目路径）
    #[serde(rename = "scopeRef")]
    scope_ref: Option<String>,
    /// 搜索关键词
    search: Option<String>,
    /// 返回数量上限
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCreateTodoParams {
    /// 任务标题
    title: String,
    /// 任务描述
    description: Option<String>,
    /// 优先级：high, medium, low
    priority: Option<String>,
    /// 范围：global, workspace, project
    scope: Option<String>,
    /// 范围引用（如工作空间名称或项目路径）
    #[serde(rename = "scopeRef")]
    scope_ref: Option<String>,
    /// 标签列表
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateTodoParams {
    /// Todo ID
    id: String,
    /// 新标题
    title: Option<String>,
    /// 新状态：todo, in_progress, done
    status: Option<String>,
    /// 新优先级：high, medium, low
    priority: Option<String>,
    /// 新描述
    description: Option<String>,
}

// ---- Memory MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemorySearchParams {
    /// 搜索关键词。兼容 query/search 两个字段。
    #[serde(alias = "search")]
    query: Option<String>,
    /// 作用域：global, workspace, project, session
    scope: Option<String>,
    /// 类别：decision, lesson, preference, pattern, fact, plan 或自定义字符串
    category: Option<String>,
    /// 最低重要度：1-5
    #[serde(rename = "minImportance", alias = "min_importance")]
    min_importance: Option<u8>,
    /// 工作空间名称
    #[serde(rename = "workspaceName", alias = "workspace_name")]
    workspace_name: Option<String>,
    /// 项目路径
    #[serde(rename = "projectPath", alias = "project_path")]
    project_path: Option<String>,
    /// 会话 ID
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    /// 标签过滤
    tags: Option<Vec<String>>,
    /// 排序：relevance, created_at, updated_at, importance
    #[serde(rename = "sortBy", alias = "sort_by")]
    sort_by: Option<String>,
    /// 返回数量上限
    limit: Option<u32>,
    /// 分页偏移
    offset: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemoryAddParams {
    /// 短标题（最多 200 字符）
    title: String,
    /// 记忆正文
    content: String,
    /// 作用域：global, workspace, project, session；默认 project
    scope: Option<String>,
    /// 类别：decision, lesson, preference, pattern, fact, plan 或自定义字符串；默认 fact
    category: Option<String>,
    /// 重要度：1-5；importance >= 4 才会作为核心记忆优先召回
    importance: Option<u8>,
    /// 工作空间名称；workspace/project 作用域建议填写
    #[serde(rename = "workspaceName", alias = "workspace_name")]
    workspace_name: Option<String>,
    /// 项目路径；project 作用域必填
    #[serde(rename = "projectPath", alias = "project_path")]
    project_path: Option<String>,
    /// 会话 ID；session 作用域必填
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    /// 标签
    tags: Option<Vec<String>>,
    /// 来源；默认 mcp
    source: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemoryUpdateParams {
    /// Memory ID
    id: String,
    /// 新标题
    title: Option<String>,
    /// 新正文
    content: Option<String>,
    /// 新类别
    category: Option<String>,
    /// 新重要度：1-5
    importance: Option<u8>,
    /// 新标签列表
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemoryIdParams {
    /// Memory ID
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpMemoryStatsParams {
    /// 工作空间名称
    #[serde(rename = "workspaceName", alias = "workspace_name")]
    workspace_name: Option<String>,
    /// 项目路径
    #[serde(rename = "projectPath", alias = "project_path")]
    project_path: Option<String>,
}

impl McpMemorySearchParams {
    fn into_query(self) -> std::result::Result<MemoryQuery, String> {
        Ok(MemoryQuery {
            search: self.query.filter(|value| !value.trim().is_empty()),
            scope: parse_memory_scope(self.scope.as_deref())?,
            category: self.category.as_deref().map(MemoryCategory::parse),
            min_importance: self.min_importance,
            workspace_name: self.workspace_name,
            project_path: self.project_path,
            session_id: self.session_id,
            tags: self.tags,
            from_date: None,
            to_date: None,
            sort_by: self.sort_by,
            limit: self.limit,
            offset: self.offset,
        })
    }
}

impl McpMemoryAddParams {
    fn into_request(self) -> std::result::Result<StoreMemoryRequest, String> {
        Ok(StoreMemoryRequest {
            title: self.title,
            content: self.content,
            scope: parse_memory_scope(self.scope.as_deref())?,
            category: self.category.as_deref().map(MemoryCategory::parse),
            importance: self.importance,
            workspace_name: self.workspace_name,
            project_path: self.project_path,
            session_id: self.session_id,
            tags: self.tags,
            source: Some(self.source.unwrap_or_else(|| "mcp".to_string())),
        })
    }
}

impl McpMemoryUpdateParams {
    fn into_request(self) -> UpdateMemoryRequest {
        UpdateMemoryRequest {
            title: self.title,
            content: self.content,
            category: self.category.as_deref().map(MemoryCategory::parse),
            importance: self.importance,
            tags: self.tags,
        }
    }
}

// ---- Skill MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListSkillsParams {
    /// 项目路径
    #[serde(rename = "projectPath")]
    project_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListExternalSkillsParams {
    /// 外部 Skill 来源：claude / codex / plugin；不传则返回全部
    source: Option<String>,
}

// ---- File MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpOpenFolderParams {
    /// 要在文件浏览器中打开的目录路径
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpOpenFileParams {
    /// 文件完整路径
    #[serde(rename = "filePath")]
    file_path: String,
    /// 文件所属项目路径（可选，自动推断）
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCloseFileParams {
    /// 要关闭的文件路径
    #[serde(rename = "filePath")]
    file_path: String,
}

// ---- PTY Control MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpWriteToSessionParams {
    /// 终端会话 ID（由 launch_task 返回）
    #[serde(rename = "sessionId")]
    session_id: String,
    /// 要写入终端的文本。控制键必须用 JSON \u 转义（\x 不是合法 JSON 转义）：Esc = "\u001b"，Shift+Tab = "\u001b[Z"，Ctrl+C = "\u0003"，Ctrl+D = "\u0004"，回车 = "\r"（CR 非 LF）。控制键必须走本工具，不能用 submit_to_session（它总会追加一个 CR，会把 Esc 变成 Esc+Enter）。要发字面反斜杠请写两个反斜杠。
    text: String,
}

/// MCP/REST 边界的容错转义解码。
///
/// 模型经常写出 `"\\x03"` 这类 JSON 表达不了的转义，反序列化后落到这里是
/// 字面的 `\`、`x`、`0`、`3` 四个字符，原样写进 PTY 就是"不报错也没效果"。
/// 这里把字面量 `\xNN` / `\uNNNN` / `\e` / `\r` / `\n` / `\t` / `\0` 还原成真字符，
/// 真控制字节本身不含反斜杠，因此该变换对已正确转义的输入是幂等的。
/// 想发字面反斜杠时用 `\\` 表示。
fn decode_terminal_escapes(input: &str) -> String {
    fn take_hex(chars: &[char], start: usize, len: usize) -> Option<char> {
        let digits: String = chars.get(start..start + len)?.iter().collect();
        if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        char::from_u32(u32::from_str_radix(&digits, 16).ok()?)
    }

    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' || i + 1 >= chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        match chars[i + 1] {
            '\\' => {
                out.push('\\');
                i += 2;
            }
            'x' => match take_hex(&chars, i + 2, 2) {
                Some(c) => {
                    out.push(c);
                    i += 4;
                }
                None => {
                    out.push(chars[i]);
                    i += 1;
                }
            },
            'u' => match take_hex(&chars, i + 2, 4) {
                Some(c) => {
                    out.push(c);
                    i += 6;
                }
                None => {
                    out.push(chars[i]);
                    i += 1;
                }
            },
            'e' => {
                out.push('\u{1b}');
                i += 2;
            }
            'r' => {
                out.push('\r');
                i += 2;
            }
            'n' => {
                out.push('\n');
                i += 2;
            }
            't' => {
                out.push('\t');
                i += 2;
            }
            '0' => {
                out.push('\0');
                i += 2;
            }
            // 未知转义原样保留，避免吞掉用户真想发的字符
            _ => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSubmitToSessionParams {
    /// 终端会话 ID（由 launch_task 返回）
    #[serde(rename = "sessionId")]
    session_id: String,
    /// 要提交的单行或多行文本。工具会用 bracketed-paste 整体写入，等待后再单独发送 CR。
    text: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetSessionStatusParams {
    /// 终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpWaitForSessionParams {
    /// 终端会话 ID；与 launchId 二选一
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// launch_task 的 launch ID；与 sessionId 二选一
    #[serde(rename = "launchId")]
    launch_id: Option<String>,
    /// 任一状态命中即返回；状态名与 get_session_status 一致
    #[serde(rename = "waitFor")]
    #[schemars(with = "Vec<String>")]
    wait_for: Vec<SessionStatus>,
    /// 最长等待毫秒数，默认 180000，范围 1000..=570000
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpKillSessionParams {
    /// 要终止的终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetSessionOutputParams {
    /// 终端会话 ID（由 launch_task 返回）
    #[serde(rename = "sessionId")]
    session_id: String,
    /// 返回最近 N 行（0 或不传 = 全部缓冲，建议 100-500）
    lines: Option<usize>,
}

fn notification_metadata_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": ["object", "null"]
    })
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpTriggerNotificationParams {
    kind: String,
    title: String,
    body: Option<String>,
    source: Option<String>,
    scope: Option<String>,
    #[serde(rename = "dedupeKey")]
    dedupe_key: Option<String>,
    #[serde(rename = "groupKey")]
    group_key: Option<String>,
    #[serde(rename = "onlyWhenUnfocused")]
    only_when_unfocused: Option<bool>,
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpCcChanSayParams {
    /// 要显示在 cc酱气泡中的文本。
    text: String,
    /// 显示时长，单位毫秒。默认约 5.4 秒，限制在 1200..=30000。
    duration_ms: Option<u64>,
}

// ============ Runner Registry Params ============

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpListRunnerProfilesParams {
    /// 项目绝对路径
    project_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpUpsertRunnerProfileParams {
    /// 启动配置 ID（提供则更新，缺省则新建）
    #[serde(default)]
    id: Option<String>,
    /// 项目绝对路径
    project_path: String,
    /// 可选：所属工作空间名
    #[serde(default)]
    workspace_name: Option<String>,
    /// 配置名（如 "frontend dev"）
    name: String,
    /// 启动命令（如 "npm run dev"）
    command: String,
    /// 工作目录
    cwd: String,
    /// local / wsl / ssh
    runtime_kind: String,
    /// WSL distro 名（runtime_kind=wsl 时必填）
    #[serde(default)]
    wsl_distro: Option<String>,
    /// SSH machine ID（runtime_kind=ssh 时必填）
    #[serde(default)]
    ssh_machine_id: Option<String>,
    /// 额外环境变量
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    /// 期望监听的端口（用于启动前预演冲突）
    #[serde(default)]
    expected_ports: Vec<u16>,
    /// 工具提示：npm / cargo / mvn / sh / docker（元信息）
    #[serde(default)]
    tool_hint: Option<String>,
}

impl From<McpUpsertRunnerProfileParams> for cc_panes_core::models::RunnerProfileDraft {
    fn from(p: McpUpsertRunnerProfileParams) -> Self {
        Self {
            id: p.id,
            project_path: p.project_path,
            workspace_name: p.workspace_name,
            name: p.name,
            command: p.command,
            cwd: p.cwd,
            runtime_kind: p.runtime_kind,
            wsl_distro: p.wsl_distro,
            ssh_machine_id: p.ssh_machine_id,
            env: p.env,
            expected_ports: p.expected_ports,
            tool_hint: p.tool_hint,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpDeleteRunnerProfileParams {
    /// 启动配置 ID
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpPlanRunnerLaunchParams {
    /// 启动配置 ID
    profile_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpStartRunnerParams {
    /// 启动配置 ID
    profile_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpWorkspacePortReservationsParams {
    /// 工作空间名称
    workspace_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpListActiveRunnersParams {
    /// 可选：按项目路径过滤
    #[serde(default)]
    project_path: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpListPortConflictsParams {
    /// 要查询的端口列表
    ports: Vec<u16>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpKillRunnerPidParams {
    /// 目标 PID
    pid: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpStopRunnerParams {
    /// 运行实例 ID
    instance_id: String,
}

impl From<McpTriggerNotificationParams> for NotificationRequest {
    fn from(value: McpTriggerNotificationParams) -> Self {
        Self {
            kind: value.kind,
            title: value.title,
            body: value.body,
            source: value.source,
            scope: value.scope,
            dedupe_key: value.dedupe_key,
            group_key: value.group_key,
            only_when_unfocused: value.only_when_unfocused,
            metadata: value.metadata,
        }
    }
}

// ---- Launch History / Resume Sessions MCP 参数 ----

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListLaunchHistoryParams {
    /// 按项目路径筛选（可选）
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
    /// 返回数量上限（默认 20）
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListClaudeSessionsParams {
    /// 项目路径（可选，不传则返回所有项目的会话）
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
    /// 返回数量上限（默认 20）
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListResumeSessionsParams {
    /// CLI 工具类型：`"claude"` | `"codex"`，默认 `"claude"`
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
    /// 运行环境：`"local"` | `"wsl"`，默认 `"local"`
    #[serde(rename = "runtimeKind")]
    runtime_kind: Option<String>,
    /// WSL distro 名称（可选，不传则使用默认 distro）
    #[serde(rename = "wslDistro")]
    wsl_distro: Option<String>,
    /// 项目路径（可选，不传则返回所有项目的会话）
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
    /// 返回数量上限（默认 20）
    limit: Option<usize>,
}

// ============ TaskBinding MCP 参数 ============

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCreateTaskBindingParams {
    /// 任务标题（简短描述）
    title: String,
    /// 角色：task/leader/worker
    role: Option<String>,
    /// 父任务 ID（worker 指向 leader）
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    /// Plan 文件路径
    #[serde(rename = "planPath")]
    plan_path: Option<String>,
    /// 已归一化 Plan 文件路径
    #[serde(rename = "normalizedPlanPath")]
    normalized_plan_path: Option<String>,
    /// 完整 prompt（可能比 title 长）
    prompt: Option<String>,
    /// 关联终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// Claude/Codex 可恢复会话 ID
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// UI pane ID（仅作快速定位缓存）
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// UI tab ID（仅作快速定位缓存）
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// 项目路径
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 工作空间名称
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// CLI 工具类型：claude/codex/gemini/opencode/cursor
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
    /// 附加元数据（小 JSON 对象）
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateTaskBindingParams {
    /// 任务 ID
    id: String,
    /// 新标题
    title: Option<String>,
    /// 新角色：task/leader/worker
    role: Option<String>,
    /// 父任务 ID
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    /// Plan 文件路径
    #[serde(rename = "planPath")]
    plan_path: Option<String>,
    /// 完整 prompt
    prompt: Option<String>,
    /// 新状态：pending/running/waiting/completed/failed
    status: Option<String>,
    /// 进度 0-100
    progress: Option<i32>,
    /// 完成摘要
    #[serde(rename = "completionSummary")]
    completion_summary: Option<String>,
    /// 关联终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// Claude/Codex 可恢复会话 ID
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// UI pane ID
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// UI tab ID
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// 退出码
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    /// 附加元数据（小 JSON 对象）
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpDeleteTaskBindingParams {
    /// TaskBinding ID
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpFindTaskBindingBySessionParams {
    /// 关联终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpReportToLeaderParams {
    /// worker TaskBinding ID
    worker_id: String,
    /// 可覆盖上报状态；默认使用 worker 当前状态
    status: Option<String>,
    /// 可覆盖上报摘要；默认使用 worker.completion_summary
    summary: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpQueryTaskBindingsParams {
    /// 按状态过滤：pending/running/waiting/completed/failed
    status: Option<String>,
    /// 按角色过滤：task/leader/worker
    role: Option<String>,
    /// 按父任务 ID 过滤
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    /// 按 Plan 文件路径过滤
    #[serde(rename = "planPath")]
    plan_path: Option<String>,
    /// 按 pane ID 过滤
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// 按 session ID 过滤
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    /// 按 resume ID 过滤
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// 按项目路径过滤
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
    /// 按工作空间过滤
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// 搜索关键词
    search: Option<String>,
    /// 返回数量上限（默认 50）
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpRegisterPlanLeaderParams {
    /// Plan 文件路径
    #[serde(rename = "planPath")]
    plan_path: String,
    /// 项目路径
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 标题
    title: Option<String>,
    /// 完整 prompt
    prompt: Option<String>,
    /// leader 的 PTY session ID
    #[serde(rename = "sessionId")]
    session_id: String,
    /// leader 的 Claude/Codex resume ID
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// UI pane ID
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// UI tab ID
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// 工作空间名称
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// CLI 工具类型，默认 claude
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpRegisterPlanWorkerParams {
    /// leader TaskBinding ID
    #[serde(rename = "leaderId")]
    leader_id: Option<String>,
    /// Plan 文件路径（leaderId 不传时使用）
    #[serde(rename = "planPath")]
    plan_path: Option<String>,
    /// worker 的 PTY session ID
    #[serde(rename = "sessionId")]
    session_id: String,
    /// 项目路径
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 标题
    title: Option<String>,
    /// 完整 prompt（可选，用于审计/重派）
    prompt: Option<String>,
    /// worker 的 Claude/Codex resume ID
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// UI pane ID
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// UI tab ID
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// 工作空间名称
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// CLI 工具类型，默认 codex
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpPlanCollaborationParams {
    /// leader TaskBinding ID
    #[serde(rename = "leaderId")]
    leader_id: Option<String>,
    /// Plan 文件路径
    #[serde(rename = "planPath")]
    plan_path: Option<String>,
    /// 是否返回 prompt/metadata/completionSummary
    verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListRecentPlansParams {
    /// 项目路径（必填）
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 工作空间名（可选，若指定则按 workspace 召回；否则按 project）
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// 返回数量上限,默认 1
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSearchPlansParams {
    /// 项目路径（必填）
    #[serde(rename = "projectPath")]
    project_path: String,
    /// 工作空间名（可选）
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// 关键词（在 intent/followups/tags 中模糊匹配）
    keyword: String,
    /// 返回数量上限,默认 3
    limit: Option<i64>,
    /// 当前会话 ID（用于热度统计的同 session 去重）
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSetPlanArchivedParams {
    /// Plan id
    id: i64,
    /// true=归档（不再召回），false=恢复
    archived: bool,
}

// ============ MCP Config MCP 参数 ============

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpProjectMcpParams {
    /// 项目路径（必须是已注册项目）
    #[serde(rename = "projectPath")]
    project_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpNamedProjectMcpParams {
    /// 项目路径（必须是已注册项目）
    #[serde(rename = "projectPath")]
    project_path: String,
    /// MCP Server 名称
    name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpsertProjectMcpServerParams {
    /// 项目路径（必须是已注册项目）
    #[serde(rename = "projectPath")]
    project_path: String,
    /// MCP Server 名称
    name: String,
    /// 启动命令，例如 npx、node、python
    command: String,
    /// 命令参数；不传则默认为空数组
    args: Option<Vec<String>>,
    /// 环境变量；不传则默认为空对象
    env: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpUpsertSharedMcpServerParams {
    /// 共享 MCP Server 名称
    name: String,
    /// 原始启动命令，例如 npx、node、python
    command: String,
    /// 原始命令参数；不传则更新时保留原值，创建时默认为空数组
    args: Option<Vec<String>>,
    /// 环境变量；不传则更新时保留原值，创建时默认为空对象
    env: Option<HashMap<String, String>>,
    /// 是否启用共享；不传则更新时保留原值，创建时默认为 true
    shared: Option<bool>,
    /// HTTP 端口；不传则更新时保留原值，创建时自动分配
    port: Option<u16>,
    /// 桥接模式：mcp-proxy 或 native-http
    bridge_mode: Option<String>,
    /// 写入配置后是否启动；默认 false
    start: Option<bool>,
    /// 如果该共享 MCP 正在运行，是否重启以应用新配置；start=true 时会自动重启
    restart_if_running: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSharedMcpServerNameParams {
    /// 共享 MCP Server 名称
    name: String,
}

// ============ CLI Launcher MCP 参数 ============

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpCliLauncherToolParams {
    /// CLI 工具 ID，例如 claude、codex、gemini、kimi、glm、opencode、cursor。
    #[serde(alias = "cli_tool_id", alias = "cliTool")]
    cli_tool_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpSetCliLauncherOverrideParams {
    /// CLI 工具 ID，例如 claude、codex、gemini、kimi、glm、opencode、cursor。
    #[serde(alias = "cli_tool_id", alias = "cliTool")]
    cli_tool_id: String,
    /// 要用于新本地会话的可执行程序路径或命令名，例如 reclaude 或 C:\...\reclaude.exe。
    command: String,
}

// ============ Runtime Config MCP 参数 ============

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpRuntimeMcpPolicyParams {
    /// MCP 模式：default / custom / disabled
    mode: Option<String>,
    /// custom 模式下启用的 MCP server ID/name
    enabled_server_ids: Option<Vec<String>>,
    /// default/custom 模式下禁用的 MCP server ID/name
    disabled_server_ids: Option<Vec<String>>,
    /// 是否注入 CC-Panes 自身 orchestrator MCP
    include_ccpanes_mcp: Option<bool>,
    /// 是否注入共享 MCP server
    include_shared_mcp: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpRuntimeSkillPolicyParams {
    /// Skill 模式：core / custom / disabled
    mode: Option<String>,
    /// custom 模式下启用的 Skill ID
    enabled_skill_ids: Option<Vec<String>>,
    /// core/custom 模式下禁用的 Skill ID
    disabled_skill_ids: Option<Vec<String>>,
    /// 是否启用工作空间项目 Skill
    include_project_skills: Option<bool>,
    /// 是否允许 Claude 全局 Agent Skills
    include_external_claude_skills: Option<bool>,
    /// 是否允许 Codex 全局 Skills
    include_external_codex_skills: Option<bool>,
    /// 是否允许 Claude plugin 注入的 Skills
    include_external_plugin_skills: Option<bool>,
    /// Skill 注入目标，当前主要使用 session
    target: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpRuntimeSharedMcpServerParams {
    /// 共享 MCP server 名称，也是运行配置中引用的 server ID
    name: String,
    /// 原始启动命令，如 npx
    command: String,
    /// 命令参数，如 ["-y", "@upstash/context7-mcp"]
    args: Option<Vec<String>>,
    /// 环境变量
    env: Option<HashMap<String, String>>,
    /// 是否作为共享 MCP 启用，默认 true
    shared: Option<bool>,
    /// 指定端口；不传则复用同名 server 端口或从共享 MCP 端口池分配
    port: Option<u16>,
    /// 桥接模式：mcp-proxy / native-http
    bridge_mode: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct McpCreateRuntimeConfigParams {
    /// 可选：指定已有运行配置 ID 时更新该配置
    profile_id: Option<String>,
    /// 运行配置名称
    name: String,
    /// 可选别名；不传时后端会默认使用 name
    alias: Option<String>,
    /// 描述
    description: Option<String>,
    /// 绑定 Provider ID
    provider_id: Option<String>,
    /// 适用 CLI 工具，如 ["claude"] 或 ["codex"]；不传表示全部
    target_tools: Option<Vec<String>>,
    /// 适用运行时：local / wsl / ssh；不传表示全部
    target_runtime: Option<String>,
    /// MCP 策略
    mcp_policy: Option<McpRuntimeMcpPolicyParams>,
    /// Skill 策略
    skill_policy: Option<McpRuntimeSkillPolicyParams>,
    /// 可选：同时创建/更新共享 MCP server
    shared_mcp_servers: Option<Vec<McpRuntimeSharedMcpServerParams>>,
    /// 是否立即启动 sharedMcpServers 中声明的 server，默认 false
    start_shared_mcp_servers: Option<bool>,
    /// 可选：绑定目标工作空间
    workspace_name: Option<String>,
    /// 可选：绑定目标项目 ID
    project_id: Option<String>,
    /// 可选：绑定目标项目路径
    project_path: Option<String>,
    /// 是否将该运行配置设为工作空间默认配置，默认 false
    bind_to_workspace: Option<bool>,
    /// 是否将该运行配置设为项目配置，默认 false
    bind_to_project: Option<bool>,
    /// 是否设为系统默认运行配置，默认 false
    set_default: Option<bool>,
    /// name/alias 已存在时是否更新已有配置，默认 false
    overwrite_existing: Option<bool>,
    /// 只返回计划，不写入配置文件或启动进程
    dry_run: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpRuntimeConfigResult {
    profile: Option<LaunchProfile>,
    planned_draft: Option<LaunchProfileDraft>,
    resolution: Option<LaunchProfileResolution>,
    created_profile: bool,
    updated_profile: bool,
    planned_mcp_servers: Vec<String>,
    upserted_mcp_servers: Vec<String>,
    started_mcp_servers: Vec<String>,
    bound_workspace: Option<String>,
    bound_project: Option<String>,
    warnings: Vec<String>,
    dry_run: bool,
}

fn trim_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_trimmed(value: &str, field: &str) -> std::result::Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{} cannot be empty", field))
    } else {
        Ok(trimmed.to_string())
    }
}

fn normalize_cli_launcher_tool_id(
    cli_tool_id: &str,
    supported_ids: &[String],
) -> std::result::Result<String, String> {
    let cli_tool_id = cli_tool_id.trim().to_ascii_lowercase();
    if cli_tool_id.is_empty() {
        return Err("cliToolId cannot be empty".to_string());
    }
    if cli_tool_id == CliTool::None.as_id() {
        return Err("cliToolId 'none' does not have a launcher command".to_string());
    }
    if !supported_ids.iter().any(|id| id == &cli_tool_id) {
        return Err(format!(
            "Unknown cliToolId '{}'; supported values: {}",
            cli_tool_id,
            supported_ids.join(", ")
        ));
    }
    Ok(cli_tool_id)
}

fn normalize_cli_launcher_override_command(
    command: &str,
) -> std::result::Result<Option<String>, String> {
    let command = normalize_cli_command(command).trim();
    if command.is_empty() {
        return Ok(None);
    }
    if command.contains('\n') || command.contains('\r') {
        return Err("CLI launcher command cannot contain newlines".to_string());
    }
    if command.chars().count() > 1024 {
        return Err("CLI launcher command is too long (max 1024 chars)".to_string());
    }
    validate_command(command).map_err(|error| error.to_string())?;
    Ok(Some(command.to_string()))
}

fn clean_string_list(values: Option<&[String]>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for value in values.into_iter().flatten() {
        let value = value.trim();
        if !value.is_empty() && seen.insert(value.to_string()) {
            cleaned.push(value.to_string());
        }
    }
    cleaned
}

fn clean_target_tools(values: Option<&[String]>) -> Vec<String> {
    clean_string_list(values)
        .into_iter()
        .map(|tool| tool.to_ascii_lowercase())
        .collect()
}

fn normalize_target_runtime(value: Option<String>) -> std::result::Result<Option<String>, String> {
    let Some(runtime) = trim_optional_string(value).map(|value| value.to_ascii_lowercase()) else {
        return Ok(None);
    };
    if runtime == "all" {
        return Ok(None);
    }
    if matches!(runtime.as_str(), "local" | "wsl" | "ssh") {
        Ok(Some(runtime))
    } else {
        Err(format!(
            "Unknown targetRuntime '{}'; expected local, wsl, ssh, or all",
            runtime
        ))
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn build_runtime_mcp_policy(
    params: Option<&McpRuntimeMcpPolicyParams>,
    shared_server_names: &[String],
    warnings: &mut Vec<String>,
) -> std::result::Result<LaunchProfileMcpPolicy, String> {
    let mut policy = LaunchProfileMcpPolicy::default();

    if let Some(params) = params {
        policy.mode = parse_runtime_mcp_mode(params.mode.as_deref())?;
        policy.enabled_server_ids = clean_string_list(params.enabled_server_ids.as_deref());
        policy.disabled_server_ids = clean_string_list(params.disabled_server_ids.as_deref());
        if let Some(value) = params.include_ccpanes_mcp {
            policy.include_ccpanes_mcp = value;
        }
        if let Some(value) = params.include_shared_mcp {
            policy.include_shared_mcp = value;
        }
    }

    if !shared_server_names.is_empty() {
        if policy.mode == LaunchProfileMcpMode::Disabled {
            warnings.push(
                "sharedMcpServers were configured, but mcpPolicy.mode is disabled".to_string(),
            );
        } else {
            if policy.mode == LaunchProfileMcpMode::Default {
                policy.mode = LaunchProfileMcpMode::Custom;
            }
            policy.include_shared_mcp = true;
            for name in shared_server_names {
                push_unique(&mut policy.enabled_server_ids, name.clone());
            }
        }
    }

    Ok(policy)
}

fn build_runtime_skill_policy(
    params: Option<&McpRuntimeSkillPolicyParams>,
) -> std::result::Result<LaunchProfileSkillPolicy, String> {
    let mut policy = LaunchProfileSkillPolicy::default();

    if let Some(params) = params {
        policy.mode = parse_runtime_skill_mode(params.mode.as_deref())?;
        policy.enabled_skill_ids = clean_string_list(params.enabled_skill_ids.as_deref());
        policy.disabled_skill_ids = clean_string_list(params.disabled_skill_ids.as_deref());
        if let Some(value) = params.include_project_skills {
            policy.include_project_skills = value;
        }
        if let Some(value) = params.include_external_claude_skills {
            policy.include_external_claude_skills = value;
        }
        if let Some(value) = params.include_external_codex_skills {
            policy.include_external_codex_skills = value;
        }
        if let Some(value) = params.include_external_plugin_skills {
            policy.include_external_plugin_skills = value;
        }
        if let Some(target) = trim_optional_string(params.target.clone()) {
            policy.target = target;
        }
    }

    Ok(policy)
}

fn validate_runtime_shared_port(
    name: &str,
    port: u16,
    config: &SharedMcpConfig,
    claimed_ports: &HashMap<u16, String>,
) -> std::result::Result<(), String> {
    for (existing_name, server) in &config.servers {
        if existing_name != name && server.port == port {
            return Err(format!(
                "Port {} is already used by shared MCP server '{}'",
                port, existing_name
            ));
        }
    }
    if let Some(owner) = claimed_ports.get(&port) {
        if owner != name {
            return Err(format!(
                "Port {} is already claimed by shared MCP server '{}'",
                port, owner
            ));
        }
    }
    Ok(())
}

fn allocate_runtime_shared_port(
    config: &SharedMcpConfig,
    claimed_ports: &HashMap<u16, String>,
) -> std::result::Result<u16, String> {
    for port in config.port_range_start..=config.port_range_end {
        let used_by_config = config.servers.values().any(|server| server.port == port);
        if !used_by_config && !claimed_ports.contains_key(&port) {
            return Ok(port);
        }
    }
    Err(format!(
        "No free shared MCP port in {}..={}",
        config.port_range_start, config.port_range_end
    ))
}

fn build_runtime_shared_mcp_servers(
    params: &[McpRuntimeSharedMcpServerParams],
    config: &SharedMcpConfig,
) -> std::result::Result<Vec<(String, SharedMcpServerConfig)>, String> {
    let mut seen_names = HashSet::new();
    let mut claimed_ports: HashMap<u16, String> = HashMap::new();
    let mut servers = Vec::new();

    for param in params {
        let name = required_trimmed(&param.name, "sharedMcpServers[].name")?;
        if !seen_names.insert(name.clone()) {
            return Err(format!(
                "sharedMcpServers contains duplicate server name '{}'",
                name
            ));
        }

        let command = required_trimmed(&param.command, "sharedMcpServers[].command")?;
        let port = if let Some(port) = param.port {
            validate_runtime_shared_port(&name, port, config, &claimed_ports)?;
            port
        } else if let Some(existing) = config.servers.get(&name) {
            validate_runtime_shared_port(&name, existing.port, config, &claimed_ports)?;
            existing.port
        } else {
            allocate_runtime_shared_port(config, &claimed_ports)?
        };

        let bridge_mode = parse_bridge_mode(param.bridge_mode.as_deref())?;
        let server = SharedMcpServerConfig {
            command,
            args: param.args.clone().unwrap_or_default(),
            env: param.env.clone().unwrap_or_default(),
            shared: param.shared.unwrap_or(true),
            port,
            bridge_mode,
        };
        claimed_ports.insert(port, name.clone());
        servers.push((name, server));
    }

    Ok(servers)
}

fn build_upsert_shared_mcp_server_config(
    params: McpUpsertSharedMcpServerParams,
    config: &SharedMcpConfig,
) -> std::result::Result<(String, SharedMcpServerConfig), String> {
    let name = required_trimmed(&params.name, "name")?;
    let command = required_trimmed(&params.command, "command")?;
    validate_mcp_name(&name).map_err(|error| error.to_string())?;
    validate_command(&command).map_err(|error| error.to_string())?;

    let existing = config.servers.get(&name);
    let port = if let Some(port) = params.port {
        validate_runtime_shared_port(&name, port, config, &HashMap::new())?;
        port
    } else if let Some(existing) = existing {
        existing.port
    } else {
        allocate_runtime_shared_port(config, &HashMap::new())?
    };

    let bridge_mode = match params.bridge_mode.as_deref() {
        Some(value) => parse_bridge_mode(Some(value))?,
        None => existing
            .map(|server| server.bridge_mode.clone())
            .unwrap_or_default(),
    };

    let server = SharedMcpServerConfig {
        command,
        args: params
            .args
            .or_else(|| existing.map(|server| server.args.clone()))
            .unwrap_or_default(),
        env: params
            .env
            .or_else(|| existing.map(|server| server.env.clone()))
            .unwrap_or_default(),
        shared: params
            .shared
            .or_else(|| existing.map(|server| server.shared))
            .unwrap_or(true),
        port,
        bridge_mode,
    };

    Ok((name, server))
}

fn mask_mcp_env_values(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Object(env)) = map.get_mut("env") {
                for value in env.values_mut() {
                    *value = serde_json::Value::String("***".to_string());
                }
            }
            for child in map.values_mut() {
                mask_mcp_env_values(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                mask_mcp_env_values(item);
            }
        }
        _ => {}
    }
}

fn to_masked_mcp_json<T: Serialize>(value: &T) -> serde_json::Value {
    match serde_json::to_value(value) {
        Ok(mut value) => {
            mask_mcp_env_values(&mut value);
            value
        }
        Err(error) => serde_json::json!({
            "serializationError": error.to_string()
        }),
    }
}

fn runtime_profile_matches_key(profile: &LaunchProfile, name: &str, alias: Option<&str>) -> bool {
    let alias = alias.unwrap_or(name);
    profile.name == name
        || profile.name == alias
        || profile.alias.as_deref() == Some(name)
        || profile.alias.as_deref() == Some(alias)
}

fn find_runtime_project_index(
    workspace: &Workspace,
    project_id: Option<&str>,
    project_path: Option<&str>,
) -> std::result::Result<Option<usize>, String> {
    let project_id = project_id.map(str::trim).filter(|value| !value.is_empty());
    let project_path = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if project_id.is_none() && project_path.is_none() {
        return Ok(None);
    }

    let by_id = project_id.and_then(|id| {
        workspace
            .projects
            .iter()
            .position(|project| project.id == id)
    });
    if let Some(id) = project_id {
        if by_id.is_none() {
            return Err(format!(
                "Project id '{}' was not found in workspace '{}'",
                id, workspace.name
            ));
        }
    }

    let by_path = project_path.and_then(|path| {
        let normalized_path = normalize_path(path);
        workspace
            .projects
            .iter()
            .position(|project| normalize_path(&project.path) == normalized_path)
    });
    if let Some(path) = project_path {
        if by_path.is_none() {
            return Err(format!(
                "Project path '{}' was not found in workspace '{}'",
                path, workspace.name
            ));
        }
    }

    if let (Some(left), Some(right)) = (by_id, by_path) {
        if left != right {
            return Err("projectId and projectPath point to different projects".to_string());
        }
    }

    Ok(by_id.or(by_path))
}

/// MCP 工具处理器
#[derive(Clone)]
struct McpToolHandler {
    state: AppState,
    tool_router: ToolRouter<McpToolHandler>,
}

impl McpToolHandler {
    fn new(state: AppState) -> Self {
        let tool_router = Self::tool_router();
        Self { state, tool_router }
    }

    fn ccchan_say_impl(
        &self,
        text: &str,
        duration_ms: Option<u64>,
    ) -> std::result::Result<serde_json::Value, String> {
        emit_ccchan_say(
            &self.state.app_handle,
            &self.state.ccchan_service,
            text,
            duration_ms,
        )
    }

    /// Spec 后置钩子：如果 Todo 是 spec 类型，自动同步 Tasks 段到 Spec 文件
    fn try_sync_spec_for_todo(&self, todo: &crate::models::todo::TodoItem) {
        if todo.todo_type != "spec" {
            return;
        }
        // 从 description 解析 spec_id（格式："Spec: {spec_id}"）
        let spec_id = match todo.description.as_deref() {
            Some(desc) if desc.starts_with("Spec: ") => desc[6..].trim(),
            _ => return,
        };
        if spec_id.is_empty() {
            return;
        }
        let project_path = match &todo.scope_ref {
            Some(p) => p.clone(),
            None => return,
        };
        if let Err(e) = self.state.spec_service.sync_tasks(&project_path, spec_id) {
            warn!("[mcp] spec sync_tasks post-hook failed: {}", e);
        }
    }

    fn create_runtime_config_impl(
        &self,
        params: McpCreateRuntimeConfigParams,
    ) -> std::result::Result<McpRuntimeConfigResult, String> {
        let dry_run = params.dry_run.unwrap_or(false);
        let mut warnings = Vec::new();

        let name = required_trimmed(&params.name, "name")?;
        let alias = trim_optional_string(params.alias.clone());
        let provider_id = trim_optional_string(params.provider_id.clone());
        if let Some(provider_id) = provider_id.as_deref() {
            if self
                .state
                .provider_service
                .get_provider(provider_id)
                .is_none()
            {
                return Err(format!("Provider '{}' was not found", provider_id));
            }
        }

        let shared_config = self.state.shared_mcp_service.get_config();
        let shared_servers = build_runtime_shared_mcp_servers(
            params.shared_mcp_servers.as_deref().unwrap_or_default(),
            &shared_config,
        )?;
        let shared_server_names = shared_servers
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();

        let mcp_policy = build_runtime_mcp_policy(
            params.mcp_policy.as_ref(),
            &shared_server_names,
            &mut warnings,
        )?;
        let skill_policy = build_runtime_skill_policy(params.skill_policy.as_ref())?;
        let draft = LaunchProfileDraft {
            name: Some(name.clone()),
            alias: alias.clone(),
            description: trim_optional_string(params.description.clone()),
            provider_id: provider_id.clone(),
            adapter_options: HashMap::new(),
            target_tools: clean_target_tools(params.target_tools.as_deref()),
            target_runtime: normalize_target_runtime(params.target_runtime.clone())?,
            // YOLO 仅通过受控的 UI launch profile 启用，不经 MCP 播种危险 profile。
            yolo_mode: false,
            mcp_policy,
            skill_policy,
            is_default: params.set_default.unwrap_or(false),
        };

        let profiles = self.state.launch_profile_service.list_profiles();
        let requested_profile_id = trim_optional_string(params.profile_id.clone());
        let overwrite_existing = params.overwrite_existing.unwrap_or(false);
        let target_profile_id = if let Some(profile_id) = requested_profile_id {
            if profiles.iter().all(|profile| profile.id != profile_id) {
                return Err(format!("Launch profile '{}' was not found", profile_id));
            }
            Some(profile_id)
        } else if overwrite_existing {
            profiles
                .iter()
                .find(|profile| runtime_profile_matches_key(profile, &name, alias.as_deref()))
                .map(|profile| profile.id.clone())
        } else {
            None
        };

        if let Some(conflict) = profiles.iter().find(|profile| {
            runtime_profile_matches_key(profile, &name, alias.as_deref())
                && target_profile_id.as_deref() != Some(profile.id.as_str())
        }) {
            return Err(format!(
                "Launch profile '{}' already exists as '{}'; pass profileId or overwriteExisting=true",
                name, conflict.id
            ));
        }

        let bind_workspace = params.bind_to_workspace.unwrap_or(false);
        let bind_project = params.bind_to_project.unwrap_or(false);
        let mut workspace_for_binding = if bind_workspace || bind_project {
            let workspace_name =
                trim_optional_string(params.workspace_name.clone()).ok_or_else(|| {
                    "workspaceName is required when binding a runtime config".to_string()
                })?;
            Some(
                self.state
                    .workspace_service
                    .get_workspace(&workspace_name)
                    .map_err(|error| {
                        format!("Failed to load workspace '{}': {}", workspace_name, error)
                    })?,
            )
        } else {
            None
        };

        let project_index = if bind_project {
            let workspace = workspace_for_binding
                .as_ref()
                .expect("workspace exists when bindProject is true");
            let index = find_runtime_project_index(
                workspace,
                params.project_id.as_deref(),
                params.project_path.as_deref(),
            )?
            .ok_or_else(|| {
                "projectId or projectPath is required when bindToProject=true".to_string()
            })?;
            Some(index)
        } else {
            None
        };
        let bound_workspace = bind_workspace
            .then(|| {
                workspace_for_binding
                    .as_ref()
                    .map(|workspace| workspace.name.clone())
            })
            .flatten();
        let bound_project = project_index.and_then(|index| {
            workspace_for_binding
                .as_ref()
                .map(|workspace| workspace.projects[index].id.clone())
        });

        if dry_run {
            warnings
                .push("dryRun=true; no files were changed and no MCP server was started".into());
            return Ok(McpRuntimeConfigResult {
                profile: None,
                planned_draft: Some(draft),
                resolution: None,
                created_profile: false,
                updated_profile: false,
                planned_mcp_servers: shared_server_names,
                upserted_mcp_servers: Vec::new(),
                started_mcp_servers: Vec::new(),
                bound_workspace,
                bound_project,
                warnings,
                dry_run,
            });
        }

        let mut upserted_mcp_servers = Vec::new();
        for (name, server) in &shared_servers {
            self.state
                .shared_mcp_service
                .upsert_server(name, server.clone())
                .map_err(|error| {
                    format!("Failed to upsert shared MCP server '{}': {}", name, error)
                })?;
            upserted_mcp_servers.push(name.clone());
        }

        let mut started_mcp_servers = Vec::new();
        if params.start_shared_mcp_servers.unwrap_or(false) {
            for name in &upserted_mcp_servers {
                match self.state.shared_mcp_service.start_server(name) {
                    Ok(()) => started_mcp_servers.push(name.clone()),
                    Err(error) if error.contains("already running") => {
                        warnings.push(format!("Shared MCP server '{}' is already running", name));
                    }
                    Err(error) => warnings.push(format!(
                        "Failed to start shared MCP server '{}': {}",
                        name, error
                    )),
                }
            }
        }

        let (profile, created_profile, updated_profile) =
            if let Some(profile_id) = target_profile_id {
                let profile = self
                    .state
                    .launch_profile_service
                    .update_profile(&profile_id, draft.clone())
                    .map_err(|error| {
                        format!(
                            "Failed to update launch profile '{}': {}",
                            profile_id, error
                        )
                    })?;
                (profile, false, true)
            } else {
                let profile = self
                    .state
                    .launch_profile_service
                    .create_profile(draft.clone())
                    .map_err(|error| format!("Failed to create launch profile: {}", error))?;
                (profile, true, false)
            };

        if let Some(workspace) = workspace_for_binding.as_mut() {
            if bind_workspace {
                workspace.launch_profile_id = Some(profile.id.clone());
            }
            if let Some(index) = project_index {
                workspace.projects[index].launch_profile_id = Some(profile.id.clone());
            }
            self.state
                .workspace_service
                .write_workspace_json(&workspace.name, workspace)
                .map_err(|error| {
                    format!(
                        "Failed to bind launch profile to workspace '{}': {}",
                        workspace.name, error
                    )
                })?;
        }

        let resolution = self.resolve_runtime_profile_preview(
            &profile,
            params.workspace_name.as_deref(),
            bound_project.as_deref().or(params.project_id.as_deref()),
            provider_id.as_deref(),
        );

        Ok(McpRuntimeConfigResult {
            profile: Some(profile),
            planned_draft: None,
            resolution: Some(resolution),
            created_profile,
            updated_profile,
            planned_mcp_servers: shared_server_names,
            upserted_mcp_servers,
            started_mcp_servers,
            bound_workspace,
            bound_project,
            warnings,
            dry_run,
        })
    }

    fn resolve_runtime_profile_preview(
        &self,
        profile: &LaunchProfile,
        workspace_name: Option<&str>,
        project_id: Option<&str>,
        provider_id: Option<&str>,
    ) -> LaunchProfileResolution {
        let request = LaunchProfilePreviewRequest {
            profile_id: Some(profile.id.clone()),
            use_system_default: false,
            workspace_name: workspace_name.map(str::to_string),
            project_id: project_id.map(str::to_string),
            provider_id: provider_id.map(str::to_string),
            provider_selection: LaunchProviderSelection::Inherit,
            cli_tool: profile.target_tools.first().cloned(),
            runtime_kind: profile.target_runtime.clone(),
        };

        self.state.launch_profile_service.resolve_profile(
            &request,
            &self
                .state
                .workspace_service
                .list_workspaces()
                .unwrap_or_default(),
            &self.state.provider_service.list_providers(),
            &self.state.shared_mcp_service.get_config(),
            &self.state.shared_mcp_service.get_running_servers_urls(),
        )
    }

    fn supported_cli_launcher_ids(&self) -> Vec<String> {
        self.state
            .local_terminal_service
            .cli_registry()
            .list_tools()
            .into_iter()
            .map(|info| info.id.clone())
            .collect()
    }

    fn list_cli_launcher_overrides_impl(&self) -> serde_json::Value {
        let supported_tools = self
            .state
            .local_terminal_service
            .cli_registry()
            .list_tools()
            .into_iter()
            .map(|info| {
                serde_json::json!({
                    "id": info.id,
                    "displayName": info.display_name,
                    "defaultCommand": info.executable,
                    "versionArgs": info.version_args,
                })
            })
            .collect::<Vec<_>>();
        let settings = self.state.settings_service.get_settings();
        serde_json::json!({
            "supportedTools": supported_tools,
            "overrides": settings.cli_launchers.overrides,
            "effectiveOn": "new local sessions"
        })
    }

    fn set_cli_launcher_override_impl(
        &self,
        params: McpSetCliLauncherOverrideParams,
    ) -> std::result::Result<serde_json::Value, String> {
        let supported_ids = self.supported_cli_launcher_ids();
        let cli_tool_id = normalize_cli_launcher_tool_id(&params.cli_tool_id, &supported_ids)?;
        let command = normalize_cli_launcher_override_command(&params.command)?;
        let mut settings = self.state.settings_service.get_settings();
        let cleared = match command {
            Some(command) => {
                settings
                    .cli_launchers
                    .overrides
                    .insert(cli_tool_id.clone(), CliLauncherOverride { command });
                false
            }
            None => {
                settings.cli_launchers.overrides.remove(&cli_tool_id);
                true
            }
        };
        settings.merge_missing_defaults();
        let saved_command = settings
            .cli_launchers
            .command_for(&cli_tool_id)
            .map(str::to_string);
        self.state
            .settings_service
            .update_settings(settings)
            .map_err(|error| error.to_string())?;

        Ok(serde_json::json!({
            "cliToolId": cli_tool_id,
            "command": saved_command,
            "cleared": cleared,
            "effectiveOn": "new local sessions"
        }))
    }

    fn clear_cli_launcher_override_impl(
        &self,
        params: McpCliLauncherToolParams,
    ) -> std::result::Result<serde_json::Value, String> {
        self.set_cli_launcher_override_impl(McpSetCliLauncherOverrideParams {
            cli_tool_id: params.cli_tool_id,
            command: String::new(),
        })
    }
}

#[tool_router]
impl McpToolHandler {
    /// 启动一个新的 Claude Code 实例来执行指定任务，或恢复已有会话。
    /// 新任务：传 prompt（必需），会在 CC-Panes 中创建新标签页并注入 prompt。
    /// 恢复会话：传 resumeId（必需），会以 `claude --resume <id>` 启动，不注入 prompt。
    #[tool]
    async fn launch_task(
        &self,
        Parameters(params): Parameters<McpLaunchTaskParams>,
        extensions: Extensions,
    ) -> String {
        let is_resume = params.resume_id.is_some();
        let prompt_len = params.prompt.as_ref().map(|p| p.len()).unwrap_or(0);
        info!(project = %params.project_path, prompt_len, is_resume, "mcp::launch_task");

        // 从 HTTP 请求 URL 上的 `?launchId=...` 提取 caller launch_id（由 cli-adapters
        // 在写 MCP URL 时附带）。读不到时调用方可能不是 cc-pane 启动的 Claude（外部
        // claude code、REST、测试），此时父信息留空 → 顶层编号。
        let caller_launch_id: Option<String> = extensions
            .get::<http::request::Parts>()
            .and_then(|p| p.uri.query())
            .and_then(|q| {
                q.split('&').find_map(|pair| {
                    pair.strip_prefix("launchId=")
                        .filter(|v| !v.is_empty())
                        .map(|v| v.to_string())
                })
            });

        // 参数校验：prompt 和 resumeId 互斥，必须且只能提供其一
        if params.prompt.is_some() && params.resume_id.is_some() {
            return "错误: prompt 和 resumeId 互斥，不能同时提供".to_string();
        }
        if params.prompt.is_none() && params.resume_id.is_none() {
            return "错误: 必须提供 prompt 或 resumeId 其中之一".to_string();
        }

        // 白名单校验（DB 项目 + 工作空间项目）
        if !is_project_registered(&self.state, &params.project_path) {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }

        let provider_selection =
            match parse_provider_selection(params.provider_selection.as_deref()) {
                Ok(selection) => selection,
                Err(error) => return format!("错误: {}", error),
            };

        // 工作空间解析：workspace_name → workspace_path；Provider 继承由 TerminalService 统一解析
        let mut ws_name: Option<String> = params.workspace_name.clone();
        let mut ws_path: Option<String> = None;

        if let Some(ref name) = ws_name {
            match self.state.workspace_service.get_workspace(name) {
                Ok(ws) => {
                    ws_path = ws.path.clone();
                    debug!(workspace = %name, path = ?ws_path, "mcp::launch_task resolved workspace");
                }
                Err(e) => {
                    warn!(workspace = %name, err = %e, "mcp::launch_task workspace not found, ignoring");
                    ws_name = None;
                }
            }
        }

        let task_id = uuid::Uuid::new_v4().to_string();
        // launch_id 同时用作 history.project_id（`find_by_launch_id` 的查询键）。
        // 必须在 create_session 之前生成，作为 `?launchId=` 注入子 Claude 的 MCP URL；
        // 这样子 Claude 后续调 launch_task 时我们才能反查到它，串成 #N.M.K 的级联。
        let child_launch_id = format!("orch-{}", uuid::Uuid::new_v4());
        let project_id = child_launch_id.clone();
        let project_name = std::path::Path::new(&params.project_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(params.project_path.as_str())
            .to_string();

        // 解析 CLI 工具类型
        let cli_tool = match parse_launch_cli_tool(params.cli_tool.as_deref()) {
            Ok(tool) => tool,
            Err(error) => return format!("错误: {}", error),
        };

        // 非 resume 时通过 CLI 位置参数注入 prompt（避免 PTY stdin 时序问题）
        // 安全网：长 prompt 自动外部化为文件，避免终端黑屏
        let initial_prompt_owned = if !is_resume {
            params
                .prompt
                .map(|p| externalize_long_prompt(&params.project_path, &task_id, p))
        } else {
            None
        };
        let initial_prompt = initial_prompt_owned.as_deref();
        let runtime = match resolve_launch_runtime(
            &params.project_path,
            ws_name.as_deref(),
            params.cli_tool.as_deref(),
            params.runtime_kind.as_deref(),
            params.resume_id.as_deref(),
            &self.state,
        ) {
            Ok(runtime) => runtime,
            Err(error) => return format!("错误: {}", error),
        };

        // 在创建 PTY 之前捕获 backfill 起始时刻：本地 Windows / WSL Codex 不装 hook，
        // 靠 run_launch_history_backfill 启动后扫 ~/.codex/sessions 反查 rollout id 回填。
        // after_ts 必须早于 PTY spawn，否则 rollout 已生成但 mtime 早于扫描起点会被跳过。
        let backfill_after_ts = chrono::Utc::now().to_rfc3339();

        // 创建 PTY 会话（resume 时传 resume_id）
        // 把 child_launch_id 传进去，TerminalService 会写入 CC_PANES_LAUNCH_ID
        // 环境变量并把它附在 ccpanes MCP URL 的 `?launchId=` 上，让子 Claude
        // 之后再调 launch_task 时能被识别为本会话的 caller。
        let create_request = CoreCreateSessionRequest {
            launch_id: Some(child_launch_id.clone()),
            project_path: params.project_path.clone(),
            cols: 120,
            rows: 30,
            workspace_name: ws_name.clone(),
            provider_id: params.provider_id.clone(),
            provider_selection,
            launch_profile_id: None,
            workspace_path: ws_path.clone(),
            workspace_snapshot_id: None,
            launch_claude: cli_tool != CliTool::None,
            cli_tool,
            resume_id: params.resume_id.clone(),
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: initial_prompt.map(str::to_string),
            yolo_mode: None,
            adapter_options: None,
            extra_env: None,
            ssh: runtime.ssh.clone(),
            wsl: runtime.wsl.clone(),
        };
        let session_id = match backend_call(&self.state, move |backend| {
            backend.create_session(create_request)
        })
        .await
        {
            Ok(sid) => sid,
            Err(e) => {
                error!(err = %e, "mcp::launch_task failed to create session");
                let runtime_notice = runtime
                    .notice
                    .as_deref()
                    .map(|notice| format!("{} ", notice))
                    .unwrap_or_default();
                return format!("错误: 创建会话失败: {}{}", runtime_notice, e);
            }
        };

        if let Err(error) = self
            .state
            .history_watch_manager
            .on_session_created(&session_id, &params.project_path)
        {
            warn!(session_id = %session_id, err = %error, "mcp::launch_task failed to start local history watcher");
        }

        // 记录任务状态 + 清理旧任务
        {
            let mut tasks = self.state.tasks.lock().unwrap_or_else(|e| e.into_inner());
            cleanup_stale_tasks(&mut tasks);
            tasks.insert(
                task_id.clone(),
                TaskStatus {
                    task_id: task_id.clone(),
                    session_id: session_id.clone(),
                    status: "launching".to_string(),
                    error: None,
                    created_at: std::time::Instant::now(),
                },
            );
        }

        // 同步落 launch_history 行：project_id 就是 child_launch_id，pty_session_id
        // 一并写入。这样如果子 Claude 启动后立即再调 launch_task，
        // `find_by_launch_id(child_launch_id)` 能直接命中并拿到 pty_session_id，
        // 从而把孙标签认成 #N.M.K。
        // 这是后端 in-process 路径，不走 GUI 的 `historyService.add` 异步流。
        //
        // 极窄竞态（已知，不阻塞合并）：`create_session` 已经把 PTY spawn 起来；
        // 子 Claude 进程理论上可以在我们 INSERT 之前就发出第一次 launch_task。
        // 实测窗口 = "SQLite 同步 insert（亚毫秒）" vs "子进程冷启动到能发 MCP
        // 请求（秒级）"，相差两个数量级。如果未来出现"孙标签偶发降级到顶层"
        // 的现场，再考虑把 history 写入提前到 spawn 之前（需要 launch_id ↔
        // pty_session_id 的内存映射，或把 insert 移进 TerminalService 内部）。
        let provider_selection_str = params.provider_selection.as_deref();
        let wsl_distro = runtime.wsl.as_ref().and_then(|wsl| wsl.distro.as_deref());
        if let Err(error) = self.state.launch_history_service.add_with_pty_session(
            &child_launch_id,
            &project_name,
            &params.project_path,
            &session_id,
            cli_tool.as_id(),
            runtime.kind.as_str(),
            wsl_distro,
            ws_name.as_deref(),
            ws_path.as_deref(),
            Some(&params.project_path),
            params.provider_id.as_deref(),
            provider_selection_str,
            None,
            None,
        ) {
            warn!(
                child_launch_id = %child_launch_id,
                err = %error,
                "mcp::launch_task: failed to insert launch_history; grandchild numbering may degrade"
            );
        }

        // 本地 / WSL Codex 经 orchestrator 启动时不装 hook、不会自报 resume_session_id，
        // 也不走 GUI 的 startLaunchHistoryBackfill。这里补一个后端兜底回填：扫
        // ~/.codex/sessions 反查刚生成的 rollout id 回填 + emit history-updated，让 reload
        // 能自动恢复。仅新会话（无 resume_id）需要；resume 启动本就带 id。
        if cli_tool == CliTool::Codex
            && params.resume_id.is_none()
            && matches!(runtime.kind.as_str(), "local" | "wsl")
        {
            // WSL 时 rollout 的 session_meta.cwd 是 POSIX（/mnt/...），优先用 runtime.wsl.remote_path
            // （已解析为 POSIX）作为反查候选，最易命中；非 WSL 回退 workspace 路径。
            // 叠加 detect_in_sessions 的跨平台归一化（Windows/UNC↔POSIX）双保险。
            let backfill_workspace_path = if runtime.kind.as_str() == "wsl" {
                runtime
                    .wsl
                    .as_ref()
                    .map(|wsl| wsl.remote_path.clone())
                    .or_else(|| ws_path.clone())
            } else {
                ws_path.clone()
            };
            tauri::async_runtime::spawn(crate::services::run_launch_history_backfill(
                self.state.app_handle.clone(),
                self.state.launch_history_service.clone(),
                child_launch_id.clone(),
                session_id.clone(),
                "codex".to_string(),
                runtime.kind.as_str().to_string(),
                wsl_distro.map(|s| s.to_string()),
                params.project_path.clone(),
                backfill_workspace_path,
                backfill_after_ts.clone(),
            ));
        }

        // 通知前端
        // 推导 parent_session_id：当前 MCP 调用是否来自某个已知 Claude 实例。
        // caller_launch_id 由 URL query 注入；外部 Claude Code 或 REST 直连时为
        // None，结果落到顶层。
        let parent_session_id = caller_launch_id.and_then(|caller_launch_id| {
            // daemon 模式下会话建在 daemon 进程，必须走 backend 反查；失败再退回
            // launch_history DB（跨进程持久，但异步 backfill 可能尚未落库）。
            if let Some(session_id) = self
                .state
                .terminal_backend
                .backend()
                .find_session_id_by_launch_id(&caller_launch_id)
                .ok()
                .flatten()
            {
                return Some(session_id);
            }

            match self.state.launch_history_service.find_by_launch_id(&caller_launch_id) {
                Ok(Some(rec)) => rec.pty_session_id,
                Ok(None) => {
                    debug!(
                        caller_launch_id = %caller_launch_id,
                        "mcp::launch_task: caller launch_id has no live session or history record yet"
                    );
                    None
                }
                Err(error) => {
                    warn!(
                        caller_launch_id = %caller_launch_id,
                        err = %error,
                        "mcp::launch_task: failed to look up caller launch record"
                    );
                    None
                }
            }
        });

        let event = OrchestratorLaunchEvent {
            task_id: task_id.clone(),
            session_id: session_id.clone(),
            project_path: params.project_path.clone(),
            project_id,
            workspace_name: ws_name,
            provider_id: params.provider_id.clone(),
            provider_selection: params.provider_selection.clone(),
            workspace_path: ws_path,
            title: params.title.clone(),
            resume_id: params.resume_id.clone(),
            pane_id: params.pane_id.clone(),
            layout_id: params.layout_id.clone(),
            layout_name: params.layout_name.clone(),
            cli_tool: params.cli_tool.clone(),
            runtime_kind: runtime.kind.as_str().to_string(),
            runtime_source: runtime.source.to_string(),
            notice: runtime.notice.clone(),
            wsl: runtime.wsl.clone(),
            ssh: runtime.ssh.clone(),
            placement: params.placement.clone(),
            parent_session_id,
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-launch-task", &event);

        serde_json::json!({
            "taskId": task_id,
            "sessionId": session_id,
            "status": "launching",
            "runtimeKind": runtime.kind.as_str(),
            "runtimeSource": runtime.source,
            "notice": runtime.notice
        })
        .to_string()
    }

    /// 创建或更新运行配置。可同时创建共享 MCP server，并可绑定到 workspace/project。
    #[tool]
    async fn create_runtime_config(
        &self,
        Parameters(params): Parameters<McpCreateRuntimeConfigParams>,
    ) -> String {
        info!(name = %params.name, dry_run = params.dry_run.unwrap_or(false), "mcp::create_runtime_config");
        match self.create_runtime_config_impl(params) {
            Ok(result) => serde_json::to_string_pretty(&result)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 列出 AI 可管理的 CLI 启动命令覆盖配置。覆盖只影响新建的本地会话。
    #[tool]
    async fn list_cli_launcher_overrides(&self) -> String {
        debug!("mcp::list_cli_launcher_overrides");
        serde_json::to_string_pretty(&self.list_cli_launcher_overrides_impl())
            .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error))
    }

    /// 设置某个 CLI 工具的新本地会话启动命令覆盖。传空字符串会清除覆盖。
    #[tool]
    async fn set_cli_launcher_override(
        &self,
        Parameters(params): Parameters<McpSetCliLauncherOverrideParams>,
    ) -> String {
        info!(cli_tool_id = %params.cli_tool_id, "mcp::set_cli_launcher_override");
        match self.set_cli_launcher_override_impl(params) {
            Ok(result) => serde_json::to_string_pretty(&result)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 清除某个 CLI 工具的新本地会话启动命令覆盖，恢复使用默认命令。
    #[tool]
    async fn clear_cli_launcher_override(
        &self,
        Parameters(params): Parameters<McpCliLauncherToolParams>,
    ) -> String {
        info!(cli_tool_id = %params.cli_tool_id, "mcp::clear_cli_launcher_override");
        match self.clear_cli_launcher_override_impl(params) {
            Ok(result) => serde_json::to_string_pretty(&result)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 列出项目的所有 MCP Server 配置（读取 project/.claude/settings.local.json）。
    #[tool]
    async fn list_mcp_servers(
        &self,
        Parameters(params): Parameters<McpProjectMcpParams>,
    ) -> String {
        debug!(project = %params.project_path, "mcp::list_mcp_servers");
        if let Err(error) = validate_path(&params.project_path) {
            return format!("错误: {}", error);
        }
        if !is_project_registered(&self.state, &params.project_path) {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }
        match self
            .state
            .mcp_config_service
            .list_mcp_servers(&params.project_path)
        {
            Ok(servers) => {
                serde_json::json!({ "servers": to_masked_mcp_json(&servers) }).to_string()
            }
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 获取项目的单个 MCP Server 配置。
    #[tool]
    async fn get_mcp_server(
        &self,
        Parameters(params): Parameters<McpNamedProjectMcpParams>,
    ) -> String {
        debug!(project = %params.project_path, name = %params.name, "mcp::get_mcp_server");
        if let Err(error) = validate_path(&params.project_path) {
            return format!("错误: {}", error);
        }
        if !is_project_registered(&self.state, &params.project_path) {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }
        match self
            .state
            .mcp_config_service
            .get_mcp_server(&params.project_path, &params.name)
        {
            Ok(server) => serde_json::json!({ "server": to_masked_mcp_json(&server) }).to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 添加或更新项目级 MCP Server 配置，写入 project/.claude/settings.local.json。
    #[tool]
    async fn upsert_mcp_server(
        &self,
        Parameters(params): Parameters<McpUpsertProjectMcpServerParams>,
    ) -> String {
        info!(project = %params.project_path, name = %params.name, "mcp::upsert_mcp_server");
        if let Err(error) = validate_path(&params.project_path) {
            return format!("错误: {}", error);
        }
        if !is_project_registered(&self.state, &params.project_path) {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }
        if let Err(error) = validate_mcp_name(&params.name) {
            return format!("错误: {}", error);
        }
        if let Err(error) = validate_command(&params.command) {
            return format!("错误: {}", error);
        }

        let config = McpServerConfig {
            command: params.command,
            args: params.args.unwrap_or_default(),
            env: params.env.unwrap_or_default(),
        };
        match self.state.mcp_config_service.upsert_mcp_server(
            &params.project_path,
            &params.name,
            config.clone(),
        ) {
            Ok(()) => serde_json::json!({
                "projectPath": params.project_path,
                "name": params.name,
                "config": to_masked_mcp_json(&config),
                "updated": true
            })
            .to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 删除项目级 MCP Server 配置。
    #[tool]
    async fn remove_mcp_server(
        &self,
        Parameters(params): Parameters<McpNamedProjectMcpParams>,
    ) -> String {
        info!(project = %params.project_path, name = %params.name, "mcp::remove_mcp_server");
        if let Err(error) = validate_path(&params.project_path) {
            return format!("错误: {}", error);
        }
        if !is_project_registered(&self.state, &params.project_path) {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }
        match self
            .state
            .mcp_config_service
            .remove_mcp_server(&params.project_path, &params.name)
        {
            Ok(removed) => serde_json::json!({
                "projectPath": params.project_path,
                "name": params.name,
                "removed": removed
            })
            .to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 获取共享 MCP 全局配置。
    #[tool]
    async fn get_shared_mcp_config(&self) -> String {
        debug!("mcp::get_shared_mcp_config");
        serde_json::to_string_pretty(&to_masked_mcp_json(
            &self.state.shared_mcp_service.get_config(),
        ))
        .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error))
    }

    /// 获取共享 MCP Server 运行状态。
    #[tool]
    async fn get_shared_mcp_status(&self) -> String {
        debug!("mcp::get_shared_mcp_status");
        serde_json::json!({
            "servers": to_masked_mcp_json(&self.state.shared_mcp_service.get_all_status())
        })
        .to_string()
    }

    /// 添加或更新共享 MCP Server 配置，可选立即启动或重启。
    #[tool]
    async fn upsert_shared_mcp_server(
        &self,
        Parameters(params): Parameters<McpUpsertSharedMcpServerParams>,
    ) -> String {
        info!(name = %params.name, "mcp::upsert_shared_mcp_server");
        let config = self.state.shared_mcp_service.get_config();
        let start = params.start.unwrap_or(false);
        let restart_if_running = params.restart_if_running.unwrap_or(false);
        let (name, server) = match build_upsert_shared_mcp_server_config(params, &config) {
            Ok(value) => value,
            Err(error) => return format!("错误: {}", error),
        };

        let was_running = self
            .state
            .shared_mcp_service
            .get_all_status()
            .iter()
            .any(|info| info.name == name && info.status == SharedMcpServerStatus::Running);

        if let Err(error) = self
            .state
            .shared_mcp_service
            .upsert_server(&name, server.clone())
        {
            return format!("错误: {}", error);
        }

        let mut started = false;
        let mut restarted = false;
        let mut warnings = Vec::<String>::new();
        if start || (was_running && restart_if_running) {
            let result = if was_running {
                restarted = true;
                started = start;
                self.state.shared_mcp_service.restart_server(&name)
            } else {
                started = true;
                self.state.shared_mcp_service.start_server(&name)
            };
            if let Err(error) = result {
                warnings.push(format!(
                    "Failed to start/restart shared MCP server: {}",
                    error
                ));
            }
        }

        serde_json::json!({
            "name": name,
            "config": to_masked_mcp_json(&server),
            "updated": true,
            "started": started,
            "restarted": restarted,
            "warnings": warnings
        })
        .to_string()
    }

    /// 删除共享 MCP Server 配置（会先停止运行中的进程）。
    #[tool]
    async fn remove_shared_mcp_server(
        &self,
        Parameters(params): Parameters<McpSharedMcpServerNameParams>,
    ) -> String {
        info!(name = %params.name, "mcp::remove_shared_mcp_server");
        match self.state.shared_mcp_service.remove_server(&params.name) {
            Ok(()) => serde_json::json!({ "name": params.name, "removed": true }).to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 启动共享 MCP Server。
    #[tool]
    async fn start_shared_mcp_server(
        &self,
        Parameters(params): Parameters<McpSharedMcpServerNameParams>,
    ) -> String {
        info!(name = %params.name, "mcp::start_shared_mcp_server");
        match self.state.shared_mcp_service.start_server(&params.name) {
            Ok(()) => serde_json::json!({ "name": params.name, "started": true }).to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 停止共享 MCP Server。
    #[tool]
    async fn stop_shared_mcp_server(
        &self,
        Parameters(params): Parameters<McpSharedMcpServerNameParams>,
    ) -> String {
        info!(name = %params.name, "mcp::stop_shared_mcp_server");
        if !self
            .state
            .shared_mcp_service
            .get_config()
            .servers
            .contains_key(&params.name)
        {
            return format!("错误: Shared MCP server '{}' not found", params.name);
        }
        let was_running = self
            .state
            .shared_mcp_service
            .get_all_status()
            .iter()
            .any(|info| info.name == params.name && info.status == SharedMcpServerStatus::Running);
        self.state.shared_mcp_service.stop_server(&params.name);
        serde_json::json!({ "name": params.name, "stopped": was_running }).to_string()
    }

    /// 重启共享 MCP Server。
    #[tool]
    async fn restart_shared_mcp_server(
        &self,
        Parameters(params): Parameters<McpSharedMcpServerNameParams>,
    ) -> String {
        info!(name = %params.name, "mcp::restart_shared_mcp_server");
        match self.state.shared_mcp_service.restart_server(&params.name) {
            Ok(()) => serde_json::json!({ "name": params.name, "restarted": true }).to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 从 ~/.claude.json 导入 stdio MCP Server 到共享 MCP 配置。
    #[tool]
    async fn import_shared_mcp_from_claude(&self) -> String {
        info!("mcp::import_shared_mcp_from_claude");
        match self.state.shared_mcp_service.import_from_claude_json() {
            Ok(imported) => serde_json::json!({ "imported": imported }).to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 搜索 CC-Panes Memory。默认返回当前 memory.db 中匹配项；可按 scope/project/workspace/importance 过滤。
    #[tool]
    async fn memory_search(&self, Parameters(params): Parameters<McpMemorySearchParams>) -> String {
        debug!("mcp::memory_search");
        let query = match params.into_query() {
            Ok(query) => query,
            Err(error) => return format!("错误: {}", error),
        };
        match self.state.memory_service.search(query) {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: 搜索 Memory 失败: {}", error),
        }
    }

    /// 写入一条 CC-Panes Memory。用于保存稳定偏好、决策、经验、事实或计划。
    #[tool]
    async fn memory_add(&self, Parameters(params): Parameters<McpMemoryAddParams>) -> String {
        info!(title = %params.title, "mcp::memory_add");
        let request = match params.into_request() {
            Ok(request) => request,
            Err(error) => return format!("错误: {}", error),
        };
        match self.state.memory_service.store(request) {
            Ok(memory) => serde_json::to_string(&memory)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: 写入 Memory 失败: {}", error),
        }
    }

    /// 读取一条 CC-Panes Memory。
    #[tool]
    async fn memory_get(&self, Parameters(params): Parameters<McpMemoryIdParams>) -> String {
        debug!(id = %params.id, "mcp::memory_get");
        match self.state.memory_service.get(&params.id) {
            Ok(memory) => serde_json::to_string(&memory)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: 读取 Memory 失败: {}", error),
        }
    }

    /// 更新一条 CC-Panes Memory。
    #[tool]
    async fn memory_update(&self, Parameters(params): Parameters<McpMemoryUpdateParams>) -> String {
        info!(id = %params.id, "mcp::memory_update");
        let id = params.id.clone();
        let request = params.into_request();
        match self.state.memory_service.update(&id, request) {
            Ok(updated) => serde_json::json!({ "id": id, "updated": updated }).to_string(),
            Err(error) => format!("错误: 更新 Memory 失败: {}", error),
        }
    }

    /// 删除一条 CC-Panes Memory（软删除）。
    #[tool]
    async fn memory_delete(&self, Parameters(params): Parameters<McpMemoryIdParams>) -> String {
        info!(id = %params.id, "mcp::memory_delete");
        match self.state.memory_service.delete(&params.id) {
            Ok(deleted) => serde_json::json!({ "id": params.id, "deleted": deleted }).to_string(),
            Err(error) => format!("错误: 删除 Memory 失败: {}", error),
        }
    }

    /// 获取 CC-Panes Memory 统计。
    #[tool]
    async fn memory_stats(&self, Parameters(params): Parameters<McpMemoryStatsParams>) -> String {
        debug!("mcp::memory_stats");
        match self.state.memory_service.stats(
            params.workspace_name.as_deref(),
            params.project_path.as_deref(),
        ) {
            Ok(stats) => serde_json::to_string(&stats)
                .unwrap_or_else(|error| format!("错误: 序列化失败: {}", error)),
            Err(error) => format!("错误: 获取 Memory 统计失败: {}", error),
        }
    }

    /// 列出所有已注册的项目（DB 项目 + 工作空间项目）
    #[tool]
    async fn list_projects(&self) -> String {
        debug!("mcp::list_projects");
        let mut infos: Vec<serde_json::Value> = Vec::new();
        let mut seen = HashSet::new();

        // DB 项目
        for p in self
            .state
            .project_service
            .list_projects()
            .unwrap_or_default()
        {
            if !mark_project_path_seen(&mut seen, &p.path) {
                continue;
            }
            infos.push(serde_json::json!({
                "id": p.id.to_string(),
                "name": p.name,
                "path": p.path,
                "source": "db",
            }));
        }

        // 工作空间项目（去重：与 DB 路径重复则跳过）
        for ws in self
            .state
            .workspace_service
            .list_workspaces()
            .unwrap_or_default()
        {
            for p in &ws.projects {
                if !mark_project_path_seen(&mut seen, &p.path) {
                    continue;
                }
                infos.push(serde_json::json!({
                    "id": p.id,
                    "name": p.path.split(['/', '\\']).next_back().unwrap_or(&p.path),
                    "path": p.path,
                    "alias": p.alias,
                    "workspace": ws.name,
                    "source": "workspace",
                }));
            }
        }

        serde_json::json!({ "projects": infos }).to_string()
    }

    /// 查询已启动任务的当前状态
    #[tool]
    async fn get_task_status(
        &self,
        Parameters(params): Parameters<McpGetTaskStatusParams>,
    ) -> String {
        debug!(task_id = %params.task_id, "mcp::get_task_status");
        let statuses = query_all_session_statuses(&self.state).await.ok();
        let mut tasks = self.state.tasks.lock().unwrap_or_else(|e| e.into_inner());
        match tasks.get_mut(&params.task_id) {
            Some(status) => {
                if let Some(statuses) = statuses.as_deref() {
                    refresh_task_status(status, statuses);
                }
                serde_json::json!({
                    "taskId": status.task_id,
                    "sessionId": status.session_id,
                    "status": status.status,
                    "error": status.error,
                })
                .to_string()
            }
            None => {
                format!("错误: 任务 '{}' 不存在", params.task_id)
            }
        }
    }

    // ============ Workspace Tools ============

    /// 列出所有工作空间及其基本信息
    #[tool]
    async fn list_workspaces(&self) -> String {
        debug!("mcp::list_workspaces");
        match self.state.workspace_service.list_workspaces() {
            Ok(workspaces) => {
                let items: Vec<serde_json::Value> = workspaces
                    .iter()
                    .map(|ws| {
                        serde_json::json!({
                            "name": ws.name,
                            "alias": ws.alias,
                            "projectCount": ws.projects.len(),
                            "providerId": ws.provider_id,
                            "path": ws.path,
                            "pinned": ws.pinned,
                        })
                    })
                    .collect();
                serde_json::json!({ "workspaces": items }).to_string()
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 获取指定工作空间的详细信息，包括项目列表
    #[tool]
    async fn get_workspace(&self, Parameters(params): Parameters<McpGetWorkspaceParams>) -> String {
        debug!(name = %params.workspace_name, "mcp::get_workspace");
        match self
            .state
            .workspace_service
            .get_workspace(&params.workspace_name)
        {
            Ok(ws) => {
                let projects: Vec<serde_json::Value> = ws
                    .projects
                    .iter()
                    .map(|p| {
                        serde_json::json!({
                            "id": p.id,
                            "path": p.path,
                            "alias": p.alias,
                            "wslRemotePath": p.wsl_remote_path,
                            "ssh": p.ssh,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "name": ws.name,
                    "alias": ws.alias,
                    "projects": projects,
                    "providerId": ws.provider_id,
                    "path": ws.path,
                    "defaultEnvironment": ws.default_environment,
                    "cliEnvironmentDefaults": ws.cli_environment_defaults,
                    "wsl": ws.wsl,
                    "sshLaunch": ws.ssh_launch,
                    "pinned": ws.pinned,
                })
                .to_string()
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 创建新的工作空间。name 为工作空间名，path 可选指定根目录
    #[tool]
    async fn create_workspace(
        &self,
        Parameters(params): Parameters<McpCreateWorkspaceParams>,
    ) -> String {
        info!(name = %params.name, "mcp::create_workspace");
        match self
            .state
            .workspace_service
            .create_workspace(&params.name, params.path.as_deref())
        {
            Ok(ws) => {
                serde_json::to_string(&ws).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 将项目添加到指定工作空间。projectPath 必须是存在的目录
    #[tool]
    async fn add_project_to_workspace(
        &self,
        Parameters(params): Parameters<McpAddProjectToWorkspaceParams>,
    ) -> String {
        info!(ws = %params.workspace_name, path = %params.project_path, "mcp::add_project_to_workspace");
        match self
            .state
            .workspace_service
            .add_project(&params.workspace_name, &params.project_path)
        {
            Ok(project) => serde_json::to_string(&project)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 扫描目录发现 Git 仓库和 worktree，用于批量导入项目
    #[tool]
    async fn scan_directory(
        &self,
        Parameters(params): Parameters<McpScanDirectoryParams>,
    ) -> String {
        info!(path = %params.path, "mcp::scan_directory");
        match WorkspaceService::scan_directory(std::path::Path::new(&params.path)) {
            Ok(repos) => serde_json::json!({ "repos": repos }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    // ============ Todo Tools ============

    /// 查询待办任务列表，支持按状态、优先级、范围等条件筛选
    #[tool]
    async fn query_todos(&self, Parameters(params): Parameters<McpQueryTodosParams>) -> String {
        debug!("mcp::query_todos");
        let query = TodoQuery {
            status: params.status.and_then(|s| s.parse::<TodoStatus>().ok()),
            priority: params.priority.and_then(|s| s.parse::<TodoPriority>().ok()),
            scope: params.scope.and_then(|s| s.parse::<TodoScope>().ok()),
            scope_ref: params.scope_ref,
            search: params.search,
            limit: params.limit,
            ..Default::default()
        };
        match self.state.todo_service.query_todos(query) {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 创建新的待办任务
    #[tool]
    async fn create_todo(&self, Parameters(params): Parameters<McpCreateTodoParams>) -> String {
        info!(title = %params.title, "mcp::create_todo");
        let req = CreateTodoRequest {
            title: params.title,
            description: params.description,
            priority: params.priority.and_then(|s| s.parse::<TodoPriority>().ok()),
            scope: params.scope.and_then(|s| s.parse::<TodoScope>().ok()),
            scope_ref: params.scope_ref,
            tags: params.tags,
            ..Default::default()
        };
        match self.state.todo_service.create_todo(req) {
            Ok(todo) => {
                serde_json::to_string(&todo).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 更新待办任务的标题、状态、优先级或描述
    #[tool]
    async fn update_todo(&self, Parameters(params): Parameters<McpUpdateTodoParams>) -> String {
        info!(id = %params.id, "mcp::update_todo");
        let req = UpdateTodoRequest {
            title: params.title,
            status: params.status.and_then(|s| s.parse::<TodoStatus>().ok()),
            priority: params.priority.and_then(|s| s.parse::<TodoPriority>().ok()),
            description: params.description,
            ..Default::default()
        };
        match self.state.todo_service.update_todo(&params.id, req) {
            Ok(todo) => {
                // Spec 后置钩子：如果该 Todo 是 spec 类型，自动同步到 Spec 文件
                self.try_sync_spec_for_todo(&todo);
                serde_json::to_string(&todo).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    // ============ Skill Tools ============

    /// 列出项目的可用 Skill（命令模板），返回名称和预览
    #[tool]
    async fn list_skills(&self, Parameters(params): Parameters<McpListSkillsParams>) -> String {
        debug!(project = %params.project_path, "mcp::list_skills");
        match self.state.skill_service.list_skills(&params.project_path) {
            Ok(skills) => serde_json::json!({ "skills": skills }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 列出全局外部 Skill（Claude/Codex/plugin），不读取项目 .claude/commands
    #[tool]
    async fn list_external_skills(
        &self,
        Parameters(params): Parameters<McpListExternalSkillsParams>,
    ) -> String {
        let source = params
            .source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase);
        let result = match source.as_deref() {
            None => self.state.external_skill_registry.list(),
            Some("claude" | "codex" | "plugin") => self
                .state
                .external_skill_registry
                .list_by_source_filter(source.as_deref().unwrap()),
            Some(other) => {
                return format!(
                    "错误: unsupported source '{}'; expected claude, codex, or plugin",
                    other
                );
            }
        };
        match result {
            Ok(skills) => {
                let total = skills.len();
                serde_json::json!({ "skills": skills, "total": total }).to_string()
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    // ============ File Tools ============

    /// 在 CC-Panes 文件浏览器中导航到指定目录，自动切换到 Files 视图模式
    #[tool]
    async fn open_folder(&self, Parameters(params): Parameters<McpOpenFolderParams>) -> String {
        info!(path = %params.path, "mcp::open_folder");
        let path = std::path::Path::new(&params.path);
        if !path.exists() {
            return format!("错误: 路径 '{}' 不存在", params.path);
        }
        if !path.is_dir() {
            return format!("错误: '{}' 不是目录", params.path);
        }
        let canonical = match path.canonicalize() {
            Ok(p) => simplify_path_str(&p.to_string_lossy()),
            Err(e) => return format!("错误: 路径规范化失败: {}", e),
        };
        let event = OrchestratorOpenFolderEvent {
            path: canonical.clone(),
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-open-folder", &event);
        serde_json::json!({ "success": true, "path": canonical }).to_string()
    }

    /// 在 CC-Panes 编辑器中打开文件标签页，自动切换到 Files 视图模式。projectPath 可选，不传则自动推断
    #[tool]
    async fn open_file(&self, Parameters(params): Parameters<McpOpenFileParams>) -> String {
        info!(file = %params.file_path, "mcp::open_file");
        let file_path = std::path::Path::new(&params.file_path);
        if !file_path.exists() {
            return format!("错误: 文件 '{}' 不存在", params.file_path);
        }
        if !file_path.is_file() {
            return format!("错误: '{}' 不是文件", params.file_path);
        }
        let canonical_file = match file_path.canonicalize() {
            Ok(p) => simplify_path_str(&p.to_string_lossy()),
            Err(e) => return format!("错误: 路径规范化失败: {}", e),
        };

        // 推断 projectPath：优先用参数，否则从已注册项目做最长前缀匹配
        let project_path = if let Some(ref pp) = params.project_path {
            pp.clone()
        } else {
            let projects = self
                .state
                .project_service
                .list_projects()
                .unwrap_or_default();
            let normalized_file = canonical_file.replace('\\', "/");
            projects
                .iter()
                .filter_map(|p| {
                    let normalized_proj = p.path.replace('\\', "/");
                    if normalized_file.starts_with(&normalized_proj) {
                        Some((p.path.clone(), normalized_proj.len()))
                    } else {
                        None
                    }
                })
                .max_by_key(|(_, len)| *len)
                .map(|(path, _)| path)
                .unwrap_or_else(|| {
                    // fallback: 文件的父目录
                    file_path
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                })
        };

        let title = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "File".to_string());

        let event = OrchestratorOpenFileEvent {
            file_path: canonical_file.clone(),
            project_path: project_path.clone(),
            title,
        };
        let _ = self.state.app_handle.emit("orchestrator-open-file", &event);
        serde_json::json!({
            "success": true,
            "filePath": canonical_file,
            "projectPath": project_path,
        })
        .to_string()
    }

    /// 关闭 CC-Panes 编辑器中匹配的文件标签页
    #[tool]
    async fn close_file(&self, Parameters(params): Parameters<McpCloseFileParams>) -> String {
        info!(file = %params.file_path, "mcp::close_file");
        // open_file 发给前端的是 canonicalize 后的路径，前端按字符串精确匹配 tab；
        // 这里必须做同样的规范化，否则分隔符/大小写/相对路径差异会导致关不掉。
        // 文件已被删除时 canonicalize 会失败，此时用原始路径尽力匹配。
        let file_path = std::path::Path::new(&params.file_path)
            .canonicalize()
            .map(|p| simplify_path_str(&p.to_string_lossy()))
            .unwrap_or_else(|_| params.file_path.clone());
        let event = OrchestratorCloseFileEvent {
            file_path: file_path.clone(),
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-close-file", &event);
        serde_json::json!({
            "success": true,
            "filePath": file_path,
        })
        .to_string()
    }

    /// 查询 CC-Panes 编辑器中当前打开的所有文件标签页信息
    #[tool]
    async fn list_open_files(&self) -> String {
        debug!("mcp::list_open_files");
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();

        // 注册 pending query
        {
            let mut queries = self
                .state
                .pending_queries
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            queries.insert(request_id.clone(), tx);
        }

        // 发射查询事件给前端
        let event = OrchestratorQueryEvent {
            request_id: request_id.clone(),
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-query-open-files", &event);

        // 等待前端响应（超时 5 秒）
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(data)) => data,
            Ok(Err(_)) => "错误: 前端响应通道已关闭".to_string(),
            Err(_) => {
                // 超时，清理 pending query
                let mut queries = self
                    .state
                    .pending_queries
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queries.remove(&request_id);
                "错误: 查询超时（5秒），前端未响应".to_string()
            }
        }
    }

    /// 查询当前所有布局和面板信息（布局 ID/名称、面板 ID、稳定显示编号、标签数量、活跃标签等），可用于 launch_task 的 layoutId/layoutName/paneId 参数
    #[tool]
    async fn list_panes(&self) -> String {
        debug!("mcp::list_panes");
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();

        // 注册 pending query
        {
            let mut queries = self
                .state
                .pending_queries
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            queries.insert(request_id.clone(), tx);
        }

        // 发射查询事件给前端
        let event = OrchestratorQueryEvent {
            request_id: request_id.clone(),
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-query-panes", &event);

        // 等待前端响应（超时 5 秒）
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(data)) => data,
            Ok(Err(_)) => "错误: 前端响应通道已关闭".to_string(),
            Err(_) => {
                // 超时，清理 pending query
                let mut queries = self
                    .state
                    .pending_queries
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queries.remove(&request_id);
                "错误: 查询超时（5秒），前端未响应".to_string()
            }
        }
    }

    // ============ PTY Control Tools ============

    /// 向指定 PTY 会话写入文本/控制键（不做 Enter 时序处理）。控制键必须用 JSON \u 转义（\x 不是合法 JSON 转义，写 "\\x03" 只会送出 4 个字面字符）：Esc = "\u001b"，Shift+Tab = "\u001b[Z"，Ctrl+C = "\u0003"，Ctrl+D = "\u0004"，回车 = "\r"。控制键只能用本工具，不要用 submit_to_session（它会追加 CR）。提交命令或 prompt 请改用 submit_to_session。
    #[tool]
    async fn write_to_session(
        &self,
        Parameters(params): Parameters<McpWriteToSessionParams>,
    ) -> String {
        info!(session_id = %params.session_id, text_len = params.text.len(), "mcp::write_to_session");
        let sid = params.session_id.clone();
        // 容错：把模型写出的字面量转义（如 "\\x03"）还原成真控制字节。
        let txt = decode_terminal_escapes(&params.text);
        match backend_call(&self.state, move |backend| backend.write(&sid, &txt)).await {
            Ok(()) => serde_json::json!({
                "success": true,
                "sessionId": params.session_id,
            })
            .to_string(),
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::write_to_session failed");
                format!("错误: 写入会话 '{}' 失败: {}", params.session_id, e)
            }
        }
    }

    /// 向 PTY 会话提交单行或多行文本（自动处理 Enter 键时序）。内部用 bracketed-paste 写入完整文本，按长度等待 min(200 + (len/512)*30, 5000) ms，再单独发送 CR。适用于发送 slash command（如 "/plan"）或输入 prompt。控制键请改用 write_to_session。
    #[tool]
    async fn submit_to_session(
        &self,
        Parameters(params): Parameters<McpSubmitToSessionParams>,
    ) -> String {
        info!(session_id = %params.session_id, text_len = params.text.len(), "mcp::submit_to_session");
        // 安全网：长文本外部化为文件，避免 PTY 处理异常
        let fallback_dir = self
            .state
            .app_paths
            .data_dir()
            .to_string_lossy()
            .to_string();
        let effective_text = externalize_long_prompt(
            &fallback_dir,
            &uuid::Uuid::new_v4().to_string(),
            params.text,
        );
        match submit_text_to_session(
            self.state.terminal_backend.backend(),
            &params.session_id,
            &effective_text,
        )
        .await
        {
            Ok(()) => serde_json::json!({
                "success": true,
                "sessionId": params.session_id,
            })
            .to_string(),
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::submit_to_session failed");
                format!("错误: 提交到会话 '{}' 失败: {}", params.session_id, e)
            }
        }
    }

    /// 查询指定终端会话的当前状态（Active/Idle/WaitingInput/Exited）及最近输出时间。
    #[tool]
    async fn get_session_status(
        &self,
        Parameters(params): Parameters<McpGetSessionStatusParams>,
    ) -> String {
        debug!(session_id = %params.session_id, "mcp::get_session_status");
        match query_session_status(&self.state, &params.session_id).await {
            Ok(Some(status)) => serde_json::json!({
                "sessionId": status.session_id,
                "status": status.status,
                "lastOutputAt": status.last_output_at,
            })
            .to_string(),
            Ok(None) => format!("错误: 会话 '{}' 不存在", params.session_id),
            Err(e) => format!("错误: 获取会话状态失败: {}", e),
        }
    }

    /// 阻塞到指定会话进入 waitFor 中任一状态或超时。事件驱动且无忙轮询；WaitingInput/Error 会立即以 blockedReason 返回。超时后重新调用即可续等。
    #[tool]
    async fn wait_for_session(
        &self,
        Parameters(params): Parameters<McpWaitForSessionParams>,
    ) -> String {
        if params.wait_for.is_empty() {
            return "错误: waitFor 至少需要一个目标状态".to_string();
        }
        let session_id = match (params.session_id, params.launch_id) {
            (Some(session_id), None) if !session_id.trim().is_empty() => session_id,
            (None, Some(launch_id)) if !launch_id.trim().is_empty() => {
                let lookup_id = launch_id.clone();
                match backend_call(&self.state, move |backend| {
                    backend.find_session_id_by_launch_id(&lookup_id)
                })
                .await
                {
                    Ok(Some(session_id)) => session_id,
                    Ok(None) => return format!("错误: launchId '{}' 对应的会话不存在", launch_id),
                    Err(error) => return format!("错误: 解析 launchId 失败: {}", error),
                }
            }
            (Some(_), Some(_)) => return "错误: sessionId 与 launchId 只能提供一个".to_string(),
            _ => return "错误: 必须提供 sessionId 或 launchId".to_string(),
        };
        let timeout_ms = normalized_wait_timeout_ms(params.timeout_ms);
        info!(
            session_id = %session_id,
            timeout_ms,
            wait_for = ?params.wait_for,
            "mcp::wait_for_session"
        );

        let query_state = self.state.clone();
        let query_session_id = session_id.clone();
        match wait_for_session_with_query(
            self.state.session_state_machine.clone(),
            session_id,
            params.wait_for,
            std::time::Duration::from_millis(timeout_ms),
            move || {
                let state = query_state.clone();
                let session_id = query_session_id.clone();
                async move { query_session_status(&state, &session_id).await }
            },
        )
        .await
        {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|error| format!("错误: 序列化等待结果失败: {}", error)),
            Err(error) => format!("错误: 等待会话状态失败: {}", error),
        }
    }

    /// 列出所有活跃的终端会话及其状态，返回 sessionId、status、lastOutputAt。
    #[tool]
    async fn list_sessions(&self) -> String {
        debug!("mcp::list_sessions");
        match query_all_session_statuses(&self.state).await {
            Ok(statuses) => {
                let sessions: Vec<serde_json::Value> = statuses
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "sessionId": s.session_id,
                            "status": s.status,
                            "lastOutputAt": s.last_output_at,
                        })
                    })
                    .collect();
                serde_json::json!({ "sessions": sessions }).to_string()
            }
            Err(e) => format!("错误: 获取会话列表失败: {}", e),
        }
    }

    /// 终止指定的终端会话。会话将被立即关闭，PTY 进程被终止。
    #[tool]
    async fn kill_session(&self, Parameters(params): Parameters<McpKillSessionParams>) -> String {
        info!(session_id = %params.session_id, "mcp::kill_session");
        let sid = params.session_id.clone();
        match backend_call(&self.state, move |backend| {
            backend.kill_with_reason(&sid, KillReason::Mcp)
        })
        .await
        {
            Ok(()) => serde_json::json!({
                "success": true,
                "sessionId": params.session_id,
            })
            .to_string(),
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::kill_session failed");
                format!("错误: 终止会话 '{}' 失败: {}", params.session_id, e)
            }
        }
    }

    /// 显式触发桌面通知。适用于 MCP、hooks 或脚本按需发送通知。
    #[tool]
    async fn trigger_notification(
        &self,
        Parameters(params): Parameters<McpTriggerNotificationParams>,
    ) -> String {
        let mut request: NotificationRequest = params.into();
        if request.source.is_none() {
            request.source = Some("mcp".to_string());
        }
        match self.state.notification_service.trigger(
            &self.state.app_handle,
            &self.state.settings_service,
            request,
        ) {
            Ok(result) => serde_json::to_string(&result).unwrap_or_else(|_| {
                "{\"sent\":false,\"skipped\":true,\"reason\":\"serialization_failed\"}".to_string()
            }),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 让 cc酱在桌面浮窗中显示一句指定文本。适合轻量提醒、状态说明或手动打招呼。
    #[tool]
    async fn ccchan_say(&self, Parameters(params): Parameters<McpCcChanSayParams>) -> String {
        match self.ccchan_say_impl(&params.text, params.duration_ms) {
            Ok(result) => result.to_string(),
            Err(error) => format!("错误: {}", error),
        }
    }

    /// 读取终端会话的最近输出内容（纯文本，ANSI 已剥离）。
    /// 用途：监控其他 Claude 实例进度、提取错误信息、判断任务完成状态。
    /// 已退出的会话在 5 分钟内仍可读取。
    #[tool]
    async fn get_session_output(
        &self,
        Parameters(params): Parameters<McpGetSessionOutputParams>,
    ) -> String {
        let lines_param = params.lines.unwrap_or(0);
        debug!(session_id = %params.session_id, lines = lines_param, "mcp::get_session_output");
        let sid = params.session_id.clone();
        match backend_call(&self.state, move |backend| {
            backend.get_session_output(&sid, lines_param)
        })
        .await
        {
            Ok(output) => {
                let content = output.lines.join("\n");
                serde_json::json!({
                    "sessionId": output.session_id,
                    "lines": output.lines,
                    "content": content,
                    "lineCount": output.lines.len(),
                })
                .to_string()
            }
            Err(e) => {
                format!(
                    "错误: 会话 '{}' 不存在或已退出超过 5 分钟: {}",
                    params.session_id, e
                )
            }
        }
    }

    // ============ Launch History / Resume Sessions Tools ============

    /// 查询 CC-Panes 启动历史记录。返回 resumeSessionId（可用作 launch_task 的 resumeId）、
    /// cliTool、runtimeKind、lastPrompt、projectPath、launchedAt 等信息。
    /// 推荐 resume 流程：list_launch_history → 匹配 projectPath + 找到 resumeSessionId/cliTool → launch_task(resumeId=resumeSessionId, cliTool=cliTool)
    #[tool]
    async fn list_launch_history(
        &self,
        Parameters(params): Parameters<McpListLaunchHistoryParams>,
    ) -> String {
        let limit = params.limit.unwrap_or(20).min(100);
        debug!(limit, project_path = ?params.project_path, "mcp::list_launch_history");

        let result = if let Some(ref project_path) = params.project_path {
            self.state
                .launch_history_service
                .list_by_project(project_path, limit)
        } else {
            self.state.launch_history_service.list(limit)
        };

        match result {
            Ok(records) => {
                let items: Vec<serde_json::Value> = records
                    .into_iter()
                    .map(|r| {
                        serde_json::json!({
                            "id": r.id,
                            "projectId": r.project_id,
                            "projectName": r.project_name,
                            "projectPath": r.project_path,
                            "launchedAt": r.launched_at,
                            "resumeSessionId": r.resume_session_id,
                            "cliTool": r.cli_tool,
                            "runtimeKind": r.runtime_kind,
                            "wslDistro": r.wsl_distro,
                            "lastPrompt": r.last_prompt,
                            "workspaceName": r.workspace_name,
                        })
                    })
                    .collect();
                serde_json::json!({ "records": items, "total": items.len() }).to_string()
            }
            Err(e) => format!("错误: 查询启动历史失败: {}", e),
        }
    }

    /// 查询指定 CLI 的历史会话列表（Claude/Codex）。
    /// 返回 sessionId（可用作 launch_task 的 resumeId）、description、modifiedAt、projectPath、cliTool。
    #[tool]
    async fn list_resume_sessions(
        &self,
        Parameters(params): Parameters<McpListResumeSessionsParams>,
    ) -> String {
        let cli_tool = params.cli_tool.as_deref().unwrap_or("claude");
        let runtime_kind = params.runtime_kind.as_deref().unwrap_or("local");
        debug!(cli_tool, runtime_kind, project_path = ?params.project_path, "mcp::list_resume_sessions");
        let limit = params.limit.unwrap_or(20).min(100);

        let result: Result<Vec<serde_json::Value>, String> = match cli_tool {
            "claude" => {
                let sessions = if let Some(ref project_path) = params.project_path {
                    crate::services::claude_session_service::list_sessions(project_path, limit)
                } else {
                    crate::services::claude_session_service::list_all_sessions(limit)
                };
                sessions.map(|items| {
                    items
                        .into_iter()
                        .map(|session| {
                            serde_json::json!({
                                "sessionId": session.id,
                                "projectPath": session.project_path,
                                "modifiedAt": session.modified_at,
                                "description": session.description,
                                "cliTool": "claude",
                            })
                        })
                        .collect()
                })
            }
            "codex" => {
                let sessions = if runtime_kind == "wsl" {
                    if let Some(ref project_path) = params.project_path {
                        crate::services::codex_session_service::list_wsl_sessions(
                            project_path,
                            limit,
                            params.wsl_distro.as_deref(),
                        )
                    } else {
                        crate::services::codex_session_service::list_all_wsl_sessions(
                            limit,
                            params.wsl_distro.as_deref(),
                        )
                    }
                } else if let Some(ref project_path) = params.project_path {
                    crate::services::codex_session_service::list_sessions(project_path, limit)
                } else {
                    crate::services::codex_session_service::list_all_sessions(limit)
                };
                sessions.map(|items| {
                    items
                        .into_iter()
                        .map(|session| {
                            serde_json::json!({
                                "sessionId": session.id,
                                "projectPath": session.project_path,
                                "modifiedAt": session.modified_at,
                                "description": session.description,
                                "cliTool": "codex",
                                "runtimeKind": runtime_kind,
                                "wslDistro": params.wsl_distro,
                            })
                        })
                        .collect()
                })
            }
            other => Err(format!("错误: 不支持的 cliTool: {}", other)),
        };

        match result {
            Ok(sessions) => {
                serde_json::json!({ "sessions": sessions, "total": sessions.len() }).to_string()
            }
            Err(error) => error,
        }
    }

    /// 查询 Claude Code 历史会话列表（从 ~/.claude/projects/ 读取）。
    /// 返回 sessionId（可用作 launch_task 的 resumeId）、description、modifiedAt。
    #[tool]
    async fn list_claude_sessions(
        &self,
        Parameters(params): Parameters<McpListClaudeSessionsParams>,
    ) -> String {
        debug!(project_path = ?params.project_path, "mcp::list_claude_sessions");

        let limit = params.limit.unwrap_or(20).min(100);
        let result = if let Some(ref project_path) = params.project_path {
            crate::services::claude_session_service::list_sessions(project_path, limit)
        } else {
            crate::services::claude_session_service::list_all_sessions(limit)
        };

        match result {
            Ok(sessions) => {
                let items: Vec<serde_json::Value> = sessions
                    .into_iter()
                    .map(|s| {
                        serde_json::json!({
                            "sessionId": s.id,
                            "projectPath": s.project_path,
                            "modifiedAt": s.modified_at,
                            "description": s.description,
                        })
                    })
                    .collect();
                serde_json::json!({ "sessions": items, "total": items.len() }).to_string()
            }
            Err(e) => format!("错误: 查询 Claude 会话失败: {}", e),
        }
    }

    /// 创建编排任务（TaskBinding），用于跟踪和管理多任务编排
    #[tool]
    async fn create_task_binding(
        &self,
        Parameters(params): Parameters<McpCreateTaskBindingParams>,
    ) -> String {
        use crate::models::task_binding::{CreateTaskBindingRequest, TaskBindingRole};
        info!(title = %params.title, "mcp::create_task_binding");

        let req = CreateTaskBindingRequest {
            title: params.title,
            role: params.role.and_then(|s| s.parse::<TaskBindingRole>().ok()),
            parent_id: params.parent_id,
            plan_path: params.plan_path,
            normalized_plan_path: params.normalized_plan_path,
            prompt: params.prompt,
            session_id: params.session_id,
            resume_id: params.resume_id,
            pane_id: params.pane_id,
            tab_id: params.tab_id,
            todo_id: None,
            project_path: params.project_path,
            workspace_name: params.workspace_name,
            cli_tool: params.cli_tool,
            metadata: params.metadata,
        };

        match self.state.task_binding_service.create(req) {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 创建 TaskBinding 失败: {}", e),
        }
    }

    /// 更新编排任务的状态、进度、摘要等信息
    #[tool]
    async fn update_task_binding(
        &self,
        Parameters(params): Parameters<McpUpdateTaskBindingParams>,
    ) -> String {
        use crate::models::task_binding::{
            TaskBindingRole, TaskBindingStatus, UpdateTaskBindingRequest,
        };
        info!(id = %params.id, "mcp::update_task_binding");
        let task_id = params.id.clone();

        let req = UpdateTaskBindingRequest {
            title: params.title,
            role: params.role.and_then(|s| s.parse::<TaskBindingRole>().ok()),
            parent_id: params.parent_id,
            plan_path: params.plan_path,
            normalized_plan_path: None,
            prompt: params.prompt,
            session_id: params.session_id,
            resume_id: params.resume_id,
            pane_id: params.pane_id,
            tab_id: params.tab_id,
            status: params
                .status
                .and_then(|s| s.parse::<TaskBindingStatus>().ok()),
            progress: params.progress,
            completion_summary: params.completion_summary,
            exit_code: params.exit_code,
            sort_order: None,
            metadata: params.metadata,
        };

        match self
            .state
            .task_binding_service
            .update_returning_previous_status(&task_id, req)
        {
            Ok((old_status, binding)) => {
                notify_leader_on_terminal_status(self.state.clone(), old_status, binding.clone());
                serde_json::to_string(&binding)
                    .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e))
            }
            Err(e) => format!("错误: 更新 TaskBinding 失败: {}", e),
        }
    }

    /// 删除指定 TaskBinding。
    #[tool]
    async fn delete_task_binding(
        &self,
        Parameters(params): Parameters<McpDeleteTaskBindingParams>,
    ) -> String {
        info!(id = %params.id, "mcp::delete_task_binding");
        match self.state.task_binding_service.delete(&params.id) {
            Ok(deleted) => serde_json::json!({
                "success": true,
                "deleted": deleted,
                "id": params.id,
            })
            .to_string(),
            Err(e) => format!("错误: 删除 TaskBinding 失败: {}", e),
        }
    }

    /// 根据终端会话 ID 查找 TaskBinding。
    #[tool]
    async fn find_task_binding_by_session(
        &self,
        Parameters(params): Parameters<McpFindTaskBindingBySessionParams>,
    ) -> String {
        debug!(session_id = %params.session_id, "mcp::find_task_binding_by_session");
        match self
            .state
            .task_binding_service
            .find_by_session_id(&params.session_id)
        {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 查询 TaskBinding 失败: {}", e),
        }
    }

    /// Manually report a worker's terminal status to its leader via PTY. Bypasses automatic dedup. Use when the auto-notify did not fire (e.g. worker.status was already completed before this call).
    #[tool]
    async fn report_to_leader(
        &self,
        Parameters(params): Parameters<McpReportToLeaderParams>,
    ) -> String {
        info!(worker_id = %params.worker_id, "mcp::report_to_leader");
        let mut worker = match self.state.task_binding_service.get(&params.worker_id) {
            Ok(Some(binding)) => binding,
            Ok(None) => {
                return serde_json::json!({
                    "sent": false,
                    "skipReason": "worker not found",
                })
                .to_string()
            }
            Err(e) => {
                warn!(worker_id = %params.worker_id, err = %e, "mcp::report_to_leader failed to load worker");
                return serde_json::json!({
                    "sent": false,
                    "skipReason": format!("failed to load worker: {}", e),
                })
                .to_string();
            }
        };

        if let Some(status) = params.status {
            match status.parse::<TaskBindingStatus>() {
                Ok(status) => worker.status = status,
                Err(e) => {
                    return serde_json::json!({
                        "sent": false,
                        "skipReason": format!("invalid status: {}", e),
                    })
                    .to_string()
                }
            }
        }

        if let Some(summary) = params.summary {
            worker.completion_summary = Some(summary);
        }

        serde_json::to_string(&send_worker_report_to_leader(self.state.clone(), worker).await)
            .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e))
    }

    /// 查询编排任务列表（按状态、项目路径过滤）
    #[tool]
    async fn query_task_bindings(
        &self,
        Parameters(params): Parameters<McpQueryTaskBindingsParams>,
    ) -> String {
        use crate::models::task_binding::{TaskBindingQuery, TaskBindingRole, TaskBindingStatus};
        debug!("mcp::query_task_bindings");

        let query = TaskBindingQuery {
            status: params
                .status
                .and_then(|s| s.parse::<TaskBindingStatus>().ok()),
            role: params.role.and_then(|s| s.parse::<TaskBindingRole>().ok()),
            parent_id: params.parent_id,
            plan_path: params.plan_path,
            normalized_plan_path: None,
            pane_id: params.pane_id,
            session_id: params.session_id,
            resume_id: params.resume_id,
            project_path: params.project_path,
            workspace_name: params.workspace_name,
            search: params.search,
            limit: params.limit,
            offset: None,
        };

        match self.state.task_binding_service.query(query) {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 查询 TaskBindings 失败: {}", e),
        }
    }

    /// 登记 Plan-to-Codex 的 leader（发起规划的会话）。
    #[tool]
    async fn register_plan_leader(
        &self,
        Parameters(params): Parameters<McpRegisterPlanLeaderParams>,
    ) -> String {
        use crate::models::task_binding::RegisterPlanLeaderRequest;
        info!(plan_path = %params.plan_path, "mcp::register_plan_leader");

        let req = RegisterPlanLeaderRequest {
            plan_path: params.plan_path,
            project_path: params.project_path,
            title: params.title,
            prompt: params.prompt,
            session_id: Some(params.session_id),
            resume_id: params.resume_id,
            pane_id: params.pane_id,
            tab_id: params.tab_id,
            workspace_name: params.workspace_name,
            cli_tool: params.cli_tool,
            metadata: params.metadata,
        };

        match self.state.task_binding_service.register_plan_leader(req) {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 登记 Plan leader 失败: {}", e),
        }
    }

    /// 登记 Plan-to-Codex 的 worker（被派发执行的会话）。
    #[tool]
    async fn register_plan_worker(
        &self,
        Parameters(params): Parameters<McpRegisterPlanWorkerParams>,
    ) -> String {
        use crate::models::task_binding::RegisterPlanWorkerRequest;
        info!(session_id = %params.session_id, "mcp::register_plan_worker");

        let req = RegisterPlanWorkerRequest {
            leader_id: params.leader_id,
            plan_path: params.plan_path,
            session_id: params.session_id,
            project_path: params.project_path,
            title: params.title,
            prompt: params.prompt,
            resume_id: params.resume_id,
            pane_id: params.pane_id,
            tab_id: params.tab_id,
            workspace_name: params.workspace_name,
            cli_tool: params.cli_tool,
            metadata: params.metadata,
        };

        match self.state.task_binding_service.register_plan_worker(req) {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 登记 Plan worker 失败: {}", e),
        }
    }

    /// 兼容旧称：登记 Plan-to-Codex 的 worker。新流程请使用 register_plan_worker。
    #[tool]
    async fn register_plan_child(
        &self,
        Parameters(params): Parameters<McpRegisterPlanWorkerParams>,
    ) -> String {
        use crate::models::task_binding::RegisterPlanChildRequest;
        info!(session_id = %params.session_id, "mcp::register_plan_child");

        let req = RegisterPlanChildRequest {
            leader_id: params.leader_id,
            plan_path: params.plan_path,
            session_id: params.session_id,
            project_path: params.project_path,
            title: params.title,
            prompt: params.prompt,
            resume_id: params.resume_id,
            pane_id: params.pane_id,
            tab_id: params.tab_id,
            workspace_name: params.workspace_name,
            cli_tool: params.cli_tool,
            metadata: params.metadata,
        };

        match self.state.task_binding_service.register_plan_child(req) {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 登记 Plan worker 失败: {}", e),
        }
    }

    /// 查询一个 Plan 的 leader/worker 协作关系。默认 compact，不返回 prompt/metadata。
    #[tool]
    async fn get_plan_collaboration(
        &self,
        Parameters(params): Parameters<McpPlanCollaborationParams>,
    ) -> String {
        use crate::models::task_binding::PlanCollaborationKey;
        debug!("mcp::get_plan_collaboration");

        let key = PlanCollaborationKey {
            leader_id: params.leader_id,
            plan_path: params.plan_path,
            normalized_plan_path: None,
        };

        match self
            .state
            .task_binding_service
            .get_plan_collaboration(key, params.verbose.unwrap_or(false))
        {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 查询 Plan 协作关系失败: {}", e),
        }
    }

    /// 对一个 Plan 的 leader/worker 协作关系做活跃状态校准。
    #[tool]
    async fn reconcile_plan_collaboration(
        &self,
        Parameters(params): Parameters<McpPlanCollaborationParams>,
    ) -> String {
        use crate::models::task_binding::PlanCollaborationKey;
        debug!("mcp::reconcile_plan_collaboration");

        let key = PlanCollaborationKey {
            leader_id: params.leader_id,
            plan_path: params.plan_path,
            normalized_plan_path: None,
        };
        let live_sessions = collect_plan_live_sessions(&self.state).await;

        match self
            .state
            .task_binding_service
            .reconcile_plan_collaboration(key, live_sessions, params.verbose.unwrap_or(false))
        {
            Ok(result) => serde_json::to_string(&result)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 校准 Plan 协作关系失败: {}", e),
        }
    }

    /// 列出当前 workspace 或 project 最近的 plan 标签（按 created_at DESC）。
    /// 不递增 recall_count；用于"我之前做过什么"的快速浏览。
    #[tool]
    async fn list_recent_plans(
        &self,
        Parameters(params): Parameters<McpListRecentPlansParams>,
    ) -> String {
        let limit = params.limit.unwrap_or(1).clamp(1, 20);
        match self
            .state
            .plan_archive_service
            .list_recent_for_session_start(
                params.workspace_name.as_deref(),
                &params.project_path,
                limit,
            ) {
            Ok(items) => serde_json::to_string(&serde_json::json!({ "plans": items }))
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 查询最近 plan 失败: {}", e),
        }
    }

    /// 关键词检索 plan 标签（按 recall_count DESC, created_at DESC）。
    /// 命中后会递增 recall_count（同 plan + 同 session 去重）。
    /// 用于 recall skill 实现"上次/之前/我们做过"等召回。
    #[tool]
    async fn search_plans(&self, Parameters(params): Parameters<McpSearchPlansParams>) -> String {
        let limit = params.limit.unwrap_or(3).clamp(1, 20);
        match self.state.plan_archive_service.search_for_recall(
            &params.session_id,
            params.workspace_name.as_deref(),
            &params.project_path,
            &params.keyword,
            limit,
        ) {
            Ok(items) => serde_json::to_string(&serde_json::json!({ "plans": items }))
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 搜索 plan 失败: {}", e),
        }
    }

    /// 归档（淘汰）或恢复一条 plan。归档后召回与列表都不再返回该 plan。
    #[tool]
    async fn set_plan_archived(
        &self,
        Parameters(params): Parameters<McpSetPlanArchivedParams>,
    ) -> String {
        match self
            .state
            .plan_archive_service
            .set_archived(params.id, params.archived)
        {
            Ok(()) => serde_json::json!({ "success": true }).to_string(),
            Err(e) => format!("错误: 更新 plan archived 失败: {}", e),
        }
    }

    // ============ Runner Registry Tools ============
    //
    // 设计原则：工具只暴露状态 + 提供原子操作；冲突处理决策由 skill 编排（clean-launch.md）。
    // 端口/PID 跟踪本身在后端服务做（hook 周期扫描 + 显式登记），MCP 工具只读+写少量动作。

    /// 列出某项目下的所有启动配置（按 last_started_at 倒序）
    #[tool]
    async fn list_runner_profiles(
        &self,
        Parameters(params): Parameters<McpListRunnerProfilesParams>,
    ) -> String {
        debug!(project = %params.project_path, "mcp::list_runner_profiles");
        match self
            .state
            .runner_service
            .list_profiles(&params.project_path)
        {
            Ok(profiles) => serde_json::json!({ "profiles": profiles }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 创建或更新启动配置（id 为空 = 创建；否则按 id 更新）
    #[tool]
    async fn upsert_runner_profile(
        &self,
        Parameters(params): Parameters<McpUpsertRunnerProfileParams>,
    ) -> String {
        debug!(name = %params.name, "mcp::upsert_runner_profile");
        match self.state.runner_service.upsert_profile(params.into()) {
            Ok(profile) => serde_json::to_string(&profile)
                .unwrap_or_else(|e| format!("错误: 序列化失败 {}", e)),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 删除启动配置
    #[tool]
    async fn delete_runner_profile(
        &self,
        Parameters(params): Parameters<McpDeleteRunnerProfileParams>,
    ) -> String {
        debug!(id = %params.id, "mcp::delete_runner_profile");
        match self.state.runner_service.delete_profile(&params.id) {
            Ok(()) => serde_json::json!({ "deleted": true }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 启动前预演：返回该 profile 的 expected_ports 当前占用情况和处理建议
    #[tool]
    async fn plan_runner_launch(
        &self,
        Parameters(params): Parameters<McpPlanRunnerLaunchParams>,
    ) -> String {
        debug!(profile_id = %params.profile_id, "mcp::plan_runner_launch");
        match self.state.runner_service.plan_launch(&params.profile_id) {
            Ok(plan) => {
                serde_json::to_string(&plan).unwrap_or_else(|e| format!("错误: 序列化失败 {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 启动 runner profile：可复用 running instance、端口冲突阻断、或创建新 PTY 并提交命令。
    #[tool]
    async fn start_runner(&self, Parameters(params): Parameters<McpStartRunnerParams>) -> String {
        debug!(profile_id = %params.profile_id, "mcp::start_runner");
        match start_runner_coordinator(&params.profile_id, &self.state, &self.state.start_locks)
            .await
        {
            Ok(result) => {
                serde_json::to_string(&result).unwrap_or_else(|e| format!("错误: 序列化失败 {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 列出 workspace 内所有 runner profile 的 expected_ports 预留情况。
    #[tool]
    async fn list_workspace_port_reservations(
        &self,
        Parameters(params): Parameters<McpWorkspacePortReservationsParams>,
    ) -> String {
        debug!(workspace = %params.workspace_name, "mcp::list_workspace_port_reservations");
        match self
            .state
            .runner_service
            .list_profiles_by_workspace(&params.workspace_name)
        {
            Ok(profiles) => {
                let reservations = profiles
                    .into_iter()
                    .map(|profile| PortReservation {
                        profile_id: profile.id,
                        profile_name: profile.name,
                        project_path: profile.project_path,
                        workspace_name: profile.workspace_name,
                        expected_ports: profile.expected_ports,
                    })
                    .collect::<Vec<_>>();
                serde_json::to_string(&reservations)
                    .unwrap_or_else(|e| format!("错误: 序列化失败 {}", e))
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 查询当前所有活跃运行实例（可按项目过滤）
    #[tool]
    async fn list_active_runners(
        &self,
        Parameters(params): Parameters<McpListActiveRunnersParams>,
    ) -> String {
        debug!("mcp::list_active_runners");
        match self
            .state
            .runner_service
            .list_active_instances(params.project_path.as_deref())
        {
            Ok(instances) => serde_json::json!({ "instances": instances }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 查询指定端口的当前占用情况
    #[tool]
    async fn list_port_conflicts(
        &self,
        Parameters(params): Parameters<McpListPortConflictsParams>,
    ) -> String {
        debug!(ports = ?params.ports, "mcp::list_port_conflicts");
        match self
            .state
            .runner_service
            .find_conflicts(&params.ports, None)
        {
            Ok(conflicts) => serde_json::json!({ "conflicts": conflicts }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 按 PID 杀进程（用于 skill 决定杀某个具体端口占用方）
    #[tool]
    async fn kill_runner_pid(
        &self,
        Parameters(params): Parameters<McpKillRunnerPidParams>,
    ) -> String {
        debug!(pid = params.pid, "mcp::kill_runner_pid");
        match cc_panes_core::services::ProcessMonitorService::new().kill_process(params.pid) {
            Ok(killed) => serde_json::json!({ "killed": killed }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 停止一个运行实例（杀其根进程树）
    #[tool]
    async fn stop_runner(&self, Parameters(params): Parameters<McpStopRunnerParams>) -> String {
        debug!(instance_id = %params.instance_id, "mcp::stop_runner");
        match self.state.runner_service.kill_instance(&params.instance_id) {
            Ok(killed) => serde_json::json!({ "killed": killed }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }
}

trait RunnerTerminal {
    fn create_shell_session(
        &self,
        profile: &RunnerProfile,
        runtime: &ResolvedLaunchRuntime,
    ) -> std::result::Result<String, String>;
    fn submit_text_to_session<'a>(
        &'a self,
        session_id: &'a str,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send + 'a>>;
    fn get_all_status(&self) -> std::result::Result<Vec<SessionStatusInfo>, String>;
    fn kill_session(&self, session_id: &str) -> std::result::Result<(), String>;
}

impl RunnerTerminal for TerminalBackendState {
    fn create_shell_session(
        &self,
        profile: &RunnerProfile,
        runtime: &ResolvedLaunchRuntime,
    ) -> std::result::Result<String, String> {
        self.backend()
            .create_session(CoreCreateSessionRequest {
                launch_id: None,
                project_path: profile.cwd.clone(),
                cols: 120,
                rows: 30,
                workspace_name: profile.workspace_name.clone(),
                provider_id: None,
                provider_selection: LaunchProviderSelection::None,
                launch_profile_id: None,
                workspace_path: None,
                workspace_snapshot_id: None,
                launch_claude: false,
                cli_tool: CliTool::None,
                resume_id: None,
                skip_mcp: true,
                append_system_prompt: None,
                initial_prompt: None,
                yolo_mode: None,
                adapter_options: None,
                extra_env: Some(profile.env.clone()),
                ssh: runtime.ssh.clone(),
                wsl: runtime.wsl.clone(),
            })
            .map_err(|e| e.to_string())
    }

    fn submit_text_to_session<'a>(
        &'a self,
        session_id: &'a str,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            submit_text_to_session(self.backend(), session_id, text)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn get_all_status(&self) -> std::result::Result<Vec<SessionStatusInfo>, String> {
        self.backend().get_all_status().map_err(|e| e.to_string())
    }

    fn kill_session(&self, session_id: &str) -> std::result::Result<(), String> {
        self.backend()
            .kill_with_reason(session_id, KillReason::Mcp)
            .map_err(|e| e.to_string())
    }
}

async fn start_runner_coordinator(
    profile_id: &str,
    app_state: &AppState,
    start_locks: &StartLocks,
) -> std::result::Result<RunnerStartResult, String> {
    let profile = app_state
        .runner_service
        .get_profile(profile_id)?
        .ok_or_else(|| format!("RunnerProfile not found: {}", profile_id))?;
    let runtime = resolve_launch_runtime(
        &profile.cwd,
        profile.workspace_name.as_deref(),
        None,
        Some(profile.runtime_kind.as_str()),
        None,
        app_state,
    )?;

    start_runner_coordinator_with_terminal(
        profile,
        app_state.runner_service.as_ref(),
        app_state.terminal_backend.as_ref(),
        &runtime,
        start_locks,
    )
    .await
}

async fn start_runner_coordinator_with_terminal<T: RunnerTerminal + ?Sized>(
    profile: RunnerProfile,
    runner_service: &cc_panes_core::services::RunnerService,
    terminal: &T,
    runtime: &ResolvedLaunchRuntime,
    start_locks: &StartLocks,
) -> std::result::Result<RunnerStartResult, String> {
    let _guard = start_locks.acquire(&profile.id).await;

    let active_instances = runner_service.list_active_by_profile(&profile.id)?;
    for instance in active_instances {
        if is_runner_instance_alive(terminal, &instance)? {
            return Ok(RunnerStartResult {
                status: RunnerStartStatus::Reused,
                instance_id: Some(instance.id),
                session_id: instance.session_id,
                launch_plan: None,
            });
        }

        runner_service.mark_instance_exited(&instance.id, None, RunnerInstanceStatus::Exited)?;
    }

    let plan = runner_service.plan_launch(&profile.id)?;
    if !plan.conflicts.is_empty() {
        return Ok(RunnerStartResult {
            status: RunnerStartStatus::Blocked,
            instance_id: None,
            session_id: None,
            launch_plan: Some(plan),
        });
    }

    let session_id = terminal.create_shell_session(&profile, runtime)?;
    let root_pid = match wait_for_session_root_pid(terminal, &session_id).await? {
        Some(pid) => pid,
        None => {
            let _ = terminal.kill_session(&session_id);
            return Err(format!(
                "Failed to resolve root pid for runner session {}",
                session_id
            ));
        }
    };

    let instance = runner_service.register_instance(
        Some(&profile.id),
        &profile.project_path,
        profile.workspace_name.as_deref(),
        Some(&session_id),
        root_pid,
        runtime.kind.as_str(),
        &profile.command,
        &profile.cwd,
    )?;

    if let Err(error) = terminal
        .submit_text_to_session(&session_id, &profile.command)
        .await
    {
        let _ = terminal.kill_session(&session_id);
        let _ =
            runner_service.mark_instance_exited(&instance.id, None, RunnerInstanceStatus::Exited);
        return Err(format!("Failed to submit runner command: {}", error));
    }

    Ok(RunnerStartResult {
        status: RunnerStartStatus::Launched,
        instance_id: Some(instance.id),
        session_id: Some(session_id),
        launch_plan: None,
    })
}

fn is_runner_instance_alive<T: RunnerTerminal + ?Sized>(
    terminal: &T,
    instance: &RunnerInstance,
) -> std::result::Result<bool, String> {
    let Some(session_id) = instance.session_id.as_deref() else {
        return Ok(false);
    };
    let statuses = terminal.get_all_status()?;
    Ok(statuses.iter().any(|status| {
        status.session_id == session_id
            && status.pid == Some(instance.root_pid)
            && !status.status.is_terminal()
    }))
}

async fn wait_for_session_root_pid<T: RunnerTerminal + ?Sized>(
    terminal: &T,
    session_id: &str,
) -> std::result::Result<Option<u32>, String> {
    for _ in 0..10 {
        let statuses = terminal.get_all_status()?;
        if let Some(pid) = statuses
            .iter()
            .find(|status| status.session_id == session_id)
            .and_then(|status| status.pid)
        {
            return Ok(Some(pid));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(None)
}

async fn collect_plan_live_sessions(
    state: &AppState,
) -> Vec<crate::models::task_binding::PlanLiveSession> {
    let mut live_sessions = match backend_call(state, |backend| backend.get_all_status()).await {
        Ok(statuses) => statuses
            .into_iter()
            .map(|status| {
                (
                    status.session_id.clone(),
                    crate::models::task_binding::PlanLiveSession {
                        session_id: status.session_id,
                        pane_id: None,
                        tab_id: None,
                    },
                )
            })
            .collect::<HashMap<_, _>>(),
        Err(error) => {
            warn!(err = %error, "Failed to collect live terminal sessions for plan reconcile");
            HashMap::new()
        }
    };

    if let Some(panes) = query_frontend_panes(state).await {
        apply_pane_locations(&mut live_sessions, &panes);
    }

    live_sessions.into_values().collect()
}

async fn query_frontend_panes(state: &AppState) -> Option<serde_json::Value> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        let mut queries = state
            .pending_queries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        queries.insert(request_id.clone(), tx);
    }

    let event = OrchestratorQueryEvent {
        request_id: request_id.clone(),
    };
    if let Err(error) = state.app_handle.emit("orchestrator-query-panes", &event) {
        warn!(err = %error, "Failed to emit orchestrator-query-panes for plan reconcile");
        let mut queries = state
            .pending_queries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        queries.remove(&request_id);
        return None;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(data)) => serde_json::from_str(&data).ok(),
        Ok(Err(error)) => {
            warn!(err = %error, "Plan reconcile pane query channel closed");
            None
        }
        Err(_) => {
            let mut queries = state
                .pending_queries
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            queries.remove(&request_id);
            None
        }
    }
}

fn apply_pane_locations(
    live_sessions: &mut HashMap<String, crate::models::task_binding::PlanLiveSession>,
    panes: &serde_json::Value,
) {
    let Some(panes) = panes.get("panes").and_then(|value| value.as_array()) else {
        return;
    };

    for pane in panes {
        let pane_id = pane
            .get("paneId")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let Some(tabs) = pane.get("tabs").and_then(|value| value.as_array()) else {
            continue;
        };
        for tab in tabs {
            let Some(session_id) = tab.get("sessionId").and_then(|value| value.as_str()) else {
                continue;
            };
            let entry = live_sessions
                .entry(session_id.to_string())
                .or_insert_with(|| crate::models::task_binding::PlanLiveSession {
                    session_id: session_id.to_string(),
                    pane_id: None,
                    tab_id: None,
                });
            entry.pane_id = pane_id.clone();
            entry.tab_id = tab
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_string);
        }
    }
}

#[tool_handler]
impl ServerHandler for McpToolHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(concat!(
                "CC-Panes Orchestrator: 多 CLI（Claude/Codex）多实例编排与工作空间管理。\n",
                "工具按需调用，完整列表见 tools/list。\n",
                "典型流程: launch_task → wait_for_session → get_session_output。\n",
                "布局分流: list_panes 查看 layoutId/paneId，launch_task 可传 layoutId 或 layoutName；layoutName 不存在时前端会自动创建布局。\n",
                "项目接入: scan_directory → create_workspace → add_project_to_workspace → launch_task。\n",
                "Resume: list_launch_history(projectPath) → 取 resumeSessionId/cliTool/runtimeKind → launch_task(resumeId, cliTool, runtimeKind)。",
            ))
    }
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn parse_wsl_unc_path(path: &str) -> Option<(String, String)> {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim();
    let rest = trimmed.strip_prefix("//")?;
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let host = parts.next()?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }

    let distro = parts.next()?.trim();
    if distro.is_empty() {
        return None;
    }

    let suffix = parts.collect::<Vec<_>>().join("/");
    let remote_path = if suffix.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", suffix)
    };

    Some((distro.to_string(), remote_path))
}

#[cfg(target_os = "windows")]
fn windows_path_to_wsl_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let bytes = normalized.as_bytes();
    if normalized.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }

    let suffix = normalized[2..].trim_start_matches('/');
    if suffix.is_empty() {
        return Some(format!("/mnt/{}", (bytes[0] as char).to_ascii_lowercase()));
    }

    Some(format!(
        "/mnt/{}/{}",
        (bytes[0] as char).to_ascii_lowercase(),
        suffix
    ))
}

fn find_workspace_for_launch(
    project_path: &str,
    workspace_name: Option<&str>,
    workspace_service: &WorkspaceService,
) -> Option<Workspace> {
    let normalized_project_path = normalize_path(project_path);
    workspace_name
        .and_then(|name| workspace_service.get_workspace(name).ok())
        .or_else(|| {
            workspace_service
                .list_workspaces()
                .ok()
                .and_then(|workspaces| {
                    workspaces.into_iter().find(|workspace| {
                        workspace
                            .projects
                            .iter()
                            .any(|project| normalize_path(&project.path) == normalized_project_path)
                    })
                })
        })
}

#[cfg(target_os = "windows")]
fn join_remote_path(root: &str, relative: &str) -> String {
    let root = root.trim_end_matches('/');
    let relative = relative.trim_start_matches('/');
    if relative.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{relative}")
    }
}

#[cfg(target_os = "windows")]
fn workspace_relative_path(project_path: &str, workspace_path: &str) -> Option<String> {
    let display_project = canonical_project_path(project_path).replace('\\', "/");
    let display_workspace = canonical_project_path(workspace_path).replace('\\', "/");
    let identity_project = project_identity_key(project_path).replace('\\', "/");
    let identity_workspace = project_identity_key(workspace_path).replace('\\', "/");
    if identity_project == identity_workspace {
        return Some(String::new());
    }
    let identity_prefix = format!("{}/", identity_workspace.trim_end_matches('/'));
    if !identity_project.starts_with(&identity_prefix) {
        return None;
    }
    let display_prefix_len = display_workspace.trim_end_matches('/').len() + 1;
    display_project
        .get(display_prefix_len..)
        .map(str::to_string)
}

#[cfg(target_os = "windows")]
fn resolve_wsl_launch_info(
    project_path: &str,
    workspace: Option<&Workspace>,
) -> Option<WslLaunchInfo> {
    if let Some((distro, remote_path)) = parse_wsl_unc_path(project_path) {
        return Some(WslLaunchInfo {
            remote_path,
            workspace_remote_path: workspace
                .and_then(|ws| ws.wsl.as_ref())
                .and_then(|cfg| cfg.remote_path.clone())
                .filter(|path| !path.trim().is_empty()),
            distro: Some(distro),
        });
    }

    let normalized_project_path = normalize_path(project_path);
    let workspace_remote_path = workspace
        .and_then(|ws| ws.wsl.as_ref())
        .and_then(|cfg| cfg.remote_path.clone())
        .filter(|path| !path.trim().is_empty());
    let remote_path = workspace
        .and_then(|ws| {
            ws.projects
                .iter()
                .find(|project| normalize_path(&project.path) == normalized_project_path)
                .and_then(|project| project.wsl_remote_path.clone())
                .filter(|path| !path.trim().is_empty())
                .or_else(|| {
                    let workspace_path = ws.path.as_deref()?;
                    let relative = workspace_relative_path(project_path, workspace_path)?;
                    let remote_root = workspace_remote_path.as_deref()?;
                    Some(join_remote_path(remote_root, &relative))
                })
        })
        .or_else(|| windows_path_to_wsl_path(project_path))?;

    Some(WslLaunchInfo {
        remote_path,
        workspace_remote_path,
        distro: workspace
            .and_then(|ws| ws.wsl.as_ref())
            .and_then(|cfg| cfg.distro.clone())
            .filter(|distro| !distro.trim().is_empty()),
    })
}

#[cfg(not(target_os = "windows"))]
fn resolve_wsl_launch_info(
    _project_path: &str,
    _workspace: Option<&Workspace>,
) -> Option<WslLaunchInfo> {
    None
}

fn resolve_ssh_launch_info(
    project_path: &str,
    workspace: Option<&Workspace>,
    ssh_machine_service: &SshMachineService,
) -> Option<SshConnectionInfo> {
    let normalized_project_path = normalize_path(project_path);
    if let Some(project_ssh) = workspace.and_then(|ws| {
        ws.projects
            .iter()
            .find(|project| normalize_path(&project.path) == normalized_project_path)
            .and_then(|project| project.ssh.clone())
    }) {
        return Some(project_ssh);
    }

    let ssh_launch = workspace.and_then(|ws| ws.ssh_launch.as_ref())?;
    let machine_id = ssh_launch.machine_id.as_deref()?.trim();
    let remote_path = ssh_launch.remote_path.as_deref()?.trim();
    if machine_id.is_empty() || remote_path.is_empty() {
        return None;
    }
    let machine = ssh_machine_service.get(machine_id)?;
    Some(SshConnectionInfo {
        host: machine.host,
        port: machine.port,
        user: machine.user,
        remote_path: remote_path.to_string(),
        identity_file: machine.identity_file,
        machine_id: Some(machine.id),
        auth_method: Some(machine.auth_method),
    })
}

fn runtime_notice(
    workspace: Option<&Workspace>,
    kind: LaunchRuntimeKind,
    source: &'static str,
    cli_tool: Option<&str>,
) -> Option<String> {
    let workspace = workspace?;
    let default = workspace_runtime_kind(workspace);
    let cli_tool = cli_tool.unwrap_or("claude");
    if source == "explicit" && default != kind {
        return Some(format!(
            "workspace '{}' 默认是 {}，本次按显式 runtimeKind='{}' 启动。",
            workspace.name,
            default.as_str(),
            kind.as_str()
        ));
    }
    if source == "history" && default != kind {
        return Some(format!(
            "workspace '{}' 默认是 {}，resume 历史记录为 {}，本次按历史 runtimeKind 启动。",
            workspace.name,
            default.as_str(),
            kind.as_str()
        ));
    }
    if source == "path" && kind == LaunchRuntimeKind::Wsl {
        return Some(format!(
            "workspace '{}' 项目路径是 WSL UNC，已按 WSL 启动；如需 Windows local 请传 runtimeKind='local'。",
            workspace.name
        ));
    }
    if source == "cli_workspace_default" && kind == LaunchRuntimeKind::Wsl {
        return Some(format!(
            "workspace '{}' 中 {} 默认是 WSL，未传 runtimeKind，已按 WSL 启动；如需 Windows local 请传 runtimeKind='local'。",
            workspace.name,
            cli_tool
        ));
    }
    if source == "workspace_default" && kind == LaunchRuntimeKind::Wsl {
        return Some(format!(
            "workspace '{}' 默认是 WSL，未传 runtimeKind，已按 WSL 启动；如需 Windows local，请传 runtimeKind='local'。",
            workspace.name
        ));
    }
    None
}

fn select_launch_runtime_kind(
    explicit_runtime: Option<LaunchRuntimeKind>,
    history_runtime: Option<LaunchRuntimeKind>,
    cli_default: Option<LaunchRuntimeKind>,
    path_runtime: Option<LaunchRuntimeKind>,
    workspace_default: Option<LaunchRuntimeKind>,
) -> (LaunchRuntimeKind, &'static str) {
    // 优先级：explicit > history > path/UNC > cli_workspace_default > workspace_default。
    // path（WSL UNC 推断）必须高于 per-CLI 默认，避免 WSL UNC 项目被 CLI 默认 local
    // 错误覆盖；只有显式 runtimeKind 能压过 UNC 推断。
    if let Some(runtime) = explicit_runtime {
        (runtime, "explicit")
    } else if let Some(runtime) = history_runtime {
        (runtime, "history")
    } else if let Some(runtime) = path_runtime {
        (runtime, "path")
    } else if let Some(runtime) = cli_default {
        (runtime, "cli_workspace_default")
    } else if let Some(runtime) = workspace_default {
        (runtime, "workspace_default")
    } else {
        (LaunchRuntimeKind::Local, "default")
    }
}

fn resolve_launch_runtime(
    project_path: &str,
    workspace_name: Option<&str>,
    cli_tool: Option<&str>,
    requested_runtime: Option<&str>,
    resume_id: Option<&str>,
    state: &AppState,
) -> std::result::Result<ResolvedLaunchRuntime, String> {
    let effective_cli = effective_cli_default_key(cli_tool);
    let workspace =
        find_workspace_for_launch(project_path, workspace_name, &state.workspace_service);
    let explicit_runtime = requested_runtime
        .map(str::trim)
        .filter(|runtime| !runtime.is_empty())
        .map(parse_launch_runtime_kind)
        .transpose()?;
    let history_runtime = if explicit_runtime.is_none() {
        resume_id
            .and_then(|id| {
                state
                    .launch_history_service
                    .find_by_resume_session_id(id)
                    .ok()
                    .flatten()
            })
            .and_then(|record| parse_launch_runtime_kind(&record.runtime_kind).ok())
    } else {
        None
    };
    let path_runtime = if explicit_runtime.is_none() && history_runtime.is_none() {
        #[cfg(target_os = "windows")]
        {
            parse_wsl_unc_path(project_path).map(|_| LaunchRuntimeKind::Wsl)
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    } else {
        None
    };
    let cli_default = if explicit_runtime.is_none() && history_runtime.is_none() {
        workspace
            .as_ref()
            .and_then(|workspace| cli_workspace_default(workspace, effective_cli))
    } else {
        None
    };
    let workspace_default = workspace.as_ref().map(workspace_runtime_kind);

    let (kind, source) = select_launch_runtime_kind(
        explicit_runtime,
        history_runtime,
        cli_default,
        path_runtime,
        workspace_default,
    );

    let wsl = if kind == LaunchRuntimeKind::Wsl {
        let resolved = resolve_wsl_launch_info(project_path, workspace.as_ref());
        if resolved.is_none() {
            return Err(match source {
                "explicit" => {
                    "runtimeKind='wsl' 但无法解析 WSL 路径。请配置 workspace.wsl.remotePath、项目 wslRemotePath，或传可转换的 Windows 路径。".to_string()
                }
                "workspace_default" => workspace
                    .as_ref()
                    .map(|ws| format!(
                        "workspace '{}' 默认是 WSL，但无法解析 WSL 路径。请选择 local，或配置 WSL 路径。",
                        ws.name
                    ))
                    .unwrap_or_else(|| "无法解析 WSL 路径。".to_string()),
                "cli_workspace_default" => workspace
                    .as_ref()
                    .map(|ws| format!(
                        "workspace '{}' 的 {} 默认为 WSL，但缺少 WSL 远端路径配置。请在工作空间设置中为 WSL 配置 remotePath，或修改 {} 的默认环境。",
                        ws.name,
                        effective_cli,
                        effective_cli
                    ))
                    .unwrap_or_else(|| "无法解析 WSL 路径。".to_string()),
                _ => "无法解析 WSL 路径。".to_string(),
            });
        }
        resolved
    } else {
        None
    };

    let ssh = if kind == LaunchRuntimeKind::Ssh {
        let resolved =
            resolve_ssh_launch_info(project_path, workspace.as_ref(), &state.ssh_machine_service);
        if resolved.is_none() {
            return Err(match source {
                "explicit" => {
                    "runtimeKind='ssh' 但无法解析 SSH 连接。请配置 workspace.sshLaunch 或使用已登记的 SSH 项目。".to_string()
                }
                "workspace_default" => workspace
                    .as_ref()
                    .map(|ws| format!(
                        "workspace '{}' 默认是 SSH，但 SSH 配置不完整。请选择 local/wsl，或补齐 SSH 运行环境。",
                        ws.name
                    ))
                    .unwrap_or_else(|| "无法解析 SSH 连接。".to_string()),
                "cli_workspace_default" => workspace
                    .as_ref()
                    .map(|ws| format!(
                        "workspace '{}' 的 {} 默认为 SSH，但 SSH 配置不完整。请在工作空间设置中补齐 SSH machineId/remotePath，或修改 {} 的默认环境。",
                        ws.name,
                        effective_cli,
                        effective_cli
                    ))
                    .unwrap_or_else(|| "无法解析 SSH 连接。".to_string()),
                _ => "无法解析 SSH 连接。".to_string(),
            });
        }
        resolved
    } else {
        None
    };

    Ok(ResolvedLaunchRuntime {
        kind,
        source,
        notice: runtime_notice(workspace.as_ref(), kind, source, Some(effective_cli)),
        wsl,
        ssh,
    })
}

// ============ 路径白名单 ============

/// Canonical project identity key used by registration and runtime lookups.
fn normalize_path(p: &str) -> String {
    project_identity_key(p)
}

fn registered_path_matches(registered: &str, requested: &str) -> bool {
    normalize_path(registered) == normalize_path(requested)
}

fn mark_project_path_seen(seen: &mut HashSet<String>, path: &str) -> bool {
    seen.insert(normalize_path(path))
}

/// 检查项目路径是否在已注册列表中（DB 项目 + 工作空间项目）
fn is_project_registered(state: &AppState, path: &str) -> bool {
    // 1. 查 DB projects 表
    if let Ok(projects) = state.project_service.list_projects() {
        if projects
            .iter()
            .any(|p| registered_path_matches(&p.path, path))
        {
            return true;
        }
    }

    // 2. 查工作空间项目
    if let Ok(workspaces) = state.workspace_service.list_workspaces() {
        for ws in &workspaces {
            if ws
                .projects
                .iter()
                .any(|p| registered_path_matches(&p.path, path))
            {
                return true;
            }
        }
    }

    false
}

// ============ 认证中间件 ============

fn verify_token(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.strip_prefix("Bearer ")
                .map(|t| t == expected)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// 简易频率限制：10 秒内最多 20 个请求
fn check_rate_limit(times: &Arc<Mutex<Vec<std::time::Instant>>>) -> bool {
    let mut times = times.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    let window = std::time::Duration::from_secs(10);

    times.retain(|t| now.duration_since(*t) < window);

    if times.len() >= 20 {
        return false;
    }

    times.push(now);
    true
}

// ============ REST API Handler ============

async fn handle_health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok" })))
}

async fn handle_launch_task(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<LaunchTaskRequest>,
) -> impl IntoResponse {
    let is_resume = req.resume_id.is_some();
    let prompt_len = req.prompt.as_ref().map(|p| p.len()).unwrap_or(0);
    info!(project = %req.project_path, prompt_len, is_resume, "REST::launch_task");

    if !verify_token(&headers, &state.token) {
        warn!("REST::launch_task unauthorized");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::launch_task rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    // 参数校验：prompt 和 resumeId 互斥，必须且只能提供其一
    if req.prompt.is_some() && req.resume_id.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError {
                error: "Cannot provide both 'prompt' and 'resumeId'".to_string()
            })),
        );
    }
    if req.prompt.is_none() && req.resume_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError {
                error: "Must provide either 'prompt' or 'resumeId'".to_string()
            })),
        );
    }

    // 白名单校验（DB 项目 + 工作空间项目）
    if !is_project_registered(&state, &req.project_path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError {
                error: format!("Project path '{}' is not registered", req.project_path)
            })),
        );
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let project_id = format!("orch-{}", uuid::Uuid::new_v4());

    // 解析 CLI 工具类型
    let cli_tool = match parse_launch_cli_tool(req.cli_tool.as_deref()) {
        Ok(tool) => tool,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!(ApiError { error })),
            );
        }
    };
    let provider_selection = match parse_provider_selection(req.provider_selection.as_deref()) {
        Ok(selection) => selection,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!(ApiError { error })),
            );
        }
    };

    let mut workspace_name = req.workspace_name.clone();
    let mut workspace_path = req.workspace_path.clone();
    if let Some(ref name) = workspace_name {
        match state.workspace_service.get_workspace(name) {
            Ok(ws) => {
                if workspace_path.is_none() {
                    workspace_path = ws.path.clone();
                }
                debug!(workspace = %name, path = ?workspace_path, "REST::launch_task resolved workspace");
            }
            Err(error) => {
                warn!(workspace = %name, err = %error, "REST::launch_task workspace not found, ignoring");
                workspace_name = None;
            }
        }
    }

    // 非 resume 时通过 CLI 位置参数注入 prompt（避免 PTY stdin 时序问题）
    // 安全网：长 prompt 自动外部化为文件，避免终端黑屏
    let initial_prompt_owned = if !is_resume {
        req.prompt
            .map(|p| externalize_long_prompt(&req.project_path, &task_id, p))
    } else {
        None
    };
    let initial_prompt = initial_prompt_owned.as_deref();
    let runtime = match resolve_launch_runtime(
        &req.project_path,
        workspace_name.as_deref(),
        req.cli_tool.as_deref(),
        req.runtime_kind.as_deref(),
        req.resume_id.as_deref(),
        &state,
    ) {
        Ok(runtime) => runtime,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!(ApiError { error })),
            );
        }
    };

    let create_request = CoreCreateSessionRequest {
        launch_id: None,
        project_path: req.project_path.clone(),
        cols: 120,
        rows: 30,
        workspace_name: workspace_name.clone(),
        provider_id: req.provider_id.clone(),
        provider_selection,
        launch_profile_id: None,
        workspace_path: workspace_path.clone(),
        workspace_snapshot_id: None,
        launch_claude: cli_tool != CliTool::None,
        cli_tool,
        resume_id: req.resume_id.clone(),
        skip_mcp: false,
        append_system_prompt: None,
        initial_prompt: initial_prompt.map(str::to_string),
        yolo_mode: None,
        adapter_options: None,
        extra_env: None,
        ssh: runtime.ssh.clone(),
        wsl: runtime.wsl.clone(),
    };
    let session_id = match backend_call(&state, move |backend| {
        backend.create_session(create_request)
    })
    .await
    {
        Ok(sid) => {
            info!(session_id = %sid, "REST::launch_task session created");
            sid
        }
        Err(e) => {
            error!(project = %req.project_path, err = %e, "REST::launch_task failed to create session");
            let runtime_notice = runtime
                .notice
                .as_deref()
                .map(|notice| format!("{} ", notice))
                .unwrap_or_default();
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to create session: {}{}", runtime_notice, e)
                })),
            );
        }
    };

    if let Err(error) = state
        .history_watch_manager
        .on_session_created(&session_id, &req.project_path)
    {
        warn!(session_id = %session_id, err = %error, "REST::launch_task failed to start local history watcher");
    }

    {
        let mut tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_stale_tasks(&mut tasks);
        tasks.insert(
            task_id.clone(),
            TaskStatus {
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                status: "launching".to_string(),
                error: None,
                created_at: std::time::Instant::now(),
            },
        );
    }

    let event = OrchestratorLaunchEvent {
        task_id: task_id.clone(),
        session_id: session_id.clone(),
        project_path: req.project_path.clone(),
        project_id,
        workspace_name,
        provider_id: req.provider_id.clone(),
        provider_selection: req.provider_selection.clone(),
        workspace_path,
        title: req.title.clone(),
        resume_id: req.resume_id.clone(),
        pane_id: req.pane_id.clone(),
        layout_id: req.layout_id.clone(),
        layout_name: req.layout_name.clone(),
        cli_tool: req.cli_tool.clone(),
        runtime_kind: runtime.kind.as_str().to_string(),
        runtime_source: runtime.source.to_string(),
        notice: runtime.notice.clone(),
        wsl: runtime.wsl.clone(),
        ssh: runtime.ssh.clone(),
        placement: req.placement.clone(),
        // REST `/api/launch-task` 没有 caller launchId 上下文（直接由 GUI/外部
        // 客户端发起），父信息留空 → 顶层编号。
        parent_session_id: None,
    };
    let _ = state.app_handle.emit("orchestrator-launch-task", &event);

    let response = LaunchTaskResponse {
        task_id,
        session_id,
        status: "launching".to_string(),
        runtime_kind: runtime.kind.as_str().to_string(),
        runtime_source: runtime.source.to_string(),
        notice: runtime.notice,
    };

    (StatusCode::OK, Json(serde_json::json!(response)))
}

async fn handle_list_projects(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    debug!("REST::list_projects");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    let mut project_infos: Vec<ProjectInfo> = Vec::new();
    let mut seen = HashSet::new();

    // DB 项目
    for p in state.project_service.list_projects().unwrap_or_default() {
        if !mark_project_path_seen(&mut seen, &p.path) {
            continue;
        }
        project_infos.push(ProjectInfo {
            id: p.id.to_string(),
            name: p.name.clone(),
            path: p.path.clone(),
            workspace_name: None,
        });
    }

    // 工作空间项目（去重）
    for ws in state
        .workspace_service
        .list_workspaces()
        .unwrap_or_default()
    {
        for p in &ws.projects {
            if !mark_project_path_seen(&mut seen, &p.path) {
                continue;
            }
            project_infos.push(ProjectInfo {
                id: p.id.clone(),
                name: p.alias.clone().unwrap_or_else(|| {
                    p.path
                        .split(['/', '\\'])
                        .next_back()
                        .unwrap_or(&p.path)
                        .to_string()
                }),
                path: p.path.clone(),
                workspace_name: Some(ws.name.clone()),
            });
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!(ProjectsResponse {
            projects: project_infos
        })),
    )
}

async fn handle_task_status(
    headers: HeaderMap,
    State(state): State<AppState>,
    AxumPath(task_id): AxumPath<String>,
) -> impl IntoResponse {
    debug!(task_id = %task_id, "REST::task_status");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    let statuses = query_all_session_statuses(&state).await.ok();
    let mut tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    match tasks.get_mut(&task_id) {
        Some(status) => {
            if let Some(statuses) = statuses.as_deref() {
                refresh_task_status(status, statuses);
            }
            (StatusCode::OK, Json(serde_json::json!(status)))
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!(ApiError {
                error: format!("Task '{}' not found", task_id)
            })),
        ),
    }
}

// ---- PTY Control REST 请求 ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteToSessionRequest {
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitToSessionRequest {
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillSessionRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerNotificationRequest {
    kind: String,
    title: String,
    body: Option<String>,
    source: Option<String>,
    scope: Option<String>,
    dedupe_key: Option<String>,
    group_key: Option<String>,
    only_when_unfocused: Option<bool>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcChanSayRequest {
    text: String,
    duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStartedRequest {
    launch_id: String,
    pty_session_id: String,
    resume_session_id: String,
    cli_tool: String,
    runtime_kind: String,
    wsl_distro: Option<String>,
    cwd: Option<String>,
}

impl From<TriggerNotificationRequest> for NotificationRequest {
    fn from(value: TriggerNotificationRequest) -> Self {
        Self {
            kind: value.kind,
            title: value.title,
            body: value.body,
            source: value.source,
            scope: value.scope,
            dedupe_key: value.dedupe_key,
            group_key: value.group_key,
            only_when_unfocused: value.only_when_unfocused,
            metadata: value.metadata,
        }
    }
}

fn normalize_ccchan_say(
    text: &str,
    duration_ms: Option<u64>,
) -> std::result::Result<(String, u64), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("text is required".to_string());
    }
    let text = text.chars().take(240).collect::<String>();
    let duration_ms = duration_ms.unwrap_or(5_400).clamp(1_200, 30_000);
    Ok((text, duration_ms))
}

fn emit_ccchan_say(
    app_handle: &AppHandle,
    ccchan_service: &CCChanService,
    text: &str,
    duration_ms: Option<u64>,
) -> std::result::Result<serde_json::Value, String> {
    let (text, duration_ms) = normalize_ccchan_say(text, duration_ms)?;
    let needs_load_wait = app_handle.get_webview_window("ccchan").is_none();
    ccchan_service
        .show_window(app_handle)
        .map_err(|error| format!("Failed to show ccchan: {error}"))?;
    if needs_load_wait {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let Some(window) = app_handle.get_webview_window("ccchan") else {
        return Err("ccchan window was not created".to_string());
    };
    let pet_size = ccchan_service.pet_size();
    let (bubble_w, bubble_h) = ccchan_service.window_size(CCChanWindowMode::Bubble);
    window
        .set_size(LogicalSize::new(bubble_w, bubble_h))
        .map_err(|error| format!("Failed to resize ccchan for bubble: {error}"))?;
    // 气泡预留区：宠物本体被下移到窗口底部，上方留给气泡。s=120 时还原
    // 历史值 translate(10px, 96px) 与气泡宽 260px。
    let shift_y = (bubble_h - pet_size - 4.0).max(0.0);
    let bubble_width = (bubble_w - 40.0).max(200.0);
    let text_json = serde_json::to_string(&text)
        .map_err(|error| format!("Failed to encode ccchan text: {error}"))?;
    let script = format!(
        r#"
(() => {{
  const text = {text_json};
  const durationMs = {duration_ms};
  const root = document.getElementById("root");
  if (root) {{
    root.dataset.ccchanBubbleShift = "1";
    root.style.transform = "translate(10px, {shift_y}px)";
    root.style.transition = "transform 140ms ease";
  }}
  let bubble = document.getElementById("ccchan-manual-bubble");
  if (!bubble) {{
    bubble = document.createElement("div");
    bubble.id = "ccchan-manual-bubble";
    bubble.style.cssText = [
      "position:fixed",
      "left:12px",
      "top:8px",
      "z-index:2147483647",
      "width:{bubble_width}px",
      "box-sizing:border-box",
      "border:2px solid #38bdf8",
      "border-radius:8px",
      "padding:8px 11px",
      "background:#ffffff",
      "color:#0f172a",
      "font:600 13px/19px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "box-shadow:0 14px 32px rgba(15,23,42,.28), 0 0 0 3px rgba(255,255,255,.72)",
      "pointer-events:none",
      "white-space:normal",
      "overflow-wrap:anywhere"
    ].join(";");
    const tail = document.createElement("div");
    tail.style.cssText = [
      "position:absolute",
      "left:54px",
      "bottom:-9px",
      "width:14px",
      "height:14px",
      "box-sizing:border-box",
      "background:#ffffff",
      "border-right:2px solid #38bdf8",
      "border-bottom:2px solid #38bdf8",
      "transform:rotate(45deg)",
      "box-shadow:4px 4px 8px rgba(15,23,42,.08)"
    ].join(";");
    const body = document.createElement("span");
    body.id = "ccchan-manual-bubble-text";
    body.style.cssText = "position:relative;z-index:1";
    bubble.appendChild(tail);
    bubble.appendChild(body);
    document.body.appendChild(bubble);
  }}
  const body = document.getElementById("ccchan-manual-bubble-text") || bubble;
  body.textContent = text;
  clearTimeout(window.__ccchanManualBubbleTimer);
  window.__ccchanManualBubbleTimer = setTimeout(() => {{
    bubble.remove();
    if (root && root.dataset.ccchanBubbleShift === "1") {{
      root.style.transform = "";
      delete root.dataset.ccchanBubbleShift;
    }}
  }}, durationMs);
}})();
"#
    );
    window
        .eval(&script)
        .map_err(|error| format!("Failed to dispatch ccchan-say-dom: {error}"))?;
    let shrink_window = window.clone();
    let (collapsed_w, collapsed_h) = ccchan_service.window_size(CCChanWindowMode::Collapsed);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(duration_ms));
        let _ = shrink_window.set_size(LogicalSize::new(collapsed_w, collapsed_h));
    });
    Ok(serde_json::json!({
        "success": true,
        "text": text,
        "durationMs": duration_ms,
    }))
}

// ---- PTY Control REST Handlers ----

async fn handle_list_sessions(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    debug!("REST::list_sessions");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    match query_all_session_statuses(&state).await {
        Ok(statuses) => {
            let sessions: Vec<serde_json::Value> = statuses
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "sessionId": s.session_id,
                        "status": s.status,
                        "lastOutputAt": s.last_output_at,
                    })
                })
                .collect();
            (
                StatusCode::OK,
                Json(serde_json::json!({ "sessions": sessions })),
            )
        }
        Err(e) => {
            error!(err = %e, "REST::list_sessions failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to list sessions: {}", e)
                })),
            )
        }
    }
}

async fn handle_session_status(
    headers: HeaderMap,
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> impl IntoResponse {
    debug!(session_id = %session_id, "REST::session_status");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    match query_session_status(&state, &session_id).await {
        Ok(Some(status)) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "sessionId": status.session_id,
                "status": status.status,
                "lastOutputAt": status.last_output_at,
            })),
        ),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!(ApiError {
                error: format!("Session '{}' not found", session_id)
            })),
        ),
        Err(e) => {
            error!(session_id = %session_id, err = %e, "REST::session_status failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to get session status: {}", e)
                })),
            )
        }
    }
}

async fn handle_write_to_session(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<WriteToSessionRequest>,
) -> impl IntoResponse {
    info!(session_id = %req.session_id, text_len = req.text.len(), "REST::write_to_session");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::write_to_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    let sid = req.session_id.clone();
    // 与 MCP write_to_session 共用同一条容错解码，避免两条路径行为分叉。
    let txt = decode_terminal_escapes(&req.text);
    match backend_call(&state, move |backend| backend.write(&sid, &txt)).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::write_to_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to write to session: {}", e)
                })),
            )
        }
    }
}

async fn handle_submit_to_session(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<SubmitToSessionRequest>,
) -> impl IntoResponse {
    info!(session_id = %req.session_id, text_len = req.text.len(), "REST::submit_to_session");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::submit_to_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    // 安全网：长文本外部化为文件，避免 PTY 处理异常
    let fallback_dir = state.app_paths.data_dir().to_string_lossy().to_string();
    let effective_text =
        externalize_long_prompt(&fallback_dir, &uuid::Uuid::new_v4().to_string(), req.text);

    match submit_text_to_session(
        state.terminal_backend.backend(),
        &req.session_id,
        &effective_text,
    )
    .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::submit_to_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to submit to session: {}", e)
                })),
            )
        }
    }
}

async fn handle_kill_session(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<KillSessionRequest>,
) -> impl IntoResponse {
    info!(session_id = %req.session_id, "REST::kill_session");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::kill_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    let sid = req.session_id.clone();
    match backend_call(&state, move |backend| {
        backend.kill_with_reason(&sid, KillReason::Mcp)
    })
    .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::kill_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to kill session: {}", e)
                })),
            )
        }
    }
}

async fn handle_trigger_notification(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<TriggerNotificationRequest>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::trigger_notification rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    let mut request: NotificationRequest = req.into();
    if request.source.is_none() {
        request.source = Some("api".to_string());
    }

    match state
        .notification_service
        .trigger(&state.app_handle, &state.settings_service, request)
    {
        Ok(result) => (StatusCode::OK, Json(serde_json::json!(result))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError { error })),
        ),
    }
}

async fn handle_ccchan_say(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<CcChanSayRequest>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::ccchan_say rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    match emit_ccchan_say(
        &state.app_handle,
        &state.ccchan_service,
        &req.text,
        req.duration_ms,
    ) {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError { error })),
        ),
    }
}

// ============ Hook 事件总线（阶段 2.3） ============
//
// 所有 cc-panes-cli-hook 子命令通过此端点上报 cc-pane 抽象事件。
// 主进程的 SessionStateMachine 消费事件 → 更新状态点 → 触发通知。
//
// 鉴权：Bearer token（与其他 /api/* 一致）。
// 频率限制：**不走** check_rate_limit。原因：hook 是可信高频调用方
// （每个工具调用都会触发 ToolBefore/ToolAfter），rate_limit 会误伤。

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookEventRequest {
    /// cc-pane 事件名（与 cc-panes-cli-hook 子命令名一致）：
    /// session-init / session-resume / session-end / prompt-before /
    /// tool-before / tool-after / turn-end / before-compact /
    /// waiting-input / error
    cc_pane_event: String,
    /// PTY 会话 ID（由 hook 进程的 CC_PANES_PTY_SESSION_ID env 注入）
    pty_session_id: String,
    /// 可选：TaskBinding ID（hook 上报 TurnEnd/SessionEnd 时用于回写 completionSummary）
    #[serde(default)]
    task_binding_id: Option<String>,
    /// hook stdin 原文（不同事件字段不同，state machine 内部按需取）
    #[serde(default)]
    payload: serde_json::Value,
}

async fn handle_hook_event(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<HookEventRequest>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    // 把字符串事件名翻译为 CcPaneEvent 枚举
    let event = match parse_cc_pane_event(&req.cc_pane_event) {
        Some(e) => e,
        None => {
            warn!(event = %req.cc_pane_event, "REST::hook_event: unknown cc-pane event");
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!(ApiError {
                    error: format!("unknown cc-pane event: {}", req.cc_pane_event)
                })),
            );
        }
    };

    let (from, to) = state.session_state_machine.on_event(
        &req.pty_session_id,
        &event,
        req.task_binding_id.clone(),
        &req.payload,
    );

    debug!(
        pty_session_id = %req.pty_session_id,
        event = %req.cc_pane_event,
        from = ?from,
        to = ?to,
        "REST::hook_event processed"
    );

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "ptySessionId": req.pty_session_id,
            "from": from,
            "to": to,
        })),
    )
}

fn parse_cc_pane_event(name: &str) -> Option<cc_cli_adapters::CcPaneEvent> {
    // 与 OSC 通道共用同一份事件名映射，避免两处各自维护静默漏事件
    cc_panes_core::services::session_state_machine::parse_cc_pane_event_name(name)
}

async fn handle_memory_recall(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<MemoryRecallBody>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }
    if !check_rate_limit(&state.last_request_times) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    let mut project_paths = Vec::new();
    if !req.project_path.trim().is_empty() {
        project_paths.push(req.project_path.trim().to_string());
    }
    if let Some(alt) = req.alt_project_path.as_deref().map(str::trim) {
        if !alt.is_empty() && !project_paths.iter().any(|path| path == alt) {
            project_paths.push(alt.to_string());
        }
    }
    if project_paths.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError {
                error: "projectPath is required".to_string()
            })),
        );
    }

    let min_importance = req.min_importance.unwrap_or(4).clamp(1, 5);
    let limit = req.limit.unwrap_or(5).clamp(1, 20);
    match state.memory_service.recall_for_session_start(
        req.workspace_name.as_deref(),
        &project_paths,
        min_importance,
        limit,
    ) {
        Ok(memories) => {
            let ids: Vec<String> = memories.iter().map(|memory| memory.id.clone()).collect();
            let count = ids.len();
            let context = state.memory_service.format_recall_for_injection(&memories);
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "context": context,
                    "ids": ids,
                    "count": count,
                })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError {
                error: e.to_string()
            })),
        ),
    }
}

async fn handle_session_started(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<SessionStartedRequest>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::session_started rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    let update_result = state.launch_history_service.update_session_started(
        &req.launch_id,
        &req.pty_session_id,
        &req.resume_session_id,
        &req.cli_tool,
        &req.runtime_kind,
        req.wsl_distro.as_deref(),
        req.cwd.as_deref(),
    );

    match update_result {
        Ok(Some(record_id)) => {
            let _ = state
                .launch_history_service
                .update_resume_source(record_id, "hook");
            let _ = state.app_handle.emit(
                "history-updated",
                serde_json::json!({
                    "source": "session-started",
                    "recordId": record_id,
                    "launchId": req.launch_id,
                    "ptySessionId": req.pty_session_id,
                    "resumeSessionId": req.resume_session_id,
                    "resumeSource": "hook",
                }),
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "recordId": record_id,
                })),
            )
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!(ApiError {
                error: format!("Launch '{}' not found", req.launch_id)
            })),
        ),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError { error })),
        ),
    }
}

// ============ Plan-as-memory handlers ============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryRecallBody {
    workspace_name: Option<String>,
    project_path: String,
    alt_project_path: Option<String>,
    #[serde(default)]
    min_importance: Option<u8>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTagBody {
    session_id: Option<String>,
    workspace_name: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    workspace_path: Option<String>, // 兜底信息，目前不直接使用（通过 task_binding 反查更可信）
    project_path: String,
    plan_path: String,
    archived_path: String,
    tag: cc_panes_core::models::plan::PlanTag,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRecentQuery {
    workspace_name: Option<String>,
    project_path: String,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSearchBody {
    session_id: String,
    workspace_name: Option<String>,
    project_path: String,
    keyword: String,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSetArchivedBody {
    id: i64,
    archived: bool,
}

async fn handle_plan_tag(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<PlanTagBody>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }
    if !check_rate_limit(&state.last_request_times) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }

    // 通过 session_id 反查 task_binding，可信地拿到 workspace_name + project_path
    let (workspace_name, project_path, task_binding_id) =
        if let Some(sid) = req.session_id.as_deref() {
            match state.task_binding_service.find_by_session_id(sid) {
                Ok(Some(tb)) => (
                    tb.workspace_name.clone(),
                    tb.project_path.clone(),
                    Some(tb.id.clone()),
                ),
                _ => (req.workspace_name.clone(), req.project_path.clone(), None),
            }
        } else {
            (req.workspace_name.clone(), req.project_path.clone(), None)
        };

    let upsert_req = cc_panes_core::models::plan::UpsertPlanRequest {
        task_binding_id,
        workspace_name,
        project_path,
        session_id: req.session_id.clone(),
        plan_path: req.plan_path.clone(),
        archived_path: req.archived_path.clone(),
        tag: req.tag,
    };
    let mut memory_req = upsert_req.clone();
    memory_req.tag.clamp();

    match state.plan_archive_service.upsert_plan(upsert_req) {
        Ok(plan_id) => {
            if let Err(e) = record_plan_as_memory(&state, plan_id, &memory_req) {
                warn!(plan_id, err = %e, "plan-as-memory dual write failed");
            }
            let _ = state.app_handle.emit(
                "plan-recorded",
                serde_json::json!({
                    "planId": plan_id,
                    "archivedPath": req.archived_path,
                }),
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({ "success": true, "planId": plan_id })),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError {
                error: e.to_string()
            })),
        ),
    }
}

fn record_plan_as_memory(
    state: &AppState,
    plan_id: i64,
    plan: &cc_panes_core::models::plan::UpsertPlanRequest,
) -> Result<(), String> {
    let plan_id_tag = format!("plan-id:{}", plan_id);
    let title = plan
        .tag
        .intent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|intent| limit_chars(&format!("Plan: {}", intent), 200))
        .unwrap_or_else(|| format!("Plan {}", plan_id));
    let content = format_plan_memory_content(plan_id, plan);
    let mut tags = vec![
        "plan".to_string(),
        "plan-as-memory".to_string(),
        plan_id_tag.clone(),
    ];
    for tag in &plan.tag.tags {
        let trimmed = tag.trim();
        if !trimmed.is_empty() && !tags.iter().any(|existing| existing == trimmed) {
            tags.push(trimmed.to_string());
        }
    }
    let importance = match plan.tag.risk.as_deref() {
        Some("high") => 5,
        Some("med") => 4,
        Some("low") => 3,
        _ => 4,
    };

    let existing = state.memory_service.search(MemoryQuery {
        scope: Some(MemoryScope::Project),
        project_path: Some(plan.project_path.clone()),
        tags: Some(vec![plan_id_tag]),
        limit: Some(1),
        ..Default::default()
    })?;

    if let Some(memory) = existing.items.first() {
        state.memory_service.update(
            &memory.id,
            UpdateMemoryRequest {
                title: Some(title),
                content: Some(content),
                category: Some(MemoryCategory::Plan),
                importance: Some(importance),
                tags: Some(tags),
            },
        )?;
        return Ok(());
    }

    state.memory_service.store(StoreMemoryRequest {
        title,
        content,
        scope: Some(MemoryScope::Project),
        category: Some(MemoryCategory::Plan),
        importance: Some(importance),
        workspace_name: plan.workspace_name.clone(),
        project_path: Some(plan.project_path.clone()),
        session_id: plan.session_id.clone(),
        tags: Some(tags),
        source: Some("plan_archive".to_string()),
    })?;

    Ok(())
}

fn format_plan_memory_content(
    plan_id: i64,
    plan: &cc_panes_core::models::plan::UpsertPlanRequest,
) -> String {
    let mut lines = vec![format!("Plan record id: {}", plan_id)];
    if let Some(intent) = plan.tag.intent.as_deref().map(str::trim) {
        if !intent.is_empty() {
            lines.push(format!("Intent: {}", intent));
        }
    }
    if !plan.tag.tags.is_empty() {
        lines.push(format!("Tags: {}", plan.tag.tags.join(", ")));
    }
    if !plan.tag.scope.is_empty() {
        lines.push(format!("Scope: {}", plan.tag.scope.join(", ")));
    }
    if let Some(risk) = plan.tag.risk.as_deref().map(str::trim) {
        if !risk.is_empty() {
            lines.push(format!("Risk: {}", risk));
        }
    }
    if let Some(followups) = plan.tag.followups.as_deref().map(str::trim) {
        if !followups.is_empty() {
            lines.push(format!("Followups: {}", followups));
        }
    }
    lines.push(format!("Original plan path: {}", plan.plan_path));
    lines.push(format!("Archived plan path: {}", plan.archived_path));
    lines.join("\n")
}

fn limit_chars(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        value.to_string()
    } else {
        let mut out = String::new();
        for ch in value.chars() {
            if out.len() + ch.len_utf8() > max_bytes {
                break;
            }
            out.push(ch);
        }
        out
    }
}

async fn handle_plan_recent(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(q): Query<PlanRecentQuery>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }
    let limit = q.limit.unwrap_or(1).clamp(1, 20);
    match state.plan_archive_service.list_recent_for_session_start(
        q.workspace_name.as_deref(),
        &q.project_path,
        limit,
    ) {
        Ok(items) => (StatusCode::OK, Json(serde_json::json!({ "plans": items }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError {
                error: e.to_string()
            })),
        ),
    }
}

async fn handle_plan_search(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<PlanSearchBody>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }
    if !check_rate_limit(&state.last_request_times) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError {
                error: "Rate limit exceeded".to_string()
            })),
        );
    }
    let limit = req.limit.unwrap_or(3).clamp(1, 20);
    match state.plan_archive_service.search_for_recall(
        &req.session_id,
        req.workspace_name.as_deref(),
        &req.project_path,
        &req.keyword,
        limit,
    ) {
        Ok(items) => (StatusCode::OK, Json(serde_json::json!({ "plans": items }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError {
                error: e.to_string()
            })),
        ),
    }
}

async fn handle_plan_set_archived(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(req): Json<PlanSetArchivedBody>,
) -> impl IntoResponse {
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError {
                error: "Invalid or missing Bearer token".to_string()
            })),
        );
    }
    match state
        .plan_archive_service
        .set_archived(req.id, req.archived)
    {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ApiError {
                error: e.to_string()
            })),
        ),
    }
}

// ============ 辅助函数 ============

/// 生成随机 Bearer Token（32 字符 hex，密码学安全随机源）
fn generate_token() -> String {
    use rand::rngs::OsRng;
    use rand::Rng;
    let bytes: [u8; 16] = OsRng.gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// L2: 清理已完成/超时/错误的旧任务（30 分钟淘汰）
fn cleanup_stale_tasks(tasks: &mut HashMap<String, TaskStatus>) {
    cleanup_stale_tasks_at(tasks, std::time::Instant::now());
}

/// 注入 now 以便单测（CI 新虚拟机 uptime 短，构造"过去的 Instant"会下溢 panic）
fn cleanup_stale_tasks_at(tasks: &mut HashMap<String, TaskStatus>, now: std::time::Instant) {
    let ttl = std::time::Duration::from_secs(30 * 60);
    tasks.retain(|_, t| {
        let is_terminal = matches!(
            t.status.as_str(),
            "completed" | "error" | "timeout" | "exited"
        );
        !(is_terminal && now.saturating_duration_since(t.created_at) > ttl)
    });
}

fn task_status_from_session_status(
    status: cc_panes_core::services::terminal_service::SessionStatus,
) -> &'static str {
    use cc_panes_core::services::terminal_service::SessionStatus;

    match status {
        SessionStatus::Initializing => "launching",
        SessionStatus::Thinking | SessionStatus::ToolRunning | SessionStatus::Compacting => {
            "running"
        }
        SessionStatus::Active => "running",
        SessionStatus::WaitingInput => "waitingInput",
        SessionStatus::Idle => "idle",
        SessionStatus::Error => "error",
        SessionStatus::Exited => "exited",
    }
}

fn refresh_task_status(task: &mut TaskStatus, statuses: &[SessionStatusInfo]) {
    match statuses
        .iter()
        .find(|status| status.session_id == task.session_id)
    {
        Some(status) => {
            task.status = task_status_from_session_status(status.status).to_string();
            if status.status == cc_panes_core::services::terminal_service::SessionStatus::Error
                && task.error.is_none()
            {
                task.error = Some("session reported error".to_string());
            }
        }
        None if !matches!(
            task.status.as_str(),
            "completed" | "error" | "timeout" | "exited"
        ) =>
        {
            task.status = "exited".to_string();
        }
        None => {}
    }
}

/// 长 prompt 阈值（字节）。超过此长度的 prompt 将被写入文件，用短引用替代。
/// 8KB 足以避免 Windows 命令行长度限制和 ConPTY/ink 处理异常。
const PROMPT_FILE_THRESHOLD: usize = 8192;

/// 将长 prompt 写入 `.ccpanes/prompts/<id>.md`，返回文件路径
fn write_prompt_file(project_path: &str, id: &str, prompt: &str) -> std::io::Result<PathBuf> {
    let dir = PathBuf::from(project_path).join(".ccpanes").join("prompts");
    std::fs::create_dir_all(&dir)?;
    let file_path = dir.join(format!("{}.md", id));
    std::fs::write(&file_path, prompt)?;
    Ok(file_path)
}

/// 如果 prompt 超过阈值，写入文件并返回短引用指令；否则原样返回。
/// 这是防止长 prompt 导致终端黑屏的安全网。
fn externalize_long_prompt(project_path: &str, id: &str, prompt: String) -> String {
    if prompt.len() <= PROMPT_FILE_THRESHOLD {
        return prompt;
    }
    match write_prompt_file(project_path, id, &prompt) {
        Ok(path) => {
            info!(
                path = %path.display(),
                len = prompt.len(),
                "Long prompt externalized to file"
            );
            format!(
                "Read the detailed task description from '{}' and execute it. \
                 After reading, delete the file.",
                path.display()
            )
        }
        Err(e) => {
            warn!(err = %e, "Failed to write prompt file, using original");
            prompt
        }
    }
}

/// 智能提交：写入文本 → 延迟 → 发 Enter，确保 ink-text-input 正确识别提交
/// 参考: https://github.com/anthropics/claude-code/issues/15553
///
/// 直接复用 TerminalService::submit_text_to_session——它持有 per-session 输入锁
/// 覆盖 "写文本 + sleep + 写 Enter" 的完整序列（fix C2）。此前 orchestrator 自己
/// 拆成两次独立 write，未持锁，多个 worker 同时向同一 leader 报告时文本会交错，
/// 提交给 leader PTY 的是拼接乱码。整段放进 spawn_blocking（含内部 sleep）避免
/// 阻塞 tokio worker。
async fn submit_text_to_session(
    backend: Arc<dyn TerminalBackend>,
    session_id: &str,
    text: &str,
) -> std::result::Result<(), anyhow::Error> {
    let sid = session_id.to_string();
    let txt = text.to_string();
    tokio::task::spawn_blocking(move || backend.submit_text_to_session(&sid, &txt))
        .await?
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaderReportResult {
    sent: bool,
    skip_reason: Option<String>,
    /// report 已入补投队列，leader 回到 Idle/WaitingInput 时由引擎自动补投。
    /// false 时不序列化，保持旧 JSON 格式逐字节兼容（skill 文档匹配 skipReason 字符串）。
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    queued: bool,
}

impl LeaderReportResult {
    fn sent() -> Self {
        Self {
            sent: true,
            skip_reason: None,
            queued: false,
        }
    }

    fn skipped(reason: impl Into<String>) -> Self {
        Self {
            sent: false,
            skip_reason: Some(reason.into()),
            queued: false,
        }
    }

    fn queued(reason: impl Into<String>) -> Self {
        Self {
            sent: false,
            skip_reason: Some(reason.into()),
            queued: true,
        }
    }
}

// ============ worker report 补投队列 ============
//
// leader busy/initializing 时 report 不丢弃而是入队（key = leader PTY session_id），
// 状态机 listener 在 leader 跃迁回 Idle/WaitingInput 时补投。队列元素存 worker
// TaskBinding **快照**（保住 MCP report_to_leader 覆写的 status/summary，不重查 DB）。

const PENDING_REPORT_TTL_SECS: u64 = 30 * 60;
const PENDING_REPORT_MAX_PER_LEADER: usize = 32;
const PENDING_REPORT_SCAN_INTERVAL_SECS: u64 = 60;

#[derive(Debug, Clone)]
pub struct PendingWorkerReport {
    worker: TaskBinding,
    queued_at: std::time::Instant,
}

/// key = leader 的 PTY session_id（与 StateTransition.pty_session_id 同域）
pub type PendingReportMap = HashMap<String, Vec<PendingWorkerReport>>;

#[derive(Debug, PartialEq, Eq)]
struct ExpiredPendingReport {
    worker_id: String,
    age_secs: u64,
}

struct PendingEnqueueResult {
    queue_len: usize,
    expired: Vec<ExpiredPendingReport>,
}

struct PendingReportBatch {
    reports: Vec<PendingWorkerReport>,
    expired: Vec<ExpiredPendingReport>,
}

fn pending_report_expired(report: &PendingWorkerReport, now: std::time::Instant) -> bool {
    now.saturating_duration_since(report.queued_at).as_secs() > PENDING_REPORT_TTL_SECS
}

fn expired_pending_report(
    report: &PendingWorkerReport,
    now: std::time::Instant,
) -> ExpiredPendingReport {
    ExpiredPendingReport {
        worker_id: report.worker.id.clone(),
        age_secs: now.saturating_duration_since(report.queued_at).as_secs(),
    }
}

/// 入队：TTL 剪枝 → 同 worker.id 去重（保留最新）→ push → 超上限丢最老。
fn enqueue_pending_report(
    map: &mut PendingReportMap,
    leader_session_id: &str,
    worker: TaskBinding,
    now: std::time::Instant,
) -> PendingEnqueueResult {
    let queue = map.entry(leader_session_id.to_string()).or_default();
    let mut expired = Vec::new();
    queue.retain(|report| {
        if pending_report_expired(report, now) {
            expired.push(expired_pending_report(report, now));
            false
        } else {
            report.worker.id != worker.id
        }
    });
    queue.push(PendingWorkerReport {
        worker,
        queued_at: now,
    });
    if queue.len() > PENDING_REPORT_MAX_PER_LEADER {
        let dropped = queue.remove(0);
        warn!(
            leader_session_id,
            dropped_worker_id = %dropped.worker.id,
            "pending worker report queue overflow; dropped oldest"
        );
    }
    PendingEnqueueResult {
        queue_len: queue.len(),
        expired,
    }
}

/// 取走并清空该 leader 的全部排队 report（TTL 过滤）
fn take_pending_reports(
    map: &mut PendingReportMap,
    leader_session_id: &str,
    now: std::time::Instant,
) -> PendingReportBatch {
    let mut reports = Vec::new();
    let mut expired = Vec::new();
    for report in map.remove(leader_session_id).unwrap_or_default() {
        if pending_report_expired(&report, now) {
            expired.push(expired_pending_report(&report, now));
        } else {
            reports.push(report);
        }
    }
    PendingReportBatch { reports, expired }
}

fn record_expired_pending_reports(
    task_binding_service: &crate::services::TaskBindingService,
    expired: &[ExpiredPendingReport],
) -> usize {
    let mut updated = 0;
    for report in expired {
        warn!(
            worker_id = %report.worker_id,
            age_secs = report.age_secs,
            "pending worker report expired before delivery"
        );
        match task_binding_service.update_patch(
            &report.worker_id,
            serde_json::json!({ "metadata": { "reportDropped": true } }),
        ) {
            Ok(_) => updated += 1,
            Err(error) => warn!(
                worker_id = %report.worker_id,
                age_secs = report.age_secs,
                error = %error,
                "failed to persist expired worker report metadata"
            ),
        }
    }
    updated
}

/// 丢弃该 leader 的全部排队 report，返回丢弃条数
fn clear_pending_reports(map: &mut PendingReportMap, leader_session_id: &str) -> usize {
    map.remove(leader_session_id).map_or(0, |queue| queue.len())
}

#[derive(Debug, PartialEq, Eq)]
enum PendingFlushAction {
    Flush,
    Clear,
    None,
}

/// 状态机跃迁 → 补投动作。不检查 from：Initializing→Idle 也必须 flush
/// （initializing 期间入队的 report 靠这次边沿投出）。
fn pending_flush_action(to: SessionStatus) -> PendingFlushAction {
    match to {
        SessionStatus::Idle | SessionStatus::WaitingInput => PendingFlushAction::Flush,
        SessionStatus::Exited | SessionStatus::Error => PendingFlushAction::Clear,
        SessionStatus::Initializing
        | SessionStatus::Thinking
        | SessionStatus::ToolRunning
        | SessionStatus::Compacting
        | SessionStatus::Active => PendingFlushAction::None,
    }
}

fn pending_level_action(status: Option<SessionStatus>) -> PendingFlushAction {
    status.map_or(PendingFlushAction::Clear, pending_flush_action)
}

/// 补投：锁内取走队列立即放锁，逐条顺序重跑 send_worker_report_to_leader
/// （保序；期间 leader 再次变 busy 时其内部会重新入队等下次边沿）。
async fn flush_pending_reports(state: AppState, leader_session_id: String) {
    let batch = {
        let mut map = state
            .pending_worker_reports
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        take_pending_reports(&mut map, &leader_session_id, std::time::Instant::now())
    };
    record_expired_pending_reports(&state.task_binding_service, &batch.expired);
    if batch.reports.is_empty() {
        return;
    }
    info!(
        leader_session_id,
        count = batch.reports.len(),
        "flushing pending worker reports to leader"
    );
    for report in batch.reports {
        let worker_id = report.worker.id.clone();
        let result = send_worker_report_to_leader(state.clone(), report.worker).await;
        debug!(
            leader_session_id,
            worker_id,
            sent = result.sent,
            requeued = result.queued,
            skip_reason = result.skip_reason.as_deref().unwrap_or(""),
            "pending worker report flush attempt"
        );
    }
}

/// busy/initializing 入队 + 竞态双重检查：入队后 leader 可能已恰好跃迁回空闲
/// （边沿已过、无人再触发 flush），重读一次状态，空闲则立即补投。
fn read_session_status_for_automatic_submit(
    state: &AppState,
    session_id: &str,
) -> std::result::Result<Option<SessionStatus>, String> {
    state
        .terminal_backend
        .backend()
        .get_session_status(session_id)
        .map(|status| {
            status.map(|status| {
                state.session_state_machine.status_for_automatic_submit(
                    session_id,
                    status.status,
                    status.last_output_at,
                )
            })
        })
        .map_err(|error| error.to_string())
}

fn enqueue_and_recheck(
    state: &AppState,
    leader_session_id: &str,
    worker: &TaskBinding,
    reason: &'static str,
) -> LeaderReportResult {
    let enqueue_result = {
        let mut map = state
            .pending_worker_reports
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        enqueue_pending_report(
            &mut map,
            leader_session_id,
            worker.clone(),
            std::time::Instant::now(),
        )
    };
    record_expired_pending_reports(&state.task_binding_service, &enqueue_result.expired);
    info!(
        worker_id = %worker.id,
        leader_session_id,
        queue_len = enqueue_result.queue_len,
        reason,
        "worker report queued for redelivery"
    );

    let now_idle = read_session_status_for_automatic_submit(state, leader_session_id)
        .ok()
        .flatten()
        .is_some_and(|status| matches!(status, SessionStatus::Idle | SessionStatus::WaitingInput));
    if now_idle {
        let flush_state = state.clone();
        let sid = leader_session_id.to_string();
        tokio::spawn(flush_pending_reports(flush_state, sid));
    }

    LeaderReportResult::queued(reason)
}

async fn scan_pending_reports_once(state: &AppState) {
    let leader_session_ids = {
        let map = state
            .pending_worker_reports
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        map.iter()
            .filter(|(_, queue)| !queue.is_empty())
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>()
    };

    for leader_session_id in leader_session_ids {
        let sid = leader_session_id.clone();
        let status = match query_session_status_for_automatic_submit(state, &sid).await {
            Ok(status) => status,
            Err(error) => {
                warn!(
                    session_id = %leader_session_id,
                    error,
                    "pending worker report level scan could not read leader status"
                );
                continue;
            }
        };

        match pending_level_action(status) {
            PendingFlushAction::Flush => {
                flush_pending_reports(state.clone(), leader_session_id).await;
            }
            PendingFlushAction::Clear => {
                let dropped = {
                    let mut map = state
                        .pending_worker_reports
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    clear_pending_reports(&mut map, &leader_session_id)
                };
                if dropped > 0 {
                    warn!(
                        session_id = %leader_session_id,
                        dropped,
                        "leader session unavailable; dropped pending worker reports"
                    );
                }
            }
            PendingFlushAction::None => {}
        }
    }
}

async fn run_pending_report_level_scan(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(
        PENDING_REPORT_SCAN_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        interval.tick().await;
        scan_pending_reports_once(&state).await;
    }
}

fn should_notify_terminal_transition(
    old: Option<TaskBindingStatus>,
    new: TaskBindingStatus,
) -> bool {
    fn is_terminal(status: &TaskBindingStatus) -> bool {
        matches!(
            status,
            TaskBindingStatus::Completed | TaskBindingStatus::Failed
        )
    }

    is_terminal(&new) && !old.as_ref().is_some_and(is_terminal)
}

fn sanitize_pty_line(input: &str, max_len: usize) -> String {
    let normalized = input.replace(['\r', '\n'], " | ");
    normalized
        .chars()
        .filter(|ch| *ch == '\t' || *ch >= ' ')
        .take(max_len)
        .collect()
}

fn notify_leader_on_terminal_status(
    state: AppState,
    old_status: Option<TaskBindingStatus>,
    worker: TaskBinding,
) {
    if !should_notify_terminal_transition(old_status.clone(), worker.status.clone()) {
        debug!(
            worker_id = %worker.id,
            old_status = ?old_status,
            new_status = %worker.status,
            "worker report auto-notify skipped: status transition is not terminal"
        );
        return;
    }

    tokio::spawn(async move {
        let _ = send_worker_report_to_leader(state, worker).await;
    });
}

async fn send_worker_report_to_leader(state: AppState, worker: TaskBinding) -> LeaderReportResult {
    let Some(parent_id) = worker.parent_id.clone() else {
        debug!(
            worker_id = %worker.id,
            "worker report skipped: worker has no parent binding"
        );
        return LeaderReportResult::skipped("worker has no parent");
    };

    let leader = match state.task_binding_service.get(&parent_id) {
        Ok(Some(leader)) => leader,
        Ok(None) => {
            warn!(
                worker_id = %worker.id,
                leader_id = %parent_id,
                "worker report skipped: leader binding not found"
            );
            return LeaderReportResult::skipped("leader not found");
        }
        Err(e) => {
            warn!(
                worker_id = %worker.id,
                leader_id = %parent_id,
                err = %e,
                "worker report skipped: failed to load leader binding"
            );
            return LeaderReportResult::skipped(format!("failed to load leader: {}", e));
        }
    };

    let Some(leader_session_id) = leader.session_id.clone() else {
        warn!(
            worker_id = %worker.id,
            leader_id = %leader.id,
            "worker report skipped: leader has no session id"
        );
        return LeaderReportResult::skipped("leader session missing");
    };

    let leader_status = match read_session_status_for_automatic_submit(&state, &leader_session_id) {
        Ok(status) => status,
        Err(e) => {
            warn!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                err = %e,
                "worker report skipped: failed to read leader session status"
            );
            return LeaderReportResult::skipped(format!("failed to read leader status: {}", e));
        }
    };

    let Some(leader_status) = leader_status else {
        warn!(
            worker_id = %worker.id,
            leader_id = %leader.id,
            session_id = %leader_session_id,
            "worker report skipped: leader session not found"
        );
        return LeaderReportResult::skipped("leader session not found");
    };

    match leader_status {
        SessionStatus::Idle | SessionStatus::WaitingInput => {}
        status @ (SessionStatus::Thinking
        | SessionStatus::ToolRunning
        | SessionStatus::Compacting
        | SessionStatus::Active) => {
            debug_assert!(status.is_busy());
            debug!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                status = ?status,
                "worker report queued: leader is busy"
            );
            return enqueue_and_recheck(&state, &leader_session_id, &worker, "leader busy");
        }
        SessionStatus::Initializing => {
            debug!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                "worker report queued: leader session is initializing"
            );
            return enqueue_and_recheck(
                &state,
                &leader_session_id,
                &worker,
                "leader session initializing",
            );
        }
        SessionStatus::Error => {
            let dropped = {
                let mut map = state
                    .pending_worker_reports
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                clear_pending_reports(&mut map, &leader_session_id)
            };
            warn!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                dropped_pending = dropped,
                "worker report skipped: leader session is in error state"
            );
            return LeaderReportResult::skipped("leader session error");
        }
        SessionStatus::Exited => {
            let dropped = {
                let mut map = state
                    .pending_worker_reports
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                clear_pending_reports(&mut map, &leader_session_id)
            };
            warn!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                dropped_pending = dropped,
                "worker report skipped: leader session exited"
            );
            return LeaderReportResult::skipped("leader session exited");
        }
    }

    let summary = worker
        .completion_summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
        .map(|summary| sanitize_pty_line(summary, 500))
        .unwrap_or_else(|| "(no summary)".to_string());
    let line = format!(
        "[worker-report] id={} status={} summary={}",
        worker.id, worker.status, summary
    );

    match submit_text_to_session(state.terminal_backend.backend(), &leader_session_id, &line).await
    {
        Ok(()) => {
            info!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                "worker report sent to leader"
            );
            LeaderReportResult::sent()
        }
        Err(e) => {
            warn!(
                worker_id = %worker.id,
                leader_id = %leader.id,
                session_id = %leader_session_id,
                err = %e,
                "worker report failed to submit to leader"
            );
            LeaderReportResult::skipped(format!("submit failed: {}", e))
        }
    }
}

fn local_orchestrator_endpoint_reachable(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::WorkspaceCliEnvironmentDefaults;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn wait_test_status(session_id: &str, status: SessionStatus) -> SessionStatusInfo {
        SessionStatusInfo {
            session_id: session_id.to_string(),
            status,
            last_output_at: 0,
            pid: Some(1),
            exit_code: None,
            current_tool_name: None,
            current_tool_use_id: None,
            current_tool_summary: None,
            updated_at: 0,
        }
    }

    #[test]
    fn registered_project_path_matches_all_windows_runtime_forms() {
        let registered = r"D:\Repos\App";
        assert!(registered_path_matches(registered, r"d:\repos\app\"));
        assert!(registered_path_matches(registered, "/mnt/d/REPOS/APP"));
        assert!(registered_path_matches(
            registered,
            r"\\wsl.localhost\Ubuntu\mnt\d\Repos\App"
        ));
    }

    #[test]
    fn registration_and_list_dedup_keep_wsl_linux_identity_sensitive() {
        let mut seen = HashSet::new();
        assert!(mark_project_path_seen(&mut seen, r"D:\Repos\App"));
        assert!(!mark_project_path_seen(&mut seen, "/mnt/d/repos/app"));
        assert!(!mark_project_path_seen(
            &mut seen,
            r"\\wsl$\Ubuntu\mnt\d\REPOS\APP"
        ));

        assert!(mark_project_path_seen(
            &mut seen,
            r"\\wsl.localhost\Ubuntu\home\User\App"
        ));
        assert!(mark_project_path_seen(
            &mut seen,
            r"\\wsl.localhost\ubuntu\home\User\App"
        ));
        assert!(mark_project_path_seen(
            &mut seen,
            r"\\wsl.localhost\Ubuntu\home\user\App"
        ));
    }

    #[test]
    fn decode_terminal_escapes_restores_control_bytes() {
        // 模型写 "\\x03" 时到达的是字面 \ x 0 3。
        assert_eq!(decode_terminal_escapes("\\x03"), "\u{3}");
        assert_eq!(decode_terminal_escapes("\\u001b[Z"), "\u{1b}[Z");
        assert_eq!(decode_terminal_escapes("\\e"), "\u{1b}");
        assert_eq!(decode_terminal_escapes("\\r"), "\r");
        assert_eq!(decode_terminal_escapes("\\n\\t\\0"), "\n\t\u{0}");
    }

    #[test]
    fn decode_terminal_escapes_honors_doubled_backslash() {
        // 想发字面 \x03 的用户写 \\x03（JSON 里是 "\\\\x03"）。
        assert_eq!(decode_terminal_escapes("\\\\x03"), "\\x03");
        assert_eq!(decode_terminal_escapes("C:\\\\tmp"), "C:\\tmp");
    }

    #[test]
    fn decode_terminal_escapes_is_idempotent_on_real_control_bytes() {
        // 已经是真控制字节的输入不受影响（不含反斜杠）。
        for raw in ["\u{1b}", "\u{1b}[Z", "\u{3}", "\r", "hello world"] {
            assert_eq!(decode_terminal_escapes(raw), raw);
            assert_eq!(decode_terminal_escapes(&decode_terminal_escapes(raw)), raw);
        }
    }

    #[test]
    fn decode_terminal_escapes_preserves_unknown_and_truncated_escapes() {
        // 非转义序列原样保留，不吞字符。
        assert_eq!(decode_terminal_escapes("\\q"), "\\q");
        assert_eq!(decode_terminal_escapes("\\xZZ"), "\\xZZ");
        assert_eq!(decode_terminal_escapes("\\u12"), "\\u12");
        assert_eq!(decode_terminal_escapes("trailing\\"), "trailing\\");
    }

    #[test]
    fn wait_timeout_uses_default_and_clamps_bounds() {
        assert_eq!(
            normalized_wait_timeout_ms(None),
            WAIT_FOR_SESSION_DEFAULT_TIMEOUT_MS
        );
        assert_eq!(
            normalized_wait_timeout_ms(Some(1)),
            WAIT_FOR_SESSION_MIN_TIMEOUT_MS
        );
        assert_eq!(
            normalized_wait_timeout_ms(Some(u64::MAX)),
            WAIT_FOR_SESSION_MAX_TIMEOUT_MS
        );
    }

    #[tokio::test]
    async fn wait_for_session_fast_path_and_missing_exited_are_immediate() {
        let state_machine = Arc::new(cc_panes_core::services::SessionStateMachine::new());
        let idle = wait_for_session_with_query(
            state_machine.clone(),
            "idle-session".to_string(),
            vec![SessionStatus::Idle],
            std::time::Duration::from_secs(1),
            || async { Ok(Some(wait_test_status("idle-session", SessionStatus::Idle))) },
        )
        .await
        .expect("idle fast path");
        assert!(idle.satisfied);
        assert_eq!(idle.final_status, SessionStatus::Idle);
        assert_eq!(idle.waited_ms, 0);

        let missing = wait_for_session_with_query(
            state_machine,
            "missing-session".to_string(),
            vec![SessionStatus::Exited],
            std::time::Duration::from_secs(1),
            || async { Ok(None) },
        )
        .await
        .expect("missing session satisfies exited");
        assert!(missing.satisfied);
        assert_eq!(missing.final_status, SessionStatus::Exited);
        assert_eq!(missing.waited_ms, 0);
    }

    #[tokio::test]
    async fn wait_for_session_second_snapshot_closes_subscribe_race() {
        let state_machine = Arc::new(cc_panes_core::services::SessionStateMachine::new());
        let status = Arc::new(Mutex::new(SessionStatus::Thinking));
        let calls = Arc::new(AtomicUsize::new(0));
        let query_state_machine = state_machine.clone();
        let query_status = status.clone();
        let query_calls = calls.clone();

        let result = wait_for_session_with_query(
            state_machine,
            "race-session".to_string(),
            vec![SessionStatus::Idle],
            std::time::Duration::from_secs(1),
            move || {
                let observed = *query_status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if query_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    *query_status
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = SessionStatus::Idle;
                    query_state_machine.on_event(
                        "race-session",
                        &cc_cli_adapters::CcPaneEvent::TurnEnd,
                        None,
                        &serde_json::json!({}),
                    );
                }
                async move { Ok(Some(wait_test_status("race-session", observed))) }
            },
        )
        .await
        .expect("second snapshot catches transition");

        assert!(result.satisfied);
        assert_eq!(result.final_status, SessionStatus::Idle);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn wait_for_session_wakes_on_matching_transition() {
        let state_machine = Arc::new(cc_panes_core::services::SessionStateMachine::new());
        state_machine.on_event(
            "event-session",
            &cc_cli_adapters::CcPaneEvent::PromptBefore,
            None,
            &serde_json::json!({}),
        );
        let status = Arc::new(Mutex::new(SessionStatus::Thinking));
        let calls = Arc::new(AtomicUsize::new(0));
        let query_status = status.clone();
        let query_calls = calls.clone();
        let waiter_state_machine = state_machine.clone();
        let waiter = tokio::spawn(wait_for_session_with_query(
            waiter_state_machine,
            "event-session".to_string(),
            vec![SessionStatus::Idle],
            std::time::Duration::from_secs(1),
            move || {
                query_calls.fetch_add(1, Ordering::SeqCst);
                let observed = *query_status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                async move { Ok(Some(wait_test_status("event-session", observed))) }
            },
        ));
        while calls.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }

        *status.lock().unwrap_or_else(|error| error.into_inner()) = SessionStatus::Idle;
        state_machine.on_event(
            "event-session",
            &cc_cli_adapters::CcPaneEvent::TurnEnd,
            None,
            &serde_json::json!({}),
        );

        let result = waiter.await.expect("wait task").expect("wait result");
        assert!(result.satisfied);
        assert_eq!(result.final_status, SessionStatus::Idle);
        assert_eq!(result.turn_seq, 1);
    }

    #[tokio::test]
    async fn wait_for_session_returns_blocked_states_without_waiting() {
        for (status, reason) in [
            (SessionStatus::WaitingInput, "waiting-input"),
            (SessionStatus::Error, "error"),
        ] {
            let result = wait_for_session_with_query(
                Arc::new(cc_panes_core::services::SessionStateMachine::new()),
                "blocked-session".to_string(),
                vec![SessionStatus::Idle],
                std::time::Duration::from_secs(1),
                || async { Ok(Some(wait_test_status("blocked-session", status))) },
            )
            .await
            .expect("blocked result");
            assert!(!result.satisfied);
            assert_eq!(result.final_status, status);
            assert_eq!(result.blocked_reason.as_deref(), Some(reason));
            assert_eq!(result.waited_ms, 0);
        }
    }

    #[tokio::test]
    async fn clear_like_turn_end_does_not_satisfy_wait_for_exited() {
        let state_machine = Arc::new(cc_panes_core::services::SessionStateMachine::new());
        state_machine.on_event(
            "clear-session",
            &cc_cli_adapters::CcPaneEvent::PromptBefore,
            None,
            &serde_json::json!({}),
        );
        let status = Arc::new(Mutex::new(SessionStatus::Thinking));
        let calls = Arc::new(AtomicUsize::new(0));
        let query_status = status.clone();
        let query_calls = calls.clone();
        let waiter_state_machine = state_machine.clone();
        let waiter = tokio::spawn(wait_for_session_with_query(
            waiter_state_machine,
            "clear-session".to_string(),
            vec![SessionStatus::Exited],
            std::time::Duration::from_millis(40),
            move || {
                query_calls.fetch_add(1, Ordering::SeqCst);
                let observed = *query_status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                async move { Ok(Some(wait_test_status("clear-session", observed))) }
            },
        ));
        while calls.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }

        // CLI hook 已过滤 reason=clear 的 SessionEnd；可能到达的 TurnEnd 只能进入 Idle。
        *status.lock().unwrap_or_else(|error| error.into_inner()) = SessionStatus::Idle;
        state_machine.on_event(
            "clear-session",
            &cc_cli_adapters::CcPaneEvent::TurnEnd,
            None,
            &serde_json::json!({ "reason": "clear" }),
        );

        let result = waiter.await.expect("wait task").expect("wait result");
        assert!(!result.satisfied);
        assert_eq!(result.final_status, SessionStatus::Idle);
        assert!(result.blocked_reason.is_none());
    }

    #[test]
    fn periodic_wait_recheck_observes_stale_busy_fallback() {
        let state_machine = cc_panes_core::services::SessionStateMachine::new();
        let session_id = "stale-session";
        state_machine.on_event(
            session_id,
            &cc_cli_adapters::CcPaneEvent::PromptBefore,
            None,
            &serde_json::json!({}),
        );
        let snapshot = state_machine.snapshot(session_id).expect("state entry");
        let query_time = snapshot.last_hook_event_at
            + std::time::Duration::from_secs(
                cc_panes_core::constants::session_state::STALE_BUSY_TIMEOUT_SECS + 1,
            );
        let effective =
            state_machine.status_for_query_at(session_id, SessionStatus::Thinking, query_time);

        let observation = observe_wait_status(
            &state_machine,
            session_id,
            &[SessionStatus::Idle],
            Some(wait_test_status(session_id, effective)),
            WAIT_FOR_SESSION_RECHECK_SECS * 1_000,
        )
        .expect("wait observation");
        let WaitObservation::Done(result) = observation else {
            panic!("stale busy fallback should satisfy idle wait");
        };
        assert!(result.satisfied);
        assert_eq!(result.final_status, SessionStatus::Idle);
    }

    #[test]
    fn decide_bind_explicit_modes_ignore_wsl_signal() {
        let loopback = decide_bind("loopback", None, Some(false));
        assert_eq!(loopback.host, "127.0.0.1");
        let all = decide_bind("all", None, Some(true));
        assert_eq!(all.host, "0.0.0.0");
    }

    #[test]
    fn decide_bind_auto_without_wsl_usage_stays_loopback() {
        let decision = decide_bind("auto", Some(Ok(None)), None);
        assert_eq!(decision.host, "127.0.0.1");
    }

    #[test]
    fn decide_bind_auto_with_wsl_usage_and_mirrored_stays_loopback() {
        let decision = decide_bind(
            "auto",
            Some(Ok(Some("workspace 'x'".to_string()))),
            Some(true),
        );
        assert_eq!(decision.host, "127.0.0.1");
        assert!(decision.reason.contains("mirrored"));
    }

    #[test]
    fn decide_bind_auto_with_wsl_usage_and_nat_opens_all_interfaces() {
        for mirrored in [Some(false), None] {
            let decision = decide_bind(
                "auto",
                Some(Ok(Some("launch history".to_string()))),
                mirrored,
            );
            assert_eq!(decision.host, "0.0.0.0");
        }
    }

    #[test]
    fn decide_bind_auto_detection_failure_fails_open() {
        let decision = decide_bind("auto", Some(Err("boom".to_string())), Some(true));
        assert_eq!(decision.host, "0.0.0.0");
        assert!(decision.reason.contains("fail-open"));
    }

    #[test]
    fn parse_wsl_networking_mirrored_variants() {
        assert!(parse_wsl_networking_mirrored(
            "[wsl2]\nnetworkingMode=mirrored\n"
        ));
        assert!(parse_wsl_networking_mirrored(
            "[wsl2]\n networkingMode = Mirrored \n"
        ));
        assert!(!parse_wsl_networking_mirrored(
            "[wsl2]\n# networkingMode=mirrored\n"
        ));
        assert!(!parse_wsl_networking_mirrored("[wsl2]\nmemory=8GB\n"));
        assert!(!parse_wsl_networking_mirrored(
            "[wsl2]\nnetworkingMode=nat\n"
        ));
    }

    #[test]
    fn test_generate_token_length() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_verify_token_valid() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer abc123".parse().unwrap());
        assert!(verify_token(&headers, "abc123"));
    }

    #[test]
    fn test_verify_token_invalid() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        assert!(!verify_token(&headers, "abc123"));
    }

    #[test]
    fn test_verify_token_missing() {
        let headers = HeaderMap::new();
        assert!(!verify_token(&headers, "abc123"));
    }

    #[test]
    fn test_verify_token_no_bearer_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "abc123".parse().unwrap());
        assert!(!verify_token(&headers, "abc123"));
    }

    fn test_pending_report_worker(id: &str) -> TaskBinding {
        TaskBinding {
            id: id.to_string(),
            title: format!("worker-{id}"),
            role: crate::models::task_binding::TaskBindingRole::Worker,
            parent_id: Some("leader-1".to_string()),
            plan_path: None,
            normalized_plan_path: None,
            prompt: None,
            session_id: Some(format!("session-{id}")),
            resume_id: None,
            pane_id: None,
            tab_id: None,
            todo_id: None,
            project_path: "D:/repo".to_string(),
            workspace_name: None,
            cli_tool: "codex".to_string(),
            status: TaskBindingStatus::Completed,
            progress: 100,
            completion_summary: Some(format!("summary-{id}")),
            exit_code: None,
            sort_order: 0,
            metadata: None,
            created_at: "2026-07-04T00:00:00Z".to_string(),
            updated_at: "2026-07-04T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn pending_report_enqueue_dedupes_by_worker_id_keeping_latest() {
        let mut map = PendingReportMap::new();
        let now = std::time::Instant::now();
        enqueue_pending_report(&mut map, "leader-s", test_pending_report_worker("w1"), now);
        let mut updated = test_pending_report_worker("w1");
        updated.completion_summary = Some("newer".to_string());
        let result = enqueue_pending_report(&mut map, "leader-s", updated, now);

        assert_eq!(result.queue_len, 1);
        assert!(result.expired.is_empty());
        let queue = map.get("leader-s").expect("queue exists");
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].worker.completion_summary.as_deref(), Some("newer"));
    }

    #[test]
    fn pending_report_enqueue_drops_oldest_over_limit() {
        let mut map = PendingReportMap::new();
        let now = std::time::Instant::now();
        for index in 0..=PENDING_REPORT_MAX_PER_LEADER {
            enqueue_pending_report(
                &mut map,
                "leader-s",
                test_pending_report_worker(&format!("w{index}")),
                now,
            );
        }
        let queue = map.get("leader-s").expect("queue exists");
        assert_eq!(queue.len(), PENDING_REPORT_MAX_PER_LEADER);
        // 最老的 w0 被丢弃
        assert!(queue.iter().all(|report| report.worker.id != "w0"));
    }

    #[test]
    fn pending_report_take_filters_expired_and_removes_key() {
        let mut map = PendingReportMap::new();
        let now = std::time::Instant::now();
        enqueue_pending_report(&mut map, "leader-s", test_pending_report_worker("w1"), now);
        enqueue_pending_report(&mut map, "leader-s", test_pending_report_worker("w2"), now);
        // 用"未来的 now"制造过期（往 Instant 加时长总是安全；往回减在 CI
        // 新虚拟机上会因 uptime 不足而下溢 panic）。w2 的入队时间也前移，
        // 使其在 later 时刻仍未过期。
        let later = now + std::time::Duration::from_secs(PENDING_REPORT_TTL_SECS + 1);
        map.get_mut("leader-s").unwrap()[1].queued_at = now + std::time::Duration::from_secs(2);

        let batch = take_pending_reports(&mut map, "leader-s", later);
        assert_eq!(batch.reports.len(), 1);
        assert_eq!(batch.reports[0].worker.id, "w2");
        assert_eq!(batch.expired.len(), 1);
        assert_eq!(batch.expired[0].worker_id, "w1");
        assert!(batch.expired[0].age_secs > PENDING_REPORT_TTL_SECS);
        assert!(!map.contains_key("leader-s"));

        // 空 map 再取
        assert!(take_pending_reports(&mut map, "leader-s", later)
            .reports
            .is_empty());
    }

    #[test]
    fn ttl_drop_during_enqueue_is_persisted_in_worker_metadata() {
        use crate::models::task_binding::{CreateTaskBindingRequest, TaskBindingRole};

        let db = Arc::new(
            cc_panes_core::repository::Database::new_fallback().expect("fallback database"),
        );
        let service = crate::services::TaskBindingService::new(Arc::new(
            cc_panes_core::repository::TaskBindingRepository::new(db),
        ));
        let worker = service
            .create(CreateTaskBindingRequest {
                title: "worker".to_string(),
                role: Some(TaskBindingRole::Worker),
                parent_id: Some("leader-1".to_string()),
                plan_path: None,
                normalized_plan_path: None,
                prompt: None,
                session_id: Some("worker-session".to_string()),
                resume_id: None,
                pane_id: None,
                tab_id: None,
                todo_id: None,
                project_path: "D:/repo".to_string(),
                workspace_name: None,
                cli_tool: Some("codex".to_string()),
                metadata: Some(serde_json::json!({ "kept": true })),
            })
            .expect("create worker binding");
        let now = std::time::Instant::now();
        let mut map = PendingReportMap::new();
        enqueue_pending_report(&mut map, "leader-s", worker.clone(), now);
        let later = now + std::time::Duration::from_secs(PENDING_REPORT_TTL_SECS + 1);

        let result = enqueue_pending_report(&mut map, "leader-s", worker.clone(), later);
        assert_eq!(record_expired_pending_reports(&service, &result.expired), 1);
        assert_eq!(result.queue_len, 1);

        let persisted = service
            .get(&worker.id)
            .expect("load binding")
            .expect("binding exists");
        let metadata = persisted.metadata.expect("metadata");
        assert_eq!(metadata["kept"], true);
        assert_eq!(metadata["reportDropped"], true);
    }

    #[test]
    fn level_scan_uses_automatic_submit_status_and_flushes_once() {
        let state_machine = cc_panes_core::services::SessionStateMachine::new();
        let sid = "leader-stale";
        state_machine.on_event(
            sid,
            &cc_cli_adapters::CcPaneEvent::PromptBefore,
            None,
            &serde_json::json!({}),
        );
        let snapshot = state_machine.snapshot(sid).expect("state entry");
        let query_time = snapshot.last_hook_event_at
            + std::time::Duration::from_secs(
                cc_panes_core::constants::session_state::STALE_BUSY_TIMEOUT_SECS + 1,
            );
        let effective = state_machine.status_for_automatic_submit_at(
            sid,
            SessionStatus::Idle,
            true,
            query_time,
        );
        assert_eq!(
            pending_level_action(Some(effective)),
            PendingFlushAction::Flush
        );

        let now = std::time::Instant::now();
        let map = Arc::new(Mutex::new(PendingReportMap::new()));
        enqueue_pending_report(
            &mut map.lock().expect("queue lock"),
            sid,
            test_pending_report_worker("worker-once"),
            now,
        );

        let take = |map: Arc<Mutex<PendingReportMap>>| {
            std::thread::spawn(move || {
                take_pending_reports(&mut map.lock().expect("queue lock"), sid, now)
                    .reports
                    .len()
            })
        };
        let edge = take(map.clone());
        let level = take(map);
        assert_eq!(
            edge.join().expect("edge trigger") + level.join().expect("level trigger"),
            1
        );
    }

    #[test]
    fn pending_report_clear_returns_dropped_count() {
        let mut map = PendingReportMap::new();
        let now = std::time::Instant::now();
        enqueue_pending_report(&mut map, "leader-s", test_pending_report_worker("w1"), now);
        enqueue_pending_report(&mut map, "leader-s", test_pending_report_worker("w2"), now);

        assert_eq!(clear_pending_reports(&mut map, "leader-s"), 2);
        assert_eq!(clear_pending_reports(&mut map, "leader-s"), 0);
    }

    #[test]
    fn test_pending_flush_action_covers_all_statuses() {
        assert_eq!(pending_level_action(None), PendingFlushAction::Clear);
        let cases = [
            (SessionStatus::Idle, PendingFlushAction::Flush),
            (SessionStatus::WaitingInput, PendingFlushAction::Flush),
            (SessionStatus::Exited, PendingFlushAction::Clear),
            (SessionStatus::Error, PendingFlushAction::Clear),
            (SessionStatus::Initializing, PendingFlushAction::None),
            (SessionStatus::Thinking, PendingFlushAction::None),
            (SessionStatus::ToolRunning, PendingFlushAction::None),
            (SessionStatus::Compacting, PendingFlushAction::None),
            (SessionStatus::Active, PendingFlushAction::None),
        ];
        for (status, expected) in cases {
            assert_eq!(pending_flush_action(status), expected, "status {status:?}");
        }
    }

    #[test]
    fn leader_report_result_serialization_keeps_legacy_format() {
        let sent = serde_json::to_string(&LeaderReportResult::sent()).unwrap();
        assert!(!sent.contains("queued"));

        let skipped = serde_json::to_string(&LeaderReportResult::skipped("leader busy")).unwrap();
        assert!(!skipped.contains("queued"));
        assert!(skipped.contains("\"skipReason\":\"leader busy\""));

        let queued = serde_json::to_string(&LeaderReportResult::queued("leader busy")).unwrap();
        assert!(queued.contains("\"queued\":true"));
        assert!(queued.contains("\"skipReason\":\"leader busy\""));
    }

    #[test]
    fn test_should_notify_terminal_transition() {
        let cases = [
            (
                Some(TaskBindingStatus::Running),
                TaskBindingStatus::Completed,
                true,
            ),
            (
                Some(TaskBindingStatus::Completed),
                TaskBindingStatus::Completed,
                false,
            ),
            (
                Some(TaskBindingStatus::Failed),
                TaskBindingStatus::Failed,
                false,
            ),
            (None, TaskBindingStatus::Completed, true),
            (
                Some(TaskBindingStatus::Pending),
                TaskBindingStatus::Failed,
                true,
            ),
            (
                Some(TaskBindingStatus::Running),
                TaskBindingStatus::Running,
                false,
            ),
        ];

        for (old, new, expected) in cases {
            assert_eq!(
                should_notify_terminal_transition(old.clone(), new.clone()),
                expected,
                "old={old:?} new={new:?}"
            );
        }
    }

    #[test]
    fn test_task_status_from_session_status_maps_live_states() {
        use cc_panes_core::services::terminal_service::SessionStatus;

        assert_eq!(
            task_status_from_session_status(SessionStatus::Initializing),
            "launching"
        );
        assert_eq!(
            task_status_from_session_status(SessionStatus::ToolRunning),
            "running"
        );
        assert_eq!(
            task_status_from_session_status(SessionStatus::WaitingInput),
            "waitingInput"
        );
        assert_eq!(
            task_status_from_session_status(SessionStatus::Exited),
            "exited"
        );
    }

    #[test]
    fn test_cleanup_stale_tasks_removes_exited_tasks() {
        let created_at = std::time::Instant::now();
        let mut tasks = HashMap::from([(
            "task-1".to_string(),
            TaskStatus {
                task_id: "task-1".to_string(),
                session_id: "session-1".to_string(),
                status: "exited".to_string(),
                error: None,
                created_at,
            },
        )]);

        // 用"未来的 now"判定过期，避免在 uptime 不足的 CI 虚拟机上构造过去 Instant 下溢
        cleanup_stale_tasks_at(
            &mut tasks,
            created_at + std::time::Duration::from_secs(31 * 60),
        );

        assert!(tasks.is_empty());
    }

    #[test]
    fn test_normalize_cli_launcher_tool_id_accepts_registered_tools() {
        let supported = vec![
            "claude".to_string(),
            "codex".to_string(),
            "gemini".to_string(),
        ];

        assert_eq!(
            normalize_cli_launcher_tool_id(" Claude ", &supported).unwrap(),
            "claude"
        );
        assert_eq!(
            normalize_cli_launcher_tool_id("codex", &supported).unwrap(),
            "codex"
        );
    }

    #[test]
    fn test_normalize_cli_launcher_tool_id_rejects_none_and_unknown() {
        let supported = vec!["claude".to_string()];

        assert!(normalize_cli_launcher_tool_id("none", &supported)
            .unwrap_err()
            .contains("does not have a launcher"));
        assert!(normalize_cli_launcher_tool_id("reclaude", &supported)
            .unwrap_err()
            .contains("Unknown cliToolId"));
    }

    #[test]
    fn test_normalize_cli_launcher_override_command_trims_quotes_and_clears_blank() {
        assert_eq!(
            normalize_cli_launcher_override_command(r#" "C:\Program Files\reclaude.exe" "#)
                .unwrap()
                .as_deref(),
            Some(r"C:\Program Files\reclaude.exe")
        );
        assert_eq!(
            normalize_cli_launcher_override_command("   ").unwrap(),
            None
        );
    }

    #[test]
    fn test_normalize_cli_launcher_override_command_rejects_shell_operators() {
        assert!(normalize_cli_launcher_override_command("claude; rm -rf /").is_err());
        assert!(normalize_cli_launcher_override_command("claude\n--version").is_err());
    }

    #[derive(Clone, Default)]
    struct FakeTerminal {
        state: Arc<Mutex<FakeTerminalState>>,
    }

    #[derive(Default)]
    struct FakeTerminalState {
        statuses: Vec<SessionStatusInfo>,
        created_sessions: Vec<String>,
        submitted: Vec<(String, String)>,
        killed: Vec<String>,
        next_pid: Option<u32>,
        pid_after_polls: usize,
        get_status_calls: usize,
    }

    impl FakeTerminal {
        fn with_next_pid(pid: Option<u32>) -> Self {
            let fake = Self::default();
            fake.state.lock().unwrap().next_pid = pid;
            fake
        }

        fn with_pid_after_polls(pid: u32, polls: usize) -> Self {
            let fake = Self::with_next_pid(Some(pid));
            fake.state.lock().unwrap().pid_after_polls = polls;
            fake
        }

        fn add_status(&self, session_id: &str, pid: Option<u32>, status: SessionStatus) {
            self.state.lock().unwrap().statuses.push(SessionStatusInfo {
                session_id: session_id.to_string(),
                status,
                last_output_at: 0,
                pid,
                exit_code: None,
                current_tool_name: None,
                current_tool_use_id: None,
                current_tool_summary: None,
                updated_at: 0,
            });
        }

        fn created_count(&self) -> usize {
            self.state.lock().unwrap().created_sessions.len()
        }

        fn submitted_count(&self) -> usize {
            self.state.lock().unwrap().submitted.len()
        }

        fn killed_count(&self) -> usize {
            self.state.lock().unwrap().killed.len()
        }
    }

    impl RunnerTerminal for FakeTerminal {
        fn create_shell_session(
            &self,
            _profile: &RunnerProfile,
            _runtime: &ResolvedLaunchRuntime,
        ) -> std::result::Result<String, String> {
            let mut state = self.state.lock().unwrap();
            let session_id = format!("session-{}", state.created_sessions.len() + 1);
            let pid = if state.pid_after_polls == 0 {
                state.next_pid
            } else {
                None
            };
            state.created_sessions.push(session_id.clone());
            state.statuses.push(SessionStatusInfo {
                session_id: session_id.clone(),
                status: SessionStatus::Initializing,
                last_output_at: 0,
                pid,
                exit_code: None,
                current_tool_name: None,
                current_tool_use_id: None,
                current_tool_summary: None,
                updated_at: 0,
            });
            Ok(session_id)
        }

        fn submit_text_to_session<'a>(
            &'a self,
            session_id: &'a str,
            text: &'a str,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send + 'a>> {
            Box::pin(async move {
                self.state
                    .lock()
                    .unwrap()
                    .submitted
                    .push((session_id.to_string(), text.to_string()));
                Ok(())
            })
        }

        fn get_all_status(&self) -> std::result::Result<Vec<SessionStatusInfo>, String> {
            let mut state = self.state.lock().unwrap();
            state.get_status_calls += 1;
            if state.pid_after_polls > 0 && state.get_status_calls >= state.pid_after_polls {
                let next_pid = state.next_pid;
                for status in &mut state.statuses {
                    if status.pid.is_none() {
                        status.pid = next_pid;
                    }
                }
            }
            Ok(state.statuses.clone())
        }

        fn kill_session(&self, session_id: &str) -> std::result::Result<(), String> {
            self.state
                .lock()
                .unwrap()
                .killed
                .push(session_id.to_string());
            Ok(())
        }
    }

    fn make_runner_service() -> cc_panes_core::services::RunnerService {
        let db = Arc::new(cc_panes_core::repository::Database::new_fallback().expect("db"));
        let repo = Arc::new(cc_panes_core::repository::RunnerRepository::new(db));
        let monitor = Arc::new(cc_panes_core::services::ProcessMonitorService::new());
        cc_panes_core::services::RunnerService::new(repo, monitor)
    }

    fn runner_draft(
        profile_id: Option<String>,
        name: &str,
        expected_ports: Vec<u16>,
    ) -> cc_panes_core::models::RunnerProfileDraft {
        cc_panes_core::models::RunnerProfileDraft {
            id: profile_id,
            project_path: "/tmp/cc-panes-runner-project".to_string(),
            workspace_name: Some("runner-ws".to_string()),
            name: name.to_string(),
            command: "sleep 5".to_string(),
            cwd: "/tmp/cc-panes-runner-project".to_string(),
            runtime_kind: "local".to_string(),
            wsl_distro: None,
            ssh_machine_id: None,
            env: HashMap::new(),
            expected_ports,
            tool_hint: Some("sh".to_string()),
        }
    }

    fn local_runtime() -> ResolvedLaunchRuntime {
        ResolvedLaunchRuntime {
            kind: LaunchRuntimeKind::Local,
            source: "test",
            notice: None,
            wsl: None,
            ssh: None,
        }
    }

    #[tokio::test]
    async fn start_runner_returns_reused_when_alive_instance_exists() {
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![]))
            .expect("profile");
        let instance = service
            .register_instance(
                Some(&profile.id),
                &profile.project_path,
                profile.workspace_name.as_deref(),
                Some("session-live"),
                4242,
                "local",
                &profile.command,
                &profile.cwd,
            )
            .expect("instance");
        let terminal = FakeTerminal::default();
        terminal.add_status("session-live", Some(4242), SessionStatus::Active);
        let locks = StartLocks::default();

        let result = start_runner_coordinator_with_terminal(
            profile,
            &service,
            &terminal,
            &local_runtime(),
            &locks,
        )
        .await
        .expect("start runner");

        assert_eq!(result.status, RunnerStartStatus::Reused);
        assert_eq!(result.instance_id.as_deref(), Some(instance.id.as_str()));
        assert_eq!(result.session_id.as_deref(), Some("session-live"));
        assert_eq!(terminal.created_count(), 0);
    }

    #[tokio::test]
    async fn start_runner_returns_blocked_when_port_conflict() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![port]))
            .expect("profile");
        let terminal = FakeTerminal::with_next_pid(Some(5151));
        let locks = StartLocks::default();

        let result = start_runner_coordinator_with_terminal(
            profile,
            &service,
            &terminal,
            &local_runtime(),
            &locks,
        )
        .await
        .expect("start runner");

        assert_eq!(result.status, RunnerStartStatus::Blocked);
        let plan = result.launch_plan.expect("launch plan");
        assert!(plan.conflicts.iter().any(|conflict| conflict.port == port));
        assert_eq!(terminal.created_count(), 0);
        drop(listener);
    }

    #[tokio::test]
    async fn start_runner_launches_when_clean() {
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![]))
            .expect("profile");
        let terminal = FakeTerminal::with_next_pid(Some(7777));
        let locks = StartLocks::default();

        let result = start_runner_coordinator_with_terminal(
            profile.clone(),
            &service,
            &terminal,
            &local_runtime(),
            &locks,
        )
        .await
        .expect("start runner");

        assert_eq!(result.status, RunnerStartStatus::Launched);
        assert_eq!(result.session_id.as_deref(), Some("session-1"));
        assert_eq!(terminal.created_count(), 1);
        assert_eq!(terminal.submitted_count(), 1);
        let active = service.list_active_by_profile(&profile.id).expect("active");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].root_pid, 7777);
        assert_eq!(active[0].session_id.as_deref(), Some("session-1"));
    }

    #[tokio::test]
    async fn start_runner_concurrent_same_profile_serializes() {
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![]))
            .expect("profile");
        let terminal = FakeTerminal::with_pid_after_polls(8888, 1);
        let locks = StartLocks::default();
        let runtime = local_runtime();

        let (first, second) = tokio::join!(
            start_runner_coordinator_with_terminal(
                profile.clone(),
                &service,
                &terminal,
                &runtime,
                &locks,
            ),
            start_runner_coordinator_with_terminal(
                profile.clone(),
                &service,
                &terminal,
                &runtime,
                &locks,
            )
        );

        let mut statuses = vec![first.unwrap().status, second.unwrap().status];
        statuses.sort_by_key(|status| match status {
            RunnerStartStatus::Launched => 0,
            RunnerStartStatus::Reused => 1,
            RunnerStartStatus::Blocked => 2,
        });
        assert_eq!(
            statuses,
            vec![RunnerStartStatus::Launched, RunnerStartStatus::Reused]
        );
        assert_eq!(terminal.created_count(), 1);
        assert_eq!(
            service.list_active_by_profile(&profile.id).unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn start_runner_dead_instance_cleared_and_relaunches() {
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![]))
            .expect("profile");
        let stale = service
            .register_instance(
                Some(&profile.id),
                &profile.project_path,
                profile.workspace_name.as_deref(),
                Some("session-stale"),
                1000,
                "local",
                &profile.command,
                &profile.cwd,
            )
            .expect("stale");
        let terminal = FakeTerminal::with_next_pid(Some(2000));
        let locks = StartLocks::default();

        let result = start_runner_coordinator_with_terminal(
            profile.clone(),
            &service,
            &terminal,
            &local_runtime(),
            &locks,
        )
        .await
        .expect("start runner");

        assert_eq!(result.status, RunnerStartStatus::Launched);
        let stale_after = service
            .list_active_instances(None)
            .unwrap()
            .into_iter()
            .any(|instance| instance.id == stale.id);
        assert!(!stale_after);
        assert_eq!(terminal.created_count(), 1);
    }

    #[tokio::test]
    async fn start_runner_pid_resolve_failure_rolls_back() {
        let service = make_runner_service();
        let profile = service
            .upsert_profile(runner_draft(None, "dev", vec![]))
            .expect("profile");
        let terminal = FakeTerminal::with_next_pid(None);
        let locks = StartLocks::default();

        let error = start_runner_coordinator_with_terminal(
            profile.clone(),
            &service,
            &terminal,
            &local_runtime(),
            &locks,
        )
        .await
        .expect_err("pid resolve should fail");

        assert!(error.contains("Failed to resolve root pid"));
        assert_eq!(terminal.killed_count(), 1);
        assert!(service
            .list_active_by_profile(&profile.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_sanitize_pty_line_replaces_line_breaks_and_controls() {
        let sanitized = sanitize_pty_line("done\nline\rmore\x1b[31m", 500);

        assert!(!sanitized.contains('\r'));
        assert!(!sanitized.contains('\n'));
        assert!(sanitized.chars().all(|ch| ch == '\t' || ch >= ' '));
        assert_eq!(sanitized, "done | line | more[31m");
    }

    #[test]
    fn test_sanitize_pty_line_truncates_to_max_chars() {
        let input = "a".repeat(600);
        let sanitized = sanitize_pty_line(&input, 500);

        assert_eq!(sanitized.chars().count(), 500);
    }

    #[test]
    fn test_parse_wsl_unc_path_localhost() {
        assert_eq!(
            parse_wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\dev\repo"),
            Some(("Ubuntu".to_string(), "/home/dev/repo".to_string()))
        );
    }

    #[test]
    fn test_parse_wsl_unc_path_wsl_dollar_root() {
        assert_eq!(
            parse_wsl_unc_path(r"\\wsl$\Debian"),
            Some(("Debian".to_string(), "/".to_string()))
        );
    }

    #[test]
    fn test_parse_launch_cli_tool_supported_values() {
        assert_eq!(parse_launch_cli_tool(None).unwrap(), CliTool::Claude);
        assert_eq!(
            parse_launch_cli_tool(Some("codex")).unwrap(),
            CliTool::Codex
        );
        assert_eq!(
            parse_launch_cli_tool(Some("opencode")).unwrap(),
            CliTool::Opencode
        );
        assert_eq!(parse_launch_cli_tool(Some("grok")).unwrap(), CliTool::Grok);
    }

    #[test]
    fn test_parse_launch_cli_tool_rejects_non_orchestrated_tools() {
        let kimi = parse_launch_cli_tool(Some("kimi")).unwrap_err();
        let glm = parse_launch_cli_tool(Some("glm")).unwrap_err();
        assert!(kimi.contains("not supported by launch_task yet"));
        assert!(glm.contains("not supported by launch_task yet"));
        // opencode 现已放行，不应再被拒绝
        assert!(parse_launch_cli_tool(Some("opencode")).is_ok());
    }

    #[test]
    fn test_parse_runtime_config_modes() {
        assert_eq!(
            parse_runtime_mcp_mode(Some("custom")).unwrap(),
            LaunchProfileMcpMode::Custom
        );
        assert_eq!(
            parse_runtime_skill_mode(Some("disabled")).unwrap(),
            LaunchProfileSkillMode::Disabled
        );
        assert_eq!(
            parse_bridge_mode(Some("nativeHttp")).unwrap(),
            BridgeMode::NativeHttp
        );
        assert!(parse_runtime_mcp_mode(Some("unknown")).is_err());
    }

    #[test]
    fn test_trigger_notification_metadata_schema_is_object() {
        let schema = serde_json::to_value(schemars::schema_for!(McpTriggerNotificationParams))
            .expect("serialize schema");
        let metadata_schema = &schema["properties"]["metadata"];

        assert!(metadata_schema.is_object());
        assert_ne!(metadata_schema, &serde_json::json!(true));
        assert_eq!(
            metadata_schema["type"],
            serde_json::json!(["object", "null"])
        );
        if let Some(required) = schema["required"].as_array() {
            assert!(!required
                .iter()
                .any(|field| field.as_str() == Some("metadata")));
        }
    }

    #[test]
    fn test_build_runtime_shared_mcp_servers_allocates_and_reuses_ports() {
        let mut config = SharedMcpConfig::default();
        config.servers.insert(
            "context7".into(),
            SharedMcpServerConfig {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: HashMap::new(),
                shared: true,
                port: 3100,
                bridge_mode: BridgeMode::McpProxy,
            },
        );
        let params = vec![
            McpRuntimeSharedMcpServerParams {
                name: "context7".into(),
                command: "npx".into(),
                args: Some(vec!["-y".into(), "@upstash/context7-mcp".into()]),
                env: None,
                shared: None,
                port: None,
                bridge_mode: None,
            },
            McpRuntimeSharedMcpServerParams {
                name: "playwright".into(),
                command: "npx".into(),
                args: Some(vec!["-y".into(), "@playwright/mcp".into()]),
                env: None,
                shared: None,
                port: None,
                bridge_mode: None,
            },
        ];

        let servers = build_runtime_shared_mcp_servers(&params, &config).unwrap();

        assert_eq!(servers[0].0, "context7");
        assert_eq!(servers[0].1.port, 3100);
        assert_eq!(servers[1].0, "playwright");
        assert_eq!(servers[1].1.port, 3101);
    }

    #[test]
    fn test_build_upsert_shared_mcp_server_config_allocates_new_port() {
        let mut config = SharedMcpConfig::default();
        config.servers.insert(
            "context7".into(),
            SharedMcpServerConfig {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: HashMap::new(),
                shared: true,
                port: 3100,
                bridge_mode: BridgeMode::McpProxy,
            },
        );

        let (name, server) = build_upsert_shared_mcp_server_config(
            McpUpsertSharedMcpServerParams {
                name: "playwright".into(),
                command: "npx".into(),
                args: Some(vec!["-y".into(), "@playwright/mcp".into()]),
                env: None,
                shared: None,
                port: None,
                bridge_mode: None,
                start: None,
                restart_if_running: None,
            },
            &config,
        )
        .unwrap();

        assert_eq!(name, "playwright");
        assert_eq!(server.port, 3101);
        assert!(server.shared);
        assert_eq!(server.bridge_mode, BridgeMode::McpProxy);
    }

    #[test]
    fn test_build_upsert_shared_mcp_server_config_preserves_existing_optional_fields() {
        let mut config = SharedMcpConfig::default();
        config.servers.insert(
            "context7".into(),
            SharedMcpServerConfig {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: HashMap::from([("API_KEY".into(), "secret".into())]),
                shared: false,
                port: 3110,
                bridge_mode: BridgeMode::NativeHttp,
            },
        );

        let (_, server) = build_upsert_shared_mcp_server_config(
            McpUpsertSharedMcpServerParams {
                name: "context7".into(),
                command: "node".into(),
                args: None,
                env: None,
                shared: None,
                port: None,
                bridge_mode: None,
                start: None,
                restart_if_running: None,
            },
            &config,
        )
        .unwrap();

        assert_eq!(server.command, "node");
        assert_eq!(server.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(
            server.env.get("API_KEY").map(String::as_str),
            Some("secret")
        );
        assert!(!server.shared);
        assert_eq!(server.port, 3110);
        assert_eq!(server.bridge_mode, BridgeMode::NativeHttp);
    }

    #[test]
    fn test_to_masked_mcp_json_masks_nested_env_values() {
        let config = SharedMcpServerConfig {
            command: "npx".into(),
            args: vec!["-y".into(), "server".into()],
            env: HashMap::from([
                ("API_KEY".into(), "secret".into()),
                ("DEBUG".into(), "true".into()),
            ]),
            shared: true,
            port: 3100,
            bridge_mode: BridgeMode::McpProxy,
        };

        let value = to_masked_mcp_json(&serde_json::json!({
            "server": config,
            "nested": [{ "env": { "TOKEN": "abc" } }]
        }));

        assert_eq!(value["server"]["env"]["API_KEY"], "***");
        assert_eq!(value["server"]["env"]["DEBUG"], "***");
        assert_eq!(value["nested"][0]["env"]["TOKEN"], "***");
        assert_eq!(value["server"]["command"], "npx");
    }

    #[test]
    fn test_launch_runtime_explicit_local_overrides_workspace_wsl_default() {
        let selected = select_launch_runtime_kind(
            Some(LaunchRuntimeKind::Local),
            None,
            None,
            None,
            Some(LaunchRuntimeKind::Wsl),
        );

        assert_eq!(selected, (LaunchRuntimeKind::Local, "explicit"));
    }

    #[test]
    fn test_launch_runtime_resume_history_overrides_workspace_wsl_default() {
        let selected = select_launch_runtime_kind(
            None,
            Some(LaunchRuntimeKind::Local),
            Some(LaunchRuntimeKind::Wsl),
            Some(LaunchRuntimeKind::Ssh),
            Some(LaunchRuntimeKind::Wsl),
        );

        assert_eq!(selected, (LaunchRuntimeKind::Local, "history"));
    }

    #[test]
    fn test_launch_runtime_path_overrides_cli_default() {
        let selected = select_launch_runtime_kind(
            None,
            None,
            Some(LaunchRuntimeKind::Local),
            Some(LaunchRuntimeKind::Wsl),
            Some(LaunchRuntimeKind::Wsl),
        );

        // path（WSL UNC）优先于 per-CLI 默认；只有显式 runtimeKind 能压过它。
        assert_eq!(selected, (LaunchRuntimeKind::Wsl, "path"));
    }

    #[test]
    fn test_launch_runtime_cli_default_overrides_workspace_default_without_path() {
        let selected = select_launch_runtime_kind(
            None,
            None,
            Some(LaunchRuntimeKind::Local),
            None,
            Some(LaunchRuntimeKind::Wsl),
        );

        // 无 path 推断时，per-CLI 默认仍胜过 workspace 默认。
        assert_eq!(
            selected,
            (LaunchRuntimeKind::Local, "cli_workspace_default")
        );
    }

    #[test]
    fn test_launch_runtime_path_overrides_workspace_default_when_cli_default_missing() {
        let selected = select_launch_runtime_kind(
            None,
            None,
            None,
            Some(LaunchRuntimeKind::Wsl),
            Some(LaunchRuntimeKind::Local),
        );

        assert_eq!(selected, (LaunchRuntimeKind::Wsl, "path"));
    }

    #[test]
    fn test_cli_workspace_default_handles_missing_and_matching_values() {
        let mut workspace = Workspace::new("ws".to_string(), Some("D:/ws".to_string()));
        assert_eq!(cli_workspace_default(&workspace, "codex"), None);

        workspace.cli_environment_defaults = Some(WorkspaceCliEnvironmentDefaults {
            claude: Some(WorkspaceLaunchEnvironment::Local),
            codex: None,
        });

        assert_eq!(cli_workspace_default(&workspace, "gemini"), None);
        assert_eq!(cli_workspace_default(&workspace, "codex"), None);
        assert_eq!(
            cli_workspace_default(&workspace, "claude"),
            Some(LaunchRuntimeKind::Local)
        );
    }

    #[test]
    fn test_effective_cli_default_key_uses_claude_when_missing() {
        assert_eq!(effective_cli_default_key(None), "claude");
        assert_eq!(effective_cli_default_key(Some("codex")), "codex");
    }

    #[test]
    fn test_runtime_notice_for_cli_workspace_default_wsl() {
        let mut workspace = Workspace::new("ws".to_string(), Some("D:/ws".to_string()));
        workspace.cli_environment_defaults = Some(WorkspaceCliEnvironmentDefaults {
            claude: None,
            codex: Some(WorkspaceLaunchEnvironment::Wsl),
        });

        let notice = runtime_notice(
            Some(&workspace),
            LaunchRuntimeKind::Wsl,
            "cli_workspace_default",
            Some("codex"),
        )
        .expect("notice");

        assert!(notice.contains("codex 默认是 WSL"));
    }

    #[test]
    fn test_runtime_notice_for_path_wsl_unc() {
        let workspace = Workspace::new("ws".to_string(), Some("D:/ws".to_string()));

        // M5 后，WSL UNC 路径优先于 CLI 的 local 默认，source 为 "path"。
        let notice = runtime_notice(
            Some(&workspace),
            LaunchRuntimeKind::Wsl,
            "path",
            Some("claude"),
        )
        .expect("notice");

        assert!(notice.contains("项目路径是 WSL UNC"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_resolve_wsl_launch_info_prefers_workspace_project_remote_path() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let service = WorkspaceService::new(dir.path().to_path_buf());

        service
            .create_workspace("ws-wsl", Some(r"D:\workspace"))
            .expect("create workspace");
        service
            .add_project("ws-wsl", r"D:\workspace\repo")
            .expect("add project");

        let mut workspace = service.get_workspace("ws-wsl").expect("load workspace");
        workspace.default_environment = crate::models::WorkspaceLaunchEnvironment::Wsl;
        workspace.wsl = Some(crate::models::WorkspaceWslConfig {
            distro: Some("Ubuntu".to_string()),
            remote_path: Some("/home/dev/workspace".to_string()),
        });
        workspace.projects[0].wsl_remote_path = Some("/home/dev/workspace/repo".to_string());
        service
            .write_workspace_json("ws-wsl", &workspace)
            .expect("persist workspace");

        let workspace = service.get_workspace("ws-wsl").expect("load workspace");
        let info = resolve_wsl_launch_info(r"D:\workspace\repo", Some(&workspace))
            .expect("resolve wsl info");
        assert_eq!(info.remote_path, "/home/dev/workspace/repo");
        assert_eq!(
            info.workspace_remote_path,
            Some("/home/dev/workspace".to_string())
        );
        assert_eq!(info.distro, Some("Ubuntu".to_string()));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_resolve_wsl_launch_info_is_disabled_on_non_windows() {
        assert!(resolve_wsl_launch_info(r"\\wsl.localhost\Ubuntu\home\dev\repo", None).is_none());
    }
}
