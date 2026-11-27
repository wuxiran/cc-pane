//! 共享 MCP 聚合入口 `ccpanes-hub`（docs/113）。
//!
//! 对 agent 只暴露 `search_tools` / `call_tool` 两个工具，背后是所有已启用、正在运行的
//! 共享 MCP 服务器。启动档 `mcpPolicy.delivery = hub` 时注入给会话；资源库 Hub 卡片读 `status()`。
//!
//! - 工具清单按服务器缓存。缓存键带**指纹**（URL + 请求头 + 本地进程 PID）：服务器重启
//!   PID 变、配置改了 URL 变，都会丢掉旧缓存和旧会话；另有 TTL 兜住「工具变了但没通知」。
//! - `call_tool` 只校验服务器（在运行、对本会话开放），**不校验工具是否在缓存里**：
//!   服务器不再列出的工具仍然转发给它，由服务器自己回答（对齐 magpie 路由的同名规则）。
//!   转发了缓存里没有的工具，会让该服务器的缓存过期，下次检索时重拉。

pub mod client;
pub mod injection;
pub mod search;

use crate::models::shared_mcp::SharedMcpServerStatus;
use crate::services::SharedMcpService;
use client::{BackendClient, ClientError, ClientErrorKind};
use search::{HubTool, HubToolMatch};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

pub use injection::{
    apply_hub_injection, hub_can_route, servers_from_query, HubInjection, HUB_PATH, HUB_SERVER_NAME,
};

/// hub 对外暴露的两个工具定义（`tools/list` 的原样内容，也被对比脚本读取）。
pub const HUB_TOOLS_JSON: &str = include_str!("hub_tools.json");

const TOOLS_TTL: Duration = Duration::from_secs(10 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// 一台可代转的后端。
#[derive(Debug, Clone, PartialEq)]
struct Target {
    name: String,
    url: String,
    headers: BTreeMap<String, String>,
    fingerprint: String,
}

struct ServerEntry {
    client: BackendClient,
    tools: Option<Vec<HubTool>>,
    fetched_at: Option<Instant>,
}

impl ServerEntry {
    fn new(target: &Target) -> Self {
        Self {
            client: BackendClient::new(target.url.clone(), target.headers.clone(), CALL_TIMEOUT),
            tools: None,
            fetched_at: None,
        }
    }

    fn fresh(&self) -> bool {
        self.fetched_at.is_some_and(|at| at.elapsed() < TOOLS_TTL)
    }
}

type SharedEntry = Arc<AsyncMutex<ServerEntry>>;

/// 检索时连不上的服务器（如实告诉模型，而不是静默少一截工具）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UnavailableServer {
    pub server: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HubSearchResult {
    pub tools: Vec<HubToolMatch>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<UnavailableServer>,
}

/// 资源库 Hub 卡片的一行：这台共享服务器在 hub 里的情况（只读缓存，不触发拉取）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubServerStatus {
    pub name: String,
    pub running: bool,
    /// hub 能否代转（`sse` 远程 MCP 不能，照旧直连）。
    pub routable: bool,
    /// 缓存里的工具数；还没被检索过（或服务器换过）时为 `None`。
    pub tool_count: Option<usize>,
}

pub struct McpHubService {
    shared: Arc<SharedMcpService>,
    /// name → (指纹, 条目)。指纹放在条目锁外面，比对时不必等正在拉清单的那把锁。
    entries: AsyncMutex<HashMap<String, (String, SharedEntry)>>,
}

impl McpHubService {
    pub fn new(shared: Arc<SharedMcpService>) -> Self {
        Self {
            shared,
            entries: AsyncMutex::new(HashMap::new()),
        }
    }

    /// 当前可代转的服务器，按 `allowed`（URL 上的 `servers`）过滤。
    fn targets(&self, allowed: Option<&[String]>) -> Vec<Target> {
        let config = self.shared.get_config();
        let mut targets: Vec<Target> = self
            .shared
            .get_all_status()
            .into_iter()
            .filter(|info| info.config.shared && info.status == SharedMcpServerStatus::Running)
            .filter(|info| hub_can_route(&info.config))
            .filter(|info| allowed.is_none_or(|names| names.contains(&info.name)))
            .filter_map(|info| {
                let url = info.url.clone()?;
                let headers: BTreeMap<String, String> = config
                    .servers
                    .get(&info.name)
                    .and_then(|server| server.remote.as_ref())
                    .map(|remote| remote.headers.clone().into_iter().collect())
                    .unwrap_or_default();
                Some(Target {
                    fingerprint: fingerprint(&url, &headers, info.pid),
                    name: info.name,
                    url,
                    headers,
                })
            })
            .collect();
        targets.sort_by(|a, b| a.name.cmp(&b.name));
        targets
    }

    async fn entry_for(&self, target: &Target) -> SharedEntry {
        let mut entries = self.entries.lock().await;
        if let Some((fingerprint, entry)) = entries.get(&target.name) {
            if *fingerprint == target.fingerprint {
                return entry.clone();
            }
            info!(server = %target.name, "[mcp-hub] server changed; dropping cached tools and session");
        }
        let entry = Arc::new(AsyncMutex::new(ServerEntry::new(target)));
        entries.insert(
            target.name.clone(),
            (target.fingerprint.clone(), entry.clone()),
        );
        entry
    }

