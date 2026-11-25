//! 网页登录会话管理：列出 / 吊销单个 / 撤销其他全部（设置 → 设备与访问 → 已授权的客户端）。
//!
//! 调用方三类：浏览器（cookie 会话，标出「本会话」）、已配对设备（设备令牌）、
//! 拉起本进程的桌面端（控制令牌，见 `web_auth::ControlAuth`——它不对应任何会话或令牌）。
//! 会话本身只在本进程内存里，所以桌面端也必须经这些接口管理。
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{Request, StatusCode},
    Extension, Json,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::web_auth::{self, DeviceTokenAuth, WebSessionInfo};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionsResponse {
    pub sessions: Vec<WebSessionInfo>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Json<WebSessionsResponse> {
    let settings = state.settings_service.get_settings().web_access;
    let current = web_auth::session_from_request(&request);
    Json(WebSessionsResponse {
        sessions: state
            .web_auth
            .list_sessions(current.as_deref(), web_auth::idle_timeout(&settings)),
    })
}

pub async fn revoke_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if state.web_auth.revoke_session_by_id(id.trim()) {
        Ok(Json(serde_json::json!({ "revoked": true })))
    } else {
        Err((StatusCode::NOT_FOUND, "Web session not found".to_string()))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokeOthersRequest {
    /// 是否同时吊销设备令牌（默认是）。桌面端自己按文件吊销设备令牌，传 false。
    #[serde(default)]
    device_tokens: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevokeOthersResponse {
    pub web_sessions: usize,
    pub device_tokens: usize,
}

/// 撤销除调用方以外的全部网页会话与设备令牌。调用方的 cookie 会话 / 设备令牌保留。
pub async fn revoke_others(
    State(state): State<AppState>,
    device_auth: Option<Extension<DeviceTokenAuth>>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<Json<RevokeOthersResponse>, (StatusCode, String)> {
    let request: RevokeOthersRequest = if body.is_empty() {
        RevokeOthersRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
    };
    let keep_session = web_auth::session_from_headers(&headers);
    let web_sessions = state
        .web_auth
        .revoke_sessions_except(keep_session.as_deref());
    let mut device_tokens = 0;
    if request.device_tokens.unwrap_or(true) {
        if let Some(tokens) = state.web_auth.device_tokens().cloned() {
            let keep_token = device_auth.map(|Extension(DeviceTokenAuth(token))| token);
            device_tokens = tokio::task::spawn_blocking(move || {
                let keep_id = keep_token
                    .as_deref()
                    .and_then(|token| tokens.verify(token))
                    .map(|record| record.id);
                tokens.revoke_all_except(keep_id.as_deref())
            })
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        }
    }
    Ok(Json(RevokeOthersResponse {
        web_sessions,
        device_tokens,
    }))
}
