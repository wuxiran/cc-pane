//! Magpie 网关实况（只读）：会话路由、额度、实时路由组 / 模型。
//!
//! - 请求只发往 `127.0.0.1:<网关端口>`：端口取自 Magpie 配置目录（`gateway.json` → `MAGPIE_ADDR`
//!   → 默认 3425），主机一律换成 `127.0.0.1`，不跟随配置里的主机名。
//! - 不带任何密钥：Magpie 对回环来源的 `/v1/magpie/route`、`/v1/magpie/quotas`、`/v1/models`
//!   免 key（`local(r)` 放行；只在请求**带了**受管 key 时才识别调用方）。带了受限 key 反而只能看到
//!   该 key 自己的路由，所以这里刻意不带。
//! - 绕过系统代理：回环请求被系统代理转发会被 Magpie 认成「经代理」而拒绝。
//! - 不写 Magpie 的任何文件；Magpie 不在线时返回「不可用」，只记 debug 日志。
//!
//! 会话 id 映射：Claude Code 每个请求带 `x-claude-code-session-id: <Claude 会话 id>`，Codex 带
//! `session_id: <线程 id>`，Magpie 的 `sessionOf` 按这些头取会话（去空白、截到 128 字节）。
//! CC-Panes 的启动记录里 `resume_session_id` 就是这个 id，按同样规则规整后查询。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

use crate::models::provider::{EndpointKind, Provider};
use crate::services::external_provider_import::{magpie_config_dir, read_magpie_gateway_addr};
use crate::services::relay_gateway_probe::loopback_host_port;

/// Magpie 截断会话 id 的长度（`sessionOf`）。
const MAGPIE_SESSION_MAX: usize = 128;
/// 长轮询最长等待（Magpie 上限 60s；取小一点，组件卸载后悬挂的请求早点结束）。
pub const MAGPIE_ROUTE_WAIT_MAX_SECS: u32 = 25;
/// 非长轮询请求的超时。
const MAGPIE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
/// 实时目录缓存时长：下拉框反复打开不必每次打网关。
const CATALOG_TTL: Duration = Duration::from_secs(15);
/// 会话换模型计数最多保留多少个会话。
const MAX_TRACKED_SESSIONS: usize = 128;

// ---------------------------------------------------------------------------
// 线上形状（Magpie 的 JSON 是 snake_case；发给前端统一 camelCase）
// ---------------------------------------------------------------------------

/// `GET /v1/magpie/route` 里的一次尝试。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct MagpieRouteTry {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub fail: Option<String>,
    #[serde(default)]
    pub ms: Option<i64>,
}

/// 路由组规则命中（`rule`）。只取界面用得到的。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct MagpieRuleHit {
    #[serde(default)]
    pub n: i64,
    #[serde(default, rename(deserialize = "use"))]
    pub use_member: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub pick: Option<String>,
}

/// 会话最近一次请求的路由（`route`）。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct MagpieRoute {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub asked: String,
    #[serde(default)]
    pub asked_effort: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub rule: Option<MagpieRuleHit>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub served: Option<String>,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub tries: Vec<MagpieRouteTry>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub ms: Option<i64>,
    #[serde(default)]
    pub ttft_ms: Option<i64>,
}

impl MagpieRoute {
    /// 当前落在哪个成员：正在试的 / 最后试的，没有就是 agent 点名的模型。
    pub fn current_model(&self) -> &str {
        self.model
            .as_deref()
            .filter(|model| !model.is_empty())
            .unwrap_or(&self.asked)
    }
}

#[derive(Debug, Deserialize)]
struct RouteEnvelope {
    #[serde(default)]
    seq: i64,
    #[serde(default)]
    route: Option<MagpieRoute>,
}

/// 额度窗口（`windows[]`），`used` / `remaining` 是百分比。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieQuotaWindow {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub used: f64,
    #[serde(default)]
    pub remaining: f64,
    #[serde(default)]
    pub unlimited: bool,
    #[serde(default)]
    pub resets_at: Option<String>,
    #[serde(default)]
    pub display: Option<String>,
    #[serde(default)]
    pub text: bool,
}

/// `GET /v1/magpie/quotas` 的一行（订阅账号 / 套餐 / key 余额）。
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieQuota {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub windows: Vec<MagpieQuotaWindow>,
    #[serde(default)]
    pub balance: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub last_served_at: Option<String>,
    #[serde(default)]
    pub last: bool,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct ListEnvelope<T> {
    #[serde(default = "Vec::new", deserialize_with = "null_as_empty")]
    data: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct ModelRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    magpie_label: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
}

/// 实时目录里的一项（路由组或模型）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieCatalogEntry {
    pub id: String,
    pub label: Option<String>,
    pub context_window_tokens: Option<u64>,
}

