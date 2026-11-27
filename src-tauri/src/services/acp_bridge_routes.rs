//! ACP 移动桥 REST/WS 面（docs/112 §3.3/§3.4），挂在 orchestrator 的 `/acp/*`。
//!
//! 唯一属主仍是 app 进程里的 `AcpChatService`：这里只做参数校验与转发，
//! 手机与桌面标签驱动的是同一个 chat。鉴权 = orchestrator Bearer token（与
//! `/mcp`、`/api/heavy-jobs` 共用句柄，换令牌即时生效）。cc-panes-web 的
//! `/api/acp/*`、`/ws/acp/*` 反向代理到这里，并用 `x-ccpanes-origin` 头告知
//! 请求来自哪一端（`mobile` / `device:<name>`），进 `user_prompt` / `*_resolved`。
//!
//! 改状态的调用放到 Tauri 运行时上执行：`start` / `prompt` 内部会 `tokio::spawn`
//! 读写任务，它们应与桌面发起的会话同处一个运行时。

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as UrlPath, Query, Request, State,
    },
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::services::acp_bridge_ws::{pump, AcpEventSource, FrameSink};
use crate::services::acp_chat_service::bridge::MOBILE_CHAT_PREFIX;
use crate::services::{AcpChatService, OrchestratorToken, UserPrompt};
use crate::utils::{AppError, AppResult};

/// web 代理告知请求来源的头。缺失 / 不合法时按 `mobile`。
pub const ORIGIN_HEADER: &str = "x-ccpanes-origin";
const DEFAULT_ORIGIN: &str = "mobile";

#[derive(Clone)]
pub struct AcpBridgeState {
    token: OrchestratorToken,
    app: AppHandle,
}

impl AcpBridgeState {
    pub fn new(token: OrchestratorToken, app: AppHandle) -> Self {
        Self { token, app }
    }

    /// 惰性取服务：orchestrator 路由可能先于 `manage()` 构建。
    fn service(&self) -> Option<Arc<AcpChatService>> {
        self.app
            .try_state::<Arc<AcpChatService>>()
            .map(|state| state.inner().clone())
    }
}

fn service_unavailable() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "ACP_HOST_UNAVAILABLE",
        "ACP chat service is not ready",
    )
}

pub fn router(state: AcpBridgeState) -> Router {
    Router::new()
        .route("/engines", get(list_engines))
        .route("/history", get(list_history))
        .route("/chats", get(list_chats).post(create_chat))
        .route("/chats/{chat_id}", get(get_chat).delete(stop_chat))
        .route("/chats/{chat_id}/prompt", post(prompt))
        .route("/chats/{chat_id}/cancel", post(cancel))
        .route("/chats/{chat_id}/mode", post(set_mode))
        .route("/chats/{chat_id}/model", post(set_model))
        .route("/chats/{chat_id}/config", post(set_config))
        .route("/chats/{chat_id}/permission", post(respond_permission))
        .route("/chats/{chat_id}/elicitation", post(respond_elicitation))
        .route("/ws/{chat_id}", get(ws_upgrade))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        .with_state(state)
}

async fn require_bearer(
    State(state): State<AcpBridgeState>,
    request: Request,
    next: Next,
) -> Response {
    let ok = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| state.token.matches(token));
    if !ok {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid or missing Bearer token",
        );
    }
    next.run(request).await
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"code": code, "message": message}))).into_response()
}

pub fn status_for_code(code: &str) -> StatusCode {
    match code {
        "ACP_SESSION_NOT_FOUND" => StatusCode::NOT_FOUND,
        "ACP_CWD_INVALID"
        | "ACP_ENGINE_UNKNOWN"
        | "ACP_CHAT_ID_REQUIRED"
        | "ACP_BAD_REQUEST"
        | "ACP_BAD_SESSION_ID"
        | "ACP_PROMPT_REQUIRED"
        | "ACP_INVALID_ANSWER" => StatusCode::BAD_REQUEST,
        "ACP_ENGINE_UNAVAILABLE"
        | "ACP_TURN_IN_PROGRESS"
        | "ACP_SESSION_NOT_READY"
        | "ACP_PERMISSION_NOT_PENDING" => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn app_error_response(error: AppError) -> Response {
    let code = error.code().unwrap_or("ACP_ERROR").to_string();
    error_response(status_for_code(&code), &code, error.message())
}

/// 在 Tauri 运行时上跑一个服务调用，并把结果映射成 HTTP 响应。
async fn run_on_app<T, Fut>(fut: Fut) -> Response
where
    T: serde::Serialize + Send + 'static,
    Fut: std::future::Future<Output = AppResult<T>> + Send + 'static,
{
    match tauri::async_runtime::spawn(fut).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => app_error_response(error),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ACP_ERROR",
            &error.to_string(),
        ),
    }
}

macro_rules! service_or_return {
    ($state:expr) => {
        match $state.service() {
            Some(service) => service,
            None => return service_unavailable(),
        }
    };
}

