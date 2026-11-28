//! orchestrator 的 `/mesh/*`（docs/112 §5.2/§5.5）。cc-panes-web 把 `/api/bots*`、
//! `/api/contacts*` 反向代理到这里，并用 `x-ccpanes-origin` 告知来源
//! （设备令牌 = `device:<名>`，Cookie 会话 = `mobile`）。鉴权 = orchestrator Bearer。

use std::sync::Arc;

use axum::{
    extract::{Path as UrlPath, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::deliver::parse_inbound;
use super::outbound::{SendRequest, Sender};
use super::{error_json, BotMeshService, RemotePatch};
use crate::services::acp_bridge_routes::request_origin;
use crate::services::OrchestratorToken;
use crate::utils::{AppError, AppResult};

#[derive(Clone)]
pub struct MeshRouteState {
    token: OrchestratorToken,
    app: AppHandle,
}

impl MeshRouteState {
    pub fn new(token: OrchestratorToken, app: AppHandle) -> Self {
        Self { token, app }
    }

    fn service(&self) -> Option<Arc<BotMeshService>> {
        self.app
            .try_state::<Arc<BotMeshService>>()
            .map(|s| s.inner().clone())
    }
}

pub fn router(state: MeshRouteState) -> Router {
    Router::new()
        .route("/bots", get(list_bots))
        .route("/bots/{bot_id}", axum::routing::patch(patch_bot))
        .route("/bots/{bot_id}/messages", post(post_message))
        .route("/bots/{bot_id}/messages/{prompt_id}", get(get_message))
        .route("/contacts", get(list_contacts))
        .route(
            "/contacts/{device_id}/{bot_id}/messages",
            post(contact_send),
        )
        .route(
            "/contacts/{device_id}/{bot_id}/messages/{prompt_id}",
            get(contact_message),
        )
        .route(
            "/contacts/{device_id}/{bot_id}/permission",
            post(contact_permission),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        .with_state(state)
}

async fn require_bearer(
    State(state): State<MeshRouteState>,
    request: Request,
    next: Next,
) -> Response {
    let ok = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| state.token.matches(token));
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code": "UNAUTHORIZED", "message": "Invalid or missing Bearer token"})),
        )
            .into_response();
    }
    next.run(request).await
}

pub fn status_for_code(code: &str) -> StatusCode {
    match code {
        "BOT_NOT_FOUND" | "MESH_MESSAGE_NOT_FOUND" | "MESH_PEER_NOT_FOUND" | "BOT_BAD_ID" => {
            StatusCode::NOT_FOUND
        }
        "BOT_REMOTE_DENIED" => StatusCode::FORBIDDEN,
        "MESH_HOPS_EXCEEDED"
        | "MESH_BAD_REQUEST"
        | "ACP_PROMPT_REQUIRED"
        | "BOT_FULL_CONFIRM_REQUIRED" => StatusCode::BAD_REQUEST,
        "MESH_LOOP_DETECTED" => StatusCode::CONFLICT,
        "ACP_PERMISSION_NOT_PENDING" => StatusCode::CONFLICT,
        "MESH_BUSY" => StatusCode::TOO_MANY_REQUESTS,
        "MESH_PEER_UNREACHABLE" | "MESH_PEER_UNAUTHORIZED" | "MESH_PEER_ERROR" => {
            StatusCode::BAD_GATEWAY
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn app_error(error: AppError) -> Response {
    let status = status_for_code(error.code().unwrap_or(""));
    (status, Json(error_json(&error))).into_response()
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"code": "ACP_HOST_UNAVAILABLE", "message": "Bot mesh is not ready"})),
    )
        .into_response()
}

macro_rules! service_or_return {
    ($state:expr) => {
        match $state.service() {
            Some(service) => service,
            None => return unavailable(),
        }
    };
}

/// 在 Tauri 运行时上跑（Bot 会话的读写任务应与桌面发起的同处一个运行时）。
async fn on_app<T, F>(fut: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: std::future::Future<Output = AppResult<T>> + Send + 'static,
{
    match tauri::async_runtime::spawn(fut).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => app_error(error),
        Err(error) => app_error(AppError::from(error.to_string())),
    }
}

