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

use crate::services::{ProjectService, ProviderService, TerminalService, WorkspaceService, TodoService, SkillService};
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
    pub prompt: String,
    pub provider_id: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
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
    pub skill_service: Arc<SkillService>,
    pub app_handle: AppHandle,
    pub app_paths: Arc<AppPaths>,
    pub tasks: Arc<Mutex<HashMap<String, TaskStatus>>>,
    /// 简易频率限制：最近请求时间戳
    pub last_request_times: Arc<Mutex<Vec<std::time::Instant>>>,
}

// ============ OrchestratorService ============

pub struct OrchestratorService {
    port: Mutex<Option<u16>>,
    token: String,
}

impl OrchestratorService {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let token = generate_token();
        Self {
            port: Mutex::new(None),
            token,
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

    /// 启动 HTTP + MCP 服务器（在 tokio runtime 中运行）
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        terminal_service: Arc<TerminalService>,
        provider_service: Arc<ProviderService>,
        project_service: Arc<ProjectService>,
        workspace_service: Arc<WorkspaceService>,
        todo_service: Arc<TodoService>,
        skill_service: Arc<SkillService>,
        app_handle: AppHandle,
        app_paths: Arc<AppPaths>,
    ) -> Result<()> {
        let state = AppState {
            token: self.token.clone(),
            terminal_service,
            provider_service,
            project_service,
            workspace_service,
            todo_service,
            skill_service,
            app_handle,
            app_paths,
            tasks: Arc::new(Mutex::new(HashMap::new())),
            last_request_times: Arc::new(Mutex::new(Vec::new())),
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
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("Failed to create tokio runtime for orchestrator");

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

                let addr = listener.local_addr().unwrap();
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
        && !verify_token(request.headers(), &state.token)
    {
        warn!("[orchestrator] MCP request rejected: invalid or missing Bearer token");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or missing Bearer token"})),
        ).into_response();
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
    /// 要注入的 prompt（任务描述）
    prompt: String,
    /// 可选的 Provider ID
    #[serde(rename = "providerId")]
    provider_id: Option<String>,
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
}

#[tool_router]
impl McpToolHandler {
    /// 启动一个新的 Claude Code 实例来执行指定任务。会在 CC-Panes 中创建新标签页并注入 prompt。
    #[tool]
    async fn launch_task(
        &self,
        Parameters(params): Parameters<McpLaunchTaskParams>,
    ) -> String {
        info!(project = %params.project_path, prompt_len = params.prompt.len(), "mcp::launch_task");
        // 白名单校验
        let is_registered = self.state.project_service.list_projects()
            .map(|projects| projects.iter().any(|p| p.path == params.project_path))
            .unwrap_or(false);

        if !is_registered {
            return format!("错误: 项目路径 '{}' 未注册", params.project_path);
        }

        let task_id = uuid::Uuid::new_v4().to_string();
        let project_id = format!("orch-{}", uuid::Uuid::new_v4());

        // 创建 PTY 会话
        let session_id = match self.state.terminal_service.create_session(
            self.state.app_handle.clone(),
            &params.project_path,
            120, 30,
            None,
            params.provider_id.as_deref(),
            None,
            true,
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
            workspace_name: None,
            provider_id: params.provider_id.clone(),
            workspace_path: None,
        };
        let _ = self.state.app_handle.emit("orchestrator-launch-task", &event);

        // 后台注入 prompt
        spawn_prompt_injector(
            self.state.terminal_service.clone(),
            self.state.tasks.clone(),
            self.state.app_handle.clone(),
            session_id.clone(),
            task_id.clone(),
            params.prompt,
        );

        serde_json::json!({
            "taskId": task_id,
            "sessionId": session_id,
            "status": "launching"
        }).to_string()
    }

    /// 列出所有已注册的项目
    #[tool]
    async fn list_projects(&self) -> String {
        debug!("mcp::list_projects");
        let projects = self.state.project_service.list_projects().unwrap_or_default();
        let infos: Vec<serde_json::Value> = projects
            .into_iter()
            .map(|p| serde_json::json!({
                "id": p.id.to_string(),
                "name": p.name,
                "path": p.path,
            }))
            .collect();

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
            Ok(todo) => serde_json::to_string(&todo).unwrap_or_else(|e| format!("错误: 序列化失败: {}", e)),
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
}

#[tool_handler]
impl ServerHandler for McpToolHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(concat!(
                "CC-Panes Orchestrator: 管理 Claude Code 多实例编排与工作空间。\n",
                "编排: launch_task（启动 Claude 实例）、list_projects（已注册项目）、get_task_status（任务状态）\n",
                "工作空间: list_workspaces、get_workspace、create_workspace、add_project_to_workspace、scan_directory\n",
                "待办: query_todos、create_todo、update_todo\n",
                "Skill: list_skills（查看项目可用命令模板）\n",
                "典型流程: scan_directory 发现项目 → create_workspace → add_project_to_workspace → launch_task",
            ))
    }
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
    info!(project = %req.project_path, prompt_len = req.prompt.len(), "REST::launch_task");
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

    let is_registered = state.project_service.list_projects()
        .map(|projects| projects.iter().any(|p| p.path == req.project_path))
        .unwrap_or(false);

    if !is_registered {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!(ApiError {
                error: format!("Project path '{}' is not registered", req.project_path)
            })),
        );
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let project_id = format!("orch-{}", uuid::Uuid::new_v4());

    let session_id = match state.terminal_service.create_session(
        state.app_handle.clone(),
        &req.project_path,
        120, 30,
        req.workspace_name.as_deref(),
        req.provider_id.as_deref(),
        req.workspace_path.as_deref(),
        true,
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
    };
    let _ = state.app_handle.emit("orchestrator-launch-task", &event);

    spawn_prompt_injector(
        state.terminal_service.clone(),
        state.tasks.clone(),
        state.app_handle.clone(),
        session_id.clone(),
        task_id.clone(),
        req.prompt,
    );

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

    let projects = state.project_service.list_projects().unwrap_or_default();
    let project_infos: Vec<ProjectInfo> = projects
        .into_iter()
        .map(|p| ProjectInfo {
            id: p.id.to_string(),
            name: p.name.clone(),
            path: p.path.clone(),
            workspace_name: None,
        })
        .collect();

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
                                match terminal_svc.write(&session_id, &format!("{}\n", prompt)) {
                                    Ok(_) => {
                                        info!(
                                            task_id = %task_id,
                                            session_id = %session_id,
                                            prompt_len = prompt.len(),
                                            "prompt_injector: prompt written successfully"
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
                                            "prompt_injector: FAILED to write prompt"
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
