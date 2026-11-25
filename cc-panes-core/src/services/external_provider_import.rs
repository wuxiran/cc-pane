//! 从外部工具（cc-switch / Magpie）导入供应商：先预览、再按勾选导入。单向复制，不做同步。
//!
//! 两个来源都先转成 CC-Panes 的 [`Provider`]，预览与导入共用同一份转换结果，
//! 保证「列表里看到的」就是「导入进去的」。
//!
//! Magpie（yetone/magpie）的中转站存在 `$XDG_CONFIG_HOME/magpie/providers.json`
//! （缺省 `~/.config/magpie/providers.json`），密钥是明文 `key`。它不分类型，
//! 按填了哪些接口（anthropic / responses / chat / gemini）决定协议；CC-Panes 的供应商
//! 是单类型的，所以一条 Magpie 中转站按协议族拆成至多三条（Claude / Codex / Gemini），
//! 由用户在预览里挑。登录账号（`logins.json`）只计数、不导入——那是别的 CLI 的明文凭据。
//!
//! Magpie 的**路由组**（`groups`：成员是 `<provider>/<model>`，指向订阅登录）只能经它的本地网关
//! 用：每个组固定导入成 Claude、Codex 两条指向网关的中转站，模型名 `group/<id>`，密钥是占位符（网关对
//! 回环地址不验令牌）。cc-switch 的**本地代理**（`proxy_config`）同理导入成指向代理的中转站；
//! 代理接管期间写进 CLI 配置的占位凭据不导入（见 [`is_cc_switch_proxy_placeholder`]）。

use crate::models::provider::{
    EndpointKind, Provider, ProviderEndpoints, ProviderModel, ProviderOrigin, ProviderOriginKind,
    ProviderType,
};
use crate::services::cc_switch_import::{
    candidate_to_provider, cc_switch_db_path, load_cc_switch_providers, ImportedProfileHints,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

mod relays;
use relays::{cc_switch_proxy_candidate, load_cc_switch_proxies, push_magpie_group_candidates};
pub use relays::{
    is_cc_switch_proxy_placeholder, read_magpie_gateway_addr, CC_SWITCH_PLACEHOLDER_REASON,
    CC_SWITCH_PROXY_PLACEHOLDER_KEY, MAGPIE_DEFAULT_GATEWAY, MAGPIE_PLACEHOLDER_KEY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalProviderSource {
    CcSwitch,
    Magpie,
}

/// 预览里的一行。不含密钥明文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProviderCandidateView {
    /// 预览与导入之间对上同一条的键。
    pub key: String,
    pub name: String,
    pub provider_type: ProviderType,
    /// 主接口地址（列表里显示用）。
    pub base_url: Option<String>,
    pub has_key: bool,
    pub model_count: usize,
    /// CC-Panes 里已经有了（同来源同编号，或同名同类型同地址）。
    pub duplicate: bool,
    /// 建议给运行配置的内容（片段 / YOLO / 模型 / 没导入的键）。不含密钥。
    #[serde(default)]
    pub profile: ImportedProfileHints,
    /// 中转站一层有原生配置片段。
    #[serde(default)]
    pub has_provider_native_override: bool,
    /// 导入模型的上下文窗口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    /// 已存在的中转站可以「补充原生配置」：它的片段为空、或模型缺上下文窗口，而来源里有。
    #[serde(default)]
    pub can_supplement_provider: bool,
    /// 已存在的中转站 id（`duplicate` 时）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_provider_id: Option<String>,
    /// 依赖本地网关的条目（Magpie 路由组 / cc-switch 代理）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<ExternalRelayInfo>,
}

/// 依赖本地网关运行的导入条目种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalRelayKind {
    MagpieGroup,
    CcSwitchProxy,
}

/// 依赖本地网关的条目的说明（路由方式 / 成员数 / 依赖什么在跑）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRelayInfo {
    pub kind: ExternalRelayKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<usize>,
    pub note: String,
}

