//! Bot 组网（docs/112 §5）：每台电脑养自己的 Bot，经已配对设备互相可见、可对话。
//!
//! - 身份与信任：`<data>/instance-id` + docs/111 设备令牌（配对码换令牌）；
//! - 发现：mDNS `_ccpanes._tcp`（只在允许其他设备连接时广播）+ Tailscale；
//! - Peer API：orchestrator `/mesh/*`（[`routes`]），cc-panes-web 的 `/api/bots*`、
//!   `/api/contacts*` 反向代理过来；
//! - 远程权限：按 Bot 的 [`RemotePolicy`]，只罩住远程消息开启的回合；
//! - 防环：`hops ≤ 3` + 同一 traceId 不得回到已经过的 Bot。
//!
//! 资源边界（CLAUDE.md：不给每个对端起常驻轮询）：探测 / 联系人汇总都在被调用
//! 时做并短暂缓存；唯一的后台任务是「每条在途发件」的回复跟踪，有总数上限。

pub mod deliver;
pub mod discovery;
pub mod outbound;
pub mod peers;
pub mod policy;
pub mod records;
pub mod routes;
pub mod trace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cc_panes_core::models::MeshAddressSource;
use cc_panes_core::repository::MeshPeerRepository;
use cc_panes_core::services::{DeviceService, DeviceTokenService, SettingsService};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::services::bot_service::{bot_chat_id, Bot};
use crate::services::{AcpChatService, BotService};

pub use policy::RemotePolicy;
pub use records::{MeshFrom, MeshMessage, MeshMessageStatus, OutboxEntry};

pub const OUTBOX_CHANGED_EVENT: &str = "bot-mesh-outbox-changed";
/// 联系人分组里本机的 deviceId。
pub const LOCAL_DEVICE: &str = "local";
const CONTACTS_CACHE_TTL: Duration = Duration::from_secs(8);
const PERSONA_SUMMARY_MAX: usize = 80;

/// 对外（`/api/bots`）的 Bot 摘要：不含完整人设。
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedBot {
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub color: String,
    pub engine_id: String,
    pub persona_summary: String,
    /// `idle`（未启动）/ `starting` / `ready` / `generating` / `exited` / `failed`。
    pub status: String,
    pub remote_policy: RemotePolicy,
    #[serde(default)]
    pub remote_allow_kinds: Vec<String>,
    #[serde(default = "default_true")]
    pub remote_shared: bool,
    pub chat_id: String,
}

fn default_true() -> bool {
    true
}

pub fn persona_summary(persona: &str) -> String {
    let line = persona
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("<!--"))
        .unwrap_or("");
    let line = line.trim_start_matches('#').trim();
    let mut out: String = line.chars().take(PERSONA_SUMMARY_MAX).collect();
    if line.chars().count() > PERSONA_SUMMARY_MAX {
        out.push('…');
    }
    out
}

pub fn status_label(phase: Option<crate::services::AcpChatPhase>) -> String {
    phase
        .and_then(|phase| serde_json::to_value(phase).ok())
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "idle".to_string())
}

/// 联系人的一组（一台电脑）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactGroup {
    /// 本机为 `local`，其他电脑为设备 id。
    pub device_id: String,
    pub name: String,
    pub local: bool,
    /// `online` / `offline` / `unauthorized` / `unsupported` / `error`。
    pub status: String,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub bots: Vec<SharedBot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactsView {
    pub instance_id: Option<String>,
    pub device_name: String,
    pub groups: Vec<ContactGroup>,
}

pub struct BotMeshService {
    app: AppHandle,
    bots: Arc<BotService>,
    acp: Arc<AcpChatService>,
    peers: peers::PeerDirectory,
    tokens: Arc<DeviceTokenService>,
    settings: Arc<SettingsService>,
    guard: trace::TraceGuard,
    inbound: records::BoundedMap<MeshMessage>,
    outbox: records::BoundedMap<OutboxEntry>,
    /// botId → 它正在服务的远程消息的 (traceId, hops)，MCP 接力用。
    active_traces: Mutex<HashMap<String, (String, u32)>>,
    mdns: discovery::MdnsHub,
    contacts_cache: Mutex<HashMap<String, (Instant, ContactGroup)>>,
}

