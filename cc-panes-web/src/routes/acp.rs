//! ACP 移动桥的 web 侧：`/api/acp/*` 与 `/ws/acp/{chatId}`（docs/112 §3）。
//!
//! 这里不持有任何 ACP 状态，只做两件事：
//! 1. 鉴权——请求已过 `access_control` + `read_only_guard`（与其他 `/api/*` 同一套
//!    Cookie / 设备令牌策略；远程只读时写操作 403 `READ_ONLY`，设备令牌视同本机主人
//!    不受限，docs/111）；
//! 2. 透传——读 `<data-dir>/mcp-orchestrator.json` 拿 port+token，反向代理到桌面
//!    app 内 orchestrator 的 `/acp/*`。app 不在 → 503 `ACP_HOST_UNAVAILABLE`。
//!
//! 响应体与事件帧原样转发：未知 kind 不解析也不丢弃。请求来源经
//! `x-ccpanes-origin` 告诉上游（`device:<name>` / `mobile`）。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Extension, Path, RawQuery, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

use crate::state::AppState;
use crate::web_auth::{DeviceTokenAuth, RequestOrigin};
use crate::websocket_access::Access;

const HOST_UNAVAILABLE: &str = "ACP_HOST_UNAVAILABLE";
/// 上游（orchestrator `/acp/*`）认的来源头，见 src-tauri `acp_bridge_routes`。
const ORIGIN_HEADER: &str = "x-ccpanes-origin";
/// 新建 chat 要等适配器握手（首启可能经 npx 下载，orchestrator 侧上限 180 s）。
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(240);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// 合法的 `{action}` 段：与 orchestrator `/acp/chats/{id}/{action}` 一一对应。
const CHAT_ACTIONS: &[&str] = &[
    "prompt",
    "cancel",
    "mode",
    "model",
    "config",
    "permission",
    "elicitation",
];

/// orchestrator 端点来源：生产读 manifest；测试可钉死一个地址。
pub struct AcpHost {
    data_dir: Option<PathBuf>,
    fixed: Option<(String, String)>,
    client: reqwest::Client,
}

impl AcpHost {
    fn build(data_dir: Option<PathBuf>, fixed: Option<(String, String)>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(UPSTREAM_TIMEOUT)
            // 只连本机回环，系统代理只会把它带偏。
            .no_proxy()
            .build()
            .unwrap_or_default();
        Self {
            data_dir,
            fixed,
            client,
        }
    }

    pub fn from_data_dir(data_dir: PathBuf) -> Self {
        Self::build(Some(data_dir), None)
    }

    /// 无 orchestrator（测试 / 未知数据目录）：所有请求 503。
    #[cfg(test)]
    pub fn unavailable() -> Self {
        Self::build(None, None)
    }

    /// `base` 形如 `http://127.0.0.1:47821`。
    #[cfg(test)]
    pub fn fixed(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self::build(None, Some((base.into(), token.into())))
    }

    /// 每次请求重读 manifest：app 重启 / 换令牌后 web 不能缓存旧值。
    fn endpoint(&self) -> Option<(String, String)> {
        if let Some(fixed) = &self.fixed {
            return Some(fixed.clone());
        }
        let dir = self.data_dir.as_ref()?;
        let (port, token) = cc_panes_core::utils::orchestrator_manifest::read_active_endpoint(dir)?;
        Some((format!("http://127.0.0.1:{port}"), token))
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({"code": code, "message": message})),
    )
        .into_response()
}

fn host_unavailable(message: &str) -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, HOST_UNAVAILABLE, message)
}

/// chat id / 路径段白名单：杜绝 `..`、编码穿越把代理带到 `/mcp-full` 这类面上。
pub fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 200
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// 只放行 docs/112 §3.3 列出的形状，其余 404。
pub fn is_allowed_path(rest: &str) -> bool {
    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        ["engines"] | ["history"] | ["chats"] => true,
        ["chats", id] => is_safe_segment(id),
        ["chats", id, action] => is_safe_segment(id) && CHAT_ACTIONS.contains(action),
        _ => false,
    }
}