/// 预览里被略过、且需要说明原因的一条（不含密钥）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSkippedItem {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProviderPreview {
    /// 来源文件存在。
    pub available: bool,
    pub path: Option<String>,
    pub candidates: Vec<ExternalProviderCandidateView>,
    pub skipped_empty: usize,
    pub skipped_unsupported: usize,
    /// 来源里有、但这一版不导入的登录账号数（Magpie `logins.json`）。
    pub unsupported_logins: usize,
    /// 带原因的略过项（如 cc-switch 代理占位凭据）。不计入上面两个计数。
    #[serde(default)]
    pub skipped_items: Vec<ExternalSkippedItem>,
}

/// 转换好的一条候选：键 + 将要写入的供应商。
pub struct ExternalCandidate {
    pub key: String,
    pub provider: Provider,
    pub profile: ImportedProfileHints,
    pub relay: Option<ExternalRelayInfo>,
}

pub struct ExternalBatch {
    pub candidates: Vec<ExternalCandidate>,
    pub skipped_empty: usize,
    pub skipped_unsupported: usize,
    pub unsupported_logins: usize,
    pub skipped_items: Vec<ExternalSkippedItem>,
}

pub fn default_source_path(source: ExternalProviderSource) -> Option<PathBuf> {
    match source {
        ExternalProviderSource::CcSwitch => cc_switch_db_path(),
        ExternalProviderSource::Magpie => magpie_config_dir().map(|dir| dir.join("providers.json")),
    }
}

/// Magpie 的配置目录：绝对路径的 `$XDG_CONFIG_HOME/magpie`，否则 `~/.config/magpie`（各平台同一套）。
pub fn magpie_config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return Some(xdg.join("magpie"));
        }
    }
    dirs::home_dir().map(|home| home.join(".config").join("magpie"))
}

pub fn load_external_batch(source: ExternalProviderSource, path: &Path) -> Result<ExternalBatch> {
    match source {
        ExternalProviderSource::CcSwitch => {
            let batch = load_cc_switch_providers(path)?;
            let proxies = load_cc_switch_proxies(path);
            let proxy_ports: Vec<u16> = proxies.iter().map(|proxy| proxy.port).collect();
            let mut skipped_items = Vec::new();
            let mut candidates: Vec<ExternalCandidate> = batch
                .candidates
                .iter()
                .filter(|candidate| {
                    let placeholder = is_cc_switch_proxy_placeholder(
                        candidate.api_key.as_deref(),
                        candidate.base_url.as_deref(),
                        &proxy_ports,
                    );
                    if placeholder {
                        skipped_items.push(ExternalSkippedItem {
                            name: candidate.name.clone(),
                            reason: CC_SWITCH_PLACEHOLDER_REASON.to_string(),
                        });
                    }
                    !placeholder
                })
                .map(|candidate| {
                    let mut provider = candidate_to_provider(candidate);
                    provider.source = Some(ProviderOrigin {
                        kind: ProviderOriginKind::CcSwitch,
                        external_id: None,
                        imported_at: Some(chrono::Utc::now().to_rfc3339()),
                        fingerprint: None,
                    });
                    ExternalCandidate {
                        key: format!(
                            "cc_switch:{}:{}:{}",
                            type_id(provider.provider_type),
                            provider.name,
                            provider.base_url.as_deref().unwrap_or("")
                        ),
                        provider,
                        profile: candidate.profile.clone(),
                        relay: None,
                    }
                })
                .collect();
            candidates.extend(proxies.iter().filter_map(cc_switch_proxy_candidate));
            Ok(ExternalBatch {
                candidates,
                skipped_empty: batch.skipped_empty,
                skipped_unsupported: batch.skipped_unsupported,
                unsupported_logins: 0,
                skipped_items,
            })
        }
        ExternalProviderSource::Magpie => {
            let raw = std::fs::read_to_string(path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            let gateway = path
                .parent()
                .map(read_magpie_gateway_addr)
                .unwrap_or_else(|| MAGPIE_DEFAULT_GATEWAY.to_string());
            let mut batch = parse_magpie_providers_with_gateway(&raw, &gateway)?;
            batch.unsupported_logins = path
                .parent()
                .map(|dir| count_magpie_logins(&dir.join("logins.json")))
                .unwrap_or(0);
            Ok(batch)
        }
    }
}

fn count_magpie_logins(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(strip_bom(&raw)).ok())
        .and_then(|value| value.as_array().map(Vec::len))
        .unwrap_or(0)
}

fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

/// 解析 Magpie `providers.json`（网关按默认地址）。
pub fn parse_magpie_providers(raw: &str) -> Result<ExternalBatch> {
    parse_magpie_providers_with_gateway(raw, MAGPIE_DEFAULT_GATEWAY)
}

/// 解析 Magpie `providers.json`。只读用得到的字段，其余（费率、并发、余额……）忽略。
/// `gateway` 是网关的 `host:port`，路由组的中转站指向它。
pub fn parse_magpie_providers_with_gateway(raw: &str, gateway: &str) -> Result<ExternalBatch> {
    // 不在报错里回显内容：文件里有明文密钥。
    let root: Value = serde_json::from_str(strip_bom(raw))
        .map_err(|_| anyhow::anyhow!("Magpie providers.json is not valid JSON"))?;
    let entries = root
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut batch = ExternalBatch {
        candidates: Vec::new(),
        skipped_empty: 0,
        skipped_unsupported: 0,
        unsupported_logins: 0,
        skipped_items: Vec::new(),
    };
    for entry in &entries {
        let name = str_field(entry, "name").or_else(|| str_field(entry, "id"));
        let Some(name) = name else {
            batch.skipped_empty += 1;
            continue;
        };
        let external_id = str_field(entry, "id").unwrap_or_else(|| name.clone());
        let endpoints = ProviderEndpoints {
            anthropic: str_field(entry, "anthropic"),
            chat: str_field(entry, "chat"),
            responses: str_field(entry, "responses"),
            gemini: str_field(entry, "gemini"),
        };
        if endpoints.is_empty() {
            // 只有 vertex / baseAPI 之类的：CC-Panes 没有对应的接口槽
            batch.skipped_unsupported += 1;
            continue;
        }
        let api_key = str_field(entry, "key").or_else(|| {
            entry
                .get("keys")
                .and_then(Value::as_array)
                .and_then(|keys| keys.iter().find_map(|item| str_field(item, "key")))
        });
        let models = magpie_models(entry);

        let mut families: Vec<(ProviderType, &str, Option<&str>)> = Vec::new();
        if endpoints.anthropic.is_some() {
            families.push((ProviderType::Anthropic, "Claude", None));
        }
        if endpoints.responses.is_some() || endpoints.chat.is_some() {
            let wire = if endpoints.responses.is_some() {
                "responses"
            } else {
                "chat"
            };
            families.push((ProviderType::OpenAI, "Codex", Some(wire)));
        }
        if endpoints.gemini.is_some() {
            families.push((ProviderType::Gemini, "Gemini", None));
        }
        let split = families.len() > 1;
        for (provider_type, family_label, wire) in families {
            let display_name = if split {
                format!("{name} ({family_label})")
            } else {
                name.clone()
            };
            let provider = Provider {
                id: magpie_provider_id(&external_id, provider_type),
                name: display_name,
                provider_type,
                api_key: api_key.clone(),
                models: models.clone(),
                default_model_id: None,
                codex_wire_api: wire.map(str::to_string),
                is_default: false,
                endpoints: endpoints.clone(),
                source: Some(ProviderOrigin {
                    kind: ProviderOriginKind::Magpie,
                    external_id: Some(external_id.clone()),
                    imported_at: Some(chrono::Utc::now().to_rfc3339()),
                    fingerprint: None,
                }),
                ..Provider::default()
            };
            batch.candidates.push(ExternalCandidate {
                key: format!("magpie:{external_id}:{}", type_id(provider_type)),
                provider,
                profile: ImportedProfileHints::default(),
                relay: None,
            });
        }
    }
    push_magpie_group_candidates(&root, gateway, &mut batch);
    Ok(batch)
}