/// `x-ccpanes-origin`（URL 编码）：只接受 `mobile` 或 `device:<可打印短名>`。
pub fn request_origin(headers: &HeaderMap) -> String {
    let Some(raw) = headers.get(ORIGIN_HEADER).and_then(|v| v.to_str().ok()) else {
        return DEFAULT_ORIGIN.to_string();
    };
    let Ok(decoded) = urlencoding::decode(raw.trim()) else {
        return DEFAULT_ORIGIN.to_string();
    };
    let value = decoded.trim();
    let valid = value == "mobile"
        || value.strip_prefix("device:").is_some_and(|name| {
            !name.is_empty() && name.len() <= 64 && name.chars().all(|c| !c.is_control())
        });
    if valid {
        value.to_string()
    } else {
        DEFAULT_ORIGIN.to_string()
    }
}

async fn list_engines(State(state): State<AcpBridgeState>) -> Response {
    let app = state.app.clone();
    run_on_app(async move { crate::commands::list_acp_engines(app.state()).await }).await
}

async fn list_history(State(state): State<AcpBridgeState>) -> Response {
    let service = service_or_return!(state);
    Json(service.list_chat_history()).into_response()
}

async fn list_chats(State(state): State<AcpBridgeState>) -> Response {
    let service = service_or_return!(state);
    Json(service.list_live_chats().await).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChatBody {
    engine_id: String,
    cwd: String,
    #[serde(default)]
    resume_acp_session_id: Option<String>,
    #[serde(default)]
    auto_approve_kinds: Option<Vec<String>>,
}

/// cwd 必须是已存在的绝对目录（portable-pty 静默回退 HOME 那一类坑：宁可拒绝，
/// 也不让 agent 在错误目录里干活）。
pub fn validate_cwd(cwd: &str) -> AppResult<String> {
    let trimmed = cwd.trim();
    let path = std::path::Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err(AppError::coded(
            "ACP_CWD_INVALID",
            format!("cwd must be an existing absolute directory: {trimmed}"),
        ));
    }
    Ok(trimmed.to_string())
}

fn chat_envelope(service: &AcpChatService, snapshot: crate::services::AcpChatSnapshot) -> Value {
    let last_seq = service.last_event_seq(&snapshot.chat_id);
    json!({"snapshot": snapshot, "lastSeq": last_seq})
}

async fn create_chat(
    State(state): State<AcpBridgeState>,
    Json(body): Json<CreateChatBody>,
) -> Response {
    let service = service_or_return!(state);
    let cwd = match validate_cwd(&body.cwd) {
        Ok(cwd) => cwd,
        Err(error) => return app_error_response(error),
    };
    let engine_id = body.engine_id.trim().to_string();
    if engine_id.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "ACP_ENGINE_UNKNOWN",
            "engineId is required",
        );
    }
    let app = state.app.clone();
    let chat_id = format!("{MOBILE_CHAT_PREFIX}{}", uuid::Uuid::new_v4());
    run_on_app(async move {
        // 与桌面「新建 Agent Chat」同一条命令：引擎只能来自受信注册表，
        // 不接受可执行路径；远端机器 / 运行配置不对手机开放。
        let snapshot = crate::commands::start_acp_chat(
            app.clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            chat_id,
            engine_id,
            cwd,
            body.resume_acp_session_id,
            body.auto_approve_kinds,
            None,
            None,
            None,
        )
        .await?;
        Ok(chat_envelope(&service, snapshot))
    })
    .await
}

async fn get_chat(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
) -> Response {
    let service = service_or_return!(state);
    match service.snapshot(&chat_id).await {
        Some(snapshot) => Json(chat_envelope(&service, snapshot)).into_response(),
        None => error_response(
            StatusCode::NOT_FOUND,
            "ACP_SESSION_NOT_FOUND",
            "ACP chat session was not found",
        ),
    }
}

async fn stop_chat(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
) -> Response {
    let service = service_or_return!(state);
    run_on_app(async move { service.stop(&chat_id).await.map(|()| json!({"ok": true})) }).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptBody {
    blocks: Vec<Value>,
    #[serde(default)]
    prompt_id: Option<String>,
}

async fn prompt(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<PromptBody>,
) -> Response {
    let service = service_or_return!(state);
    if body.blocks.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "ACP_PROMPT_REQUIRED",
            "blocks cannot be empty",
        );
    }
    let user = UserPrompt::new(body.prompt_id, request_origin(&headers));
    let prompt_id = user.prompt_id.clone();
    // 手机网络重试：同一 promptId 已被接纳过就不再发第二轮。
    if service.has_prompt(&chat_id, &prompt_id) {
        return Json(json!({"promptId": prompt_id, "duplicate": true})).into_response();
    }
    run_on_app(async move {
        service
            .prompt_from(&chat_id, body.blocks, user)
            .await
            .map(|()| json!({"promptId": prompt_id}))
    })
    .await
}

