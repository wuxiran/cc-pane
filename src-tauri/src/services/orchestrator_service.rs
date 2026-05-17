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
    ExternalSkillRegistry, LaunchHistoryService, LaunchProfileService, NotificationRequest,
    NotificationService, ProjectService, ProviderService, SettingsService, SharedMcpService,
    SkillService, SpecService, SshMachineService, TerminalService, TodoService, WorkspaceService,
};
use crate::utils::{validate_command, validate_mcp_name, validate_path, AppPaths};
use anyhow::Result;
use axum::{
    extract::{DefaultBodyLimit, Json, Path as AxumPath, Request, State},
    http::{self, HeaderMap, Method, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use cc_panes_core::models::shared_mcp::{
    BridgeMode, SharedMcpConfig, SharedMcpServerConfig, SharedMcpServerStatus,
};
use cc_panes_core::services::mcp_config_service::McpServerConfig;
use rmcp::{
    handler::server::router::tool::ToolRouter,
    handler::server::wrapper::Parameters,
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ServerHandler,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
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
    /// CLI 工具类型：`"claude"` | `"codex"`，默认 `"claude"`。
    /// 其他已注册工具请通过直接终端启动。
    pub cli_tool: Option<String>,
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
    pub cli_tool: Option<String>,
    pub runtime_kind: String,
    pub runtime_source: String,
    pub notice: Option<String>,
    pub wsl: Option<WslLaunchInfo>,
    pub ssh: Option<SshConnectionInfo>,
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
        "kimi" | "glm" | "gemini" | "opencode" | "cursor" => Err(format!(
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

fn workspace_runtime_kind(workspace: &Workspace) -> LaunchRuntimeKind {
    match workspace.default_environment {
        WorkspaceLaunchEnvironment::Local => LaunchRuntimeKind::Local,
        WorkspaceLaunchEnvironment::Wsl => LaunchRuntimeKind::Wsl,
        WorkspaceLaunchEnvironment::Ssh => LaunchRuntimeKind::Ssh,
    }
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

/// axum 路由共享状态
#[derive(Clone)]
pub struct AppState {
    pub token: String,
    pub terminal_service: Arc<TerminalService>,
    pub provider_service: Arc<ProviderService>,
    pub launch_profile_service: Arc<LaunchProfileService>,
    pub shared_mcp_service: Arc<SharedMcpService>,
    pub mcp_config_service: Arc<crate::services::McpConfigService>,
    pub project_service: Arc<ProjectService>,
    pub workspace_service: Arc<WorkspaceService>,
    pub ssh_machine_service: Arc<SshMachineService>,
    pub todo_service: Arc<TodoService>,
    pub task_binding_service: Arc<crate::services::TaskBindingService>,
    pub spec_service: Arc<SpecService>,
    pub skill_service: Arc<SkillService>,
    pub external_skill_registry: Arc<ExternalSkillRegistry>,
    pub launch_history_service: Arc<LaunchHistoryService>,
    pub notification_service: Arc<NotificationService>,
    pub settings_service: Arc<SettingsService>,
    pub app_handle: AppHandle,
    pub app_paths: Arc<AppPaths>,
    pub tasks: Arc<Mutex<HashMap<String, TaskStatus>>>,
    /// 简易频率限制：最近请求时间戳
    pub last_request_times: Arc<Mutex<Vec<std::time::Instant>>>,
    /// 前端查询的 pending 请求（request_id → oneshot 发送端）
    pub pending_queries: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
}

// ============ OrchestratorService ============

pub struct OrchestratorService {
    port: Mutex<Option<u16>>,
    token: String,
    pending_queries: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
}

impl OrchestratorService {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let token = generate_token();
        Self {
            port: Mutex::new(None),
            token,
            pending_queries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 获取服务器端口
    pub fn port(&self) -> Option<u16> {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 获取认证 token
    pub fn token(&self) -> &str {
        &self.token
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
        terminal_service: Arc<TerminalService>,
        provider_service: Arc<ProviderService>,
        launch_profile_service: Arc<LaunchProfileService>,
        shared_mcp_service: Arc<SharedMcpService>,
        mcp_config_service: Arc<crate::services::McpConfigService>,
        project_service: Arc<ProjectService>,
        workspace_service: Arc<WorkspaceService>,
        ssh_machine_service: Arc<SshMachineService>,
        todo_service: Arc<TodoService>,
        task_binding_service: Arc<crate::services::TaskBindingService>,
        spec_service: Arc<SpecService>,
        skill_service: Arc<SkillService>,
        external_skill_registry: Arc<ExternalSkillRegistry>,
        launch_history_service: Arc<LaunchHistoryService>,
        notification_service: Arc<NotificationService>,
        settings_service: Arc<SettingsService>,
        app_handle: AppHandle,
        app_paths: Arc<AppPaths>,
    ) -> Result<()> {
        let app_paths_for_config = app_paths.clone();
        let state = AppState {
            token: self.token.clone(),
            terminal_service,
            provider_service,
            launch_profile_service,
            shared_mcp_service,
            mcp_config_service,
            project_service,
            workspace_service,
            ssh_machine_service,
            todo_service,
            task_binding_service,
            spec_service,
            skill_service,
            external_skill_registry,
            launch_history_service,
            notification_service,
            settings_service,
            app_handle,
            app_paths,
            tasks: Arc::new(Mutex::new(HashMap::new())),
            last_request_times: Arc::new(Mutex::new(Vec::new())),
            pending_queries: self.pending_queries.clone(),
        };

        let port_holder = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(port) = port_holder {
            warn!("[orchestrator] Server already running on port {}", port);
            return Ok(());
        }

        let port_mutex = Arc::new(Mutex::new(None::<u16>));
        let port_mutex_clone = port_mutex.clone();

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
                let app = build_router(state);

                // 绑定 0.0.0.0:0（自动分配端口），供本机与 WSL 访问
                // macOS Ventura+ 首次绑定可能触发防火墙授权弹窗，这是正常行为
                let listener = match tokio::net::TcpListener::bind("0.0.0.0:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        error!(
                            "[orchestrator] Failed to bind 0.0.0.0:0: {}. \
                             On macOS, ensure the app is allowed in System Settings > Privacy & Security > Firewall.",
                            e
                        );
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
                    "[orchestrator] HTTP + MCP server listening on 0.0.0.0:{}",
                    port
                );

                // 通知主线程端口号
                if let Ok(mut p) = port_mutex_clone.lock() {
                    *p = Some(port);
                }

                // 启动服务器
                info!("[orchestrator] axum::serve starting...");
                if let Err(e) = axum::serve(listener, app).await {
                    error!("[orchestrator] Server error: {}", e);
                }
                warn!("[orchestrator] axum::serve returned — server stopped");
            });
            warn!("[orchestrator] rt.block_on returned — runtime thread exiting");
        });

        // 等待端口分配完成（最多 5 秒）
        let start = std::time::Instant::now();
        loop {
            if start.elapsed() > std::time::Duration::from_secs(5) {
                error!("[orchestrator] Timeout waiting for port assignment");
                break;
            }
            if let Ok(p) = port_mutex.lock() {
                if let Some(port) = *p {
                    let mut self_port = self.port.lock().unwrap_or_else(|e| e.into_inner());
                    *self_port = Some(port);

                    // 启动时立即写入 mcp-orchestrator.json，确保 token 与端口同步
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
                        .join("mcp-orchestrator.json");
                    match std::fs::write(
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
    /// CLI 工具类型：`"claude"` | `"codex"`，默认 `"claude"`。
    /// 其他已注册工具请通过直接终端启动。
    #[serde(rename = "cliTool")]
    cli_tool: Option<String>,
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
    /// 要写入的原始字节（不做任何处理）。如需提交命令给 Claude Code，请改用 submit_to_session。Ctrl+C 用 "\x03"。
    text: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSubmitToSessionParams {
    /// 终端会话 ID（由 launch_task 返回）
    #[serde(rename = "sessionId")]
    session_id: String,
    /// 要提交的文本（不含换行符）。工具会自动拆分为"写文本 → 延迟 → 发 Enter"，确保 Claude Code (ink) 正确识别提交。
    text: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetSessionStatusParams {
    /// 终端会话 ID
    #[serde(rename = "sessionId")]
    session_id: String,
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
    #[serde(rename = "onlyWhenUnfocused")]
    only_when_unfocused: Option<bool>,
    #[serde(default)]
    #[schemars(schema_with = "notification_metadata_schema")]
    metadata: Option<serde_json::Value>,
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
    session_id: Option<String>,
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
}

#[tool_router]
impl McpToolHandler {
    /// 启动一个新的 Claude Code 实例来执行指定任务，或恢复已有会话。
    /// 新任务：传 prompt（必需），会在 CC-Panes 中创建新标签页并注入 prompt。
    /// 恢复会话：传 resumeId（必需），会以 `claude --resume <id>` 启动，不注入 prompt。
    #[tool]
    async fn launch_task(&self, Parameters(params): Parameters<McpLaunchTaskParams>) -> String {
        let is_resume = params.resume_id.is_some();
        let prompt_len = params.prompt.as_ref().map(|p| p.len()).unwrap_or(0);
        info!(project = %params.project_path, prompt_len, is_resume, "mcp::launch_task");

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
        let project_id = format!("orch-{}", uuid::Uuid::new_v4());

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
            params.runtime_kind.as_deref(),
            params.resume_id.as_deref(),
            &self.state,
        ) {
            Ok(runtime) => runtime,
            Err(error) => return format!("错误: {}", error),
        };

        // 创建 PTY 会话（resume 时传 resume_id）
        let session_id = match self.state.terminal_service.create_session(
            None,
            &params.project_path,
            120,
            30,
            ws_name.as_deref(),
            params.provider_id.as_deref(),
            provider_selection,
            None,
            ws_path.as_deref(),
            None,
            cli_tool,
            params.resume_id.as_deref(),
            false,
            None,
            initial_prompt,
            runtime.ssh.as_ref(),
            runtime.wsl.as_ref(),
        ) {
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

        // 通知前端
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
            cli_tool: params.cli_tool.clone(),
            runtime_kind: runtime.kind.as_str().to_string(),
            runtime_source: runtime.source.to_string(),
            notice: runtime.notice.clone(),
            wsl: runtime.wsl.clone(),
            ssh: runtime.ssh.clone(),
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

    /// 列出所有已注册的项目（DB 项目 + 工作空间项目）
    #[tool]
    async fn list_projects(&self) -> String {
        debug!("mcp::list_projects");
        let mut infos: Vec<serde_json::Value> = Vec::new();

        // DB 项目
        for p in self
            .state
            .project_service
            .list_projects()
            .unwrap_or_default()
        {
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
                let norm = normalize_path(&p.path);
                let already_listed = infos
                    .iter()
                    .any(|i| i["path"].as_str().map(normalize_path) == Some(norm.clone()));
                if already_listed {
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
        let tasks = self.state.tasks.lock().unwrap_or_else(|e| e.into_inner());
        match tasks.get(&params.task_id) {
            Some(status) => serde_json::json!({
                "taskId": status.task_id,
                "sessionId": status.session_id,
                "status": status.status,
                "error": status.error,
            })
            .to_string(),
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
            Ok(p) => strip_unc_prefix(p.to_string_lossy().to_string()),
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
            Ok(p) => strip_unc_prefix(p.to_string_lossy().to_string()),
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
        let event = OrchestratorCloseFileEvent {
            file_path: params.file_path.clone(),
        };
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-close-file", &event);
        serde_json::json!({
            "success": true,
            "filePath": params.file_path,
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

    /// 查询当前所有面板信息（ID、标签数量、活跃标签等），可用于 launch_task 的 paneId 参数
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

    /// 向指定 PTY 会话写入原始字节（不做时序处理）。适合发送控制字符（如 Ctrl+C: "\x03"）。如果需要向 Claude Code 提交命令或 prompt，请改用 submit_to_session，它会自动处理 Enter 键时序。
    #[tool]
    async fn write_to_session(
        &self,
        Parameters(params): Parameters<McpWriteToSessionParams>,
    ) -> String {
        info!(session_id = %params.session_id, text_len = params.text.len(), "mcp::write_to_session");
        let svc = self.state.terminal_service.clone();
        let sid = params.session_id.clone();
        let txt = params.text;
        match tokio::task::spawn_blocking(move || svc.write(&sid, &txt)).await {
            Ok(Ok(())) => serde_json::json!({
                "success": true,
                "sessionId": params.session_id,
            })
            .to_string(),
            Ok(Err(e)) => {
                error!(session_id = %params.session_id, err = %e, "mcp::write_to_session failed");
                format!("错误: 写入会话 '{}' 失败: {}", params.session_id, e)
            }
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::write_to_session spawn_blocking failed");
                format!("错误: 写入任务失败: {}", e)
            }
        }
    }

    /// 向 PTY 会话提交文本（自动处理 Enter 键时序）。内部先写入文本，等待 150ms，再单独发送 Enter，确保 Claude Code (ink) 正确识别为提交。适用于发送 slash command（如 "/plan"）或输入 prompt。
    #[tool]
    async fn submit_to_session(
        &self,
        Parameters(params): Parameters<McpSubmitToSessionParams>,
    ) -> String {
        info!(session_id = %params.session_id, text_len = params.text.len(), "mcp::submit_to_session");
        // 去除文本中的换行符，防止意外提交
        let clean_text = params.text.replace(['\r', '\n'], "");
        // 安全网：长文本外部化为文件，避免 PTY 处理异常
        let fallback_dir = self
            .state
            .app_paths
            .data_dir()
            .to_string_lossy()
            .to_string();
        let effective_text =
            externalize_long_prompt(&fallback_dir, &uuid::Uuid::new_v4().to_string(), clean_text);
        match submit_text_to_session(
            &self.state.terminal_service,
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
        match self.state.terminal_service.get_all_status() {
            Ok(statuses) => match statuses.iter().find(|s| s.session_id == params.session_id) {
                Some(status) => serde_json::json!({
                    "sessionId": status.session_id,
                    "status": status.status,
                    "lastOutputAt": status.last_output_at,
                })
                .to_string(),
                None => format!("错误: 会话 '{}' 不存在", params.session_id),
            },
            Err(e) => format!("错误: 获取会话状态失败: {}", e),
        }
    }

    /// 列出所有活跃的终端会话及其状态，返回 sessionId、status、lastOutputAt。
    #[tool]
    async fn list_sessions(&self) -> String {
        debug!("mcp::list_sessions");
        match self.state.terminal_service.get_all_status() {
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
        match self.state.terminal_service.kill(&params.session_id) {
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
        match self
            .state
            .terminal_service
            .get_session_output(&params.session_id, lines_param)
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
                } else {
                    if let Some(ref project_path) = params.project_path {
                        crate::services::codex_session_service::list_sessions(project_path, limit)
                    } else {
                        crate::services::codex_session_service::list_all_sessions(limit)
                    }
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

        match self.state.task_binding_service.update(&params.id, req) {
            Ok(binding) => serde_json::to_string(&binding)
                .unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: 更新 TaskBinding 失败: {}", e),
        }
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
            session_id: params.session_id,
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
}

async fn collect_plan_live_sessions(
    state: &AppState,
) -> Vec<crate::models::task_binding::PlanLiveSession> {
    let mut live_sessions = match state.terminal_service.get_all_status() {
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
                "典型流程: launch_task → get_session_status → get_session_output。\n",
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
    let normalized_project = normalize_path(project_path);
    let normalized_workspace = normalize_path(workspace_path);
    if normalized_project == normalized_workspace {
        return Some(String::new());
    }
    let prefix = format!("{}/", normalized_workspace.trim_end_matches('/'));
    normalized_project
        .strip_prefix(&prefix)
        .map(|value| value.to_string())
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
) -> Option<String> {
    let workspace = workspace?;
    let default = workspace_runtime_kind(workspace);
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
    path_runtime: Option<LaunchRuntimeKind>,
    workspace_default: Option<LaunchRuntimeKind>,
) -> (LaunchRuntimeKind, &'static str) {
    if let Some(runtime) = explicit_runtime {
        (runtime, "explicit")
    } else if let Some(runtime) = history_runtime {
        (runtime, "history")
    } else if let Some(runtime) = path_runtime {
        (runtime, "path")
    } else if let Some(runtime) = workspace_default {
        (runtime, "workspace_default")
    } else {
        (LaunchRuntimeKind::Local, "default")
    }
}

fn resolve_launch_runtime(
    project_path: &str,
    workspace_name: Option<&str>,
    requested_runtime: Option<&str>,
    resume_id: Option<&str>,
    state: &AppState,
) -> std::result::Result<ResolvedLaunchRuntime, String> {
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
    let workspace_default = workspace.as_ref().map(workspace_runtime_kind);

    let (kind, source) = select_launch_runtime_kind(
        explicit_runtime,
        history_runtime,
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
        notice: runtime_notice(workspace.as_ref(), kind, source),
        wsl,
        ssh,
    })
}

// ============ 路径白名单 ============

/// 规范化路径（统一正斜杠、去尾部分隔符）用于白名单比较
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// 检查项目路径是否在已注册列表中（DB 项目 + 工作空间项目）
fn is_project_registered(state: &AppState, path: &str) -> bool {
    let normalized = normalize_path(path);

    // 1. 查 DB projects 表
    if let Ok(projects) = state.project_service.list_projects() {
        if projects
            .iter()
            .any(|p| normalize_path(&p.path) == normalized)
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
                .any(|p| normalize_path(&p.path) == normalized)
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

    let session_id = match state.terminal_service.create_session(
        None,
        &req.project_path,
        120,
        30,
        workspace_name.as_deref(),
        req.provider_id.as_deref(),
        provider_selection,
        None,
        workspace_path.as_deref(),
        None,
        cli_tool,
        req.resume_id.as_deref(),
        false,
        None,
        initial_prompt,
        runtime.ssh.as_ref(),
        runtime.wsl.as_ref(),
    ) {
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
        cli_tool: req.cli_tool.clone(),
        runtime_kind: runtime.kind.as_str().to_string(),
        runtime_source: runtime.source.to_string(),
        notice: runtime.notice.clone(),
        wsl: runtime.wsl.clone(),
        ssh: runtime.ssh.clone(),
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

    // DB 项目
    for p in state.project_service.list_projects().unwrap_or_default() {
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
            let norm = normalize_path(&p.path);
            let already_listed = project_infos
                .iter()
                .any(|i| normalize_path(&i.path) == norm);
            if already_listed {
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

    let tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    match tasks.get(&task_id) {
        Some(status) => (StatusCode::OK, Json(serde_json::json!(status))),
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
    only_when_unfocused: Option<bool>,
    metadata: Option<serde_json::Value>,
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
            only_when_unfocused: value.only_when_unfocused,
            metadata: value.metadata,
        }
    }
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

    match state.terminal_service.get_all_status() {
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

    match state.terminal_service.get_all_status() {
        Ok(statuses) => match statuses.iter().find(|s| s.session_id == session_id) {
            Some(status) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "sessionId": status.session_id,
                    "status": status.status,
                    "lastOutputAt": status.last_output_at,
                })),
            ),
            None => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!(ApiError {
                    error: format!("Session '{}' not found", session_id)
                })),
            ),
        },
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

    let svc = state.terminal_service.clone();
    let sid = req.session_id.clone();
    let txt = req.text;
    match tokio::task::spawn_blocking(move || svc.write(&sid, &txt)).await {
        Ok(Ok(())) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Ok(Err(e)) => {
            error!(session_id = %req.session_id, err = %e, "REST::write_to_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError {
                    error: format!("Failed to write to session: {}", e)
                })),
            )
        }
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::write_to_session spawn_blocking failed");
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

    // 去除文本中的换行符，防止意外提交
    let clean_text = req.text.replace(['\r', '\n'], "");
    // 安全网：长文本外部化为文件，避免 PTY 处理异常
    let fallback_dir = state.app_paths.data_dir().to_string_lossy().to_string();
    let effective_text =
        externalize_long_prompt(&fallback_dir, &uuid::Uuid::new_v4().to_string(), clean_text);

    match submit_text_to_session(&state.terminal_service, &req.session_id, &effective_text).await {
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

    match state.terminal_service.kill(&req.session_id) {
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
            let _ = state.app_handle.emit(
                "history-updated",
                serde_json::json!({
                    "source": "session-started",
                    "recordId": record_id,
                    "launchId": req.launch_id,
                    "ptySessionId": req.pty_session_id,
                    "resumeSessionId": req.resume_session_id,
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
    let ttl = std::time::Duration::from_secs(30 * 60);
    tasks.retain(|_, t| {
        let is_terminal = matches!(t.status.as_str(), "completed" | "error" | "timeout");
        !(is_terminal && t.created_at.elapsed() > ttl)
    });
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

/// 根据文本长度动态计算 Enter 前的等待延迟（ms）
///
/// write() 同步阻塞完成后调用，只需覆盖 ink 渲染处理时间。
/// 基础 200ms + 每 512B 额外 30ms（匹配 write() 的 512B/30ms 分块速率）。
/// 范围: [200, 5000] ms
fn compute_enter_delay_ms(text_len: usize) -> u64 {
    let extra_ms = (text_len as u64 / 512) * 30;
    std::cmp::min(200 + extra_ms, 5000)
}

/// 智能提交：写入文本 → 延迟 → 发 Enter，确保 ink-text-input 正确识别提交
/// 参考: https://github.com/anthropics/claude-code/issues/15553
async fn submit_text_to_session(
    terminal_svc: &Arc<TerminalService>,
    session_id: &str,
    text: &str,
) -> std::result::Result<(), anyhow::Error> {
    // Step 1: 写入文本（spawn_blocking 避免阻塞 tokio worker）
    let svc = terminal_svc.clone();
    let sid = session_id.to_string();
    let txt = text.to_string();
    let txt_len = text.len();
    tokio::task::spawn_blocking(move || svc.write(&sid, &txt)).await??;

    // Step 2: 等待 ink 处理完文本
    let delay_ms = compute_enter_delay_ms(txt_len);
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

    // Step 3: 发送 Enter（短写入不需要 spawn_blocking）
    terminal_svc.write(session_id, "\r")?;
    Ok(())
}

/// 剥离 Windows `canonicalize()` 产生的 `\\?\` UNC 前缀
#[cfg(windows)]
fn strip_unc_prefix(path: String) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
}

#[cfg(not(windows))]
fn strip_unc_prefix(path: String) -> String {
    path
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn test_parse_launch_cli_tool_rejects_non_orchestrated_tools() {
        let kimi = parse_launch_cli_tool(Some("kimi")).unwrap_err();
        let glm = parse_launch_cli_tool(Some("glm")).unwrap_err();
        assert!(kimi.contains("not supported by launch_task yet"));
        assert!(glm.contains("not supported by launch_task yet"));
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
            Some(LaunchRuntimeKind::Wsl),
        );

        assert_eq!(selected, (LaunchRuntimeKind::Local, "explicit"));
    }

    #[test]
    fn test_launch_runtime_resume_history_overrides_workspace_wsl_default() {
        let selected = select_launch_runtime_kind(
            None,
            Some(LaunchRuntimeKind::Local),
            None,
            Some(LaunchRuntimeKind::Wsl),
        );

        assert_eq!(selected, (LaunchRuntimeKind::Local, "history"));
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