// ---------------------------------------------------------------------------
// 发给前端的结果
// ---------------------------------------------------------------------------

/// 会话路由实况。`available = false` 时前端整段隐藏。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieRouteStatus {
    pub available: bool,
    /// 给 Magpie 的会话 id（规整后）。
    pub session_key: Option<String>,
    pub seq: i64,
    pub route: Option<MagpieRoute>,
    /// 本会话里观察到的换成员次数（含同一轮内的回退）。
    pub switch_count: u32,
}

impl MagpieRouteStatus {
    pub fn unavailable() -> Self {
        Self::default()
    }
}

/// 供应商额度卡。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieQuotaReport {
    pub available: bool,
    pub quotas: Vec<MagpieQuota>,
}

/// 实时路由组与模型。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagpieCatalog {
    pub available: bool,
    pub groups: Vec<MagpieCatalogEntry>,
    pub models: Vec<MagpieCatalogEntry>,
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

fn null_as_empty<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

fn lenient_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::String(text)) if !text.is_empty() => Some(text),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    })
}

/// 按 Magpie `sessionOf` 的规则规整会话 id：去空白、截到 128 字节；空的、`new` 占位返回 `None`。
pub fn magpie_session_key(resume_id: &str) -> Option<String> {
    let trimmed = resume_id.trim();
    if trimmed.is_empty() || trimmed == "new" {
        return None;
    }
    let mut end = trimmed.len().min(MAGPIE_SESSION_MAX);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    Some(trimmed[..end].to_string())
}

/// 网关地址（`host:port`）里的端口。
pub fn gateway_port(addr: &str) -> Option<u16> {
    addr.rsplit_once(':')?.1.parse().ok()
}

/// 供应商的某个接口地址是不是指向本机 Magpie 网关（回环 + 端口一致）。
pub fn provider_points_to_gateway(provider: &Provider, port: u16) -> bool {
    EndpointKind::ALL
        .into_iter()
        .filter_map(|kind| provider.endpoints.get(kind).map(str::to_string))
        .chain(provider.base_url.clone())
        .filter_map(|url| loopback_host_port(&url))
        .any(|(_, candidate)| candidate == port)
}

/// Magpie 配置目录在、且有 `providers.json` 或 `gateway.json` 时，返回网关端口。
pub fn configured_gateway_port(config_dir: &Path) -> Option<u16> {
    let has_config =
        config_dir.join("providers.json").is_file() || config_dir.join("gateway.json").is_file();
    if !has_config {
        return None;
    }
    gateway_port(&read_magpie_gateway_addr(config_dir))
}

/// 启动解析用：供应商指向本机 Magpie 网关时，接受不在模型表里的 Magpie 模型 id
/// （`group/<id>` 或 `<provider>/<model>`）——实时目录里选的组不需要先导入。
pub fn accepts_live_magpie_model(provider: &Provider, model_id: &str) -> bool {
    let model_id = model_id.trim();
    if !model_id.contains('/') || model_id.starts_with('/') || model_id.ends_with('/') {
        return false;
    }
    magpie_config_dir()
        .as_deref()
        .and_then(configured_gateway_port)
        .is_some_and(|port| provider_points_to_gateway(provider, port))
}

/// 一次实时目录：`group/*` 进路由组，其余进模型；保持网关给的顺序，去重。
fn split_catalog(rows: Vec<ModelRow>) -> (Vec<MagpieCatalogEntry>, Vec<MagpieCatalogEntry>) {
    let mut seen = std::collections::HashSet::new();
    let mut groups = Vec::new();
    let mut models = Vec::new();
    for row in rows {
        let id = row.id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let label = row
            .magpie_label
            .or(row.display_name)
            .map(|label| label.trim().to_string())
            .filter(|label| !label.is_empty() && *label != id);
        let entry = MagpieCatalogEntry {
            id: id.clone(),
            label,
            context_window_tokens: row.context_window.filter(|tokens| *tokens > 0),
        };
        if id.starts_with("group/") {
            groups.push(entry);
        } else {
            models.push(entry);
        }
    }
    (groups, models)
}

