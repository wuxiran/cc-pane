//! orchestrator 的 `/provider-export/*`（docs/112 §6）。cc-panes-web 的
//! `POST /api/providers/export` 在核实**设备令牌**后转发到这里，并用
//! `x-ccpanes-origin: device:<设备名>` 告知来源。鉴权 = orchestrator Bearer。
//!
//! 这里再做一道来源校验：只认 `device:` 来源（Cookie / 本机无令牌一律 403），
//! 防止将来有别的转发路径漏掉 web 层的设备令牌检查。

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use cc_panes_core::services::ProviderExportService;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::acp_bridge_routes::request_origin;
use crate::services::OrchestratorToken;

/// 导出成功 / 失败时推给桌面导出对话框的事件。
pub const PROVIDER_EXPORT_EVENT: &str = "provider-export-changed";

#[derive(Clone)]
pub struct ProviderExportRouteState {
    token: OrchestratorToken,
    app: AppHandle,
}

impl ProviderExportRouteState {
    pub fn new(token: OrchestratorToken, app: AppHandle) -> Self {
        Self { token, app }
    }

    fn service(&self) -> Option<Arc<ProviderExportService>> {
        self.app
            .try_state::<Arc<ProviderExportService>>()
            .map(|s| s.inner().clone())
    }
}

pub fn router(state: ProviderExportRouteState) -> Router {
    let router = Router::new().route("/redeem", post(redeem));
    // 仅 debug 构建：E2E 夹具（建 / 删假供应商、直接生成导出码），release 不存在这些路由。
    #[cfg(debug_assertions)]
    let router = router
        .route("/debug/start", post(debug::start))
        .route("/debug/fixture", post(debug::fixture));
    router
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        .with_state(state)
}

async fn require_bearer(
    State(state): State<ProviderExportRouteState>,
    request: Request,
    next: Next,
) -> Response {
    let ok = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|token| state.token.matches(token));
    if !ok {
        return error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Invalid or missing Bearer token",
        );
    }
    next.run(request).await
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    no_store((status, Json(json!({"code": code, "message": message}))).into_response())
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
struct RedeemBody {
    code: String,
}

/// 导出码只接受 6 位数字；其余直接 400，不消耗尝试次数（也不进失败窗口）。
pub fn is_well_formed_code(code: &str) -> bool {
    let code = code.trim();
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

async fn redeem(
    State(state): State<ProviderExportRouteState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let origin = request_origin(&headers);
    if !origin.starts_with("device:") {
        return error(
            StatusCode::FORBIDDEN,
            "DEVICE_TOKEN_REQUIRED",
            "Provider export requires a paired device token",
        );
    }
    let Ok(body) = serde_json::from_slice::<RedeemBody>(&body) else {
        return error(
            StatusCode::BAD_REQUEST,
            "EXPORT_CODE_INVALID",
            "Body must be {\"code\":\"123456\"}",
        );
    };
    if !is_well_formed_code(&body.code) {
        return error(
            StatusCode::BAD_REQUEST,
            "EXPORT_CODE_INVALID",
            "Export code must be 6 digits",
        );
    }
    let Some(service) = state.service() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ACP_HOST_UNAVAILABLE",
            "Provider export service is not ready",
        );
    };
    let code = body.code;
    let origin_for_task = origin.clone();
    // 读钥匙串是阻塞调用。
    let result = tokio::task::spawn_blocking(move || service.redeem(&code, &origin_for_task)).await;
    let device = origin.trim_start_matches("device:").to_string();
    match result {
        Ok(Ok(payload)) => {
            let _ = state.app.emit(
                PROVIDER_EXPORT_EVENT,
                json!({"state": "redeemed", "device": device, "count": payload.providers.len()}),
            );
            no_store(Json(payload).into_response())
        }
        Ok(Err(rejection)) => {
            let (status, code, message) = rejection.status_and_code();
            if matches!(
                rejection,
                cc_panes_core::services::ExportRejection::Locked
                    | cc_panes_core::services::ExportRejection::Expired
            ) {
                let _ = state.app.emit(
                    PROVIDER_EXPORT_EVENT,
                    json!({"state": "cancelled", "reason": code}),
                );
            }
            let mut body = json!({"code": code, "message": message});
            if let cc_panes_core::services::ExportRejection::Invalid { attempts_left } = rejection {
                body["attemptsLeft"] = json!(attempts_left);
            }
            no_store(
                (
                    StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                    Json(body),
                )
                    .into_response(),
            )
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Export task failed",
        ),
    }
}

/// debug 构建专用的 E2E 夹具：在**桌面进程内**建 / 删假供应商（钥匙串条目由本进程读写，
/// 不会触发别的可执行文件访问的系统授权框），并跳过 UI 直接生成导出码。
#[cfg(debug_assertions)]
mod debug {
    use super::*;
    use cc_panes_core::models::provider::{Provider, ProviderModel, ProviderType};
    use cc_panes_core::services::ProviderService;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartBody {
        provider_ids: Vec<String>,
    }

    pub async fn start(
        State(state): State<ProviderExportRouteState>,
        Json(body): Json<StartBody>,
    ) -> Response {
        let Some(service) = state.service() else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE", "not ready");
        };
        match tokio::task::spawn_blocking(move || service.start(body.provider_ids)).await {
            Ok(Ok(ticket)) => no_store(Json(ticket).into_response()),
            Ok(Err(e)) => error(
                StatusCode::BAD_REQUEST,
                "EXPORT_START_FAILED",
                &e.to_string(),
            ),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "task failed"),
        }
    }

    #[derive(Deserialize)]
    pub struct FixtureBody {
        action: String,
        id: String,
        #[serde(default)]
        key: Option<String>,
    }

    pub async fn fixture(
        State(state): State<ProviderExportRouteState>,
        Json(body): Json<FixtureBody>,
    ) -> Response {
        let Some(providers) = state
            .app
            .try_state::<Arc<ProviderService>>()
            .map(|s| s.inner().clone())
        else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE", "not ready");
        };
        let result = tokio::task::spawn_blocking(move || match body.action.as_str() {
            "create" => providers.add_provider(Provider {
                id: body.id.clone(),
                name: format!("E2E Dummy {}", body.id),
                provider_type: ProviderType::Proxy,
                api_key: body.key.clone(),
                base_url: Some("https://relay.e2e.invalid".into()),
                models: vec![ProviderModel {
                    id: "claude-e2e-model".into(),
                    label: Some("E2E Model".into()),
                    ..Default::default()
                }],
                default_model_id: Some("claude-e2e-model".into()),
                ..Default::default()
            }),
            "delete" => providers.remove_provider(&body.id),
            other => Err(anyhow::anyhow!("unknown action {other}")),
        })
        .await;
        match result {
            Ok(Ok(())) => Json(json!({"ok": true})).into_response(),
            Ok(Err(e)) => error(StatusCode::BAD_REQUEST, "FIXTURE_FAILED", &e.to_string()),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "task failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_shape() {
        assert!(is_well_formed_code("012345"));
        assert!(is_well_formed_code(" 012345 "));
        assert!(!is_well_formed_code("12345"));
        assert!(!is_well_formed_code("12a456"));
        assert!(!is_well_formed_code("1234567"));
    }
}
