//! `POST /api/providers/export`（docs/112 §6）：手机凭**设备令牌 + 一次性导出码**
//! 领取桌面选中的供应商（含密钥）。
//!
//! - 必须带设备令牌（`Extension<DeviceTokenAuth>` 只在 access_control 核实令牌后才有）：
//!   Cookie 网页会话、回环无令牌请求一律 403 `DEVICE_TOKEN_REQUIRED`——密钥只交给已配对设备。
//! - 远程只读由 `read_only_guard` 先行拦截（POST 不在只读白名单）→ 403 `READ_ONLY`。
//! - 码的校验、限流、审计、读钥匙串都在桌面进程（orchestrator `/provider-export/redeem`），
//!   web 只做鉴权 + 透传；app 不在 → 503 `ACP_HOST_UNAVAILABLE`。
//! - 响应一律 `Cache-Control: no-store`。不存在任何列出密钥的 GET 接口。

use axum::{
    body::Bytes,
    extract::{Extension, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use super::acp::{forward, request_origin};
use crate::state::AppState;
use crate::web_auth::DeviceTokenAuth;

const MAX_BODY: usize = 256;

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    no_store(
        (
            status,
            Json(serde_json::json!({"code": code, "message": message})),
        )
            .into_response(),
    )
}

pub async fn redeem(
    State(state): State<AppState>,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(Extension(auth)) = device.as_ref() else {
        return deny(
            StatusCode::FORBIDDEN,
            "DEVICE_TOKEN_REQUIRED",
            "Provider export requires a paired device token",
        );
    };
    if body.len() > MAX_BODY {
        return deny(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EXPORT_CODE_INVALID",
            "Body too large",
        );
    }
    let origin = request_origin(&state, Some(auth));
    if !origin.starts_with("device:") {
        // 令牌在核实后被吊销的竞态：按无令牌处理。
        return deny(
            StatusCode::FORBIDDEN,
            "DEVICE_TOKEN_REQUIRED",
            "Provider export requires a paired device token",
        );
    }
    no_store(
        forward(
            &state,
            Method::POST,
            "/provider-export/redeem",
            None,
            &origin,
            &headers,
            body,
        )
        .await,
    )
}