/// 额度卡要显示哪些行。普通中转站（`external_id` 是 Magpie 里的供应商 id）只看自己那家；
/// 路由组看组里成员涉及的供应商；对不上就全给（网关级视图），总比空卡有用。
pub fn scope_quotas(quotas: Vec<MagpieQuota>, providers: &[String]) -> Vec<MagpieQuota> {
    if providers.is_empty() {
        return quotas;
    }
    let scoped: Vec<MagpieQuota> = quotas
        .iter()
        .filter(|quota| providers.iter().any(|id| id == &quota.provider))
        .cloned()
        .collect();
    if scoped.is_empty() {
        quotas
    } else {
        scoped
    }
}

/// 从 `providers.json` 读路由组成员涉及的 Magpie 供应商 id（`<provider>/<model>` 的前半）。只读。
fn group_member_providers(config_dir: &Path, group_id: &str) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(config_dir.join("providers.json")) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for group in root
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if group.get("id").and_then(Value::as_str) != Some(group_id) {
            continue;
        }
        for member in group
            .get("members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some((provider, _)) = member.trim().split_once('/') {
                if !provider.is_empty() && !out.iter().any(|known| known == provider) {
                    out.push(provider.to_string());
                }
            }
        }
    }
    out
}

/// 供应商在 Magpie 里对应哪些供应商 id（额度过滤用）。
fn quota_scope_for(provider: &Provider, config_dir: &Path) -> Vec<String> {
    let Some(external_id) = provider
        .source
        .as_ref()
        .and_then(|origin| origin.external_id.as_deref())
    else {
        return Vec::new();
    };
    match external_id.strip_prefix("group:") {
        Some(group_id) => group_member_providers(config_dir, group_id),
        None => vec![external_id.to_string()],
    }
}

// ---------------------------------------------------------------------------
// 换成员计数
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct SwitchTracker {
    last_model: Option<String>,
    switches: u32,
    touched: Option<Instant>,
}

impl SwitchTracker {
    fn observe(&mut self, route: Option<&MagpieRoute>) -> u32 {
        self.touched = Some(Instant::now());
        let Some(model) = route
            .map(MagpieRoute::current_model)
            .filter(|model| !model.is_empty())
        else {
            return self.switches;
        };
        if self.last_model.as_deref().is_some_and(|last| last != model) {
            self.switches += 1;
        }
        self.last_model = Some(model.to_string());
        self.switches
    }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

pub struct MagpieLiveService {
    config_dir: Option<PathBuf>,
    /// 测试用：直接指定网关根地址（必须仍是 127.0.0.1）。
    base_override: Option<String>,
    client: reqwest::Client,
    switches: Mutex<HashMap<String, SwitchTracker>>,
    catalog_cache: Mutex<Option<(Instant, MagpieCatalog)>>,
}

impl Default for MagpieLiveService {
    fn default() -> Self {
        Self::new()
    }
}

impl MagpieLiveService {
    pub fn new() -> Self {
        Self::build(magpie_config_dir(), None)
    }