/// 这次请求代表哪一端：设备令牌 → `device:<设备名>`，其余（Cookie 会话 / 本机）→ `mobile`。
pub(crate) fn request_origin(state: &AppState, device: Option<&DeviceTokenAuth>) -> String {
    device
        .and_then(|DeviceTokenAuth(token)| state.web_auth.device_tokens()?.verify(token))
        .map(|record| {
            let name: String = record
                .name
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect();
            if name.trim().is_empty() {
                "device:unknown".to_string()
            } else {
                format!("device:{name}")
            }
        })
        .unwrap_or_else(|| "mobile".to_string())
}

/// 头值一律 URL 编码（设备名可能含中文 / 空格），上游解码后再校验。
fn origin_header_value(origin: &str) -> HeaderValue {
    HeaderValue::from_str(&urlencoding::encode(origin))
        .unwrap_or_else(|_| HeaderValue::from_static("mobile"))
}

/// `ANY /api/acp/{*rest}` → orchestrator `/acp/{rest}`。
pub async fn proxy_rest(
    State(state): State<AppState>,
    method: Method,
    Path(rest): Path<String>,
    RawQuery(query): RawQuery,
    device: Option<Extension<DeviceTokenAuth>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_allowed_path(&rest) {
        return error(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown ACP route");
    }
    let origin = request_origin(&state, device.as_ref().map(|Extension(auth)| auth));
    forward(
        &state,
        method,
        &format!("/acp/{rest}"),
        query,
        &origin,
        &headers,
        body,
    )
    .await
}

/// 把一次请求原样转给 orchestrator（`upstream_path` 以 `/` 开头）。Bot 组网的
/// `/api/bots*`、`/api/contacts*` 也走这里（docs/112 §5）。
pub(crate) async fn forward(
    state: &AppState,
    method: Method,
    upstream_path: &str,
    query: Option<String>,
    origin: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Response {
    let Some((base, token)) = state.acp_host.endpoint() else {
        return host_unavailable("CC-Panes desktop app is not running");
    };
    let mut url = format!("{base}{upstream_path}");
    if let Some(query) = query.filter(|query| !query.is_empty()) {
        url.push('?');
        url.push_str(&query);
    }
    let mut request = state
        .acp_host
        .client
        .request(method, url)
        .bearer_auth(token)
        .header(ORIGIN_HEADER, origin_header_value(origin));
    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return self::error(
                StatusCode::GATEWAY_TIMEOUT,
                "ACP_HOST_TIMEOUT",
                "CC-Panes desktop app did not answer in time",
            );
        }
        Err(_) => return host_unavailable("CC-Panes desktop app is not reachable"),
    };
    let status = upstream.status();
    // manifest 里的 token 被拒 = manifest 属于另一个 / 已退出的实例。
    if status == StatusCode::UNAUTHORIZED {
        return host_unavailable("CC-Panes desktop app rejected the bridge credentials");
    }
    // 旧版桌面 app 没有该路由（axum 默认 404 空体）：按 app 不支持处理。
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return host_unavailable("CC-Panes desktop app closed the connection"),
    };
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

fn after_seq(query: Option<&str>) -> u64 {
    query
        .and_then(|query| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("afterSeq="))
        })
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