async fn list_bots(State(state): State<MeshRouteState>) -> Response {
    let service = service_or_return!(state);
    Json(service.local_bots(false).await).into_response()
}

async fn patch_bot(
    State(state): State<MeshRouteState>,
    UrlPath(bot_id): UrlPath<String>,
    Json(patch): Json<RemotePatch>,
) -> Response {
    let service = service_or_return!(state);
    on_app(async move { service.update_remote_settings(&bot_id, patch).await }).await
}

async fn post_message(
    State(state): State<MeshRouteState>,
    UrlPath(bot_id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let service = service_or_return!(state);
    let origin = request_origin(&headers);
    let request = match parse_inbound(body) {
        Ok(request) => request,
        Err(error) => return app_error(error),
    };
    on_app(async move { service.deliver(&bot_id, request, origin).await }).await
}

async fn get_message(
    State(state): State<MeshRouteState>,
    UrlPath((bot_id, prompt_id)): UrlPath<(String, String)>,
) -> Response {
    let service = service_or_return!(state);
    match service.inbound_message(&bot_id, &prompt_id) {
        Ok(message) => Json(message).into_response(),
        Err(error) => app_error(error),
    }
}

#[derive(Deserialize)]
struct ContactsQuery {
    #[serde(default)]
    refresh: Option<String>,
}

async fn list_contacts(
    State(state): State<MeshRouteState>,
    Query(query): Query<ContactsQuery>,
) -> Response {
    let service = service_or_return!(state);
    let refresh = matches!(query.refresh.as_deref(), Some("1" | "true"));
    Json(service.contacts(refresh, false).await).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactSendBody {
    text: String,
    #[serde(default)]
    prompt_id: Option<String>,
}

async fn contact_send(
    State(state): State<MeshRouteState>,
    UrlPath((device_id, bot_id)): UrlPath<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ContactSendBody>,
) -> Response {
    let service = service_or_return!(state);
    let sender = Sender {
        label: request_origin(&headers),
        caller_bot: None,
        agent: false,
    };
    let request = SendRequest {
        device_id: Some(device_id),
        bot_id,
        text: body.text,
        prompt_id: body.prompt_id,
    };
    on_app(async move { service.send(request, sender).await }).await
}

async fn contact_message(
    State(state): State<MeshRouteState>,
    UrlPath((_device_id, bot_id, prompt_id)): UrlPath<(String, String, String)>,
) -> Response {
    let service = service_or_return!(state);
    match service
        .outbox_entry(&prompt_id)
        .filter(|e| e.bot_id == bot_id)
    {
        Some(entry) => Json(entry).into_response(),
        None => app_error(AppError::coded("MESH_MESSAGE_NOT_FOUND", "Message expired")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionBody {
    request_key: String,
    #[serde(default)]
    option_id: Option<String>,
}

async fn contact_permission(
    State(state): State<MeshRouteState>,
    UrlPath((device_id, bot_id)): UrlPath<(String, String)>,
    Json(body): Json<PermissionBody>,
) -> Response {
    let service = service_or_return!(state);
    on_app(async move {
        service
            .respond_permission(&device_id, &bot_id, body.request_key, body.option_id)
            .await
            .map(|()| json!({"ok": true}))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_error_codes_map_to_status() {
        assert_eq!(status_for_code("BOT_NOT_FOUND"), StatusCode::NOT_FOUND);
        assert_eq!(status_for_code("BOT_REMOTE_DENIED"), StatusCode::FORBIDDEN);
        assert_eq!(
            status_for_code("MESH_HOPS_EXCEEDED"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(status_for_code("MESH_LOOP_DETECTED"), StatusCode::CONFLICT);
        assert_eq!(status_for_code("MESH_BUSY"), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            status_for_code("MESH_PEER_UNREACHABLE"),
            StatusCode::BAD_GATEWAY
        );
    }
}
