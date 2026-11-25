//! 设置 → 设备与访问：网页登录会话（列出 / 吊销 / 撤销其他全部）与编排器令牌更换。
//!
//! 网页登录会话只活在 cc-panes-web 进程的内存里，桌面端经本机回环 + 控制令牌
//! （`WebAccessLifecycle::control_endpoint`，每次拉起 web 进程时生成）调它的
//! `/api/auth/sessions*` 接口；设备令牌则直接改 `device-tokens.json`（web 按 mtime 重读）。

use std::sync::Arc;
use std::time::Duration;

use cc_panes_core::services::DeviceTokenService;
use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{debug, info};

use crate::services::{
    OrchestratorService, TerminalBackendState, TerminalService, WebAccessLifecycle,
};
use crate::utils::{AppError, AppPaths, AppResult};

const CONTROL_TOKEN_HEADER: &str = "x-ccpanes-control-token";
const WEB_CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionInfo {
    pub id: String,
    pub created_at: String,
    pub last_activity_at: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionList {
    /// 本机 Web 服务（由本应用拉起的）是否在运行。没在跑时会话必然为空。
    pub web_running: bool,
    pub sessions: Vec<WebSessionInfo>,
}

#[derive(Debug, Deserialize)]
struct WebSessionsResponse {
    sessions: Vec<WebSessionInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeOthersResult {
    pub device_tokens: usize,
    pub web_sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorRotationImpact {
    /// 当前仍在运行（未退出）的终端会话数：它们启动时拿到的是旧令牌。
    pub running_sessions: usize,
}

fn web_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(WEB_CONTROL_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| AppError::from(error.to_string()))
}

/// 统一处理 web 控制接口的响应。老版本 cc-panes-web 没有这些接口（回 SPA 的 HTML 或 401），
/// 给出「重启 Web 服务」的可操作提示，而不是一段 JSON 解析错误。
async fn web_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> AppResult<T> {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::from(
            "The Web access server does not support session management yet; restart it from 服务控制 and try again",
        ));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::from(format!(
            "Web access server returned HTTP {}: {}",
            status.as_u16(),
            body.chars().take(300).collect::<String>()
        )));
    }
    response.json::<T>().await.map_err(|_| {
        AppError::from(
            "The Web access server does not support session management yet; restart it from 服务控制 and try again",
        )
    })
}

/// 列出网页登录会话。Web 服务没在跑时返回空列表（会话只在内存里，进程退出即全部失效）。
#[tauri::command]
pub async fn web_sessions_list(
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<WebSessionList> {
    debug!("cmd::web_sessions_list");
    let Some((port, token)) = web_access.control_endpoint() else {
        return Ok(WebSessionList {
            web_running: false,
            sessions: Vec::new(),
        });
    };
    let response = web_client()?
        .get(format!("http://127.0.0.1:{port}/api/auth/sessions"))
        .header(CONTROL_TOKEN_HEADER, token)
        .send()
        .await
        .map_err(|error| AppError::from(format!("Cannot reach the Web access server: {error}")))?;
    let body: WebSessionsResponse = web_json(response).await?;
    Ok(WebSessionList {
        web_running: true,
        sessions: body.sessions,
    })
}

/// 吊销一个网页登录会话（该浏览器下一个请求即被要求重新登录，已打开的终端流随即断开）。
#[tauri::command]
pub async fn web_session_revoke(
    id: String,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<()> {
    debug!("cmd::web_session_revoke");
    let id = id.trim().to_string();
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AppError::from("Invalid web session id"));
    }
    let Some((port, token)) = web_access.control_endpoint() else {
        return Err(AppError::from("The Web access server is not running"));
    };
    let response = web_client()?
        .delete(format!("http://127.0.0.1:{port}/api/auth/sessions/{id}"))
        .header(CONTROL_TOKEN_HEADER, token)
        .send()
        .await
        .map_err(|error| AppError::from(format!("Cannot reach the Web access server: {error}")))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // 已过期 / 已被吊销：结果一致，不报错
        return Ok(());
    }
    let _: serde_json::Value = web_json(response).await?;
    Ok(())
}

/// 撤销其他全部：吊销全部设备令牌与全部网页登录会话。桌面端本身不是任何一个会话或令牌，
/// 所以这里没有需要保留的「调用方」——桌面应用的访问不受影响。
#[tauri::command]
pub async fn device_access_revoke_others(
    tokens: State<'_, Arc<DeviceTokenService>>,
    web_access: State<'_, Arc<WebAccessLifecycle>>,
) -> AppResult<RevokeOthersResult> {
    debug!("cmd::device_access_revoke_others");
    let tokens = tokens.inner().clone();
    let device_tokens =
        tauri::async_runtime::spawn_blocking(move || tokens.revoke_all_except(None))
            .await
            .map_err(|error| AppError::from(error.to_string()))?
            .map_err(|error| AppError::from(format!("{error:#}")))?;
    let mut web_sessions = 0;
    if let Some((port, token)) = web_access.control_endpoint() {
        let response = web_client()?
            .post(format!("http://127.0.0.1:{port}/api/auth/revoke-others"))
            .header(CONTROL_TOKEN_HEADER, token)
            .json(&serde_json::json!({ "deviceTokens": false }))
            .send()
            .await
            .map_err(|error| {
                AppError::from(format!(
                    "Device tokens were revoked, but the Web access server could not be reached: {error}"
                ))
            })?;
        let body: serde_json::Value = web_json(response).await?;
        web_sessions = body["webSessions"].as_u64().unwrap_or(0) as usize;
    }
    info!(
        device_tokens,
        web_sessions, "revoked all device tokens and web sessions"
    );
    Ok(RevokeOthersResult {
        device_tokens,
        web_sessions,
    })
}

/// 更换令牌前给确认框用：有多少终端会话还拿着旧令牌。
#[tauri::command]
pub async fn orchestrator_rotation_impact(
    backend: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<OrchestratorRotationImpact> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let statuses = backend.backend().get_all_status()?;
        Ok(OrchestratorRotationImpact {
            running_sessions: statuses
                .iter()
                .filter(|status| {
                    status.status
                        != cc_panes_core::services::terminal_service::SessionStatus::Exited
                })
                .count(),
        })
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

/// 更换编排器（MCP 端点）令牌：持久化到 mcp-orchestrator.json 后立即生效，旧令牌随即作废。
/// 之后新开的会话（本机 / daemon / WSL 都按 manifest 取令牌）拿到新值；已在运行的会话不会。
#[tauri::command]
pub async fn rotate_orchestrator_token(
    orchestrator: State<'_, Arc<OrchestratorService>>,
    terminal: State<'_, Arc<TerminalService>>,
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<()> {
    debug!("cmd::rotate_orchestrator_token");
    let orchestrator = orchestrator.inner().clone();
    let terminal = terminal.inner().clone();
    let data_dir = app_paths.data_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let token = orchestrator.rotate_token(&data_dir)?;
        if let Some(port) = orchestrator.port() {
            terminal.set_orchestrator_info(port, token);
        }
        Ok(())
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}
