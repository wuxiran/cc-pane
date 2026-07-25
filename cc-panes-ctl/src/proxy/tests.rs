use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use tempfile::tempdir;

use super::*;
use crate::discovery::ServiceKind;

fn initialize_message(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "proxy-test-client", "version": "1" }
        }
    })
}

fn endpoint(addr: std::net::SocketAddr, data_dir: &Path) -> ServiceEndpoint {
    ServiceEndpoint {
        kind: ServiceKind::Orchestrator,
        base_url: format!("http://{addr}"),
        token: "proxy-secret".to_string(),
        pid: 7,
        started_at: 11,
        data_dir: data_dir.to_path_buf(),
    }
}

fn read_http_request(stream: &mut TcpStream) -> String {
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

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str, session_id: Option<&str>) {
    let session_header = session_id
        .map(|value| format!("Mcp-Session-Id: {value}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
         {session_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).expect("response");
}

#[test]
fn offline_initialize_uses_persisted_last_known_good_tools() {
    let dir = tempdir().expect("tempdir");
    let cache_path = dir.path().join("runtime").join(CACHE_FILE);
    let tools = json!({
        "tools": [{
            "name": "cached_tool",
            "description": "cached",
            "inputSchema": { "type": "object" }
        }]
    });
    persist_tools_cache(&cache_path, &tools).expect("cache");
    let resolver: EndpointResolver = Arc::new(|| Err("offline".to_string()));
    let mut state = ProxyState::with_resolver(
        dir.path().to_path_buf(),
        Some("launch/offline".to_string()),
        Duration::ZERO,
        resolver,
    );

    let initialized = state.handle_message(initialize_message(1));
    assert_eq!(
        initialized[0]["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    state.handle_message(json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    let listed = state.handle_message(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }));
    assert_eq!(listed[0]["result"]["tools"][0]["name"], "cached_tool");
}

#[test]
fn initialize_without_endpoint_or_cache_returns_bounded_error() {
    let dir = tempdir().expect("tempdir");
    let resolver: EndpointResolver = Arc::new(|| Err("offline".to_string()));
    let mut state =
        ProxyState::with_resolver(dir.path().to_path_buf(), None, Duration::ZERO, resolver);

    let response = state.handle_message(initialize_message(1));
    assert_eq!(response[0]["error"]["code"], -32002);
    assert!(response[0]["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("last-known-good")));
}

#[test]
fn stdio_transport_uses_newline_delimited_jsonrpc() {
    let dir = tempdir().expect("tempdir");
    let cache_path = dir.path().join("runtime").join(CACHE_FILE);
    persist_tools_cache(
        &cache_path,
        &json!({
            "tools": [{
                "name": "cached_tool",
                "inputSchema": { "type": "object" }
            }]
        }),
    )
    .expect("cache");
    let resolver: EndpointResolver = Arc::new(|| Err("offline".to_string()));
    let mut state =
        ProxyState::with_resolver(dir.path().to_path_buf(), None, Duration::ZERO, resolver);
    let input = format!(
        "{}\n{}\n{}\n",
        initialize_message(1),
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        })
    );
    let mut output = Vec::new();

    run_stream(input.as_bytes(), &mut output, &mut state).expect("stdio");

    let lines = String::from_utf8(output)
        .expect("utf8")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("json line"))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[1]["result"]["tools"][0]["name"], "cached_tool");
}

#[test]
fn proxy_terminates_upstream_initialize_and_preserves_launch_id() {
    let dir = tempdir().expect("tempdir");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let requests = Arc::new(AtomicUsize::new(0));
    let server_requests = requests.clone();
    let server = std::thread::spawn(move || {
        for step in 0..4 {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http_request(&mut stream);
            server_requests.fetch_add(1, Ordering::SeqCst);
            assert!(request.starts_with("POST /mcp?launchId=launch%2F42 HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer proxy-secret"));
            match step {
                0 => {
                    assert!(request.contains(r#""method":"initialize""#));
                    assert!(request.contains(r#""name":"proxy-test-client""#));
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}"#,
                        Some("downstream-session"),
                    );
                }
                1 => {
                    assert!(request.contains(r#""method":"notifications/initialized""#));
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("mcp-session-id: downstream-session"));
                    write_http_response(&mut stream, "202 Accepted", "", None);
                }
                2 => {
                    assert!(request.contains(r#""method":"tools/list""#));
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

    let service_endpoint = endpoint(addr, dir.path());
    let resolver: EndpointResolver = Arc::new(move || Ok(service_endpoint.clone()));
    let mut state = ProxyState::with_resolver(
        dir.path().to_path_buf(),
        Some("launch/42".to_string()),
        Duration::from_secs(1),
        resolver,
    );
    let initialized = state.handle_message(initialize_message(91));
    assert_eq!(initialized[0]["id"], 91);
    assert_eq!(state.generation(), 1);
    state.handle_message(json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    let result = state.handle_message(json!({
        "jsonrpc": "2.0",
        "id": "call-1",
        "method": "tools/call",
        "params": { "name": "demo", "arguments": {} }
    }));
    assert_eq!(result[0]["id"], "call-1");
    assert_eq!(result[0]["result"]["content"][0]["text"], "ok");

    server.join().expect("server");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
}

#[test]
fn endpoint_rotation_reinitializes_and_emits_tools_changed() {
    let dir = tempdir().expect("tempdir");
    let first_listener = TcpListener::bind("127.0.0.1:0").expect("first bind");
    let first_addr = first_listener.local_addr().expect("first addr");
    let first_server = std::thread::spawn(move || {
        for step in 0..3 {
            let (mut stream, _) = first_listener.accept().expect("first accept");
            let request = read_http_request(&mut stream);
            match step {
                0 => write_http_response(
                    &mut stream,
                    "200 OK",
                    r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"first","version":"1"}}}"#,
                    Some("first-session"),
                ),
                1 => write_http_response(&mut stream, "202 Accepted", "", None),
                2 => {
                    assert!(request.contains(r#""method":"tools/list""#));
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"first_tool","inputSchema":{"type":"object"}}]}}"#,
                        None,
                    );
                }
                _ => unreachable!(),
            }
        }
    });

    let second_listener = TcpListener::bind("127.0.0.1:0").expect("second bind");
    let second_addr = second_listener.local_addr().expect("second addr");
    let second_server = std::thread::spawn(move || {
        for step in 0..4 {
            let (mut stream, _) = second_listener.accept().expect("second accept");
            let request = read_http_request(&mut stream);
            match step {
                0 => {
                    assert!(request.contains(r#""method":"initialize""#));
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"second","version":"1"}}}"#,
                        Some("second-session"),
                    );
                }
                1 => write_http_response(&mut stream, "202 Accepted", "", None),
                2 => write_http_response(
                    &mut stream,
                    "200 OK",
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"second_tool","inputSchema":{"type":"object"}}]}}"#,
                    None,
                ),
                3 => {
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("mcp-session-id: second-session"));
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"second"}]}}"#,
                        None,
                    );
                }
                _ => unreachable!(),
            }
        }
    });

    let current = Arc::new(std::sync::Mutex::new(endpoint(first_addr, dir.path())));
    let resolver_current = current.clone();
    let resolver: EndpointResolver =
        Arc::new(move || Ok(resolver_current.lock().expect("endpoint lock").clone()));
    let mut state = ProxyState::with_resolver(
        dir.path().to_path_buf(),
        Some("launch/rotation".to_string()),
        Duration::from_secs(1),
        resolver,
    );
    assert!(state.handle_message(initialize_message(1))[0]
        .get("result")
        .is_some());
    state.handle_message(json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    *current.lock().expect("endpoint lock") = ServiceEndpoint {
        pid: 8,
        started_at: 12,
        ..endpoint(second_addr, dir.path())
    };

    let output = state.handle_message(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "second_tool", "arguments": {} }
    }));
    assert_eq!(state.generation(), 2);
    assert_eq!(output.len(), 2);
    assert_eq!(output[0]["method"], "notifications/tools/list_changed");
    assert_eq!(output[1]["result"]["content"][0]["text"], "second");

    first_server.join().expect("first server");
    second_server.join().expect("second server");
}

