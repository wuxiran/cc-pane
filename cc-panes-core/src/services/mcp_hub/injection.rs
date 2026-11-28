//! 启动时「只注入 hub」的改写：把本次会话本该逐个注入的共享 MCP 换成一条 `ccpanes-hub`。
//!
//! 纯函数，调用方（`terminal_service` 本地分支）负责判定开关是否生效。
//! hub 只能转发 Streamable HTTP：本地桥（mcp-proxy / native http）和 `transport=http`
//! 的远程 MCP 进 hub；`sse` 远程 MCP 留在原表里照旧直连注入。

use crate::models::shared_mcp::{SharedMcpConfig, SharedMcpServerConfig};
use std::collections::HashMap;

/// 注入给 CLI 的条目名。
pub const HUB_SERVER_NAME: &str = "ccpanes-hub";
/// orchestrator 上的路由。以 `/mcp` 开头，复用同一套 Bearer / `?token=` 鉴权。
pub const HUB_PATH: &str = "/mcp-hub";
/// URL 上限定本会话可见服务器的参数名。
pub const HUB_SERVERS_QUERY: &str = "servers";

/// hub 能否代转这台服务器。
pub fn hub_can_route(server: &SharedMcpServerConfig) -> bool {
    server
        .remote
        .as_ref()
        .is_none_or(|remote| remote.transport.eq_ignore_ascii_case("http"))
}

/// 本会话的 hub URL：token 走 query（与 ccpanes 注入一致，Claude 某些版本忽略 headers），
/// `servers` 是逗号分隔、逐项 URL 编码的服务器名。
pub fn hub_url(port: u16, token: &str, servers: &[String]) -> String {
    let encoded = servers
        .iter()
        .map(|name| urlencoding::encode(name).into_owned())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "http://127.0.0.1:{port}{HUB_PATH}?token={}&{HUB_SERVERS_QUERY}={encoded}",
        urlencoding::encode(token)
    )
}

/// 从 hub 请求的 query 里取回 `servers`。缺参数 = `None`（不限制，所有已启用的都可见）。
pub fn servers_from_query(query: Option<&str>) -> Option<Vec<String>> {
    let query = query?;
    let raw = query.split('&').find_map(|pair| {
        pair.strip_prefix(HUB_SERVERS_QUERY)
            .and_then(|rest| rest.strip_prefix('='))
    })?;
    Some(
        raw.split(',')
            .filter(|part| !part.is_empty())
            .filter_map(|part| urlencoding::decode(part).ok().map(|s| s.into_owned()))
            .collect(),
    )
}

/// 改写结果。`covered` 为空表示没有可进 hub 的服务器，调用方应保持原样。
#[derive(Debug, Clone, PartialEq)]
pub struct HubInjection {
    pub urls: HashMap<String, String>,
    pub covered: Vec<String>,
}

/// 把 `urls` 里 hub 能代转的服务器收进一条 `ccpanes-hub`。
/// 用户自己把某台共享服务器命名成 `ccpanes-hub` 时放弃改写，避免顶掉它。
pub fn apply_hub_injection(
    urls: &HashMap<String, String>,
    config: &SharedMcpConfig,
    port: u16,
    token: &str,
) -> Option<HubInjection> {
    if urls.contains_key(HUB_SERVER_NAME) || config.servers.contains_key(HUB_SERVER_NAME) {
        return None;
    }
    let mut covered: Vec<String> = urls
        .keys()
        .filter(|name| config.servers.get(*name).is_some_and(hub_can_route))
        .cloned()
        .collect();
    if covered.is_empty() {
        return None;
    }
    covered.sort();
    let mut rewritten: HashMap<String, String> = urls
        .iter()
        .filter(|(name, _)| !covered.contains(name))
        .map(|(name, url)| (name.clone(), url.clone()))
        .collect();
    rewritten.insert(HUB_SERVER_NAME.to_string(), hub_url(port, token, &covered));
    Some(HubInjection {
        urls: rewritten,
        covered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::shared_mcp::{BridgeMode, SharedMcpRemote};

    fn local(port: u16) -> SharedMcpServerConfig {
        SharedMcpServerConfig {
            command: "npx".into(),
            args: vec![],
            env: HashMap::new(),
            shared: true,
            port,
            bridge_mode: BridgeMode::McpProxy,
            remote: None,
        }
    }

    fn remote(transport: &str) -> SharedMcpServerConfig {
        SharedMcpServerConfig {
            remote: Some(SharedMcpRemote {
                url: "https://example.com/mcp".into(),
                transport: transport.into(),
                headers: HashMap::new(),
            }),
            ..local(0)
        }
    }

    fn config() -> SharedMcpConfig {
        let mut config = SharedMcpConfig::default();
        config.servers.insert("fetch".into(), local(3100));
        config.servers.insert("chrome devtools".into(), local(3101));
        config.servers.insert("cloud".into(), remote("http"));
        config.servers.insert("legacy".into(), remote("sse"));
        config
    }

    fn urls() -> HashMap<String, String> {
        HashMap::from([
            ("fetch".to_string(), "http://127.0.0.1:3100/mcp".to_string()),
            (
                "chrome devtools".to_string(),
                "http://127.0.0.1:3101/mcp".to_string(),
            ),
            ("cloud".to_string(), "https://example.com/mcp".to_string()),
            ("legacy".to_string(), "https://example.com/sse".to_string()),
        ])
    }

    #[test]
    fn rewrites_routable_servers_into_one_hub_entry_and_keeps_sse() {
        let result = apply_hub_injection(&urls(), &config(), 4567, "tok").unwrap();
        assert_eq!(result.covered, vec!["chrome devtools", "cloud", "fetch"]);
        let mut keys: Vec<_> = result.urls.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["ccpanes-hub", "legacy"]);
        let url = &result.urls["ccpanes-hub"];
        assert!(url.starts_with("http://127.0.0.1:4567/mcp-hub?token=tok&servers="));
        let query = url.split_once('?').map(|(_, q)| q);
        assert_eq!(servers_from_query(query).unwrap(), result.covered);
    }

    #[test]
    fn nothing_routable_means_no_rewrite() {
        let only_sse =
            HashMap::from([("legacy".to_string(), "https://example.com/sse".to_string())]);
        assert!(apply_hub_injection(&only_sse, &config(), 1, "t").is_none());
        assert!(apply_hub_injection(&HashMap::new(), &config(), 1, "t").is_none());
    }

    #[test]
    fn user_server_named_like_the_hub_blocks_rewrite() {
        let mut config = config();
        config.servers.insert(HUB_SERVER_NAME.into(), local(3199));
        assert!(apply_hub_injection(&urls(), &config, 1, "t").is_none());
    }

    #[test]
    fn missing_servers_query_is_unrestricted() {
        assert_eq!(servers_from_query(Some("token=x")), None);
        assert_eq!(servers_from_query(None), None);
        assert_eq!(servers_from_query(Some("servers=")), Some(vec![]));
    }
}
