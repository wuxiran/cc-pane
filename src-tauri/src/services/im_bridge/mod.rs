//! IM 外推桥：把会话事件推送到钉钉/企业微信/飞书等群机器人。
//!
//! 与桌面通知（NotificationService）刻意分离——IM 推送在用户不在电脑前时
//! 才最有价值，因此默认聚焦时也推（`ImSettings.push_when_focused`）。
//! 协议构造在 cc-notify（纯函数），本模块只负责闸门判定与 reqwest 传输。
//! 批次1 仅出站单向；双向长连接（钉钉 Stream / 企微智能机器人）在后续批次。

mod outbound;

pub use outbound::spawn_im_transition_consumer;

use cc_notify::{BuiltRequest, NotifyPayload};
use cc_panes_core::models::settings::ImSettings;
use cc_panes_core::services::{SettingsService, TaskBindingService};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

const SEND_TIMEOUT_SECS: u64 = 10;
const DEDUPE_SECS: u64 = 10;

/// 每渠道最近一次发送结果（Settings UI 展示 + `im-channel-result` 事件载荷）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImChannelStatus {
    pub channel_id: String,
    pub channel_name: String,
    pub kind: String,
    pub ok: bool,
    pub error: Option<String>,
    /// RFC3339
    pub at: String,
}

pub struct ImBridgeService {
    app: AppHandle,
    settings: Arc<SettingsService>,
    task_bindings: Arc<TaskBindingService>,
    recent: Mutex<HashMap<String, Instant>>,
    /// Arc：发送在独立 tokio task 里完成，结果落账需跨 task 共享
    last_results: Arc<Mutex<HashMap<String, ImChannelStatus>>>,
}

