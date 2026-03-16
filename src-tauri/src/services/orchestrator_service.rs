//! Orchestrator Service — HTTP API + MCP Server
//!
//! 提供 REST API 和 MCP Streamable HTTP 端点，让 PTY 中运行的 Claude 实例
//! 通过 HTTP/MCP 调用 CC-Panes 功能（创建标签、启动 Claude、注入 prompt）。
//!
//! 安全措施：
//! - 绑定 127.0.0.1（仅本地访问）
//! - 随机 Bearer Token 认证
//! - 项目路径白名单校验
//! - 请求频率限制

use crate::services::{ProjectService, ProviderService, TerminalService, WorkspaceService, TodoService, SpecService, SkillService, LaunchHistoryService};
use crate::models::CliTool;
use crate::models::todo::{TodoQuery, CreateTodoRequest, UpdateTodoRequest, TodoStatus, TodoPriority, TodoScope};
use crate::utils::AppPaths;
use anyhow::Result;
use axum::{
    extract::{Json, Path as AxumPath, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use rmcp::{
    ServerHandler,
    handler::server::router::tool::ToolRouter,
    handler::server::wrapper::Parameters,
    model::{ServerCapabilities, ServerInfo},
    tool, tool_router, tool_handler,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub title: Option<String>,
    /// 恢复指定 Claude 会话（传入 session UUID）
    pub resume_id: Option<String>,
    /// 指定目标面板 ID（可选，不指定则使用活跃面板。通过 list_panes 获取可用面板）
    pub pane_id: Option<String>,
    /// CLI 工具类型：`"claude"` | `"codex"`，默认 `"claude"`
    pub cli_tool: Option<String>,
}

/// 启动任务响应
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTaskResponse {
    pub task_id: String,
    pub session_id: String,
    pub status: String,
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
    pub workspace_path: Option<String>,
    pub title: Option<String>,
    pub resume_id: Option<String>,
    pub pane_id: Option<String>,
    pub cli_tool: Option<String>,
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
    pub project_service: Arc<ProjectService>,
    pub workspace_service: Arc<WorkspaceService>,
    pub todo_service: Arc<TodoService>,
    pub spec_service: Arc<SpecService>,
    pub skill_service: Arc<SkillService>,
    pub launch_history_service: Arc<LaunchHistoryService>,
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
    pub fn pending_queries(&self) -> Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>> {
        self.pending_queries.clone()
    }

    /// 启动 HTTP + MCP 服务器（在 tokio runtime 中运行）
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        terminal_service: Arc<TerminalService>,
        provider_service: Arc<ProviderService>,
        project_service: Arc<ProjectService>,
        workspace_service: Arc<WorkspaceService>,
        todo_service: Arc<TodoService>,
        spec_service: Arc<SpecService>,
        skill_service: Arc<SkillService>,
        launch_history_service: Arc<LaunchHistoryService>,
        app_handle: AppHandle,
        app_paths: Arc<AppPaths>,
    ) -> Result<()> {
        let app_paths_for_config = app_paths.clone();
        let state = AppState {
            token: self.token.clone(),
            terminal_service,
            provider_service,
            project_service,
            workspace_service,
            todo_service,
            spec_service,
            skill_service,
            launch_history_service,
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
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    error!("[orchestrator] Failed to create tokio runtime: {}", e);
                    return;
                }
            };

            rt.block_on(async move {
                let app = build_router(state);

                // 绑定 127.0.0.1:0（自动分配端口）
                let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        error!("[orchestrator] Failed to bind: {}", e);
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
                info!("[orchestrator] HTTP + MCP server listening on http://127.0.0.1:{}", port);

                // 通知主线程端口号
                if let Ok(mut p) = port_mutex_clone.lock() {
                    *p = Some(port);
                }

                // 启动服务器
                if let Err(e) = axum::serve(listener, app).await {
                    error!("[orchestrator] Server error: {}", e);
                }
            });
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
                    let config_path = app_paths_for_config.data_dir().join("mcp-orchestrator.json");
                    match std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap_or_default()) {
                        Ok(_) => info!("[orchestrator] MCP config written to {}", config_path.display()),
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
        StreamableHttpService,
        session::local::LocalSessionManager,
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
        .route("/api/session-status/{session_id}", get(handle_session_status))
        .route("/api/write-to-session", post(handle_write_to_session))
        .route("/api/submit-to-session", post(handle_submit_to_session))
        .route("/api/kill-session", post(handle_kill_session))
        .route("/api/health", get(handle_health))
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(state.clone(), mcp_auth_middleware))
        .layer(cors)
        .with_state(state)
}

