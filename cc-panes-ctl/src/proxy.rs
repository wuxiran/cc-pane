use std::fmt;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::discovery::{discover_orchestrator_endpoint, ServiceEndpoint};
use crate::mcp::{McpClient, McpError};

const CACHE_VERSION: u32 = 1;
const CACHE_FILE: &str = "cc-panes-ctl-tools.json";
const DOWNSTREAM_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_STARTUP_WAIT: Duration = Duration::from_secs(3);

type EndpointResolver = Arc<dyn Fn() -> Result<ServiceEndpoint, String> + Send + Sync + 'static>;

#[derive(Debug)]
pub struct ProxyError(String);

impl ProxyError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ProxyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProxyError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsCache {
    version: u32,
    saved_at_ms: u64,
    tools_result: Value,
}

pub struct ProxyState {
    resolver: EndpointResolver,
    launch_id: Option<String>,
    cache_path: PathBuf,
    cached_tools: Option<Value>,
    initialize_params: Option<Value>,
    upstream_protocol: Option<String>,
    upstream_initialized: bool,
    client: Option<McpClient>,
    active_endpoint: Option<ServiceEndpoint>,
    generation: u64,
    pending_list_changed: bool,
    startup_wait: Duration,
}

impl ProxyState {
    pub fn for_data_dir(
        data_dir: PathBuf,
        launch_id: Option<String>,
        startup_wait: Duration,
    ) -> Self {
        let discover_dir = data_dir.clone();
        let resolver = Arc::new(move || {
            discover_orchestrator_endpoint(&discover_dir).map_err(|error| error.to_string())
        });
        Self::with_resolver(data_dir, launch_id, startup_wait, resolver)
    }

    fn with_resolver(
        data_dir: PathBuf,
        launch_id: Option<String>,
        startup_wait: Duration,
        resolver: EndpointResolver,
    ) -> Self {
        let cache_path = data_dir.join("runtime").join(CACHE_FILE);
        let cached_tools = load_tools_cache(&cache_path);
        Self {
            resolver,
            launch_id,
            cache_path,
            cached_tools,
            initialize_params: None,
            upstream_protocol: None,
            upstream_initialized: false,
            client: None,
            active_endpoint: None,
            generation: 0,
            pending_list_changed: false,
            startup_wait,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn handle_message(&mut self, message: Value) -> Vec<Value> {
        let Some(object) = message.as_object() else {
            return vec![jsonrpc_error(
                Value::Null,
                -32600,
                "JSON-RPC 消息必须是 object",
            )];
        };
        let id = object.get("id").cloned();
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return id
                .map(|id| jsonrpc_error(id, -32600, "JSON-RPC 请求缺少 method"))
                .into_iter()
                .collect();
        };
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));

        if id.is_none() {
            self.handle_notification(method, params);
            return Vec::new();
        }
        let id = id.unwrap_or(Value::Null);
        let response = match method {
            "initialize" => self.handle_initialize(id.clone(), params),
            "ping" => jsonrpc_result(id.clone(), json!({})),
            _ if self.initialize_params.is_none() => {
                jsonrpc_error(id.clone(), -32002, "mcp-proxy 尚未完成 initialize")
            }
            "tools/list" => self.handle_tools_list(id.clone()),
            "tools/call" => self.handle_downstream_request(id.clone(), method, params, true),
            _ => self.handle_downstream_request(id.clone(), method, params, false),
        };