impl BotMeshService {
    pub fn new(
        app: AppHandle,
        bots: Arc<BotService>,
        acp: Arc<AcpChatService>,
        devices: Arc<DeviceService>,
        repo: Arc<MeshPeerRepository>,
        tokens: Arc<DeviceTokenService>,
        settings: Arc<SettingsService>,
    ) -> Self {
        Self {
            app,
            bots,
            acp,
            peers: peers::PeerDirectory::new(devices, repo),
            tokens,
            settings,
            guard: trace::TraceGuard::default(),
            inbound: records::inbound_store(),
            outbox: records::outbox_store(),
            active_traces: Mutex::new(HashMap::new()),
            mdns: discovery::MdnsHub::default(),
            contacts_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn instance_id(&self) -> Option<String> {
        self.tokens.instance_id()
    }

    pub fn device_name(&self) -> String {
        sysinfo::System::host_name().unwrap_or_else(|| "cc-panes-desktop".to_string())
    }

    pub fn peers(&self) -> &peers::PeerDirectory {
        &self.peers
    }

    fn emit(&self, event: &str, payload: impl Serialize + Clone) {
        if crate::webview_reliability::webview_emits_allowed() {
            let _ = self.app.emit(event, payload);
        }
    }

    pub fn active_trace(&self, bot_id: &str) -> Option<(String, u32)> {
        self.active_traces
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(bot_id)
            .cloned()
    }

    fn set_active_trace(&self, bot_id: &str, value: Option<(String, u32)>) {
        let mut map = self.active_traces.lock().unwrap_or_else(|p| p.into_inner());
        match value {
            Some(value) => {
                map.insert(bot_id.to_string(), value);
            }
            None => {
                map.remove(bot_id);
            }
        }
    }

    /// 本机 Bot 目录。`include_private` = 本机桌面视角（含未共享的）。
    pub async fn local_bots(&self, include_private: bool) -> Vec<SharedBot> {
        let mut out = Vec::new();
        for bot in self.bots.list_bots() {
            if !include_private && !bot.remote_shared {
                continue;
            }
            let chat_id = bot_chat_id(&bot.id);
            let phase = self.acp.snapshot(&chat_id).await.map(|s| s.phase);
            out.push(shared_bot(&bot, status_label(phase)));
        }
        out
    }

    /// 改 Bot 的远程设置（手机 `PATCH /api/bots/{id}`、桌面同一入口）。
    pub async fn update_remote_settings(
        &self,
        bot_id: &str,
        patch: RemotePatch,
    ) -> crate::utils::AppResult<SharedBot> {
        let mut bot = self.bots.get(bot_id)?;
        if let Some(policy) = patch.remote_policy {
            if policy == RemotePolicy::Full && policy != bot.remote_policy && !patch.confirm_full {
                return Err(crate::utils::AppError::coded(
                    "BOT_FULL_CONFIRM_REQUIRED",
                    "Setting remotePolicy=full requires confirmFull=true",
                ));
            }
            bot.remote_policy = policy;
        }
        if let Some(kinds) = patch.remote_allow_kinds {
            bot.remote_allow_kinds = kinds;
        }
        if let Some(shared) = patch.remote_shared {
            bot.remote_shared = shared;
        }
        let saved = self.bots.save(bot).await?;
        crate::services::bot_service::emit_changed(&self.app);
        let phase = self
            .acp
            .snapshot(&bot_chat_id(&saved.id))
            .await
            .map(|s| s.phase);
        Ok(shared_bot(&saved, status_label(phase)))
    }

    /// 本机 + 所有已配对电脑的 Bot（并发拉取，短暂缓存）。
    pub async fn contacts(self: &Arc<Self>, refresh: bool, include_private: bool) -> ContactsView {
        let local = ContactGroup {
            device_id: LOCAL_DEVICE.to_string(),
            name: self.device_name(),
            local: true,
            status: "online".into(),
            online: true,
            error: None,
            address: None,
            instance_id: self.instance_id(),
            last_seen_at: None,
            bots: self.local_bots(include_private).await,
        };
        // 设备清单不碰 keyring；令牌只在 `endpoint()` 的阻塞线程里读。
        let devices = self.peers.devices().devices();
        let groups = futures_util::future::join_all(devices.into_iter().map(|device| {
            let this = self.clone();
            async move { this.peer_group(&device.id, &device.name, refresh).await }
        }))
        .await;
        let mut all = vec![local];
        all.extend(groups);
        ContactsView {
            instance_id: self.instance_id(),
            device_name: self.device_name(),
            groups: all,
        }
    }

    async fn peer_group(&self, device_id: &str, name: &str, refresh: bool) -> ContactGroup {
        if !refresh {
            if let Some((at, group)) = self
                .contacts_cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(device_id)
            {
                if at.elapsed() < CONTACTS_CACHE_TTL {
                    return group.clone();
                }
            }
        }
        let group = self.fetch_peer_group(device_id, name).await;
        self.contacts_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(device_id.to_string(), (Instant::now(), group.clone()));
        group
    }

    async fn fetch_peer_group(&self, device_id: &str, name: &str) -> ContactGroup {
        let mut group = ContactGroup {
            device_id: device_id.to_string(),
            name: name.to_string(),
            local: false,
            status: "offline".into(),
            online: false,
            error: None,
            address: None,
            instance_id: None,
            last_seen_at: None,
            bots: Vec::new(),
        };
        let endpoint = match self.peers.endpoint(device_id).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                group.error = Some(error.message().to_string());
                let record = self.peers.record(device_id);
                group.instance_id = record.instance_id;
                group.last_seen_at = record.last_seen_at;
                return group;
            }
        };
        group.address = Some(endpoint.base_url.clone());
        if let Ok(info) = peers::peer_get(&endpoint, "/api/device/info").await {
            self.peers.remember_identity(device_id, &info);
        }
        let record = self.peers.record(device_id);
        group.instance_id = record.instance_id;
        group.last_seen_at = record.last_seen_at;
        match peers::peer_get(&endpoint, "/api/bots").await {
            Ok(value) => {
                group.online = true;
                group.status = "online".into();
                group.bots = parse_bot_list(&value);
            }
            Err(error) => {
                group.online = !matches!(error, peers::PeerHttpError::Unreachable(_));
                group.status = match &error {
                    peers::PeerHttpError::Unauthorized => "unauthorized",
                    peers::PeerHttpError::Unreachable(_) => "offline",
                    other if other.unsupported() => "unsupported",
                    _ => "error",
                }
                .into();
                group.error = Some(error.into_app_error().message().to_string());
            }
        }
        group
    }