/// M2: MCP 路由认证中间件 — /mcp 请求必须携带有效 Bearer token
async fn mcp_auth_middleware(
    State(state): State<AppState>,
    request: Request,
    next: middleware::Next,
) -> axum::response::Response {
    // 仅对 /mcp 路由校验 token（REST handlers 各自校验；OPTIONS 预检由 CORS 层处理）
    if request.uri().path().starts_with("/mcp")
        && request.method() != Method::OPTIONS
    {
        let header_ok = verify_token(request.headers(), &state.token);
        // 后备：从 URL query ?token=xxx 读取（Claude Code 某些版本忽略 headers — Issue #7290）
        let query_ok = request.uri().query()
            .and_then(|q| q.split('&').find(|p| p.starts_with("token=")))
            .map(|p| p[6..] == *state.token)
            .unwrap_or(false);

        if !header_ok && !query_ok {
            warn!("[orchestrator] MCP request rejected: invalid or missing Bearer token");
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Invalid or missing Bearer token"})),
            ).into_response();
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
    /// 自定义标签名（不指定则使用默认 "${目录名} (Claude)"）
    title: Option<String>,
    /// 工作空间名称（自动解析 workspace_path 和 provider）
    #[serde(rename = "workspaceName")]
    workspace_name: Option<String>,
    /// 恢复指定 Claude 会话（传入 session UUID，可从 list_launch_history 获取 claudeSessionId）
    #[serde(rename = "resumeId")]
    resume_id: Option<String>,
    /// 指定目标面板 ID（可选，不指定则使用活跃面板。通过 list_panes 获取可用面板）
    #[serde(rename = "paneId")]
    pane_id: Option<String>,
    /// CLI 工具类型：`"claude"` | `"codex"`，默认 `"claude"`
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

// ---- Launch History / Claude Sessions MCP 参数 ----

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
    ) -> String {
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

        // 工作空间解析：workspace_name → workspace_path + provider_id
        let mut ws_name: Option<String> = params.workspace_name.clone();
        let mut ws_path: Option<String> = None;
        let mut provider_id = params.provider_id.clone();

        if let Some(ref name) = ws_name {
            match self.state.workspace_service.get_workspace(name) {
                Ok(ws) => {
                    ws_path = ws.path.clone();
                    if provider_id.is_none() {
                        provider_id = ws.provider_id.clone();
                    }
                    debug!(workspace = %name, path = ?ws_path, provider = ?provider_id, "mcp::launch_task resolved workspace");
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
        let cli_tool = match params.cli_tool.as_deref() {
            Some("codex") => CliTool::Codex,
            _ => CliTool::Claude, // 默认 Claude
        };

        // 创建 PTY 会话（resume 时传 resume_id）
        let session_id = match self.state.terminal_service.create_session(
            self.state.app_handle.clone(),
            &params.project_path,
            120, 30,
            ws_name.as_deref(),
            provider_id.as_deref(),
            ws_path.as_deref(),
            cli_tool,
            params.resume_id.as_deref(),
            false,
            None,
        ) {
            Ok(sid) => sid,
            Err(e) => {
                error!(err = %e, "mcp::launch_task failed to create session");
                return format!("错误: 创建会话失败: {}", e);
            }
        };

        // 记录任务状态 + 清理旧任务
        {
            let mut tasks = self.state.tasks.lock().unwrap_or_else(|e| e.into_inner());
            cleanup_stale_tasks(&mut tasks);
            tasks.insert(task_id.clone(), TaskStatus {
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                status: "launching".to_string(),
                error: None,
                created_at: std::time::Instant::now(),
            });
        }

        // 通知前端
        let event = OrchestratorLaunchEvent {
            task_id: task_id.clone(),
            session_id: session_id.clone(),
            project_path: params.project_path.clone(),
            project_id,
            workspace_name: ws_name,
            provider_id,
            workspace_path: ws_path,
            title: params.title.clone(),
            resume_id: params.resume_id.clone(),
            pane_id: params.pane_id.clone(),
            cli_tool: params.cli_tool.clone(),
        };
        let _ = self.state.app_handle.emit("orchestrator-launch-task", &event);

        // resume 时不注入 prompt（Claude --resume 自动恢复上下文）
        // 新任务时后台注入 prompt
        if !is_resume {
            if let Some(prompt) = params.prompt {
                spawn_prompt_injector(
                    self.state.terminal_service.clone(),
                    self.state.tasks.clone(),
                    self.state.app_handle.clone(),
                    session_id.clone(),
                    task_id.clone(),
                    prompt,
                );
            }
        }

        serde_json::json!({
            "taskId": task_id,
            "sessionId": session_id,
            "status": "launching"
        }).to_string()
    }

    /// 列出所有已注册的项目（DB 项目 + 工作空间项目）
    #[tool]
    async fn list_projects(&self) -> String {
        debug!("mcp::list_projects");
        let mut infos: Vec<serde_json::Value> = Vec::new();

        // DB 项目
        for p in self.state.project_service.list_projects().unwrap_or_default() {
            infos.push(serde_json::json!({
                "id": p.id.to_string(),
                "name": p.name,
                "path": p.path,
                "source": "db",
            }));
        }

        // 工作空间项目（去重：与 DB 路径重复则跳过）
        for ws in self.state.workspace_service.list_workspaces().unwrap_or_default() {
            for p in &ws.projects {
                let norm = normalize_path(&p.path);
                let already_listed = infos.iter().any(|i| {
                    i["path"].as_str().map(normalize_path) == Some(norm.clone())
                });
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
            Some(status) => {
                serde_json::json!({
                    "taskId": status.task_id,
                    "sessionId": status.session_id,
                    "status": status.status,
                    "error": status.error,
                }).to_string()
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
                let items: Vec<serde_json::Value> = workspaces.iter().map(|ws| {
                    serde_json::json!({
                        "name": ws.name,
                        "alias": ws.alias,
                        "projectCount": ws.projects.len(),
                        "providerId": ws.provider_id,
                        "path": ws.path,
                        "pinned": ws.pinned,
                    })
                }).collect();
                serde_json::json!({ "workspaces": items }).to_string()
            }
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 获取指定工作空间的详细信息，包括项目列表
    #[tool]
    async fn get_workspace(
        &self,
        Parameters(params): Parameters<McpGetWorkspaceParams>,
    ) -> String {
        debug!(name = %params.workspace_name, "mcp::get_workspace");
        match self.state.workspace_service.get_workspace(&params.workspace_name) {
            Ok(ws) => {
                let projects: Vec<serde_json::Value> = ws.projects.iter().map(|p| {
                    serde_json::json!({
                        "id": p.id,
                        "path": p.path,
                        "alias": p.alias,
                    })
                }).collect();
                serde_json::json!({
                    "name": ws.name,
                    "alias": ws.alias,
                    "projects": projects,
                    "providerId": ws.provider_id,
                    "path": ws.path,
                    "pinned": ws.pinned,
                }).to_string()
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
        match self.state.workspace_service.create_workspace(
            &params.name,
            params.path.as_deref(),
        ) {
            Ok(ws) => serde_json::to_string(&ws).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
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
        match self.state.workspace_service.add_project(
            &params.workspace_name,
            &params.project_path,
        ) {
            Ok(project) => serde_json::to_string(&project).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
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
    async fn query_todos(
        &self,
        Parameters(params): Parameters<McpQueryTodosParams>,
    ) -> String {
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
            Ok(result) => serde_json::to_string(&result).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 创建新的待办任务
    #[tool]
    async fn create_todo(
        &self,
        Parameters(params): Parameters<McpCreateTodoParams>,
    ) -> String {
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
            Ok(todo) => serde_json::to_string(&todo).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
            Err(e) => format!("错误: {}", e),
        }
    }

    /// 更新待办任务的标题、状态、优先级或描述
    #[tool]
    async fn update_todo(
        &self,
        Parameters(params): Parameters<McpUpdateTodoParams>,
    ) -> String {
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
    async fn list_skills(
        &self,
        Parameters(params): Parameters<McpListSkillsParams>,
    ) -> String {
        debug!(project = %params.project_path, "mcp::list_skills");
        match self.state.skill_service.list_skills(&params.project_path) {
            Ok(skills) => serde_json::json!({ "skills": skills }).to_string(),
            Err(e) => format!("错误: {}", e),
        }
    }

    // ============ File Tools ============

    /// 在 CC-Panes 文件浏览器中导航到指定目录，自动切换到 Files 视图模式
    #[tool]
    async fn open_folder(
        &self,
        Parameters(params): Parameters<McpOpenFolderParams>,
    ) -> String {
        info!(path = %params.path, "mcp::open_folder");
        let path = std::path::Path::new(&params.path);
        if !path.exists() {
            return format!("错误: 路径 '{}' 不存在", params.path);
        }
        if !path.is_dir() {
            return format!("错误: '{}' 不是目录", params.path);
        }
        let canonical = match path.canonicalize() {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(e) => return format!("错误: 路径规范化失败: {}", e),
        };
        let event = OrchestratorOpenFolderEvent {
            path: canonical.clone(),
        };
        let _ = self.state.app_handle.emit("orchestrator-open-folder", &event);
        serde_json::json!({ "success": true, "path": canonical }).to_string()
    }

    /// 在 CC-Panes 编辑器中打开文件标签页，自动切换到 Files 视图模式。projectPath 可选，不传则自动推断
    #[tool]
    async fn open_file(
        &self,
        Parameters(params): Parameters<McpOpenFileParams>,
    ) -> String {
        info!(file = %params.file_path, "mcp::open_file");
        let file_path = std::path::Path::new(&params.file_path);
        if !file_path.exists() {
            return format!("错误: 文件 '{}' 不存在", params.file_path);
        }
        if !file_path.is_file() {
            return format!("错误: '{}' 不是文件", params.file_path);
        }
        let canonical_file = match file_path.canonicalize() {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(e) => return format!("错误: 路径规范化失败: {}", e),
        };

        // 推断 projectPath：优先用参数，否则从已注册项目做最长前缀匹配
        let project_path = if let Some(ref pp) = params.project_path {
            pp.clone()
        } else {
            let projects = self.state.project_service.list_projects().unwrap_or_default();
            let normalized_file = canonical_file.replace('\\', "/");
            projects.iter()
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
                    file_path.parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                })
        };

        let title = file_path.file_name()
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
        }).to_string()
    }

    /// 关闭 CC-Panes 编辑器中匹配的文件标签页
    #[tool]
    async fn close_file(
        &self,
        Parameters(params): Parameters<McpCloseFileParams>,
    ) -> String {
        info!(file = %params.file_path, "mcp::close_file");
        let event = OrchestratorCloseFileEvent {
            file_path: params.file_path.clone(),
        };
        let _ = self.state.app_handle.emit("orchestrator-close-file", &event);
        serde_json::json!({
            "success": true,
            "filePath": params.file_path,
        }).to_string()
    }

    /// 查询 CC-Panes 编辑器中当前打开的所有文件标签页信息
    #[tool]
    async fn list_open_files(&self) -> String {
        debug!("mcp::list_open_files");
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();

        // 注册 pending query
        {
            let mut queries = self.state.pending_queries.lock().unwrap_or_else(|e| e.into_inner());
            queries.insert(request_id.clone(), tx);
        }

        // 发射查询事件给前端
        let event = OrchestratorQueryEvent {
            request_id: request_id.clone(),
        };
        let _ = self.state.app_handle.emit("orchestrator-query-open-files", &event);

        // 等待前端响应（超时 5 秒）
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(data)) => data,
            Ok(Err(_)) => {
                "错误: 前端响应通道已关闭".to_string()
            }
            Err(_) => {
                // 超时，清理 pending query
                let mut queries = self.state.pending_queries.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut queries = self.state.pending_queries.lock().unwrap_or_else(|e| e.into_inner());
            queries.insert(request_id.clone(), tx);
        }

        // 发射查询事件给前端
        let event = OrchestratorQueryEvent {
            request_id: request_id.clone(),
        };
        let _ = self.state.app_handle.emit("orchestrator-query-panes", &event);

        // 等待前端响应（超时 5 秒）
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(data)) => data,
            Ok(Err(_)) => {
                "错误: 前端响应通道已关闭".to_string()
            }
            Err(_) => {
                // 超时，清理 pending query
                let mut queries = self.state.pending_queries.lock().unwrap_or_else(|e| e.into_inner());
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
        match self.state.terminal_service.write(&params.session_id, &params.text) {
            Ok(()) => {
                serde_json::json!({
                    "success": true,
                    "sessionId": params.session_id,
                }).to_string()
            }
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::write_to_session failed");
                format!("错误: 写入会话 '{}' 失败: {}", params.session_id, e)
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
        match submit_text_to_session(&self.state.terminal_service, &params.session_id, &clean_text).await {
            Ok(()) => {
                serde_json::json!({
                    "success": true,
                    "sessionId": params.session_id,
                }).to_string()
            }
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
            Ok(statuses) => {
                match statuses.iter().find(|s| s.session_id == params.session_id) {
                    Some(status) => {
                        serde_json::json!({
                            "sessionId": status.session_id,
                            "status": status.status,
                            "lastOutputAt": status.last_output_at,
                        }).to_string()
                    }
                    None => format!("错误: 会话 '{}' 不存在", params.session_id),
                }
            }
            Err(e) => format!("错误: 获取会话状态失败: {}", e),
        }
    }

    /// 列出所有活跃的终端会话及其状态，返回 sessionId、status、lastOutputAt。
    #[tool]
    async fn list_sessions(&self) -> String {
        debug!("mcp::list_sessions");
        match self.state.terminal_service.get_all_status() {
            Ok(statuses) => {
                let sessions: Vec<serde_json::Value> = statuses.iter().map(|s| {
                    serde_json::json!({
                        "sessionId": s.session_id,
                        "status": s.status,
                        "lastOutputAt": s.last_output_at,
                    })
                }).collect();
                serde_json::json!({ "sessions": sessions }).to_string()
            }
            Err(e) => format!("错误: 获取会话列表失败: {}", e),
        }
    }

    /// 终止指定的终端会话。会话将被立即关闭，PTY 进程被终止。
    #[tool]
    async fn kill_session(
        &self,
        Parameters(params): Parameters<McpKillSessionParams>,
    ) -> String {
        info!(session_id = %params.session_id, "mcp::kill_session");
        match self.state.terminal_service.kill(&params.session_id) {
            Ok(()) => {
                serde_json::json!({
                    "success": true,
                    "sessionId": params.session_id,
                }).to_string()
            }
            Err(e) => {
                error!(session_id = %params.session_id, err = %e, "mcp::kill_session failed");
                format!("错误: 终止会话 '{}' 失败: {}", params.session_id, e)
            }
        }
    }

    // ============ Launch History / Claude Sessions Tools ============

    /// 查询 CC-Panes 启动历史记录。返回 claudeSessionId（可用作 launch_task 的 resumeId）、
    /// lastPrompt（上次任务描述）、projectPath、launchedAt 等信息。
    /// 推荐 resume 流程：list_launch_history → 匹配 projectPath + 找到 claudeSessionId → launch_task(resumeId=claudeSessionId)
    #[tool]
    async fn list_launch_history(
        &self,
        Parameters(params): Parameters<McpListLaunchHistoryParams>,
    ) -> String {
        let limit = params.limit.unwrap_or(20).min(100);
        debug!(limit, project_path = ?params.project_path, "mcp::list_launch_history");

        let result = if let Some(ref project_path) = params.project_path {
            self.state.launch_history_service.list_by_project(project_path, limit)
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
                            "claudeSessionId": r.claude_session_id,
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
}

#[tool_handler]
impl ServerHandler for McpToolHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(concat!(
                "CC-Panes Orchestrator: 管理 Claude Code 多实例编排与工作空间。\n",
                "编排: launch_task（启动 Claude 实例）、list_projects（已注册项目）、get_task_status（任务状态）\n",
                "PTY 控制: write_to_session（向会话写入文本/命令）、get_session_status（查询会话状态）、list_sessions（列出所有会话）、kill_session（终止会话）\n",
                "工作空间: list_workspaces、get_workspace、create_workspace、add_project_to_workspace、scan_directory\n",
                "待办: query_todos、create_todo、update_todo\n",
                "Skill: list_skills（查看项目可用命令模板）\n",
                "文件: open_folder（导航文件浏览器）、open_file（编辑器打开文件）、close_file（关闭标签）、list_open_files（查询打开的文件）\n",
                "面板: list_panes（查询当前面板布局和标签信息，返回 paneId 可用于 launch_task）\n",
                "历史: list_launch_history（查询启动历史，含 claudeSessionId）、list_claude_sessions（查询 Claude 会话列表）\n",
                "典型编排流程: launch_task → get_session_status（等 WaitingInput）→ write_to_session（注入命令）→ 监控 → kill_session\n",
                "典型项目流程: scan_directory 发现项目 → create_workspace → add_project_to_workspace → launch_task\n",
                "典型 resume 流程: list_launch_history(projectPath) → 找到 claudeSessionId → launch_task(projectPath, resumeId=claudeSessionId)",
            ))
    }
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
        if projects.iter().any(|p| normalize_path(&p.path) == normalized) {
            return true;
        }
    }

    // 2. 查工作空间项目
    if let Ok(workspaces) = state.workspace_service.list_workspaces() {
        for ws in &workspaces {
            if ws.projects.iter().any(|p| normalize_path(&p.path) == normalized) {
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::launch_task rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError { error: "Rate limit exceeded".to_string() })),
        );
    }

    // 参数校验：prompt 和 resumeId 互斥，必须且只能提供其一
    if req.prompt.is_some() && req.resume_id.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError { error: "Cannot provide both 'prompt' and 'resumeId'".to_string() })),
        );
    }
    if req.prompt.is_none() && req.resume_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError { error: "Must provide either 'prompt' or 'resumeId'".to_string() })),
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
    let cli_tool = match req.cli_tool.as_deref() {
        Some("codex") => CliTool::Codex,
        _ => CliTool::Claude,
    };

    let session_id = match state.terminal_service.create_session(
        state.app_handle.clone(),
        &req.project_path,
        120, 30,
        req.workspace_name.as_deref(),
        req.provider_id.as_deref(),
        req.workspace_path.as_deref(),
        cli_tool,
        req.resume_id.as_deref(),
        false,
        None,
    ) {
        Ok(sid) => {
            info!(session_id = %sid, "REST::launch_task session created");
            sid
        }
        Err(e) => {
            error!(project = %req.project_path, err = %e, "REST::launch_task failed to create session");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError { error: format!("Failed to create session: {}", e) })),
            );
        }
    };

    {
        let mut tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_stale_tasks(&mut tasks);
        tasks.insert(task_id.clone(), TaskStatus {
            task_id: task_id.clone(),
            session_id: session_id.clone(),
            status: "launching".to_string(),
            error: None,
            created_at: std::time::Instant::now(),
        });
    }

    let event = OrchestratorLaunchEvent {
        task_id: task_id.clone(),
        session_id: session_id.clone(),
        project_path: req.project_path.clone(),
        project_id,
        workspace_name: req.workspace_name.clone(),
        provider_id: req.provider_id.clone(),
        workspace_path: req.workspace_path.clone(),
        title: req.title.clone(),
        resume_id: req.resume_id.clone(),
        pane_id: req.pane_id.clone(),
        cli_tool: req.cli_tool.clone(),
    };
    let _ = state.app_handle.emit("orchestrator-launch-task", &event);

    // resume 时不注入 prompt
    if !is_resume {
        if let Some(ref prompt) = req.prompt {
            spawn_prompt_injector(
                state.terminal_service.clone(),
                state.tasks.clone(),
                state.app_handle.clone(),
                session_id.clone(),
                task_id.clone(),
                prompt.clone(),
            );
        }
    }

    let response = LaunchTaskResponse {
        task_id,
        session_id,
        status: "launching".to_string(),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
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
    for ws in state.workspace_service.list_workspaces().unwrap_or_default() {
        for p in &ws.projects {
            let norm = normalize_path(&p.path);
            let already_listed = project_infos.iter().any(|i| normalize_path(&i.path) == norm);
            if already_listed {
                continue;
            }
            project_infos.push(ProjectInfo {
                id: p.id.clone(),
                name: p.alias.clone().unwrap_or_else(|| {
                    p.path.split(['/', '\\']).next_back().unwrap_or(&p.path).to_string()
                }),
                path: p.path.clone(),
                workspace_name: Some(ws.name.clone()),
            });
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!(ProjectsResponse { projects: project_infos })),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    let tasks = state.tasks.lock().unwrap_or_else(|e| e.into_inner());
    match tasks.get(&task_id) {
        Some(status) => (StatusCode::OK, Json(serde_json::json!(status))),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!(ApiError { error: format!("Task '{}' not found", task_id) })),
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

// ---- PTY Control REST Handlers ----

async fn handle_list_sessions(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    debug!("REST::list_sessions");
    if !verify_token(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    match state.terminal_service.get_all_status() {
        Ok(statuses) => {
            let sessions: Vec<serde_json::Value> = statuses.iter().map(|s| {
                serde_json::json!({
                    "sessionId": s.session_id,
                    "status": s.status,
                    "lastOutputAt": s.last_output_at,
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!({ "sessions": sessions })))
        }
        Err(e) => {
            error!(err = %e, "REST::list_sessions failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError { error: format!("Failed to list sessions: {}", e) })),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    match state.terminal_service.get_all_status() {
        Ok(statuses) => {
            match statuses.iter().find(|s| s.session_id == session_id) {
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
                    Json(serde_json::json!(ApiError { error: format!("Session '{}' not found", session_id) })),
                ),
            }
        }
        Err(e) => {
            error!(session_id = %session_id, err = %e, "REST::session_status failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError { error: format!("Failed to get session status: {}", e) })),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::write_to_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError { error: "Rate limit exceeded".to_string() })),
        );
    }

    match state.terminal_service.write(&req.session_id, &req.text) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::write_to_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError { error: format!("Failed to write to session: {}", e) })),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::submit_to_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError { error: "Rate limit exceeded".to_string() })),
        );
    }

    // 去除文本中的换行符，防止意外提交
    let clean_text = req.text.replace(['\r', '\n'], "");

    match submit_text_to_session(&state.terminal_service, &req.session_id, &clean_text).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "sessionId": req.session_id })),
        ),
        Err(e) => {
            error!(session_id = %req.session_id, err = %e, "REST::submit_to_session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ApiError { error: format!("Failed to submit to session: {}", e) })),
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
            Json(serde_json::json!(ApiError { error: "Invalid or missing Bearer token".to_string() })),
        );
    }

    if !check_rate_limit(&state.last_request_times) {
        warn!("REST::kill_session rate limit exceeded");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ApiError { error: "Rate limit exceeded".to_string() })),
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
                Json(serde_json::json!(ApiError { error: format!("Failed to kill session: {}", e) })),
            )
        }
    }
}

