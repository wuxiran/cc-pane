use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::discovery::ServiceEndpoint;

const DEFAULT_PROTOCOL_VERSION: &str = "2025-03-26";
const RESPONSE_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpErrorKind {
    /// DNS、拒绝连接等可以确认请求未到达服务端的失败。
    Unreachable,
    /// 下游明确返回旧 MCP session 不存在；原请求未进入工具执行。
    SessionExpired,
    /// 请求可能已到达服务端，但响应在 reset、超时或读取阶段丢失。
    Indeterminate,
    Http,
    Protocol,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpError {
    pub kind: McpErrorKind,
    message: String,
}

impl McpError {
    fn new(kind: McpErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn retryable_before_execution(&self) -> bool {
        matches!(
            self.kind,
            McpErrorKind::Unreachable | McpErrorKind::SessionExpired
        )
    }

    pub fn execution_uncertain(&self) -> bool {
        matches!(
            self.kind,
            McpErrorKind::Indeterminate | McpErrorKind::InvalidResponse
        )
    }
}

impl fmt::Display for McpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for McpError {}

#[derive(Debug)]
pub struct McpClient {
    endpoint: ServiceEndpoint,
    launch_id: Option<String>,
    session_id: Option<String>,
    protocol_version: String,
    next_id: u64,
    initialized: bool,
    timeout: Duration,
}

impl McpClient {
    pub fn new(endpoint: ServiceEndpoint, launch_id: Option<String>) -> Self {
        Self {
            endpoint,
            launch_id,
            session_id: None,
            protocol_version: DEFAULT_PROTOCOL_VERSION.to_string(),
            next_id: 1,
            initialized: false,
            timeout: Duration::from_secs(10),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn initialize(&mut self) -> Result<Value, McpError> {
        let params = json!({
            "protocolVersion": DEFAULT_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "cc-panes-ctl",
                "version": env!("CARGO_PKG_VERSION")
            }
        });
        self.initialize_with(params)
    }

    pub fn initialize_with(&mut self, params: Value) -> Result<Value, McpError> {
        if self.initialized {
            return Ok(json!({ "protocolVersion": self.protocol_version }));
        }
        if !params.is_object() {
            return Err(McpError::new(
                McpErrorKind::Protocol,
                "initialize params 必须是 JSON object",
            ));
        }
        if let Some(version) = params.get("protocolVersion").and_then(Value::as_str) {
            self.protocol_version = version.to_string();
        }
        let result = self.request("initialize", params)?;
        if let Some(version) = result.get("protocolVersion").and_then(Value::as_str) {
            self.protocol_version = version.to_string();
        }
        self.notification("notifications/initialized", json!({}))?;
        self.initialized = true;
        Ok(result)
    }

    pub fn list_tools(&mut self) -> Result<Vec<ToolDefinition>, McpError> {
        let value = self.list_tools_value()?;
        let page: ToolsPage = serde_json::from_value(value).map_err(|error| {
            McpError::new(
                McpErrorKind::InvalidResponse,
                format!("tools/list 响应结构无效: {error}"),
            )
        })?;
        Ok(page.tools.into_iter().map(ToolDefinition::from).collect())
    }

    /// 返回已经展开分页的原始 tools/list 结果，保留服务端未来新增的 schema 字段。
    pub fn list_tools_value(&mut self) -> Result<Value, McpError> {
        self.ensure_initialized()?;
        let mut cursor: Option<String> = None;
        let mut tools: Vec<Value> = Vec::new();
        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let result = self.request("tools/list", params)?;
            let page_tools = result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    McpError::new(
                        McpErrorKind::InvalidResponse,
                        "tools/list 响应缺少 tools 数组",
                    )
                })?;
            tools.extend(page_tools);
            let next_cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            match next_cursor {
                Some(next) => cursor = Some(next),
                None => return Ok(json!({ "tools": tools })),
            }
        }
    }

    pub fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, McpError> {
        self.ensure_initialized()?;
        if !arguments.is_object() {
            return Err(McpError::new(
                McpErrorKind::Protocol,
                "tools/call arguments 必须是 JSON object",
            ));
        }
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    }

    pub fn request_method(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        self.ensure_initialized()?;
        self.request(method, params)
    }

    pub fn notification_method(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        self.ensure_initialized()?;
        self.notification(method, params)
    }

    fn ensure_initialized(&mut self) -> Result<(), McpError> {
        if !self.initialized {
            self.initialize()?;
        }
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let response = self.send(&message, true)?;
        let envelope = select_jsonrpc_response(&response, Some(id))?;
        if let Some(error) = envelope.get("error") {
            return Err(McpError::new(
                McpErrorKind::Protocol,
                format!("MCP {method} 返回错误: {}", compact_json(error)),
            ));
        }
        envelope.get("result").cloned().ok_or_else(|| {
            McpError::new(
                McpErrorKind::InvalidResponse,
                format!("MCP {method} 响应缺少 result"),
            )
        })
    }

    fn notification(&mut self, method: &str, params: Value) -> Result<(), McpError> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send(&message, false).map(|_| ())
    }

    fn send(&mut self, message: &Value, expects_response: bool) -> Result<String, McpError> {
        let url = self.mcp_url()?;
        let payload = serde_json::to_vec(message).map_err(|error| {
            McpError::new(
                McpErrorKind::Protocol,
                format!("编码 MCP 请求失败: {error}"),
            )
        })?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(self.timeout))
            .http_status_as_error(false)
            .build()
            .new_agent();
        let mut request = agent
            .post(url.as_str())
            .header("Authorization", &format!("Bearer {}", self.endpoint.token))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.protocol_version);
        if let Some(session_id) = self.session_id.as_deref() {
            request = request.header("Mcp-Session-Id", session_id);
        }
        let response = request
            .send(payload.as_slice())
            .map_err(classify_transport_error)?;
        let new_session_id = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let status = response.status().as_u16();
        let body = response
            .into_body()
            .with_config()
            .limit(RESPONSE_LIMIT)
            .read_to_string()
            .map_err(|error| {
                McpError::new(
                    McpErrorKind::Indeterminate,
                    format!("读取 MCP 响应失败，执行状态未知: {error}"),
                )
            })?;
        if !(200..300).contains(&status) {
            let kind = if status == 404 && self.session_id.is_some() {
                McpErrorKind::SessionExpired
            } else {
                McpErrorKind::Http
            };
            return Err(McpError::new(
                kind,
                format!("MCP HTTP {status}: {}", compact_text(&body)),
            ));
        }
        if self.session_id.is_none() {
            self.session_id = new_session_id;
        }
        if !expects_response && (body.trim().is_empty() || status == 202 || status == 204) {
            return Ok(String::new());
        }
        Ok(body)
    }

    fn mcp_url(&self) -> Result<url::Url, McpError> {
        let mut url = url::Url::parse(&self.endpoint.base_url).map_err(|error| {
            McpError::new(
                McpErrorKind::Protocol,
                format!("orchestrator base URL 无效: {error}"),
            )
        })?;
        url.set_path("/mcp");
        url.set_query(None);
        if let Some(launch_id) = self.launch_id.as_deref() {
            url.query_pairs_mut().append_pair("launchId", launch_id);
        }
        Ok(url)
    }
}