#[test]
fn indeterminate_side_effect_is_not_replayed() {
    let dir = tempdir().expect("tempdir");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let requests = Arc::new(AtomicUsize::new(0));
    let server_requests = requests.clone();
    let server = std::thread::spawn(move || {
        for step in 0..4 {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http_request(&mut stream);
            server_requests.fetch_add(1, Ordering::SeqCst);
            match step {
                0 => write_http_response(
                    &mut stream,
                    "200 OK",
                    r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}"#,
                    Some("uncertain-session"),
                ),
                1 => write_http_response(&mut stream, "202 Accepted", "", None),
                2 => write_http_response(
                    &mut stream,
                    "200 OK",
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"launch_task","inputSchema":{"type":"object"}}]}}"#,
                    None,
                ),
                3 => {
                    assert!(request.contains(r#""name":"launch_task""#));
                    // 请求已被服务端读取，但在响应前断链，执行状态不可判定。
                    drop(stream);
                }
                _ => unreachable!(),
            }
        }
    });

    let service_endpoint = endpoint(addr, dir.path());
    let resolver: EndpointResolver = Arc::new(move || Ok(service_endpoint.clone()));
    let mut state = ProxyState::with_resolver(
        dir.path().to_path_buf(),
        None,
        Duration::from_secs(1),
        resolver,
    );
    state.handle_message(initialize_message(1));
    state.handle_message(json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    let output = state.handle_message(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "launch_task", "arguments": {} }
    }));
    let message = output[0]["error"]["message"]
        .as_str()
        .expect("error message");
    assert!(message.contains("结果不确定"));
    assert!(message.contains("禁止自动重放"));

    server.join().expect("server");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
}