        let mut output = Vec::new();
        if self.pending_list_changed && self.upstream_initialized {
            self.pending_list_changed = false;
            output.push(json!({
                "jsonrpc": "2.0",
                "method": "notifications/tools/list_changed",
                "params": {}
            }));
            eprintln!(
                "cc-panes-ctl mcp-proxy: 工具目录已变化；若当前客户端不支持 \
                 notifications/tools/list_changed，请重启该 CLI 会话"
            );
        }
        output.push(response);
        output
    }

    fn handle_initialize(&mut self, id: Value, params: Value) -> Value {
        if !params.is_object() {
            return jsonrpc_error(id, -32602, "initialize params 必须是 object");
        }
        let Some(protocol) = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return jsonrpc_error(id, -32602, "initialize params 缺少 protocolVersion");
        };
        self.initialize_params = Some(params);
        self.upstream_protocol = Some(protocol);
        self.upstream_initialized = false;
        self.pending_list_changed = false;
        self.reset_downstream();

        if let Err(error) = self.connect_for_initialize() {
            if self.cached_tools.is_none() {
                return jsonrpc_error(
                    id,
                    -32002,
                    &format!(
                        "orchestrator 不可达，且 {wait_ms}ms 内没有可用的 last-known-good \
                         tools 缓存: {error}",
                        wait_ms = self.startup_wait.as_millis()
                    ),
                );
            }
            eprintln!(
                "cc-panes-ctl mcp-proxy: orchestrator 暂不可达，initialize 使用 \
                 last-known-good tools 缓存: {error}"
            );
        }

        jsonrpc_result(
            id,
            json!({
                "protocolVersion": self.upstream_protocol,
                "capabilities": {
                    "tools": { "listChanged": true }
                },
                "serverInfo": {
                    "name": "cc-panes-ctl-mcp-proxy",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
    }

    fn handle_notification(&mut self, method: &str, params: Value) {
        if method == "notifications/initialized" {
            self.upstream_initialized = true;
            return;
        }
        if self.initialize_params.is_none() {
            return;
        }
        if let Err(error) = self.forward_notification(method, params) {
            eprintln!("cc-panes-ctl mcp-proxy: 转发通知 {method} 失败: {error}");
        }
    }

    fn handle_tools_list(&mut self, id: Value) -> Value {
        match self.refresh_tools_with_reconnect() {
            Ok(()) => {}
            Err(error) if self.cached_tools.is_some() => {
                eprintln!("cc-panes-ctl mcp-proxy: tools/list 使用 last-known-good 缓存: {error}");
            }
            Err(error) => {
                return jsonrpc_error(
                    id,
                    -32002,
                    &format!("orchestrator 不可达且无 tools 缓存: {error}"),
                );
            }
        }
        jsonrpc_result(
            id,
            self.cached_tools
                .clone()
                .unwrap_or_else(|| json!({ "tools": [] })),
        )
    }

    fn handle_downstream_request(
        &mut self,
        id: Value,
        method: &str,
        params: Value,
        side_effecting: bool,
    ) -> Value {
        match self.forward_request(method, params, side_effecting) {
            Ok(result) => jsonrpc_result(id, result),
            Err(error) => jsonrpc_error(id, -32001, &error),
        }
    }

    fn connect_for_initialize(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + self.startup_wait;
        loop {
            match self.ensure_connected() {
                Ok(()) => return Ok(()),
                Err(error) if self.cached_tools.is_some() => return Err(error),
                Err(error) if Instant::now() >= deadline => return Err(error),
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }

    fn ensure_connected(&mut self) -> Result<(), String> {
        let endpoint = match (self.resolver)() {
            Ok(endpoint) => endpoint,
            Err(_) if self.client.is_some() => return Ok(()),
            Err(error) => return Err(error),
        };
        if self.active_endpoint.as_ref() == Some(&endpoint) && self.client.is_some() {
            return Ok(());
        }
        self.connect_endpoint(endpoint)
    }

    fn connect_endpoint(&mut self, endpoint: ServiceEndpoint) -> Result<(), String> {
        let initialize_params = self
            .initialize_params
            .clone()
            .ok_or_else(|| "缺少上游 initialize 参数".to_string())?;
        let mut client = McpClient::new(endpoint.clone(), self.launch_id.clone())
            .with_timeout(DOWNSTREAM_TIMEOUT);
        client
            .initialize_with(initialize_params)
            .map_err(|error| format!("下游 initialize 失败: {error}"))?;
        let tools = client
            .list_tools_value()
            .map_err(|error| format!("下游 tools/list 失败: {error}"))?;

        self.generation += 1;
        self.client = Some(client);
        self.active_endpoint = Some(endpoint);
        self.install_tools(tools);
        Ok(())
    }

    fn refresh_tools_with_reconnect(&mut self) -> Result<(), String> {
        self.ensure_connected()?;
        let first = self
            .client
            .as_mut()
            .ok_or_else(|| "下游 MCP client 未建立".to_string())?
            .list_tools_value();
        match first {
            Ok(tools) => {
                self.install_tools(tools);
                Ok(())
            }
            Err(error) if error.retryable_before_execution() => {
                self.reset_downstream();
                self.ensure_connected()?;
                let tools = self
                    .client
                    .as_mut()
                    .ok_or_else(|| "下游 MCP client 未建立".to_string())?
                    .list_tools_value()
                    .map_err(|error| format!("重连后 tools/list 失败: {error}"))?;
                self.install_tools(tools);
                Ok(())
            }
            Err(error) => {
                if error.execution_uncertain() {
                    self.reset_downstream();
                }
                Err(error.to_string())
            }
        }
    }

    fn forward_request(
        &mut self,
        method: &str,
        params: Value,
        side_effecting: bool,
    ) -> Result<Value, String> {
        self.ensure_connected()?;
        let first = self
            .client
            .as_mut()
            .ok_or_else(|| "下游 MCP client 未建立".to_string())?
            .request_method(method, params.clone());
        match first {
            Ok(result) => Ok(result),
            Err(error) if error.retryable_before_execution() => {
                self.reset_downstream();
                self.ensure_connected()?;
                let retry = self
                    .client
                    .as_mut()
                    .ok_or_else(|| "下游 MCP client 未建立".to_string())?
                    .request_method(method, params);
                match retry {
                    Ok(result) => Ok(result),
                    Err(retry_error) => {
                        if retry_error.execution_uncertain() {
                            self.reset_downstream();
                        }
                        Err(self.request_error_message(method, retry_error, side_effecting))
                    }
                }
            }
            Err(error) => {
                if error.execution_uncertain() {
                    self.reset_downstream();
                }
                Err(self.request_error_message(method, error, side_effecting))
            }
        }
    }

    fn forward_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.ensure_connected()?;
        let first = self
            .client
            .as_mut()
            .ok_or_else(|| "下游 MCP client 未建立".to_string())?
            .notification_method(method, params.clone());
        match first {
            Ok(()) => Ok(()),
            Err(error) if error.retryable_before_execution() => {
                self.reset_downstream();
                self.ensure_connected()?;
                self.client
                    .as_mut()
                    .ok_or_else(|| "下游 MCP client 未建立".to_string())?
                    .notification_method(method, params)
                    .map_err(|error| error.to_string())
            }
            Err(error) => {
                if error.execution_uncertain() {
                    self.reset_downstream();
                }
                Err(error.to_string())
            }
        }
    }

    fn request_error_message(&self, method: &str, error: McpError, side_effecting: bool) -> String {
        if error.execution_uncertain() {
            let replay = if side_effecting {
                "该请求可能有副作用，为保证 at-most-once 已禁止自动重放"
            } else {
                "代理未自动重放"
            };
            format!("{method} 结果不确定: {error}；{replay}")
        } else {
            format!("{method} 下游调用失败: {error}")
        }
    }

    fn install_tools(&mut self, tools: Value) {
        let had_cache = self.cached_tools.is_some();
        let changed = self
            .cached_tools
            .as_ref()
            .is_some_and(|previous| previous != &tools);
        self.cached_tools = Some(tools.clone());
        if changed && self.upstream_initialized {
            self.pending_list_changed = true;
        }
        if !had_cache || changed {
            if let Err(error) = persist_tools_cache(&self.cache_path, &tools) {
                eprintln!("cc-panes-ctl mcp-proxy: 写 tools 缓存失败: {error}");
            }
        }
    }

    fn reset_downstream(&mut self) {
        self.client = None;
        self.active_endpoint = None;
    }
}

pub fn run_stdio(
    data_dir: PathBuf,
    launch_id: Option<String>,
    startup_wait: Duration,
) -> Result<(), ProxyError> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut state = ProxyState::for_data_dir(data_dir, launch_id, startup_wait);
    run_stream(stdin.lock(), stdout.lock(), &mut state)
}

fn run_stream<R: BufRead, W: Write>(
    input: R,
    mut output: W,
    state: &mut ProxyState,
) -> Result<(), ProxyError> {
    for line in input.lines() {
        let line = line.map_err(|error| ProxyError::new(format!("读取 stdin 失败: {error}")))?;
        if line.trim().is_empty() {
            continue;
        }
        let messages = match serde_json::from_str::<Value>(&line) {
            Ok(message) => state.handle_message(message),
            Err(error) => vec![jsonrpc_error(
                Value::Null,
                -32700,
                &format!("JSON 解析失败: {error}"),
            )],
        };
        for message in messages {
            serde_json::to_writer(&mut output, &message)
                .map_err(|error| ProxyError::new(format!("编码 stdout 响应失败: {error}")))?;
            output
                .write_all(b"\n")
                .map_err(|error| ProxyError::new(format!("写 stdout 失败: {error}")))?;
        }
        output
            .flush()
            .map_err(|error| ProxyError::new(format!("刷新 stdout 失败: {error}")))?;
    }
    Ok(())
}

fn load_tools_cache(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    let cache: ToolsCache = serde_json::from_str(&content).ok()?;
    (cache.version == CACHE_VERSION && cache.tools_result.get("tools").is_some_and(Value::is_array))
        .then_some(cache.tools_result)
}

fn persist_tools_cache(path: &Path, tools: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("tools 缓存路径无父目录: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 {} 失败: {error}", parent.display()))?;
    let cache = ToolsCache {
        version: CACHE_VERSION,
        saved_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        tools_result: tools.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&cache)
        .map_err(|error| format!("序列化 tools 缓存失败: {error}"))?;
    let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&temp_path)
        .map_err(|error| format!("创建 {} 失败: {error}", temp_path.display()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入 {} 失败: {error}", temp_path.display()))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("替换 {} 前删除旧缓存失败: {error}", path.display()))?;
    }
    fs::rename(&temp_path, path)
        .map_err(|error| format!("提交 tools 缓存 {} 失败: {error}", path.display()))
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

#[cfg(test)]
mod tests;