    pub fn invalidate_contacts(&self, device_id: &str) {
        self.contacts_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(device_id);
    }

    /// 本机该不该广播 mDNS：Web 访问开启 + 允许其他设备连接。
    pub fn wanted_advertisement(&self) -> Option<discovery::Advertisement> {
        let web = self.settings.get_settings().web_access;
        if !(web.enabled && web.allow_devices) {
            return None;
        }
        Some(discovery::Advertisement {
            instance_id: self.instance_id()?,
            name: self.device_name(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            port: web.port,
        })
    }

    /// 对齐 mDNS 广播（启动、改 Web 访问设置后调用）。阻塞，放 spawn_blocking。
    pub fn sync_advertisement(&self) {
        self.mdns.sync(self.wanted_advertisement());
    }

    /// 按需发现：mDNS 浏览 + Tailscale 节点探测；顺带把对上的地址记到已配对对端。
    pub async fn discover(self: &Arc<Self>) -> discovery::DiscoveryReport {
        let this = self.clone();
        let own = self.instance_id();
        let (mdns, tailnet) = tauri::async_runtime::spawn_blocking(move || {
            (this.mdns.browse(own.as_deref()), discovery::tailnet_peers())
        })
        .await
        .unwrap_or((Err("join error".into()), Err("error")));
        let mut nodes = Vec::new();
        let mdns_state = match mdns {
            Ok(found) => {
                nodes.extend(found);
                "ok".to_string()
            }
            Err(error) => format!("error:{error}"),
        };
        let tailscale_state = match tailnet {
            Ok(peers) => {
                nodes.extend(self.probe_tailnet(peers).await);
                "running".to_string()
            }
            Err(state) => state.to_string(),
        };
        for node in nodes.iter_mut() {
            for url in node.addresses.clone() {
                if !node.reachable {
                    continue;
                }
                if let Some(device_id) = self.peers.attach_address(
                    node.instance_id.as_deref(),
                    Some(node.name.as_str()),
                    &url,
                    node.source,
                ) {
                    node.paired_device_id = Some(device_id);
                }
            }
        }
        discovery::DiscoveryReport {
            nodes,
            tailscale: tailscale_state,
            mdns: mdns_state,
            advertising: self.mdns.advertising(),
        }
    }

    /// Tailscale 节点不知道对方端口：按「本机 Web 端口 / 默认端口」各试一次 `/api/health`。
    async fn probe_tailnet(
        &self,
        peers: Vec<discovery::TailnetPeer>,
    ) -> Vec<discovery::DiscoveredNode> {
        let mut ports = vec![self.settings.get_settings().web_access.port, 18080];
        ports.dedup();
        let probes = peers.into_iter().map(|peer| {
            let ports = ports.clone();
            async move {
                let mut reachable = Vec::new();
                if peer.online {
                    for ip in &peer.ips {
                        for port in &ports {
                            let url = format!("http://{ip}:{port}");
                            if peers::health_ok(&url).await {
                                reachable.push(url);
                            }
                        }
                    }
                }
                let ok = !reachable.is_empty();
                discovery::DiscoveredNode {
                    source: MeshAddressSource::Tailscale,
                    name: peer.host_name.clone(),
                    instance_id: None,
                    version: None,
                    addresses: if ok {
                        reachable
                    } else {
                        peer.ips
                            .iter()
                            .map(|ip| format!("http://{ip}:{}", ports[0]))
                            .collect()
                    },
                    online: peer.online,
                    reachable: ok,
                    paired_device_id: None,
                }
            }
        });
        futures_util::future::join_all(probes).await
    }
}

/// `PATCH /api/bots/{id}` 的请求体。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePatch {
    #[serde(default)]
    pub remote_policy: Option<RemotePolicy>,
    #[serde(default)]
    pub remote_allow_kinds: Option<Vec<String>>,
    #[serde(default)]
    pub remote_shared: Option<bool>,
    /// 改成 `full` 必须显式确认（服务端二次确认，防误点 / 旧客户端）。
    #[serde(default)]
    pub confirm_full: bool,
}