#[test]
fn stale_downstream_session_404_rehandshakes_and_retries_once() {
    let dir = tempdir().expect("tempdir");
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let call_requests = Arc::new(AtomicUsize::new(0));
    let server_calls = call_requests.clone();
    let server = std::thread::spawn(move || {
        for step in 0..8 {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http_request(&mut stream);
            match step {
                0 | 4 => {
                    let session = if step == 0 {
                        "expired-session"
                    } else {
                        "fresh-session"
                    };
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}"#,
                        Some(session),
                    );
                }
                1 | 5 => write_http_response(&mut stream, "202 Accepted", "", None),
                2 | 6 => write_http_response(
                    &mut stream,
                    "200 OK",
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"submit_to_session","inputSchema":{"type":"object"}}]}}"#,
                    None,
                ),
                3 => {
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("mcp-session-id: expired-session"));
                    server_calls.fetch_add(1, Ordering::SeqCst);
                    write_http_response(
                        &mut stream,
                        "404 Not Found",
                        r#"{"error":"session not found"}"#,
                        None,
                    );
                }
                7 => {
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("mcp-session-id: fresh-session"));
                    server_calls.fetch_add(1, Ordering::SeqCst);
                    write_http_response(
                        &mut stream,
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"retried"}]}}"#,
                        None,
                    );
                }
                _ => unreachable!(),
            }
        }
    });

    let service_endpoint = endpoint(addr, dir.path());
    let resolver: EndpointResolver = Arc::new(move || Ok(service_endpoint.clone()));
    let mut state = ProxyState::with_resolver(
        dir.path().to_path_buf(),
        None,
        Duration::from_secs(1),
        resolver,
    );
    state.handle_message(initialize_message(1));
    state.handle_message(json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    }));
    let output = state.handle_message(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "submit_to_session", "arguments": {} }
    }));
    assert_eq!(output[0]["result"]["content"][0]["text"], "retried");
    assert_eq!(state.generation(), 2);

    server.join().expect("server");
    assert_eq!(call_requests.load(Ordering::SeqCst), 2);
}