    async fn tools_of(&self, target: &Target) -> Result<Vec<HubTool>, String> {
        let entry = self.entry_for(target).await;
        let mut entry = entry.lock().await;
        if entry.fresh() {
            return Ok(entry.tools.clone().unwrap_or_default());
        }
        let fetched =
            match tokio::time::timeout(LIST_TIMEOUT, list_with_retry(&mut entry.client)).await {
                Ok(result) => result.map_err(|e| e.message),
                Err(_) => Err(format!(
                    "tools/list 超过 {}s 未返回",
                    LIST_TIMEOUT.as_secs()
                )),
            };
        match fetched {
            Ok(raw) => {
                let tools = parse_tools(&target.name, raw);
                info!(server = %target.name, count = tools.len(), "[mcp-hub] tools cached");
                entry.tools = Some(tools.clone());
                entry.fetched_at = Some(Instant::now());
                Ok(tools)
            }
            // 拉新失败但手里有旧清单：先用旧的，下次再试
            Err(error) => match entry.tools.clone() {
                Some(stale) => {
                    warn!(server = %target.name, %error, "[mcp-hub] refresh failed; serving stale tools");
                    Ok(stale)
                }
                None => Err(error),
            },
        }
    }

    /// 已启用（shared）的共享服务器在 hub 里的情况，按名字排序。
    pub async fn status(&self) -> Vec<HubServerStatus> {
        let routable_now: HashMap<String, Target> = self
            .targets(None)
            .into_iter()
            .map(|target| (target.name.clone(), target))
            .collect();
        let entries = self.entries.lock().await;
        let mut rows = Vec::new();
        for info in self.shared.get_all_status() {
            if !info.config.shared {
                continue;
            }
            let target = routable_now.get(&info.name);
            let mut tool_count = None;
            if let (Some(target), Some((fingerprint, entry))) = (target, entries.get(&info.name)) {
                if *fingerprint == target.fingerprint {
                    tool_count = entry.lock().await.tools.as_ref().map(Vec::len);
                }
            }
            rows.push(HubServerStatus {
                running: info.status == SharedMcpServerStatus::Running,
                routable: hub_can_route(&info.config),
                tool_count,
                name: info.name,
            });
        }
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        rows
    }

    /// `search_tools`。
    pub async fn search(
        &self,
        query: &str,
        limit: Option<usize>,
        allowed: Option<&[String]>,
    ) -> HubSearchResult {
        let targets = self.targets(allowed);
        let lists =
            futures_util::future::join_all(targets.iter().map(|target| self.tools_of(target)))
                .await;
        let mut all = Vec::new();
        let mut unavailable = Vec::new();
        for (target, list) in targets.iter().zip(lists) {
            match list {
                Ok(tools) => all.extend(tools),
                Err(error) => unavailable.push(UnavailableServer {
                    server: target.name.clone(),
                    error,
                }),
            }
        }
        HubSearchResult {
            tools: search::search(&all, query, limit),
            unavailable,
        }
    }

    /// `call_tool`：返回后端的 `CallToolResult` 原样 JSON。
    pub async fn call(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
        allowed: Option<&[String]>,
    ) -> Result<Value, String> {
        let target = self
            .targets(allowed)
            .into_iter()
            .find(|target| target.name == server)
            .ok_or_else(|| format!("MCP 服务器 '{server}' 未运行或未对本会话开放"))?;
        let entry = self.entry_for(&target).await;
        let first = self.call_once(&entry, tool, arguments.clone()).await;
        let result = match first {
            // 404 = 后端忘了会话（多半重启过），请求没进工具执行，重握手后重试一次是安全的
            Err(error) if error.kind == ClientErrorKind::SessionExpired => {
                entry.lock().await.client.reset();
                self.call_once(&entry, tool, arguments).await
            }
            other => other,
        };
        let mut guard = entry.lock().await;
        let known = guard
            .tools
            .as_ref()
            .is_some_and(|tools| tools.iter().any(|t| t.name == tool));
        if !known {
            // 服务器不再列出（或还没拉过）的工具照样转发；清单可能已变，下次检索重拉
            info!(
                server,
                tool, "[mcp-hub] forwarded a tool missing from the cache; marking stale"
            );
            guard.fetched_at = None;
        }
        drop(guard);
        result.map_err(|error| format!("MCP 服务器 '{server}' 调用 {tool} 失败: {}", error.message))
    }

    async fn call_once(
        &self,
        entry: &SharedEntry,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, ClientError> {
        // 只在握手时持锁；调用本身用克隆（共享会话 id），长调用不挡住同服务器的其他调用
        let mut client = {
            let mut guard = entry.lock().await;
            guard.client.ensure_initialized().await?;
            guard.client.clone()
        };
        client.call_tool(tool, arguments).await
    }
}

async fn list_with_retry(client: &mut BackendClient) -> Result<Vec<Value>, ClientError> {
    match client.list_tools().await {
        Err(error)
            if matches!(
                error.kind,
                ClientErrorKind::SessionExpired | ClientErrorKind::Transport
            ) =>
        {
            client.reset();
            client.list_tools().await
        }
        other => other,
    }
}

fn fingerprint(url: &str, headers: &BTreeMap<String, String>, pid: Option<u32>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    for (key, value) in headers {
        hasher.update(b"\0");
        hasher.update(key.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
    }
    hasher.update(format!("\0pid={}", pid.unwrap_or(0)).as_bytes());
    format!("{:x}", hasher.finalize())
}

fn parse_tools(server: &str, raw: Vec<Value>) -> Vec<HubTool> {
    raw.into_iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.to_string();
            Some(HubTool {
                server: server.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input_schema: tool
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
                name,
            })
        })
        .collect()
}

/// `tools/list` 的序列化字节数（对比全量注入 vs 只注入 hub 时用）。
pub fn tools_payload_bytes(tools: &[Value]) -> usize {
    serde_json::to_string(tools).map(|s| s.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests;