type Upstream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 先连上游：握手失败按 HTTP 状态码回（升级前），不进 WS。
async fn connect_upstream(
    state: &AppState,
    chat_id: &str,
    after_seq: u64,
    origin: &str,
) -> Result<Upstream, Response> {
    let Some((base, token)) = state.acp_host.endpoint() else {
        return Err(host_unavailable("CC-Panes desktop app is not running"));
    };
    let ws_base = base.replacen("http://", "ws://", 1);
    let url = format!("{ws_base}/acp/ws/{chat_id}?afterSeq={after_seq}");
    let mut request = url
        .into_client_request()
        .map_err(|_| host_unavailable("Invalid orchestrator endpoint"))?;
    let auth = format!("Bearer {token}")
        .parse()
        .map_err(|_| host_unavailable("Invalid orchestrator credentials"))?;
    request.headers_mut().insert(header::AUTHORIZATION, auth);
    request
        .headers_mut()
        .insert(ORIGIN_HEADER, origin_header_value(origin));
    match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
        Ok(Ok((stream, _))) => Ok(stream),
        // 上游 401 = manifest 陈旧（另一个实例 / 已换令牌）：对客户端而言就是 app 不可用。
        Ok(Err(tungstenite::Error::Http(response)))
            if response.status() != StatusCode::UNAUTHORIZED =>
        {
            let status = response.status();
            let body = response
                .body()
                .as_ref()
                .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
                .unwrap_or_else(|| {
                    serde_json::json!({
                        "code": if status == StatusCode::NOT_FOUND { "ACP_SESSION_NOT_FOUND" } else { "ACP_ERROR" },
                        "message": format!("ACP host refused the stream ({status})"),
                    })
                });
            Err((status, Json(body)).into_response())
        }
        _ => Err(host_unavailable("CC-Panes desktop app is not reachable")),
    }
}

/// `GET /ws/acp/{chatId}?afterSeq=N`。
#[allow(clippy::too_many_arguments)]
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Path(chat_id): Path<String>,
    RawQuery(query): RawQuery,
    origin: Option<Extension<RequestOrigin>>,
    device: Option<Extension<DeviceTokenAuth>>,
    State(state): State<AppState>,
) -> Response {
    if !is_safe_segment(&chat_id) {
        return error(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown ACP chat");
    }
    let device = device.map(|Extension(auth)| auth);
    let request_origin = request_origin(&state, device.as_ref());
    let upstream = match connect_upstream(
        &state,
        &chat_id,
        after_seq(query.as_deref()),
        &request_origin,
    )
    .await
    {
        Ok(upstream) => upstream,
        Err(response) => return response,
    };
    let origin = origin.map_or(RequestOrigin::Remote, |Extension(origin)| origin);
    let access = Access::new(
        &state,
        &headers,
        peer.map(|Extension(ConnectInfo(addr))| addr.ip()),
        origin,
        device.map(|auth| auth.0),
    );
    ws.on_upgrade(move |socket| relay(socket, upstream, state, access))
}

async fn relay(client: WebSocket, upstream: Upstream, state: AppState, access: Access) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let down = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            if access.permissions(&state).is_none() {
                break;
            }
            match message {
                tungstenite::Message::Text(text) => {
                    // 原样透传：帧结构（含未知 kind）由客户端解释。
                    let text: String = text.as_str().to_owned();
                    if client_tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                tungstenite::Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = client_tx.close().await;
    };
    let up = async {
        while let Some(Ok(message)) = client_rx.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    tokio::select! {
        _ = down => {}
        _ = up => {}
        _ = access.revoked(&state) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_allowlist_matches_contract_only() {
        for ok in [
            "engines",
            "history",
            "chats",
            "chats/mobile-1",
            "chats/tab_1/prompt",
            "chats/x/config",
            "chats/x/elicitation",
        ] {
            assert!(is_allowed_path(ok), "{ok}");
        }
        for bad in [
            "",
            "chats/../mcp",
            "chats/a/b/c",
            "chats/a/unknown",
            "ws/a",
            "chats/%2e%2e",
            "chats//prompt",
        ] {
            assert!(!is_allowed_path(bad), "{bad}");
        }
    }

    #[test]
    fn after_seq_query_parsing() {
        assert_eq!(after_seq(Some("afterSeq=42")), 42);
        assert_eq!(after_seq(Some("token=x&afterSeq=7")), 7);
        assert_eq!(after_seq(Some("afterSeq=nope")), 0);
        assert_eq!(after_seq(None), 0);
    }

    #[test]
    fn origin_header_is_url_encoded() {
        assert_eq!(
            origin_header_value("device:mac").to_str().unwrap(),
            "device%3Amac"
        );
        let encoded = origin_header_value("device:吴的 iPhone");
        assert_eq!(
            urlencoding::decode(encoded.to_str().unwrap()).unwrap(),
            "device:吴的 iPhone"
        );
    }
}