fn classify_transport_error(error: ureq::Error) -> McpError {
    use std::io::ErrorKind;

    let kind = match &error {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => McpErrorKind::Unreachable,
        ureq::Error::Io(error)
            if matches!(
                error.kind(),
                ErrorKind::ConnectionRefused
                    | ErrorKind::NotConnected
                    | ErrorKind::AddrNotAvailable
            ) =>
        {
            McpErrorKind::Unreachable
        }
        ureq::Error::Io(_) | ureq::Error::Timeout(_) | ureq::Error::Protocol(_) => {
            McpErrorKind::Indeterminate
        }
        _ => McpErrorKind::Http,
    };
    let uncertainty = if kind == McpErrorKind::Indeterminate {
        "，执行状态未知"
    } else {
        ""
    };
    McpError::new(kind, format!("MCP HTTP 请求失败{uncertainty}: {error}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsPage {
    tools: Vec<WireToolDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireToolDefinition {
    name: String,
    #[serde(default)]
    description: Option<String>,
    input_schema: Value,
}

impl From<WireToolDefinition> for ToolDefinition {
    fn from(value: WireToolDefinition) -> Self {
        Self {
            name: value.name,
            description: value.description,
            input_schema: value.input_schema,
        }
    }
}

fn select_jsonrpc_response(body: &str, expected_id: Option<u64>) -> Result<Value, McpError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(McpError::new(
            McpErrorKind::InvalidResponse,
            "MCP 返回空响应",
        ));
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: Value = serde_json::from_str(trimmed).map_err(|error| {
            McpError::new(
                McpErrorKind::InvalidResponse,
                format!("MCP JSON 响应无效: {error}"),
            )
        })?;
        return select_value_by_id(value, expected_id);
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
        let value: Value = serde_json::from_str(&data).map_err(|error| {
            McpError::new(
                McpErrorKind::InvalidResponse,
                format!("MCP SSE data 无效: {error}"),
            )
        })?;
        if response_id_matches(&value, expected_id) {
            return Ok(value);
        }
    }
    Err(McpError::new(
        McpErrorKind::InvalidResponse,
        "MCP SSE 中没有匹配的 JSON-RPC 响应",
    ))
}

fn select_value_by_id(value: Value, expected_id: Option<u64>) -> Result<Value, McpError> {
    if let Some(values) = value.as_array() {
        return values
            .iter()
            .find(|value| response_id_matches(value, expected_id))
            .cloned()
            .ok_or_else(|| {
                McpError::new(
                    McpErrorKind::InvalidResponse,
                    "MCP batch 响应中没有匹配的 JSON-RPC id",
                )
            });
    }
    if response_id_matches(&value, expected_id) {
        Ok(value)
    } else {
        Err(McpError::new(
            McpErrorKind::InvalidResponse,
            "MCP JSON-RPC 响应 id 不匹配",
        ))
    }
}

fn response_id_matches(value: &Value, expected_id: Option<u64>) -> bool {
    expected_id.is_none_or(|id| value.get("id").and_then(Value::as_u64) == Some(id))
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid json>".to_string())
}

fn compact_text(value: &str) -> String {
    const LIMIT: usize = 512;
    let mut text = value.chars().take(LIMIT).collect::<String>();
    if value.chars().count() > LIMIT {
        text.push_str("...");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;

        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 2048];
        let header_end = loop {
            let read = stream.read(&mut chunk).expect("read request");
            assert!(read > 0, "connection closed before headers");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while bytes.len() < header_end + content_length {
            let read = stream.read(&mut chunk).expect("read body");
            assert!(read > 0, "connection closed before body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8(bytes).expect("utf8 request")
    }

    fn write_http_response(
        stream: &mut std::net::TcpStream,
        status: &str,
        body: &str,
        session_id: Option<&str>,
    ) {
        use std::io::Write;

        let session_header = session_id
            .map(|value| format!("Mcp-Session-Id: {value}\r\n"))
            .unwrap_or_default();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{session_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("response");
    }

    #[test]
    fn parses_json_and_sse_responses_by_request_id() {
        let json = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        assert_eq!(
            select_jsonrpc_response(json, Some(7)).unwrap()["result"]["ok"],
            true
        );
        let sse = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{\"ok\":true}}\r\n\r\n";
        assert_eq!(
            select_jsonrpc_response(sse, Some(8)).unwrap()["result"]["ok"],
            true
        );
    }

    #[test]
    fn rejects_mismatched_response_id() {
        let error = select_jsonrpc_response(r#"{"jsonrpc":"2.0","id":9,"result":{}}"#, Some(7))
            .unwrap_err();
        assert_eq!(error.kind, McpErrorKind::InvalidResponse);
    }

    #[test]
    fn mcp_url_preserves_launch_identity_without_token_query() {
        let endpoint = ServiceEndpoint {
            kind: crate::discovery::ServiceKind::Orchestrator,
            base_url: "http://127.0.0.1:47822".to_string(),
            token: "never-log-me".to_string(),
            pid: 1,
            started_at: 2,
            data_dir: std::path::PathBuf::from("/tmp"),
        };
        let client = McpClient::new(endpoint, Some("launch id/1".to_string()));
        let url = client.mcp_url().unwrap();
        assert_eq!(url.path(), "/mcp");
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![("launchId".into(), "launch id/1".into())]
        );
        assert!(!url.as_str().contains("never-log-me"));
    }

    #[test]
    fn client_initializes_and_reuses_downstream_session() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = std::thread::spawn(move || {
            for step in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                let lower = request.to_ascii_lowercase();
                assert!(request.starts_with("POST /mcp?launchId=launch%2F42 HTTP/1.1"));
                assert!(lower.contains("authorization: bearer secret"));
                match step {
                    0 => {
                        assert!(request.contains(r#""method":"initialize""#));
                        assert!(!lower.contains("mcp-session-id:"));
                        write_http_response(
                            &mut stream,
                            "200 OK",
                            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}"#,
                            Some("session-42"),
                        );
                    }
                    1 => {
                        assert!(request.contains(r#""method":"notifications/initialized""#));
                        assert!(lower.contains("mcp-session-id: session-42"));
                        assert!(lower.contains("mcp-protocol-version: 2025-03-26"));
                        write_http_response(&mut stream, "202 Accepted", "", None);
                    }
                    2 => {
                        assert!(request.contains(r#""method":"tools/list""#));
                        assert!(lower.contains("mcp-session-id: session-42"));
                        write_http_response(
                            &mut stream,
                            "200 OK",
                            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"demo","description":"Demo","inputSchema":{"type":"object"}}]}}"#,
                            None,
                        );
                    }
                    3 => {
                        assert!(request.contains(r#""method":"tools/call""#));
                        assert!(request.contains(r#""name":"demo""#));
                        assert!(lower.contains("mcp-session-id: session-42"));
                        write_http_response(
                            &mut stream,
                            "200 OK",
                            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}]}}"#,
                            None,
                        );
                    }
                    _ => unreachable!(),
                }
            }
        });

        let endpoint = ServiceEndpoint {
            kind: crate::discovery::ServiceKind::Orchestrator,
            base_url: format!("http://{addr}"),
            token: "secret".to_string(),
            pid: 1,
            started_at: 2,
            data_dir: std::path::PathBuf::from("/tmp"),
        };
        let mut client = McpClient::new(endpoint, Some("launch/42".to_string()))
            .with_timeout(Duration::from_secs(2));
        let tools = client.list_tools().expect("list tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(client.session_id(), Some("session-42"));
        let result = client.call_tool("demo", json!({})).expect("call tool");
        assert_eq!(result["content"][0]["text"], "ok");
        server.join().expect("server");
    }
}
