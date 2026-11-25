//! 依赖本地网关的导入条目：Magpie 路由组、cc-switch 本地代理。
//!
//! - Magpie 路由组（`providers.json` 的 `groups`）：成员是 `<provider>/<model>`，指向订阅登录，
//!   只能经 Magpie 网关用（默认 `127.0.0.1:3425`，`MAGPIE_ADDR` 可改，运行中的网关把地址写在
//!   `gateway.json`）。每个组固定导入 Claude、Codex 两行（名称带「· Claude」「· Codex」后缀）。
//!   Anthropic 客户端用网关根地址，Codex 用 `/v1` + `wire_api = "responses"`；
//!   模型名 `group/<id>` 选中路由组；回环地址任何令牌都收，所以密钥是占位符。
//! - cc-switch 代理（`proxy_config` 表）：每个启用的 app 一条，指向 `listen_address:listen_port`。
//!   接管期间 cc-switch 会把占位凭据写进 CLI 配置，普通导入要认出来跳过。

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::{
    magpie_provider_id, str_field, type_id, ExternalBatch, ExternalCandidate, ExternalRelayInfo,
    ExternalRelayKind,
};
use crate::models::provider::{
    Provider, ProviderEndpoints, ProviderModel, ProviderOrigin, ProviderOriginKind, ProviderType,
};
use crate::services::cc_switch_import::ImportedProfileHints;
use crate::services::relay_gateway_probe::{
    loopback_host_port, CC_SWITCH_PROXY_EXTERNAL_PREFIX, MAGPIE_GROUP_EXTERNAL_PREFIX,
};

/// Magpie 网关默认监听地址。
pub const MAGPIE_DEFAULT_GATEWAY: &str = "127.0.0.1:3425";
/// 路由组中转站的占位密钥（回环地址上网关不验令牌）。
pub const MAGPIE_PLACEHOLDER_KEY: &str = "magpie-local";
/// cc-switch 代理中转站的占位密钥（真实凭据在 cc-switch 里）。
pub const CC_SWITCH_PROXY_PLACEHOLDER_KEY: &str = "cc-switch-proxy";
/// cc-switch 普通条目被认成代理占位时的略过原因。
pub const CC_SWITCH_PLACEHOLDER_REASON: &str = "skipped: cc-switch 代理占位";
const CC_SWITCH_DEFAULT_PROXY_PORT: u16 = 15721;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GatewayFamily {
    Claude,
    Codex,
    Gemini,
}

impl GatewayFamily {
    fn label(self) -> &'static str {
        match self {
            GatewayFamily::Claude => "Claude",
            GatewayFamily::Codex => "Codex",
            GatewayFamily::Gemini => "Gemini",
        }
    }

    fn provider_type(self) -> ProviderType {
        match self {
            GatewayFamily::Claude => ProviderType::Anthropic,
            GatewayFamily::Codex => ProviderType::OpenAI,
            GatewayFamily::Gemini => ProviderType::Gemini,
        }
    }

    /// 这一族客户端连网关用的地址：Codex 要 `/v1`，其余用根地址。
    fn endpoints(self, addr: &str) -> ProviderEndpoints {
        let root = format!("http://{addr}");
        match self {
            GatewayFamily::Claude => ProviderEndpoints {
                anthropic: Some(root),
                ..ProviderEndpoints::default()
            },
            GatewayFamily::Codex => ProviderEndpoints {
                responses: Some(format!("{root}/v1")),
                ..ProviderEndpoints::default()
            },
            GatewayFamily::Gemini => ProviderEndpoints {
                gemini: Some(root),
                ..ProviderEndpoints::default()
            },
        }
    }
}

/// 监听地址规整成客户端能连的 `host:port`：`0.0.0.0` / `::` / 空主机 → `127.0.0.1`。
pub(crate) fn normalize_listen_addr(addr: &str) -> Option<String> {
    let addr = addr.trim();
    let addr = addr
        .strip_prefix("http://")
        .or_else(|| addr.strip_prefix("https://"))
        .unwrap_or(addr)
        .trim_end_matches('/');
    let (host, port) = addr.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = match host {
        "" | "0.0.0.0" | "::" => "127.0.0.1",
        other => other,
    };
    Some(if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    })
}