async fn cancel(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
) -> Response {
    let service = service_or_return!(state);
    run_on_app(async move { service.cancel(&chat_id).await.map(|()| json!({"ok": true})) }).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModeBody {
    mode_id: String,
}

async fn set_mode(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    Json(body): Json<ModeBody>,
) -> Response {
    let service = service_or_return!(state);
    run_on_app(async move {
        service
            .set_mode(&chat_id, body.mode_id)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelBody {
    model_id: String,
}

async fn set_model(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    Json(body): Json<ModelBody>,
) -> Response {
    let service = service_or_return!(state);
    run_on_app(async move {
        service
            .set_model(&chat_id, body.model_id)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    config_id: String,
    value: Value,
}

async fn set_config(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    Json(body): Json<ConfigBody>,
) -> Response {
    let service = service_or_return!(state);
    run_on_app(async move {
        service
            .set_config_option(&chat_id, body.config_id, body.value)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionBody {
    request_key: String,
    /// `null` = 取消。
    #[serde(default)]
    option_id: Option<String>,
}

async fn respond_permission(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<PermissionBody>,
) -> Response {
    let service = service_or_return!(state);
    let by = request_origin(&headers);
    run_on_app(async move {
        service
            .respond_permission_by(&chat_id, body.request_key, body.option_id, &by)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElicitationBody {
    request_key: String,
    response: Value,
}

async fn respond_elicitation(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<ElicitationBody>,
) -> Response {
    let service = service_or_return!(state);
    let action = body.response.get("action").and_then(Value::as_str);
    if !matches!(action, Some("accept" | "decline" | "cancel")) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "ACP_BAD_REQUEST",
            "response.action must be accept, decline or cancel",
        );
    }
    let by = request_origin(&headers);
    run_on_app(async move {
        service
            .respond_elicitation_by(&chat_id, body.request_key, body.response, &by)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsQuery {
    #[serde(default)]
    after_seq: Option<u64>,
}

async fn ws_upgrade(
    State(state): State<AcpBridgeState>,
    UrlPath(chat_id): UrlPath<String>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let service = service_or_return!(state);
    // 升级前确认 chat 有事件日志：握手阶段以 HTTP 404 回，代理侧原样转给客户端。
    if service.subscribe_events(&chat_id, 0).is_none() {
        return error_response(
            StatusCode::NOT_FOUND,
            "ACP_SESSION_NOT_FOUND",
            "ACP chat has no event log",
        );
    }
    let after_seq = query.after_seq.unwrap_or(0);
    ws.on_upgrade(move |socket| serve_socket(socket, service, chat_id, after_seq))
}

struct SocketSink(futures_util::stream::SplitSink<WebSocket, Message>);

impl FrameSink for SocketSink {
    async fn send_frame(&mut self, frame: Value) -> bool {
        self.0
            .send(Message::Text(frame.to_string().into()))
            .await
            .is_ok()
    }
}

async fn serve_socket(
    socket: WebSocket,
    service: Arc<AcpChatService>,
    chat_id: String,
    after_seq: u64,
) {
    let (tx, mut rx) = socket.split();
    let mut sink = SocketSink(tx);
    // 下行为主；上行只用来感知断开（客户端发来的文本忽略）。
    let closed = async move {
        while let Some(Ok(message)) = rx.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    };
    let source: Arc<dyn AcpEventSource> = service;
    pump(source, &chat_id, after_seq, &mut sink, closed).await;
    let _ = sink.0.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_header_is_validated() {
        let mut headers = HeaderMap::new();
        assert_eq!(request_origin(&headers), "mobile");
        headers.insert(ORIGIN_HEADER, "device:Wu's iPhone".parse().unwrap());
        assert_eq!(request_origin(&headers), "device:Wu's iPhone");
        let encoded = urlencoding::encode("device:吴的 iPhone").into_owned();
        headers.insert(ORIGIN_HEADER, encoded.parse().unwrap());
        assert_eq!(request_origin(&headers), "device:吴的 iPhone");
        headers.insert(ORIGIN_HEADER, "desktop".parse().unwrap());
        assert_eq!(
            request_origin(&headers),
            "mobile",
            "cannot impersonate desktop"
        );
        headers.insert(ORIGIN_HEADER, "device:".parse().unwrap());
        assert_eq!(request_origin(&headers), "mobile");
    }

    #[test]
    fn cwd_must_be_an_existing_absolute_directory() {
        let dir = std::env::temp_dir();
        assert!(validate_cwd(&dir.to_string_lossy()).is_ok());
        assert_eq!(
            validate_cwd("relative/dir").unwrap_err().code(),
            Some("ACP_CWD_INVALID")
        );
        let missing = dir.join(format!("missing-{}", uuid::Uuid::new_v4()));
        assert!(validate_cwd(&missing.to_string_lossy()).is_err());
    }

    #[test]
    fn error_codes_map_to_http_status() {
        assert_eq!(
            status_for_code("ACP_SESSION_NOT_FOUND"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(status_for_code("ACP_CWD_INVALID"), StatusCode::BAD_REQUEST);
        assert_eq!(
            status_for_code("ACP_TURN_IN_PROGRESS"),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_for_code("ACP_ERROR"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