/// 类型的序列化 id（`open_ai` 等），用作键与 id 片段。
fn type_id(provider_type: ProviderType) -> String {
    serde_json::to_value(provider_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// `models` 可能是字符串数组，也可能是带 `id` / `name` 的对象数组：两种都认。
fn magpie_models(entry: &Value) -> Vec<ProviderModel> {
    entry
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_string)
                        .or_else(|| str_field(item, "id"))
                        .or_else(|| str_field(item, "name"))
                })
                .map(|id| ProviderModel {
                    id,
                    label: None,
                    default_effort: None,
                    context_window_tokens: None,
                    context_size: None,
                    hidden: false,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn magpie_provider_id(external_id: &str, provider_type: ProviderType) -> String {
    let slug: String = external_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "provider" } else { slug };
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    format!("magpie-{slug}-{}-{suffix}", type_id(provider_type))
}

/// 供应商的主接口地址：优先 `endpoints` 里类型对应那一项，退回兼容字段 `base_url`。
pub fn primary_url(provider: &Provider) -> Option<String> {
    let kind: EndpointKind = provider.primary_endpoint_kind();
    provider
        .endpoints
        .get(kind)
        .map(str::to_string)
        .or_else(|| provider.base_url.clone())
        .map(|url| url.trim().trim_end_matches('/').to_string())
}

/// 「补充原生配置」：把候选里的片段 / 上下文窗口填进已存在的中转站，只填空的，绝不覆盖。
/// 返回是否有改动。
pub fn supplement_native_fields(existing: &mut Provider, candidate: &Provider) -> bool {
    let mut changed = false;
    for (tool, fragment) in &candidate.native_overrides {
        let empty = existing
            .native_overrides
            .get(tool)
            .is_none_or(|text| text.trim().is_empty());
        if empty && !fragment.trim().is_empty() {
            existing
                .native_overrides
                .insert(tool.clone(), fragment.clone());
            changed = true;
        }
    }
    for model in &candidate.models {
        let Some(tokens) = model.context_window_tokens else {
            continue;
        };
        if let Some(target) = existing
            .models
            .iter_mut()
            .find(|item| item.id == model.id && item.context_window_tokens.is_none())
        {
            target.context_window_tokens = Some(tokens);
            changed = true;
        }
    }
    changed
}

/// 已存在判定：同来源同编号同类型，或同名同类型同主地址。
pub fn is_same_provider(existing: &Provider, candidate: &Provider) -> bool {
    if existing.provider_type != candidate.provider_type {
        return false;
    }
    if let (Some(a), Some(b)) = (&existing.source, &candidate.source) {
        if a.kind == b.kind && a.external_id.is_some() && a.external_id == b.external_id {
            return true;
        }
    }
    existing.name == candidate.name && primary_url(existing) == primary_url(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magpie_multi_protocol_relay_splits_by_family_and_keeps_all_endpoints() {
        let raw = r#"{"providers":[{"id":"myrelay","name":"My Relay","key":"sk-x",
            "anthropic":"https://relay.example.com","chat":"https://relay.example.com/v1",
            "models":["claude-sonnet-4-5",{"id":"gpt-5"}],"headers":{"X":"y"}}],"groups":[]}"#;
        let batch = parse_magpie_providers(raw).unwrap();
        assert_eq!(batch.candidates.len(), 2);
        let claude = &batch.candidates[0].provider;
        assert_eq!(claude.provider_type, ProviderType::Anthropic);
        assert_eq!(claude.name, "My Relay (Claude)");
        assert_eq!(claude.api_key.as_deref(), Some("sk-x"));
        assert_eq!(claude.models.len(), 2);
        let codex = &batch.candidates[1].provider;
        assert_eq!(codex.provider_type, ProviderType::OpenAI);
        assert_eq!(codex.codex_wire_api.as_deref(), Some("chat"));
        assert_eq!(
            codex.endpoints.chat.as_deref(),
            Some("https://relay.example.com/v1")
        );
        assert_eq!(
            codex.source.as_ref().and_then(|s| s.external_id.as_deref()),
            Some("myrelay")
        );
        assert_ne!(batch.candidates[0].key, batch.candidates[1].key);
    }

    #[test]
    fn magpie_single_protocol_keeps_plain_name_and_skips_unusable_entries() {
        let raw = "\u{feff}{\"providers\":[{\"id\":\"a\",\"name\":\"A\",\"gemini\":\"https://g\"},{\"id\":\"v\",\"vertex\":{}},{\"key\":\"k\"}]}";
        let batch = parse_magpie_providers(raw).unwrap();
        assert_eq!(batch.candidates.len(), 1);
        assert_eq!(batch.candidates[0].provider.name, "A");
        assert_eq!(
            batch.candidates[0].provider.provider_type,
            ProviderType::Gemini
        );
        assert_eq!(batch.skipped_unsupported, 1);
        assert_eq!(batch.skipped_empty, 1);
    }

    #[test]
    fn magpie_invalid_json_error_does_not_echo_content() {
        let err = parse_magpie_providers("{\"key\":\"sk-secret\"")
            .err()
            .unwrap();
        assert!(!err.to_string().contains("sk-secret"));
    }

    #[test]
    fn same_provider_matches_by_source_id_or_name_and_url() {
        let batch = parse_magpie_providers(
            r#"{"providers":[{"id":"r","name":"R","anthropic":"https://x/"}]}"#,
        )
        .unwrap();
        let candidate = &batch.candidates[0].provider;
        let mut existing = candidate.clone();
        existing.name = "Renamed".into();
        assert!(is_same_provider(&existing, candidate));
        existing.source = None;
        assert!(!is_same_provider(&existing, candidate));
        existing.name = "R".into();
        existing.endpoints.anthropic = Some("https://x".into());
        assert!(is_same_provider(&existing, candidate));
    }

    #[test]
    fn supplement_fills_only_empty_fragments_and_missing_windows() {
        let mut candidate = Provider {
            models: vec![ProviderModel {
                id: "m".into(),
                context_window_tokens: Some(1_000_000),
                ..ProviderModel::default()
            }],
            ..Provider::default()
        };
        candidate
            .native_overrides
            .insert("codex".into(), "disable_response_storage = true".into());
        let mut existing = Provider {
            models: vec![ProviderModel {
                id: "m".into(),
                ..ProviderModel::default()
            }],
            ..Provider::default()
        };
        assert!(supplement_native_fields(&mut existing, &candidate));
        assert_eq!(existing.models[0].context_window_tokens, Some(1_000_000));
        assert_eq!(
            existing.native_overrides.get("codex").map(String::as_str),
            Some("disable_response_storage = true")
        );
        // 第二次：已经不空，不再改
        assert!(!supplement_native_fields(&mut existing, &candidate));

        let mut user_edited = existing.clone();
        user_edited
            .native_overrides
            .insert("codex".into(), "service_tier = \"flex\"".into());
        user_edited.models[0].context_window_tokens = Some(5);
        assert!(!supplement_native_fields(&mut user_edited, &candidate));
        assert_eq!(user_edited.models[0].context_window_tokens, Some(5));
        assert!(user_edited.native_overrides["codex"].contains("flex"));
    }
}