/// Magpie 网关地址：运行中网关写的 `gateway.json` → `MAGPIE_ADDR` → 默认 `127.0.0.1:3425`。
pub fn read_magpie_gateway_addr(config_dir: &Path) -> String {
    std::fs::read_to_string(config_dir.join("gateway.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(super::strip_bom(&raw)).ok())
        .and_then(|value| str_field(&value, "addr"))
        .and_then(|addr| normalize_listen_addr(&addr))
        .or_else(|| {
            std::env::var("MAGPIE_ADDR")
                .ok()
                .and_then(|addr| normalize_listen_addr(&addr))
        })
        .unwrap_or_else(|| MAGPIE_DEFAULT_GATEWAY.to_string())
}

/// 路由组固定导入成 Claude + Codex 两行：网关本身在 Anthropic / OpenAI 协议之间翻译，
/// 任一客户端都能用任一组。不再按成员推断——推断会让同一个组随成员变化时有时一行、有时两行。
pub(crate) const MAGPIE_GROUP_FAMILIES: [GatewayFamily; 2] =
    [GatewayFamily::Claude, GatewayFamily::Codex];

struct GatewayProviderSpec<'a> {
    id: String,
    name: String,
    family: GatewayFamily,
    addr: &'a str,
    model: Option<String>,
    api_key: &'a str,
    origin: ProviderOriginKind,
    external_id: String,
}

fn gateway_provider(spec: GatewayProviderSpec<'_>) -> Provider {
    let models = spec
        .model
        .iter()
        .map(|id| ProviderModel {
            id: id.clone(),
            label: None,
            default_effort: None,
            context_window_tokens: None,
            context_size: None,
            hidden: false,
        })
        .collect();
    Provider {
        id: spec.id,
        name: spec.name,
        provider_type: spec.family.provider_type(),
        api_key: Some(spec.api_key.to_string()),
        models,
        default_model_id: spec.model,
        codex_wire_api: (spec.family == GatewayFamily::Codex).then(|| "responses".to_string()),
        is_default: false,
        endpoints: spec.family.endpoints(spec.addr),
        source: Some(ProviderOrigin {
            kind: spec.origin,
            external_id: Some(spec.external_id),
            imported_at: Some(chrono::Utc::now().to_rfc3339()),
            fingerprint: None,
        }),
        ..Provider::default()
    }
}

/// 把 `groups` 里的每个路由组按客户端族加进候选。
pub(super) fn push_magpie_group_candidates(root: &Value, gateway: &str, batch: &mut ExternalBatch) {
    let Some(groups) = root.get("groups").and_then(Value::as_array) else {
        return;
    };
    for group in groups {
        let Some(id) = str_field(group, "id") else {
            batch.skipped_empty += 1;
            continue;
        };
        let name = str_field(group, "name").unwrap_or_else(|| id.clone());
        let members: Vec<String> = group
            .get("members")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|member| !member.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let routing = str_field(group, "routing").unwrap_or_else(|| "smart".to_string());
        let relay = ExternalRelayInfo {
            kind: ExternalRelayKind::MagpieGroup,
            routing: Some(routing.clone()),
            member_count: Some(members.len()),
            note: format!(
                "路由组 · {routing} · {} 成员 · 依赖 Magpie 网关运行",
                members.len()
            ),
        };
        let external_id = format!("{MAGPIE_GROUP_EXTERNAL_PREFIX}{id}");
        for family in MAGPIE_GROUP_FAMILIES {
            let provider = gateway_provider(GatewayProviderSpec {
                id: magpie_provider_id(&format!("group-{id}"), family.provider_type()),
                // 两行同名会在列表里分不清；按族加后缀。去重看来源 id + 类型，改名不影响幂等。
                name: format!("{name} · {}", family.label()),
                family,
                addr: gateway,
                model: Some(format!("group/{id}")),
                api_key: MAGPIE_PLACEHOLDER_KEY,
                origin: ProviderOriginKind::Magpie,
                external_id: external_id.clone(),
            });
            batch.candidates.push(ExternalCandidate {
                key: format!("magpie:group:{id}:{}", type_id(provider.provider_type)),
                provider,
                profile: ImportedProfileHints::default(),
                relay: Some(relay.clone()),
            });
        }
    }
}

/// cc-switch `proxy_config` 里启用的一行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CcSwitchProxy {
    pub app_type: String,
    pub addr: String,
    pub port: u16,
    pub auto_failover: bool,
    /// 该 app 进了故障转移队列的供应商数。
    pub failover_members: Option<usize>,
}

fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return Vec::new();
    };
    stmt.query_map([], |row| row.get::<_, String>(1))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn failover_member_count(conn: &Connection, app_type: &str) -> Option<usize> {
    if !table_columns(conn, "providers")
        .iter()
        .any(|column| column == "in_failover_queue")
    {
        return None;
    }
    conn.query_row(
        "SELECT COUNT(*) FROM providers WHERE app_type = ?1 AND in_failover_queue != 0",
        [app_type],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .and_then(|count| usize::try_from(count).ok())
}

/// 读 cc-switch 启用的本地代理。表不存在（老版本）或读不出来就当没有，不报错。
pub(crate) fn load_cc_switch_proxies(db_path: &Path) -> Vec<CcSwitchProxy> {
    let Ok(conn) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let columns = table_columns(&conn, "proxy_config");
    if !columns.iter().any(|column| column == "app_type") {
        return Vec::new();
    }
    let flag = |name: &str| {
        if columns.iter().any(|column| column == name) {
            format!("COALESCE({name}, 0)")
        } else {
            "0".to_string()
        }
    };
    let text = |name: &str, default: &str| {
        if columns.iter().any(|column| column == name) {
            format!("CAST(COALESCE({name}, '{default}') AS TEXT)")
        } else {
            format!("'{default}'")
        }
    };
    let sql = format!(
        "SELECT app_type, {}, {}, {}, {}, {} FROM proxy_config",
        flag("proxy_enabled"),
        flag("enabled"),
        text("listen_address", "127.0.0.1"),
        text("listen_port", "15721"),
        flag("auto_failover_enabled"),
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let rows: Vec<(String, i64, i64, String, String, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    rows.into_iter()
        .filter(|(_, proxy_enabled, enabled, ..)| *proxy_enabled != 0 || *enabled != 0)
        .filter_map(|(app_type, _, _, address, port, failover)| {
            let port: u16 = port.trim().parse().ok()?;
            let addr = normalize_listen_addr(&format!("{}:{port}", address.trim()))?;
            Some(CcSwitchProxy {
                failover_members: failover_member_count(&conn, &app_type),
                app_type,
                addr,
                port,
                auto_failover: failover != 0,
            })
        })
        .collect()
}

/// 一条启用的 cc-switch 代理 → 指向它的中转站候选。不认识的 app 类型返回 `None`。
pub(crate) fn cc_switch_proxy_candidate(proxy: &CcSwitchProxy) -> Option<ExternalCandidate> {
    let app = proxy.app_type.trim().to_ascii_lowercase();
    let family = match app.as_str() {
        "claude" => GatewayFamily::Claude,
        "codex" => GatewayFamily::Codex,
        "gemini" => GatewayFamily::Gemini,
        _ => return None,
    };
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let provider = gateway_provider(GatewayProviderSpec {
        id: format!("ccsw-proxy-{app}-{suffix}"),
        name: format!("cc-switch 代理 ({})", family.label()),
        family,
        addr: &proxy.addr,
        model: None,
        api_key: CC_SWITCH_PROXY_PLACEHOLDER_KEY,
        origin: ProviderOriginKind::CcSwitch,
        external_id: format!("{CC_SWITCH_PROXY_EXTERNAL_PREFIX}{app}"),
    });
    Some(ExternalCandidate {
        key: format!("cc_switch:proxy:{app}"),
        provider,
        profile: ImportedProfileHints::default(),
        relay: Some(ExternalRelayInfo {
            kind: ExternalRelayKind::CcSwitchProxy,
            routing: proxy.auto_failover.then(|| "failover".to_string()),
            member_count: proxy.failover_members.filter(|count| *count > 0),
            note: "依赖 cc-switch 代理运行，故障转移由 cc-switch 处理".to_string(),
        }),
    })
}

/// cc-switch 普通条目是否是代理接管时写入的占位凭据：密钥像占位符，或地址指向本地代理端口。
pub fn is_cc_switch_proxy_placeholder(
    api_key: Option<&str>,
    base_url: Option<&str>,
    proxy_ports: &[u16],
) -> bool {
    let key_placeholder = api_key
        .map(|key| key.trim().to_ascii_lowercase())
        .is_some_and(|key| {
            key.contains("proxy_managed")
                || key.contains("proxy-managed")
                || key == "placeholder"
                || key == CC_SWITCH_PROXY_PLACEHOLDER_KEY
        });
    let url_is_proxy = base_url
        .and_then(loopback_host_port)
        .is_some_and(|(_, port)| {
            port == CC_SWITCH_DEFAULT_PROXY_PORT || proxy_ports.contains(&port)
        });
    key_placeholder || url_is_proxy
}

#[cfg(test)]
#[path = "relays_tests.rs"]
mod tests;