// ============ 辅助函数 ============

/// 生成随机 Bearer Token（32 字符 hex，密码学安全随机源）
fn generate_token() -> String {
    use rand::Rng;
    use rand::rngs::OsRng;
    let bytes: [u8; 16] = OsRng.gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 更新任务状态
fn update_task_status(
    tasks: &Arc<Mutex<HashMap<String, TaskStatus>>>,
    task_id: &str,
    status: &str,
    error: Option<&str>,
) {
    if let Ok(mut tasks) = tasks.lock() {
        if let Some(task) = tasks.get_mut(task_id) {
            task.status = status.to_string();
            task.error = error.map(|e| e.to_string());
        }
    }
}

/// L2: 清理已完成/超时/错误的旧任务（30 分钟淘汰）
fn cleanup_stale_tasks(tasks: &mut HashMap<String, TaskStatus>) {
    let ttl = std::time::Duration::from_secs(30 * 60);
    tasks.retain(|_, t| {
        let is_terminal = matches!(t.status.as_str(), "completed" | "error" | "timeout");
        !(is_terminal && t.created_at.elapsed() > ttl)
    });
}

/// 智能提交：写入文本 → 延迟 → 发 Enter，确保 ink-text-input 正确识别提交
/// 参考: https://github.com/anthropics/claude-code/issues/15553
async fn submit_text_to_session(
    terminal_svc: &TerminalService,
    session_id: &str,
    text: &str,
) -> std::result::Result<(), anyhow::Error> {
    // Step 1: 写入文本（不含换行符）
    terminal_svc.write(session_id, text)?;
    // Step 2: 等待 ink 处理完文本
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    // Step 3: 单独发送 Enter
    terminal_svc.write(session_id, "\r")?;
    Ok(())
}

/// 后台线程：等待 Claude 就绪后注入 prompt
fn spawn_prompt_injector(
    terminal_svc: Arc<TerminalService>,
    tasks: Arc<Mutex<HashMap<String, TaskStatus>>>,
    app_handle: AppHandle,
    session_id: String,
    task_id: String,
    prompt: String,
) {
    info!(
        task_id = %task_id,
        session_id = %session_id,
        prompt_len = prompt.len(),
        "prompt_injector: spawned, waiting for Claude WaitingInput"
    );
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(60);
        let poll_interval = std::time::Duration::from_millis(500);
        let mut poll_count: u32 = 0;

        loop {
            if start.elapsed() > timeout {
                error!(
                    task_id = %task_id,
                    session_id = %session_id,
                    elapsed_secs = start.elapsed().as_secs(),
                    polls = poll_count,
                    "prompt_injector: TIMEOUT — Claude did not become ready within 60s"
                );
                update_task_status(&tasks, &task_id, "timeout", Some("Claude did not become ready within 60s"));
                return;
            }

            poll_count += 1;

            match terminal_svc.get_all_status() {
                Ok(statuses) => {
                    if let Some(status) = statuses.iter().find(|s| s.session_id == session_id) {
                        match status.status {
                            crate::services::terminal_service::SessionStatus::WaitingInput => {
                                info!(
                                    task_id = %task_id,
                                    session_id = %session_id,
                                    elapsed_ms = start.elapsed().as_millis() as u64,
                                    polls = poll_count,
                                    "prompt_injector: WaitingInput detected, injecting prompt"
                                );
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                // 分两步写入：先文本，再单独发 Enter
                                // ink-text-input 仅在 \r 作为独立 stdin read 时识别为提交
                                // 参考: https://github.com/anthropics/claude-code/issues/15553
                                match terminal_svc.write(&session_id, &prompt) {
                                    Ok(_) => {
                                        // 等待 ink 处理完文本后再发 Enter
                                        std::thread::sleep(std::time::Duration::from_millis(150));
                                        match terminal_svc.write(&session_id, "\r") {
                                            Ok(_) => {
                                                info!(
                                                    task_id = %task_id,
                                                    session_id = %session_id,
                                                    prompt_len = prompt.len(),
                                                    "prompt_injector: prompt written successfully (split text+enter)"
                                                );
                                                update_task_status(&tasks, &task_id, "running", None);
                                                let _ = app_handle.emit("orchestrator-task-update", serde_json::json!({
                                                    "taskId": task_id,
                                                    "status": "running",
                                                }));
                                            }
                                            Err(e) => {
                                                error!(
                                                    task_id = %task_id,
                                                    session_id = %session_id,
                                                    err = %e,
                                                    "prompt_injector: FAILED to send Enter"
                                                );
                                                update_task_status(&tasks, &task_id, "error", Some(&format!("Failed to send Enter: {}", e)));
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        error!(
                                            task_id = %task_id,
                                            session_id = %session_id,
                                            err = %e,
                                            "prompt_injector: FAILED to write prompt text"
                                        );
                                        update_task_status(&tasks, &task_id, "error", Some(&format!("Failed to write prompt: {}", e)));
                                    }
                                }
                                return;
                            }
                            crate::services::terminal_service::SessionStatus::Exited => {
                                error!(
                                    task_id = %task_id,
                                    session_id = %session_id,
                                    elapsed_ms = start.elapsed().as_millis() as u64,
                                    "prompt_injector: session EXITED before prompt injection"
                                );
                                update_task_status(&tasks, &task_id, "error", Some("Session exited before prompt injection"));
                                return;
                            }
                            _ => {
                                // 每 10 次轮询输出一次 debug，避免刷屏
                                if poll_count.is_multiple_of(10) {
                                    debug!(
                                        task_id = %task_id,
                                        session_id = %session_id,
                                        elapsed_secs = start.elapsed().as_secs(),
                                        polls = poll_count,
                                        current_status = ?status.status,
                                        "prompt_injector: still waiting..."
                                    );
                                }
                            }
                        }
                    } else if poll_count.is_multiple_of(10) {
                        warn!(
                            task_id = %task_id,
                            session_id = %session_id,
                            polls = poll_count,
                            "prompt_injector: session not found in status list"
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        task_id = %task_id,
                        session_id = %session_id,
                        err = %e,
                        "prompt_injector: failed to get terminal statuses"
                    );
                }
            }

            std::thread::sleep(poll_interval);
        }
    });
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
}
