//! 主进程 HTTP IPC 客户端
//!
//! 抽取 session_start.rs:236-273 与 notify.rs:64-95 重复的 ureq + Bearer token 逻辑。
//!
//! 所有 cc-pane 事件子命令通过这里向主进程上报（POST /api/hook-event 等）。

use std::time::Duration;

use crate::common::env::{optional_env, required_env};

/// 主进程 HTTP API 鉴权信息。
pub struct ApiEndpoint {
    pub base_url: String,
    pub token: String,
}

pub struct JsonHttpResponse {
    pub status: u16,
    pub body: String,
}

impl ApiEndpoint {
    /// 从环境变量构造。
    ///
    /// 优先用 `CC_PANES_API_BASE_URL`；缺失时退化到 `http://127.0.0.1:{CC_PANES_API_PORT}`。
    pub fn from_env() -> Result<Self, String> {
        let base_url = optional_env("CC_PANES_API_BASE_URL")
            .or_else(|| {
                optional_env("CC_PANES_API_PORT").map(|port| format!("http://127.0.0.1:{}", port))
            })
            .ok_or_else(|| "CC_PANES_API_BASE_URL / CC_PANES_API_PORT both missing".to_string())?;
        let token = required_env("CC_PANES_API_TOKEN")?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    /// Resolve from env first, then fallback to the current orchestrator manifest.
    pub fn resolve() -> Result<Self, String> {
        crate::common::orchestrator::resolve_orchestrator_endpoint()
            .map(|(base_url, token)| Self {
                base_url: base_url.trim_end_matches('/').to_string(),
                token,
            })
            .ok_or_else(|| {
                "orchestrator endpoint unavailable: CC_PANES_API_* env and mcp-orchestrator.json both missing or unreachable".to_string()
            })
    }

    /// 拼出完整 URL。`path` 以 `/` 开头。
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// POST JSON 到主进程。失败返回详细错误字符串（含 path）。
///
/// 默认超时 750ms（与 session_start.rs 原值一致）。短超时是刻意的：
/// hook 阻塞会拖慢 CLI，宁可 ping 失败也不卡住用户。
pub fn post_json(
    endpoint: &ApiEndpoint,
    path: &str,
    body: &serde_json::Value,
) -> Result<String, String> {
    post_json_with_timeout(endpoint, path, body, Duration::from_millis(750))
}

/// POST JSON 到主进程，自定义超时。
pub fn post_json_with_timeout(
    endpoint: &ApiEndpoint,
    path: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<String, String> {
    post_json_response_with_timeout(endpoint, path, body, timeout).map(|response| response.body)
}

pub fn post_json_response(
    endpoint: &ApiEndpoint,
    path: &str,
    body: &serde_json::Value,
) -> Result<JsonHttpResponse, String> {
    post_json_response_with_timeout(endpoint, path, body, Duration::from_millis(750))
}

fn post_json_response_with_timeout(
    endpoint: &ApiEndpoint,
    path: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<JsonHttpResponse, String> {
    let payload =
        serde_json::to_vec(body).map_err(|e| format!("encode body for {}: {}", path, e))?;
    let url = endpoint.url(path);

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .new_agent();

    let response = agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", endpoint.token))
        .header("Content-Type", "application/json")
        .send(payload.as_slice())
        .map_err(|e| format!("POST {} failed: {}", path, e))?;

    let status = response.status().as_u16();
    let body = response
        .into_body()
        .read_to_string()
        .map_err(|e| format!("read response body for {}: {}", path, e))?;
    Ok(JsonHttpResponse { status, body })
}