pub fn shared_bot(bot: &Bot, status: String) -> SharedBot {
    SharedBot {
        id: bot.id.clone(),
        name: bot.name.clone(),
        avatar: bot.avatar.clone(),
        color: bot.color.clone(),
        engine_id: bot.engine_id.clone(),
        persona_summary: persona_summary(&bot.persona),
        status,
        remote_policy: bot.remote_policy,
        remote_allow_kinds: bot.remote_allow_kinds.clone(),
        remote_shared: bot.remote_shared,
        chat_id: bot_chat_id(&bot.id),
    }
}

/// 对端 `/api/bots`：裸数组或 `{bots:[…]}`；字段缺失的条目宽容补齐。
pub fn parse_bot_list(value: &Value) -> Vec<SharedBot> {
    let items = value
        .as_array()
        .or_else(|| value.get("bots").and_then(Value::as_array));
    items
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let text = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            Some(SharedBot {
                chat_id: item
                    .get("chatId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| bot_chat_id(&id)),
                name: text("name"),
                avatar: text("avatar"),
                color: text("color"),
                engine_id: text("engineId"),
                persona_summary: text("personaSummary"),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("idle")
                    .to_string(),
                remote_policy: item
                    .get("remotePolicy")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default(),
                remote_allow_kinds: item
                    .get("remoteAllowKinds")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default(),
                remote_shared: true,
                id,
            })
        })
        .collect()
}

/// 错误体统一 `{code,message}`。
pub fn error_json(error: &crate::utils::AppError) -> Value {
    json!({"code": error.code().unwrap_or("MESH_ERROR"), "message": error.message()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persona_summary_takes_first_meaningful_line() {
        assert_eq!(persona_summary("\n\n# Reviewer\nmore"), "Reviewer");
        assert_eq!(persona_summary(""), "");
        let long = "x".repeat(200);
        assert_eq!(
            persona_summary(&long).chars().count(),
            PERSONA_SUMMARY_MAX + 1
        );
    }

    #[test]
    fn status_label_maps_phases() {
        assert_eq!(status_label(None), "idle");
        assert_eq!(
            status_label(Some(crate::services::AcpChatPhase::Generating)),
            "generating"
        );
    }

    #[test]
    fn bot_list_accepts_array_or_object() {
        let array = json!([{"id": "a", "name": "A", "remotePolicy": "full"}, {"name": "no id"}]);
        let parsed = parse_bot_list(&array);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].chat_id, "bot-a");
        assert_eq!(parsed[0].remote_policy, RemotePolicy::Full);
        assert_eq!(parsed[0].status, "idle");
        let object = json!({"bots": [{"id": "b", "remotePolicy": "weird"}]});
        let parsed = parse_bot_list(&object);
        assert_eq!(parsed[0].remote_policy, RemotePolicy::AskOrigin);
    }

    #[test]
    fn shared_bot_serializes_contract_fields() {
        let bot: Bot = serde_json::from_value(
            json!({"id": "b1", "name": "Rev", "engineId": "claude", "persona": "Reviews PRs"}),
        )
        .unwrap();
        assert!(bot.remote_shared, "bots are shared by default");
        let value = serde_json::to_value(shared_bot(&bot, "idle".into())).unwrap();
        for key in [
            "id",
            "name",
            "avatar",
            "engineId",
            "personaSummary",
            "status",
            "remotePolicy",
            "chatId",
        ] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert_eq!(value["remotePolicy"], "ask_origin");
        assert!(value.get("persona").is_none(), "full persona stays private");
    }
}