    fn build(config_dir: Option<PathBuf>, base_override: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(500))
            .build()
            .unwrap_or_default();
        Self {
            config_dir,
            base_override,
            client,
            switches: Mutex::new(HashMap::new()),
            catalog_cache: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(config_dir: PathBuf, port: u16) -> Self {
        Self::build(Some(config_dir), Some(format!("http://127.0.0.1:{port}")))
    }

    /// 网关端口（配置文件不在 = Magpie 没装 / 没用过，不算在线）。
    pub fn gateway_port(&self) -> Option<u16> {
        self.config_dir.as_deref().and_then(configured_gateway_port)
    }

    fn base_url(&self) -> Option<String> {
        let port = self.gateway_port()?;
        Some(
            self.base_override
                .clone()
                .unwrap_or_else(|| format!("http://127.0.0.1:{port}")),
        )
    }

    /// 供应商是否走本机 Magpie 网关。
    pub fn is_magpie_provider(&self, provider: &Provider) -> bool {
        self.gateway_port()
            .is_some_and(|port| provider_points_to_gateway(provider, port))
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path_and_query: &str,
        timeout: Duration,
    ) -> Option<T> {
        let base = self.base_url()?;
        let url = format!("{base}{path_and_query}");
        let response = match self.client.get(&url).timeout(timeout).send().await {
            Ok(response) => response,
            Err(error) => {
                debug!(path = %path_and_query, err = %error, "magpie gateway not reachable");
                return None;
            }
        };
        if !response.status().is_success() {
            debug!(path = %path_and_query, status = %response.status(), "magpie gateway refused");
            return None;
        }
        match response.json::<T>().await {
            Ok(value) => Some(value),
            Err(error) => {
                debug!(path = %path_and_query, err = %error, "magpie gateway answer unreadable");
                None
            }
        }
    }

    /// 查询会话路由。`provider` 不指向 Magpie、会话 id 还没有、网关不在线 → 不可用。
    /// `after` + `wait_secs` 走 Magpie 的长轮询：路由变了（seq 超过 `after`）才返回。
    pub async fn session_route(
        &self,
        provider: Option<&Provider>,
        resume_id: Option<&str>,
        after: Option<i64>,
        wait_secs: Option<u32>,
    ) -> MagpieRouteStatus {
        if !provider.is_some_and(|provider| self.is_magpie_provider(provider)) {
            return MagpieRouteStatus::unavailable();
        }
        let Some(session_key) = resume_id.and_then(magpie_session_key) else {
            return MagpieRouteStatus::unavailable();
        };
        let wait = wait_secs.unwrap_or(0).min(MAGPIE_ROUTE_WAIT_MAX_SECS);
        let mut query = format!(
            "/v1/magpie/route?session={}",
            url::form_urlencoded::byte_serialize(session_key.as_bytes()).collect::<String>()
        );
        if wait > 0 {
            query.push_str(&format!("&after={}&wait={wait}", after.unwrap_or(0).max(0)));
        }
        let timeout = MAGPIE_REQUEST_TIMEOUT + Duration::from_secs(u64::from(wait));
        let Some(envelope) = self.get_json::<RouteEnvelope>(&query, timeout).await else {
            return MagpieRouteStatus::unavailable();
        };
        let switch_count = self.observe_switch(&session_key, envelope.route.as_ref());
        MagpieRouteStatus {
            available: true,
            session_key: Some(session_key),
            seq: envelope.seq,
            route: envelope.route,
            switch_count,
        }
    }

    fn observe_switch(&self, session_key: &str, route: Option<&MagpieRoute>) -> u32 {
        let Ok(mut trackers) = self.switches.lock() else {
            return 0;
        };
        if !trackers.contains_key(session_key) && trackers.len() >= MAX_TRACKED_SESSIONS {
            let oldest = trackers
                .iter()
                .min_by_key(|(_, tracker)| tracker.touched)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                trackers.remove(&oldest);
            }
        }
        trackers
            .entry(session_key.to_string())
            .or_default()
            .observe(route)
    }

    /// 供应商视图的额度卡：只给指向 Magpie 网关的供应商；读 Magpie 已缓存的数（`kept=1`，不催厂商）。
    pub async fn provider_quotas(&self, provider: &Provider) -> MagpieQuotaReport {
        if !self.is_magpie_provider(provider) {
            return MagpieQuotaReport::default();
        }
        let Some(list) = self
            .get_json::<ListEnvelope<MagpieQuota>>(
                "/v1/magpie/quotas?kept=1",
                MAGPIE_REQUEST_TIMEOUT,
            )
            .await
        else {
            return MagpieQuotaReport::default();
        };
        let scope = self
            .config_dir
            .as_deref()
            .map(|dir| quota_scope_for(provider, dir))
            .unwrap_or_default();
        MagpieQuotaReport {
            available: true,
            quotas: scope_quotas(list.data, &scope),
        }
    }

    /// 实时路由组与模型（`GET /v1/models`）。`provider` 给了就只在它指向 Magpie 时返回。
    pub async fn catalog(&self, provider: Option<&Provider>) -> MagpieCatalog {
        if provider.is_some_and(|provider| !self.is_magpie_provider(provider)) {
            return MagpieCatalog::default();
        }
        if let Some(cached) = self.cached_catalog() {
            return cached;
        }
        let catalog = match self
            .get_json::<ListEnvelope<ModelRow>>("/v1/models", MAGPIE_REQUEST_TIMEOUT)
            .await
        {
            Some(list) => {
                let (groups, models) = split_catalog(list.data);
                MagpieCatalog {
                    available: true,
                    groups,
                    models,
                }
            }
            None => MagpieCatalog::default(),
        };
        if let Ok(mut cache) = self.catalog_cache.lock() {
            // 不在线也缓存一会儿：下拉反复打开时不反复撞关着的端口。
            *cache = Some((Instant::now(), catalog.clone()));
        }
        catalog
    }

    fn cached_catalog(&self) -> Option<MagpieCatalog> {
        let cache = self.catalog_cache.lock().ok()?;
        let (at, catalog) = cache.as_ref()?;
        (at.elapsed() < CATALOG_TTL).then(|| catalog.clone())
    }
}

#[cfg(test)]
mod tests;
