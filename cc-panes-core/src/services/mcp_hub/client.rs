//! hub 连后端共享 MCP 的最小 Streamable HTTP 客户端：initialize / tools/list / tools/call。
//!
//! 只做 hub 需要的部分：JSON 或 SSE 响应体里挑出对应 id 的 JSON-RPC 响应；记住
//! `Mcp-Session-Id`；服务器回 404（会话被遗忘，通常是后端重启）时由调用方重新握手。
//! 不开 GET 事件流——工具变化靠缓存过期 + 指纹（见 `mod.rs`）。

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// JSON-RPC id 全局递增：同一会话可能被多个克隆并发使用（见 `mod.rs` 的 call 路径）。
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientErrorKind {
    /// 会话失效（HTTP 404 且带了 session）：重新 initialize 后可重试一次。
    SessionExpired,
    Http,
    Transport,
    Protocol,
}

#[derive(Debug, Clone)]
pub struct ClientError {
    pub kind: ClientErrorKind,
    pub message: String,
}

impl ClientError {
    fn new(kind: ClientErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// 一台后端服务器的连接状态（会话 id 跨调用复用）。克隆共享底层连接池与会话 id，
/// 调用路径据此在不持锁的情况下并发发请求。
#[derive(Debug, Clone)]
pub struct BackendClient {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: Option<String>,
    initialized: bool,
    http: reqwest::Client,
}

impl BackendClient {
    pub fn new(url: String, headers: BTreeMap<String, String>, timeout: Duration) -> Self {
        let mut builder = reqwest::Client::builder().timeout(timeout);
        // 本机桥不走系统代理；远程 MCP 照常走（用户可能只能经代理出网）
        if is_loopback_url(&url) {
            builder = builder.no_proxy();
        }
        let http = builder.build().unwrap_or_default();
        Self {
            url,
            headers,
            session_id: None,
            initialized: false,
            http,
        }
    }

    /// 丢弃会话，下次请求重新握手。
    pub fn reset(&mut self) {
        self.session_id = None;
        self.initialized = false;
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Value>, ClientError> {
        self.ensure_initialized().await?;
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        // 分页上限防御：服务器回同一个 cursor 时不至于死循环
        for _ in 0..50 {
            let params = cursor
                .as_ref()
                .map(|c| json!({ "cursor": c }))
                .unwrap_or_else(|| json!({}));
            let result = self.request("tools/list", params).await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ClientError::new(ClientErrorKind::Protocol, "tools/list 缺少 tools")
                })?;
            tools.extend(page.iter().cloned());
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, ClientError> {
        self.ensure_initialized().await?;
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    pub async fn ensure_initialized(&mut self) -> Result<(), ClientError> {
        if self.initialized {
            return Ok(());
        }
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "ccpanes-hub", "version": env!("CARGO_PKG_VERSION") }
        });
        self.request("initialize", params).await?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        self.initialized = true;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ClientError> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let body = self
            .send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        let envelope = select_response(&body, id)?;
        if let Some(error) = envelope.get("error") {
            return Err(ClientError::new(
                ClientErrorKind::Protocol,
                format!("{method} 返回错误: {error}"),
            ));
        }
        envelope.get("result").cloned().ok_or_else(|| {
            ClientError::new(ClientErrorKind::Protocol, format!("{method} 缺少 result"))
        })
    }

    async fn send(&mut self, message: &Value) -> Result<String, ClientError> {
        let mut request = self
            .http
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION)
            .json(message);
        for (key, value) in &self.headers {
            request = request.header(key.as_str(), value.as_str());
        }
        if let Some(session) = self.session_id.as_deref() {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|e| ClientError::new(ClientErrorKind::Transport, format!("请求失败: {e}")))?;
        let status = response.status().as_u16();
        let new_session = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.map_err(|e| {
            ClientError::new(ClientErrorKind::Transport, format!("读取响应失败: {e}"))
        })?;
        if status == 404 && self.session_id.is_some() {
            return Err(ClientError::new(
                ClientErrorKind::SessionExpired,
                "会话已失效",
            ));
        }
        if !(200..300).contains(&status) {
            let snippet: String = text.chars().take(200).collect();
            return Err(ClientError::new(
                ClientErrorKind::Http,
                format!("HTTP {status}: {snippet}"),
            ));
        }
        if self.session_id.is_none() {
            self.session_id = new_session;
        }
        Ok(text)
    }
}

fn is_loopback_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

/// 从 JSON 或 SSE 响应体里挑出 id 匹配的 JSON-RPC 响应。
pub fn select_response(body: &str, id: u64) -> Result<Value, ClientError> {
    let trimmed = body.trim();
    let matches = |value: &Value| value.get("id").and_then(Value::as_u64) == Some(id);
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|e| ClientError::new(ClientErrorKind::Protocol, format!("JSON 无效: {e}")))?;
        let found = match value {
            Value::Array(items) => items.into_iter().find(|v| matches(v)),
            single if matches(&single) => Some(single),
            _ => None,
        };
        return found.ok_or_else(|| ClientError::new(ClientErrorKind::Protocol, "响应 id 不匹配"));
    }
    let normalized = body.replace("\r\n", "\n");
    for event in normalized.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            if matches(&value) {
                return Ok(value);
            }
        }
    }
    Err(ClientError::new(
        ClientErrorKind::Protocol,
        "响应里没有匹配的 JSON-RPC 结果",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_plain_json_response() {
        let body = r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#;
        assert_eq!(select_response(body, 3).unwrap()["result"]["ok"], true);
        assert!(select_response(body, 4).is_err());
    }

    #[test]
    fn selects_sse_response_skipping_notifications() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n\
                    event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[]}}\n\n";
        let value = select_response(body, 7).unwrap();
        assert!(value["result"]["tools"].is_array());
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_url("http://127.0.0.1:3100/mcp"));
        assert!(is_loopback_url("http://localhost:3100/mcp"));
        assert!(!is_loopback_url("https://mcp.example.com/mcp"));
    }

    #[test]
    fn selects_from_batch() {
        let body = r#"[{"jsonrpc":"2.0","id":1,"result":1},{"jsonrpc":"2.0","id":2,"result":2}]"#;
        assert_eq!(select_response(body, 2).unwrap()["result"], 2);
    }
}
