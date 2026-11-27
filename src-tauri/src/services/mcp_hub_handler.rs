//! `ccpanes-hub` 的 MCP 面（orchestrator 上的 `/mcp-hub`，docs/113）。
//!
//! 只暴露 `search_tools` / `call_tool`；检索、缓存、转发都在 core 的 `McpHubService`。
//! 实验开关 `experimental.mcpHub` 关着时：不列工具、调用直接报错、不碰任何后端。
//! 会话可见的服务器由注入 URL 上的 `servers=` 限定（与启动档的筛选结果一致）。

use cc_panes_core::services::mcp_hub::{servers_from_query, McpHubService, HUB_TOOLS_JSON};
use cc_panes_core::services::SettingsService;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ErrorData, Extensions, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler};
use serde_json::Value;
use std::sync::{Arc, OnceLock};

#[derive(Clone)]
pub struct McpHubHandler {
    hub: Arc<McpHubService>,
    settings: Arc<SettingsService>,
}

impl McpHubHandler {
    pub fn new(hub: Arc<McpHubService>, settings: Arc<SettingsService>) -> Self {
        Self { hub, settings }
    }

    fn enabled(&self) -> bool {
        self.settings.get_settings().experimental.mcp_hub
    }
}

fn hub_tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| serde_json::from_str(HUB_TOOLS_JSON).unwrap_or_default())
}

fn allowed_servers(extensions: &Extensions) -> Option<Vec<String>> {
    let parts = extensions.get::<axum::http::request::Parts>()?;
    servers_from_query(parts.uri.query())
}

fn text_result(text: String, is_error: bool) -> CallToolResult {
    if is_error {
        CallToolResult::error(vec![Content::text(text)])
    } else {
        CallToolResult::success(vec![Content::text(text)])
    }
}

fn arg_str<'a>(args: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// `arguments` 允许是对象，或装着对象的字符串（部分模型会把 JSON 序列化一次再传）。
fn call_arguments(raw: Option<&Value>) -> Result<Value, String> {
    match raw {
        None | Some(Value::Null) => Ok(Value::Object(Default::default())),
        Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => Ok(Value::Object(map)),
            _ => Err("arguments 必须是 JSON 对象".to_string()),
        },
        Some(_) => Err("arguments 必须是 JSON 对象".to_string()),
    }
}

impl McpHubHandler {
    async fn search_tools(
        &self,
        args: &serde_json::Map<String, Value>,
        allowed: Option<&[String]>,
    ) -> CallToolResult {
        let query = arg_str(args, "query").unwrap_or_default();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let result = self.hub.search(query, limit, allowed).await;
        let mut payload = serde_json::to_value(&result).unwrap_or(Value::Null);
        if result.tools.is_empty() {
            payload["hint"] = Value::String(
                "No match. Try other keywords, or an empty query to list all.".to_string(),
            );
        }
        text_result(payload.to_string(), false)
    }

    async fn call_backend(
        &self,
        args: &serde_json::Map<String, Value>,
        allowed: Option<&[String]>,
    ) -> CallToolResult {
        let (Some(server), Some(tool)) = (arg_str(args, "server"), arg_str(args, "tool")) else {
            return text_result("call_tool 需要 server 和 tool".to_string(), true);
        };
        let arguments = match call_arguments(args.get("arguments")) {
            Ok(arguments) => arguments,
            Err(error) => return text_result(error, true),
        };
        match self.hub.call(server, tool, arguments, allowed).await {
            // 后端结果原样回传（content / structuredContent / isError）
            Ok(value) => serde_json::from_value::<CallToolResult>(value.clone())
                .unwrap_or_else(|_| text_result(value.to_string(), false)),
            Err(error) => text_result(error, true),
        }
    }
}

impl ServerHandler for McpHubHandler {
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.enabled() {
            return Ok(text_result(
                "ccpanes-hub 未启用（设置 → 实验功能）".to_string(),
                true,
            ));
        }
        let allowed = allowed_servers(&context.extensions);
        let args = request.arguments.unwrap_or_default();
        let result = match request.name.as_ref() {
            "search_tools" => self.search_tools(&args, allowed.as_deref()).await,
            "call_tool" => self.call_backend(&args, allowed.as_deref()).await,
            other => {
                return Err(ErrorData::invalid_params(
                    format!("unknown tool: {other}"),
                    None,
                ))
            }
        };
        Ok(result)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = if self.enabled() {
            hub_tools().to_vec()
        } else {
            Vec::new()
        };
        Ok(ListToolsResult {
            tools,
            meta: None,
            next_cursor: None,
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        hub_tools().iter().find(|tool| tool.name == name).cloned()
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Shared MCP servers' tools: search_tools first, then call_tool(server, tool, arguments).",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hub_tools_parse_into_rmcp_tools() {
        let names: Vec<_> = hub_tools().iter().map(|t| t.name.to_string()).collect();
        assert_eq!(names, vec!["search_tools", "call_tool"]);
    }

    #[test]
    fn call_arguments_accept_object_string_or_missing() {
        assert_eq!(call_arguments(None).unwrap(), json!({}));
        assert_eq!(
            call_arguments(Some(&json!({"a": 1}))).unwrap(),
            json!({"a": 1})
        );
        assert_eq!(
            call_arguments(Some(&json!("{\"a\":1}"))).unwrap(),
            json!({"a": 1})
        );
        assert!(call_arguments(Some(&json!([1]))).is_err());
        assert!(call_arguments(Some(&json!("not json"))).is_err());
    }
}
