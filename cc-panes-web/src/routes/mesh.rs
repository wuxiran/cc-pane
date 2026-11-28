//! Bot 组网的 web 侧（docs/112 §5）：`/api/bots*` 与 `/api/contacts*`。
//!
//! 与 ACP 移动桥同一模式：鉴权（Cookie / 设备令牌，过 access_control + 只读守卫）
//! 后原样转给桌面 app 内 orchestrator 的 `/mesh/*`；来源经 `x-ccpanes-origin`
//! 告知（设备令牌 = `device:<设备名>`，是远程权限 `full` 生效的前提）。
//! app 不在 → 503 `ACP_HOST_UNAVAILABLE`。

use axum::{
    body::Bytes,
    extract::{Extension, Path, RawQuery, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use super::acp::{forward, is_safe_segment, request_origin};
use crate::state::AppState;
use crate::web_auth::DeviceTokenAuth;

/// `/api/bots/...` 余下的段是否在契约内。
pub fn is_allowed_bots_path(rest: &str) -> bool {
    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        [""] => true,
        [id] => is_safe_segment(id),
        [id, "messages"] => is_safe_segment(id),
        [id, "messages", prompt] => is_safe_segment(id) && is_safe_segment(prompt),
        _ => false,
    }
}

/// `/api/contacts/...` 余下的段是否在契约内。
pub fn is_allowed_contacts_path(rest: &str) -> bool {
    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        [""] => true,
        [device, bot, "messages"] | [device, bot, "permission"] => {
            is_safe_segment(device) && is_safe_segment(bot)
        }
        [device, bot, "messages", prompt] => {
            is_safe_segment(device) && is_safe_segment(bot) && is_safe_segment(prompt)
        }
        _ => false,
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"code": "NOT_FOUND", "message": "Unknown bot mesh route"})),
    )
        .into_response()
}

async fn proxy(
    state: AppState,
    method: Method,
    upstream: String,
    query: Option<String>,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = request_origin(&state, device.as_ref().map(|Extension(auth)| auth));
    forward(&state, method, &upstream, query, &origin, &headers, body).await
}

/// `GET /api/bots`
pub async fn bots_root(
    State(state): State<AppState>,
    method: Method,
    RawQuery(query): RawQuery,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    proxy(
        state,
        method,
        "/mesh/bots".into(),
        query,
        device,
        headers,
        body,
    )
    .await
}

/// `ANY /api/bots/{*rest}`
pub async fn bots_rest(
    State(state): State<AppState>,
    method: Method,
    Path(rest): Path<String>,
    RawQuery(query): RawQuery,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_allowed_bots_path(&rest) {
        return not_found();
    }
    let upstream = format!("/mesh/bots/{rest}");
    proxy(state, method, upstream, query, device, headers, body).await
}

/// `GET /api/contacts`
pub async fn contacts_root(
    State(state): State<AppState>,
    method: Method,
    RawQuery(query): RawQuery,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    proxy(
        state,
        method,
        "/mesh/contacts".into(),
        query,
        device,
        headers,
        body,
    )
    .await
}

/// `ANY /api/contacts/{*rest}`
pub async fn contacts_rest(
    State(state): State<AppState>,
    method: Method,
    Path(rest): Path<String>,
    RawQuery(query): RawQuery,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_allowed_contacts_path(&rest) {
        return not_found();
    }
    let upstream = format!("/mesh/contacts/{rest}");
    proxy(state, method, upstream, query, device, headers, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bots_paths_follow_contract() {
        for ok in ["b1", "b1/messages", "b1/messages/p-1"] {
            assert!(is_allowed_bots_path(ok), "{ok}");
        }
        for bad in [
            "",
            "..",
            "b1/../x",
            "b1/permission",
            "b1/messages/p/x",
            "b1//messages",
        ] {
            assert!(!is_allowed_bots_path(bad) || bad.is_empty(), "{bad}");
        }
    }

    #[test]
    fn contacts_paths_follow_contract() {
        for ok in [
            "local/b1/messages",
            "dev-1/b1/messages/p1",
            "dev-1/b1/permission",
        ] {
            assert!(is_allowed_contacts_path(ok), "{ok}");
        }
        for bad in [
            "dev-1",
            "dev-1/b1",
            "../b1/messages",
            "a/b/c/d/e",
            "a/b/cancel",
        ] {
            assert!(!is_allowed_contacts_path(bad), "{bad}");
        }
    }
}
