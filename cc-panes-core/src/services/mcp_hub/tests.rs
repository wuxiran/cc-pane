//! hub 服务端到端测试：手写一个最小 Streamable HTTP MCP 后端（JSON 响应 + Mcp-Session-Id），
//! 用 `transport=http` 的远程共享服务器接入（远程服务器不起进程，启用即算运行）。

use super::*;
use crate::models::shared_mcp::{BridgeMode, SharedMcpRemote, SharedMcpServerConfig};
use crate::utils::AppPaths;
use serde_json::json;
use std::sync::Mutex as StdMutex;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct MockState {
    tools: Vec<&'static str>,
    list_calls: usize,
    called: Vec<String>,
    sessions_issued: usize,
}

type Shared = Arc<StdMutex<MockState>>;

async fn spawn_mock(tools: Vec<&'static str>) -> (String, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let state: Shared = Arc::new(StdMutex::new(MockState {
        tools,
        ..Default::default()
    }));
    let accept_state = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let state = accept_state.clone();
            tokio::spawn(async move {
                // 每个连接可能承载多个 keep-alive 请求
                while let Some(body) = read_request(&mut socket).await {
                    let (status, payload, session) = respond(&state, &body);
                    let mut head = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                        payload.len()
                    );
                    if let Some(session) = session {
                        head.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
                    }
                    head.push_str("\r\n");
                    if socket.write_all(head.as_bytes()).await.is_err()
                        || socket.write_all(payload.as_bytes()).await.is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    (url, state)
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(String::from_utf8_lossy(&buf[header_end..header_end + length]).into_owned())
}

fn respond(state: &Shared, body: &str) -> (&'static str, String, Option<String>) {
    let message: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let mut state = state.lock().unwrap();
    let result = match method {
        "initialize" => {
            state.sessions_issued += 1;
            let session = format!("s{}", state.sessions_issued);
            let payload = json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "mock", "version": "1"}}});
            return ("200 OK", payload.to_string(), Some(session));
        }
        "notifications/initialized" => return ("202 Accepted", String::new(), None),
        "tools/list" => {
            state.list_calls += 1;
            let tools: Vec<Value> = state
                .tools
                .iter()
                .map(|name| json!({"name": name, "description": format!("Does {name}. More."), "inputSchema": {"type": "object"}}))
                .collect();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("").to_string();
            state.called.push(name.clone());
            json!({ "content": [{ "type": "text", "text": format!("ran {name}") }] })
        }
        _ => json!({}),
    };
    let payload = json!({"jsonrpc": "2.0", "id": id, "result": result});
    ("200 OK", payload.to_string(), None)
}

fn remote_server(url: &str, header: &str) -> SharedMcpServerConfig {
    SharedMcpServerConfig {
        command: String::new(),
        args: vec![],
        env: HashMap::new(),
        shared: true,
        port: 0,
        bridge_mode: BridgeMode::NativeHttp,
        remote: Some(SharedMcpRemote {
            url: url.to_string(),
            transport: "http".into(),
            headers: HashMap::from([("X-Test".to_string(), header.to_string())]),
        }),
    }
}

fn hub_with(
    servers: &[(&str, SharedMcpServerConfig)],
) -> (TempDir, Arc<SharedMcpService>, McpHubService) {
    let dir = TempDir::new().unwrap();
    let paths = AppPaths::new(Some(dir.path().to_string_lossy().to_string()));
    let shared = Arc::new(SharedMcpService::new(&paths));
    for (name, server) in servers {
        shared.upsert_server(name, server.clone()).unwrap();
    }
    let hub = McpHubService::new(shared.clone());
    (dir, shared, hub)
}

#[tokio::test]
async fn search_lists_tools_across_servers_and_caches_them() {
    let (url_a, state_a) = spawn_mock(vec!["take_screenshot", "navigate_page"]).await;
    let (url_b, _state_b) = spawn_mock(vec!["create_issue"]).await;
    let (_dir, _shared, hub) = hub_with(&[
        ("browser", remote_server(&url_a, "1")),
        ("github", remote_server(&url_b, "1")),
    ]);

    let found = hub.search("screenshot", None, None).await;
    assert_eq!(found.tools.len(), 1);
    assert_eq!(found.tools[0].server, "browser");
    assert_eq!(found.tools[0].summary, "Does take_screenshot.");
    assert!(found.unavailable.is_empty());

    let all = hub.search("", None, None).await;
    assert_eq!(all.tools.len(), 3);
    // 第二次检索命中缓存，不再 tools/list
    assert_eq!(state_a.lock().unwrap().list_calls, 1);
}

