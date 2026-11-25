//! 两种传输：默认 stdio（每行一条 JSON-RPC，stdout 只走协议）；MODE=http 时 streamable HTTP。

use crate::mcp;
use crate::session::WeChatSession;
use serde_json::Value;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub type Shared = Arc<Mutex<WeChatSession>>;

/// stdio 主循环：逐行读 stdin，分发，响应写 stdout 并 flush。
pub fn run_stdio(session: Shared) {
    log::info!("wechat MCP 服务启动（stdio）");
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("解析请求失败: {e}");
                continue;
            }
        };
        if let Some(resp) = mcp::handle_message(&session, &req) {
            let s = serde_json::to_string(&resp).unwrap_or_default();
            if writeln!(stdout, "{s}").is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    }
    session.lock().unwrap().cleanup();
}

/// HTTP 主循环：只监听 127.0.0.1:port，POST /mcp(/) 返回 application/json。
pub fn run_http(session: Shared, port: u16) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move { serve_http(session, port).await })
}

async fn serve_http(session: Shared, port: u16) -> anyhow::Result<()> {
    use axum::routing::post;
    use axum::Router;

    let app = Router::new()
        .route("/mcp", post(post_mcp).get(get_405).delete(delete_ok))
        .route("/mcp/", post(post_mcp).get(get_405).delete(delete_ok))
        .with_state(session);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    log::info!("wechat MCP 服务启动（streamable-http 127.0.0.1:{port}/mcp）");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn get_405() -> axum::http::StatusCode {
    axum::http::StatusCode::METHOD_NOT_ALLOWED
}

async fn delete_ok() -> axum::http::StatusCode {
    axum::http::StatusCode::OK
}

async fn post_mcp(
    axum::extract::State(session): axum::extract::State<Shared>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid json").into_response(),
    };

    // 工具调用含重活（PBKDF2/解密），放 spawn_blocking，避免阻塞 runtime。
    let result = tokio::task::spawn_blocking(move || mcp::handle_message(&session, &req)).await;
    let resp = match result {
        Ok(r) => r,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "task panicked").into_response(),
    };

    match resp {
        // 通知：无响应体，返回 202。
        None => StatusCode::ACCEPTED.into_response(),
        Some(v) => {
            let is_init = v
                .get("result")
                .and_then(|r| r.get("protocolVersion"))
                .is_some();
            let mut builder = axum::response::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json");
            if is_init {
                // initialize 可带 Mcp-Session-Id（不强制校验）。
                builder = builder.header("Mcp-Session-Id", session_id());
            }
            let text = serde_json::to_string(&v).unwrap_or_default();
            builder
                .body(axum::body::Body::from(text))
                .unwrap()
                .into_response()
        }
    }
}

fn session_id() -> String {
    // 简单稳定的会话 id（进程内固定）。
    use std::sync::OnceLock;
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("ccwx-{}", std::process::id()))
        .clone()
}