impl ImBridgeService {
    pub fn new(
        app: AppHandle,
        settings: Arc<SettingsService>,
        task_bindings: Arc<TaskBindingService>,
    ) -> Self {
        Self {
            app,
            settings,
            task_bindings,
            recent: Mutex::new(HashMap::new()),
            last_results: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 事件外推入口：过闸门（enabled / 聚焦 / muted / dedupe）后异步发往所有订阅渠道。
    /// 每次读取最新 settings，配置改动即时生效。
    pub fn dispatch(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        session_id: Option<&str>,
        dedupe_key: &str,
    ) {
        let im = self.settings.get_settings().im;
        if !im.enabled {
            return;
        }
        if !im.push_when_focused && self.is_window_focused() {
            return;
        }
        if let Some(sid) = session_id {
            if self.is_task_muted(sid) {
                return;
            }
        }
        if !self.check_dedupe(dedupe_key) {
            return;
        }

        let targets: Vec<cc_notify::ChannelConfig> = im
            .channels
            .into_iter()
            .filter(|c| c.enabled && c.subscribes(kind))
            .collect();
        if targets.is_empty() {
            return;
        }

        let payload = self.build_payload(kind, title, body, session_id);
        let proxy = self.settings.get_settings().proxy;
        let results_store = ResultsHandle {
            app: self.app.clone(),
            store: self.last_results.clone(),
        };
        tauri::async_runtime::spawn(async move {
            let client = match build_http_client(&proxy) {
                Ok(client) => client,
                Err(e) => {
                    warn!(err = %e, "im_bridge: failed to build http client");
                    return;
                }
            };
            for channel in targets {
                let outcome = send_to_channel(&client, &channel, &payload).await;
                results_store.record(&channel, &payload.kind, outcome);
            }
        });
    }

    /// 「发送测试」按钮：无视 enabled 主开关与渠道 enabled/events（用户在配置期就要能试）。
    pub async fn test_channel(&self, channel_id: &str) -> Result<(), String> {
        let im = self.settings.get_settings().im;
        let channel = im
            .channels
            .iter()
            .find(|c| c.id == channel_id)
            .cloned()
            .ok_or_else(|| format!("IM channel not found: {channel_id}"))?;

        let payload = self.build_payload(
            "test",
            "CC-Panes 测试消息",
            "如果你看到这条消息，说明该渠道配置正确 ✅",
            None,
        );
        let proxy = self.settings.get_settings().proxy;
        let client = build_http_client(&proxy)?;
        let outcome = send_to_channel(&client, &channel, &payload).await;
        ResultsHandle {
            app: self.app.clone(),
            store: self.last_results.clone(),
        }
        .record(&channel, "test", outcome.clone());
        outcome
    }

    /// 各渠道最近一次发送结果（按渠道 id 去重后的快照）
    pub fn status(&self) -> Vec<ImChannelStatus> {
        let map = self.last_results.lock().unwrap_or_else(|e| e.into_inner());
        let mut list: Vec<ImChannelStatus> = map.values().cloned().collect();
        list.sort_by(|a, b| b.at.cmp(&a.at));
        list
    }

    /// 当前 im 设置快照（供 outbound 消费者做轻量预判）
    pub fn im_settings(&self) -> ImSettings {
        self.settings.get_settings().im
    }

    fn build_payload(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        session_id: Option<&str>,
    ) -> NotifyPayload {
        let mut workspace_name = None;
        let mut project_name = None;
        let mut project_path = None;
        if let Some(sid) = session_id {
            if let Ok(Some(binding)) = self.task_bindings.find_by_session_id(sid) {
                workspace_name = binding.workspace_name.clone();
                project_name = std::path::Path::new(&binding.project_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned());
                project_path = Some(binding.project_path);
            }
        }
        NotifyPayload {
            kind: kind.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            workspace_name,
            project_name,
            project_path,
            session_id: session_id.map(String::from),
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn is_window_focused(&self) -> bool {
        self.app
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
    }

    fn is_task_muted(&self, session_id: &str) -> bool {
        match self.task_bindings.find_by_session_id(session_id) {
            Ok(Some(binding)) => {
                binding
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("ui"))
                    .and_then(|ui| ui.get("muted"))
                    .and_then(|muted| muted.as_bool())
                    == Some(true)
            }
            Ok(None) => false,
            Err(error) => {
                warn!(session_id = %session_id, err = %error, "im_bridge: muted lookup failed");
                false
            }
        }
    }

    fn check_dedupe(&self, dedupe_key: &str) -> bool {
        let mut map = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(last) = map.get(dedupe_key) {
            if last.elapsed().as_secs() < DEDUPE_SECS {
                return false;
            }
        }
        map.insert(dedupe_key.to_string(), Instant::now());
        true
    }
}

/// 发送结果落账 + 广播（异步任务里持有的最小句柄）
struct ResultsHandle {
    app: AppHandle,
    store: Arc<Mutex<HashMap<String, ImChannelStatus>>>,
}

impl ResultsHandle {
    fn record(&self, channel: &cc_notify::ChannelConfig, kind: &str, outcome: Result<(), String>) {
        let status = ImChannelStatus {
            channel_id: channel.id.clone(),
            channel_name: channel.name.clone(),
            kind: kind.to_string(),
            ok: outcome.is_ok(),
            error: outcome.err(),
            at: chrono::Utc::now().to_rfc3339(),
        };
        match &status.error {
            None => info!(channel = %status.channel_name, kind = %kind, "im_bridge: sent"),
            Some(e) => {
                warn!(channel = %status.channel_name, kind = %kind, err = %e, "im_bridge: send failed")
            }
        }
        {
            let mut map = self.store.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(status.channel_id.clone(), status.clone());
        }
        let _ = self.app.emit("im-channel-result", &status);
    }
}

/// 按用户 ProxySettings 构建 reqwest client。
/// 应用自身 HTTP 走用户代理的第一个消费者——ProxySettings 此前只注入子进程 env。
fn build_http_client(
    proxy: &cc_panes_core::models::settings::ProxySettings,
) -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(SEND_TIMEOUT_SECS));
    if proxy.enabled && !proxy.host.is_empty() {
        let scheme = if proxy.proxy_type == "socks5" {
            "socks5h"
        } else {
            "http"
        };
        let url = format!("{}://{}:{}", scheme, proxy.host, proxy.port);
        let mut p = reqwest::Proxy::all(&url).map_err(|e| format!("invalid proxy {url}: {e}"))?;
        if let Some(user) = proxy.username.as_deref().filter(|u| !u.is_empty()) {
            p = p.basic_auth(user, proxy.password.as_deref().unwrap_or(""));
        }
        if let Some(no_proxy) = proxy
            .no_proxy
            .as_deref()
            .and_then(reqwest::NoProxy::from_string)
        {
            p = p.no_proxy(Some(no_proxy));
        }
        builder = builder.proxy(p);
    }
    builder
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

async fn send_to_channel(
    client: &reqwest::Client,
    channel: &cc_notify::ChannelConfig,
    payload: &NotifyPayload,
) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let built = cc_notify::build_request(channel, payload, now_ms)?;
    send_built(client, &built).await
}

async fn send_built(client: &reqwest::Client, built: &BuiltRequest) -> Result<(), String> {
    let mut req = client.post(&built.url).json(&built.body);
    for (name, value) in &built.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let http_status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !http_status.is_success() {
        return Err(format!("HTTP {}: {}", http_status, truncate(&text, 200)));
    }
    // 钉钉/企微用 errcode、飞书用 code：HTTP 200 但业务失败时错误在 body 里
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        let biz_code = json
            .get("errcode")
            .or_else(|| json.get("code"))
            .and_then(|v| v.as_i64());
        if let Some(code) = biz_code {
            if code != 0 {
                let msg = json
                    .get("errmsg")
                    .or_else(|| json.get("msg"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error");
                return Err(format!("platform error {code}: {msg}"));
            }
        }
    }
    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 起一个只应答一次的本地 HTTP server，返回 (url, join_handle)
    async fn one_shot_server(response_body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn send_built_accepts_errcode_zero() {
        let url = one_shot_server(r#"{"errcode":0,"errmsg":"ok"}"#).await;
        // no_proxy()：宿主机可能设有 HTTP_PROXY 环境变量，reqwest 默认会读，
        // 把 127.0.0.1 的 mock 请求路由进真实代理（实测报 502）
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let built = BuiltRequest {
            url,
            body: serde_json::json!({"msgtype":"markdown"}),
            headers: vec![],
        };
        assert!(send_built(&client, &built).await.is_ok());
    }

    #[tokio::test]
    async fn send_built_surfaces_platform_error() {
        // HTTP 200 但业务失败：钉钉/企微把错误放 body 的 errcode 里
        let url = one_shot_server(r#"{"errcode":310000,"errmsg":"sign not match"}"#).await;
        // no_proxy()：宿主机可能设有 HTTP_PROXY 环境变量，reqwest 默认会读，
        // 把 127.0.0.1 的 mock 请求路由进真实代理（实测报 502）
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let built = BuiltRequest {
            url,
            body: serde_json::json!({}),
            headers: vec![],
        };
        let err = send_built(&client, &built).await.unwrap_err();
        assert!(err.contains("310000"), "err was: {err}");
        assert!(err.contains("sign not match"));
    }

    #[test]
    fn proxy_settings_build_client() {
        let mut proxy = cc_panes_core::models::settings::ProxySettings {
            enabled: true,
            proxy_type: "socks5".into(),
            host: "127.0.0.1".into(),
            port: 1080,
            username: None,
            password: None,
            no_proxy: Some("localhost,127.0.0.1".into()),
        };
        assert!(build_http_client(&proxy).is_ok());
        proxy.proxy_type = "http".into();
        assert!(build_http_client(&proxy).is_ok());
        proxy.enabled = false;
        assert!(build_http_client(&proxy).is_ok());
    }
}
