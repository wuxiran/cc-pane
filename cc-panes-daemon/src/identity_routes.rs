//! `GET /api/sessions/identity` —— 已捕获的 resume id 身份事件快照。

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;

use crate::server::{authorize, DaemonConfig};

/// 已捕获的 resume id 身份事件全集。
///
/// control 是无重放的广播：桌面侧 control link 建连之前 emit 的身份事件已经丢了。
/// 桌面连上后拉一次本接口补绑，堵住 app 启动窗口期（恢复流程恰在此时批量建会话）。
pub async fn list_identity_events(
    State(config): State<DaemonConfig>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    authorize(&headers, config.token())?;
    Ok(Json(
        serde_json::json!({ "events": config.ws_emitter().identity_snapshot() }),
    ))
}