#[tokio::test]
async fn servers_query_restricts_visibility() {
    let (url_a, _) = spawn_mock(vec!["a_tool"]).await;
    let (url_b, _) = spawn_mock(vec!["b_tool"]).await;
    let (_dir, _shared, hub) = hub_with(&[
        ("a", remote_server(&url_a, "1")),
        ("b", remote_server(&url_b, "1")),
    ]);
    let only_a = vec!["a".to_string()];

    let found = hub.search("", None, Some(&only_a)).await;
    assert_eq!(found.tools.len(), 1);
    assert_eq!(found.tools[0].server, "a");
    let refused = hub.call("b", "b_tool", json!({}), Some(&only_a)).await;
    assert!(refused.unwrap_err().contains("未对本会话开放"));
}

#[tokio::test]
async fn tool_missing_from_cache_still_goes_to_its_server() {
    let (url, state) = spawn_mock(vec!["old_tool"]).await;
    let (_dir, _shared, hub) = hub_with(&[("srv", remote_server(&url, "1"))]);
    hub.search("", None, None).await;

    // 服务器现在不再列出 old_tool，换成 new_tool；缓存里仍是旧清单
    state.lock().unwrap().tools = vec!["new_tool"];
    let result = hub
        .call("srv", "new_tool", json!({"x": 1}), None)
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "ran new_tool");
    assert_eq!(state.lock().unwrap().called, vec!["new_tool"]);

    // 转发了缓存外的工具 → 缓存过期，下次检索重拉到新清单
    let found = hub.search("", None, None).await;
    assert_eq!(found.tools[0].tool, "new_tool");
    assert_eq!(state.lock().unwrap().list_calls, 2);
}

#[tokio::test]
async fn unknown_or_stopped_server_is_refused() {
    let (url, _) = spawn_mock(vec!["t"]).await;
    let mut off = remote_server(&url, "1");
    off.shared = false;
    let (_dir, _shared, hub) = hub_with(&[("off", off)]);
    assert!(hub.call("off", "t", json!({}), None).await.is_err());
    assert!(hub.call("nope", "t", json!({}), None).await.is_err());
    assert!(hub.search("", None, None).await.tools.is_empty());
}

#[tokio::test]
async fn reconfigured_server_drops_cache_and_session() {
    let (url, state) = spawn_mock(vec!["t"]).await;
    let (_dir, shared, hub) = hub_with(&[("srv", remote_server(&url, "1"))]);
    hub.search("", None, None).await;
    assert_eq!(state.lock().unwrap().sessions_issued, 1);

    // 请求头变了 → 指纹变 → 重新握手、重拉清单
    shared
        .upsert_server("srv", remote_server(&url, "2"))
        .unwrap();
    hub.search("", None, None).await;
    let state = state.lock().unwrap();
    assert_eq!(state.sessions_issued, 2);
    assert_eq!(state.list_calls, 2);
}

#[tokio::test]
async fn unreachable_server_is_reported_not_hidden() {
    // 绑定后立即释放：端口上没人监听
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let (_dir, _shared, hub) = hub_with(&[("dead", remote_server(&url, "1"))]);
    let found = hub.search("", None, None).await;
    assert!(found.tools.is_empty());
    assert_eq!(found.unavailable.len(), 1);
    assert_eq!(found.unavailable[0].server, "dead");
}

#[test]
fn hub_tools_json_is_two_short_tools() {
    let tools: Vec<Value> = serde_json::from_str(HUB_TOOLS_JSON).unwrap();
    let names: Vec<_> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["search_tools", "call_tool"]);
    // 描述常驻上下文：整份定义压在 1KB 内
    assert!(
        tools_payload_bytes(&tools) < 1024,
        "{}",
        tools_payload_bytes(&tools)
    );
}
