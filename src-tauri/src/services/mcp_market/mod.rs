//! MCP 发现市场：精选清单 + Registry 热门快照 + 官方 Registry 联网搜索。
//! 数据和转换规则移植自 magpie（见同目录 LICENSE-magpie）。空查询完全不联网。
use crate::utils::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

const REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0/servers";
const REGISTRY_STATUS_KEY: &str = "io.modelcontextprotocol.registry/official";
const MAX_SEARCH_RESULTS: usize = 100;
const ICON_MAX_BYTES: usize = 512 * 1024;
const MAX_OFFERED_ICONS: usize = 4000;

/// 用户添加前要填的值：环境变量、请求头或命令参数
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MarketInput {
    pub key: String,
    /// `env`、`header` 或 `arg`
    #[serde(rename = "where")]
    pub location: String,
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub placeholder: String,
    pub secret: bool,
    pub required: bool,
    /// 请求头的值模板，如 `Bearer {}`
    #[serde(skip_serializing_if = "String::is_empty")]
    pub format: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpMarketServer {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description_zh: String,
    pub publisher: String,
    pub icon: String,
    pub homepage: String,
    /// `stdio`、`http` 或 `sse`
    pub transport: String,
    /// 本地服务器的启动方式：npx、uvx 或 docker
    pub runs: String,
    /// 远程服务器首次使用时由 Agent 在浏览器里登录
    pub sign_in: bool,
    pub featured: bool,
    pub inputs: Vec<MarketInput>,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMarketResult {
    pub servers: Vec<McpMarketServer>,
    /// 联网搜索失败，当前只有本地结果
    pub partial: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RegistryVar {
    name: String,
    value: String,
    description: String,
    is_required: bool,
    is_secret: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RegistryRepository {
    url: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RegistryIcon {
    src: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RegistryRemote {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    headers: Vec<RegistryVar>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RegistryTransport {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RegistryArgument {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    value: String,
    default: String,
    value_hint: String,
    description: String,
    is_required: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RegistryPackage {
    registry_type: String,
    identifier: String,
    transport: RegistryTransport,
    environment_variables: Vec<RegistryVar>,
    package_arguments: Vec<RegistryArgument>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RegistryServer {
    name: String,
    title: String,
    description: String,
    website_url: String,
    repository: RegistryRepository,
    icons: Vec<RegistryIcon>,
    remotes: Vec<RegistryRemote>,
    packages: Vec<RegistryPackage>,
}

fn has_placeholder(value: &str) -> bool {
    value
        .find('{')
        .is_some_and(|start| value[start..].find('}').is_some())
}

/// 把 `{xxx}` 占位替换成模板里的 `{}`
fn placeholder_format(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('{') {
        let Some(end) = rest[start..].find('}') else {
            break;
        };
        out.push_str(&rest[..start]);
        out.push_str("{}");
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out
}

/// io.github.upstash/context7-mcp → context7
fn short_name(registry_name: &str) -> String {
    let lower = registry_name
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let mut name = lower.as_str();
    for prefix in ["mcp-server-", "server-", "mcp-"] {
        name = name.strip_prefix(prefix).unwrap_or(name);
    }
    for suffix in ["-mcp-server", "-mcp", "-server", "_mcp", ".mcp"] {
        name = name.strip_suffix(suffix).unwrap_or(name);
    }
    if name.is_empty() {
        name = lower.as_str();
    }
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '-' || c == '_');
    let bounded: String = trimmed.chars().take(64).collect();
    if bounded.is_empty() {
        "server".to_string()
    } else {
        bounded
    }
}

fn github_owner(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("https://www.github.com/"))?;
    let owner = rest.split('/').next()?;
    (!owner.is_empty()).then(|| owner.to_string())
}

fn from_registry(registry: &RegistryServer) -> Option<McpMarketServer> {
    let name = short_name(&registry.name);
    let owner = github_owner(&registry.repository.url).or_else(|| {
        let rest = registry.name.strip_prefix("io.github.")?;
        Some(rest.split('/').next()?.to_string())
    });
    let publisher = owner.clone().unwrap_or_else(|| {
        let namespace = registry.name.split('/').next().unwrap_or_default();
        namespace.split('.').rev().collect::<Vec<_>>().join(".")
    });
    let icon = registry
        .icons
        .iter()
        .find(|icon| icon.src.starts_with("https://"))
        .map(|icon| icon.src.clone())
        .or_else(|| {
            owner
                .as_ref()
                .map(|owner| format!("https://github.com/{owner}.png?size=96"))
        })
        .unwrap_or_default();
    let mut server = McpMarketServer {
        id: registry.name.clone(),
        title: if registry.title.is_empty() {
            name.clone()
        } else {
            registry.title.clone()
        },
        name,
        description: registry.description.clone(),
        homepage: if registry.website_url.is_empty() {
            registry.repository.url.clone()
        } else {
            registry.website_url.clone()
        },
        publisher,
        icon,
        ..Default::default()
    };

    for (kind, transport) in [("streamable-http", "http"), ("sse", "sse")] {
        for remote in &registry.remotes {
            if remote.kind != kind
                || remote.url.contains('{')
                || !remote.url.starts_with("https://")
            {
                continue;
            }
            server.transport = transport.to_string();
            server.url = remote.url.clone();
            for header in &remote.headers {
                if !header.value.is_empty() && !has_placeholder(&header.value) {
                    server
                        .headers
                        .insert(header.name.clone(), header.value.clone());
                } else if header.is_required || header.is_secret {
                    server.inputs.push(MarketInput {
                        key: header.name.clone(),
                        location: "header".to_string(),
                        label: header.name.clone(),
                        description: header.description.clone(),
                        secret: header.is_secret,
                        required: header.is_required,
                        format: if header.value.is_empty() {
                            "{}".to_string()
                        } else {
                            placeholder_format(&header.value)
                        },
                        ..Default::default()
                    });
                }
            }
            return Some(server);
        }
    }

    for wanted in ["npm", "pypi", "oci"] {
        for package in &registry.packages {
            let stdio = package.transport.kind.is_empty() || package.transport.kind == "stdio";
            if package.registry_type != wanted || package.identifier.is_empty() || !stdio {
                continue;
            }
            server.transport = "stdio".to_string();
            (server.command, server.args) = match wanted {
                "npm" => (
                    "npx".to_string(),
                    vec!["-y".to_string(), package.identifier.clone()],
                ),
                "pypi" => ("uvx".to_string(), vec![package.identifier.clone()]),
                _ => (
                    "docker".to_string(),
                    vec!["run".to_string(), "-i".to_string(), "--rm".to_string()],
                ),
            };
            server.runs = server.command.clone();
            for env in &package.environment_variables {
                if !env.is_required && !env.is_secret {
                    continue;
                }
                server.inputs.push(MarketInput {
                    key: env.name.clone(),
                    location: "env".to_string(),
                    label: env.name.clone(),
                    description: env.description.clone(),
                    secret: env.is_secret,
                    required: env.is_required,
                    ..Default::default()
                });
                if wanted == "oci" {
                    server.args.push("-e".to_string());
                    server.args.push(env.name.clone());
                }
            }
            if wanted == "oci" {
                server.args.push(package.identifier.clone());
            }
            for (index, argument) in package.package_arguments.iter().enumerate() {
                let mut value = if argument.value.is_empty() {
                    &argument.default
                } else {
                    &argument.value
                };
                let empty = String::new();
                if has_placeholder(value) {
                    value = &empty;
                }
                let named = argument.kind == "named";
                if !value.is_empty() {
                    if named {
                        server.args.push(argument.name.clone());
                    }
                    server.args.push(value.clone());
                } else if argument.is_required {
                    if named {
                        return None; // 必填的具名参数没法用单个输入框表达
                    }
                    server.inputs.push(MarketInput {
                        key: format!("arg{index}"),
                        location: "arg".to_string(),
                        label: if argument.value_hint.is_empty() {
                            format!("Argument {}", index + 1)
                        } else {
                            argument.value_hint.clone()
                        },
                        description: argument.description.clone(),
                        required: true,
                        ..Default::default()
                    });
                }
            }
            return Some(server);
        }
    }
    None
}

/// 同一个服务器的身份：远程看 URL，本地看命令和包名（去掉版本）
fn server_key(server: &McpMarketServer) -> String {
    if !server.url.is_empty() {
        return server.url.trim_end_matches('/').to_lowercase();
    }
    let package = server
        .args
        .iter()
        .find(|arg| !arg.is_empty() && !arg.starts_with('-') && arg.as_str() != "run")
        .map(|arg| match arg.rfind('@') {
            Some(at) if at > 0 => &arg[..at],
            _ => arg.as_str(),
        })
        .unwrap_or_default();
    format!("{} {}", server.command, package)
}

fn matches_query(server: &McpMarketServer, query: &str) -> bool {
    [
        &server.name,
        &server.title,
        &server.description,
        &server.description_zh,
        &server.publisher,
    ]
    .iter()
    .any(|field| field.to_lowercase().contains(query))
}

fn rank(registry: &RegistryServer, server: &McpMarketServer, query: &str) -> i32 {
    let short = registry
        .name
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let title = registry.title.to_lowercase();
    let mut score = 0;
    if server.name == query || title == query || short == query {
        score += 100;
    } else if short.contains(query) {
        score += 40;
    }
    if title.contains(query) {
        score += 20;
    }
    if registry.description.to_lowercase().contains(query) {
        score += 10;
    }
    if !registry.icons.is_empty() {
        score += 8;
    }
    if !registry.repository.url.is_empty() {
        score += 5;
    }
    if registry.name.starts_with("ai.smithery/") {
        score -= 60;
    }
    score
}

fn curated() -> &'static [McpMarketServer] {
    static CURATED: OnceLock<Vec<McpMarketServer>> = OnceLock::new();
    CURATED.get_or_init(|| {
        let mut list: Vec<McpMarketServer> =
            serde_json::from_str(include_str!("curated.json")).expect("curated.json must parse");
        for server in &mut list {
            server.featured = true;
        }
        list
    })
}

fn popular() -> &'static [McpMarketServer] {
    static POPULAR: OnceLock<Vec<McpMarketServer>> = OnceLock::new();
    POPULAR.get_or_init(|| {
        let snapshot: Vec<RegistryServer> =
            serde_json::from_str(include_str!("registry_snapshot.json"))
                .expect("registry_snapshot.json must parse");
        let mut seen: HashSet<String> = curated().iter().map(server_key).collect();
        snapshot
            .iter()
            .filter_map(from_registry)
            .filter(|server| seen.insert(server_key(server)))
            .collect()
    })
}

pub struct McpMarketService {
    client: reqwest::Client,
    icon_client: reqwest::Client,
    icons_dir: PathBuf,
    icon_slots: Semaphore,
    /// 只代理市场给过的图标地址，避免这个命令被当成任意 URL 抓取器
    offered_icons: Mutex<HashSet<String>>,
}

impl McpMarketService {
    pub fn new(icons_dir: PathBuf) -> Self {
        let build = |seconds| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(seconds))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        };
        Self {
            // Registry 实测可能要 13-37 秒才返回
            client: build(60),
            icon_client: build(15),
            icons_dir,
            icon_slots: Semaphore::new(6),
            offered_icons: Mutex::new(HashSet::new()),
        }
    }

    fn remember_icons(&self, servers: &[McpMarketServer]) {
        if let Ok(mut offered) = self.offered_icons.lock() {
            if offered.len() > MAX_OFFERED_ICONS {
                offered.clear();
            }
            offered.extend(
                servers
                    .iter()
                    .filter(|s| !s.icon.is_empty())
                    .map(|s| s.icon.clone()),
            );
        }
    }

    pub async fn search(&self, query: &str) -> McpMarketResult {
        let needle = query.trim().to_lowercase();
        let local: Vec<McpMarketServer> = curated()
            .iter()
            .chain(popular().iter())
            .filter(|server| needle.is_empty() || matches_query(server, &needle))
            .cloned()
            .collect();
        if needle.is_empty() {
            self.remember_icons(&local);
            return McpMarketResult {
                servers: local,
                partial: false,
                error: None,
            };
        }
        let (remote, error) = match self.fetch_registry(&needle).await {
            Ok(list) => (list, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        // 精选排最前，然后是 Registry 的结果，最后是本地热门
        let mut seen = HashSet::new();
        let (featured, rest): (Vec<_>, Vec<_>) =
            local.into_iter().partition(|server| server.featured);
        let servers: Vec<McpMarketServer> = featured
            .into_iter()
            .chain(remote)
            .chain(rest)
            .filter(|server| seen.insert(server_key(server)))
            .collect();
        self.remember_icons(&servers);
        McpMarketResult {
            partial: error.is_some(),
            servers,
            error,
        }
    }

    async fn fetch_registry(&self, query: &str) -> Result<Vec<McpMarketServer>, String> {
        let url = reqwest::Url::parse_with_params(
            REGISTRY_URL,
            &[("search", query), ("limit", "100"), ("version", "latest")],
        )
        .map_err(|error| error.to_string())?;
        let body: serde_json::Value = self
            .client
            .get(url)
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        Ok(parse_registry_response(&body, query))
    }

    /// 返回图标的 data URL，磁盘缓存；CSP 不允许页面直接加载外部图片。失败返回 None，页面显示首字母。
    pub async fn icon(&self, url: &str) -> AppResult<Option<String>> {
        let offered = self
            .offered_icons
            .lock()
            .map(|set| set.contains(url))
            .unwrap_or(false);
        if !offered || !url.starts_with("https://") {
            return Err(AppError::from("Icon URL was not offered by the market"));
        }
        let path = self.icons_dir.join(icon_cache_name(url));
        if let Ok(cached) = tokio::fs::read_to_string(&path).await {
            return Ok((!cached.is_empty()).then_some(cached));
        }
        let Ok(_slot) = self.icon_slots.acquire().await else {
            return Ok(None);
        };
        let data_url = self.fetch_icon(url).await;
        if let Err(error) = tokio::fs::create_dir_all(&self.icons_dir).await {
            tracing::debug!("[mcp-market] icon cache dir: {error}");
        } else if let Some(data_url) = &data_url {
            if let Err(error) = tokio::fs::write(&path, data_url).await {
                tracing::debug!("[mcp-market] icon cache write: {error}");
            }
        }
        Ok(data_url)
    }

    async fn fetch_icon(&self, url: &str) -> Option<String> {
        use base64::Engine;
        let response = self
            .icon_client
            .get(url)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()?
            .trim()
            .to_string();
        if !content_type.starts_with("image/") {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        if bytes.len() > ICON_MAX_BYTES {
            return None;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Some(format!("data:{content_type};base64,{encoded}"))
    }
}

fn icon_cache_name(url: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}.txt", Sha256::digest(url.as_bytes()))
}

fn parse_registry_response(body: &serde_json::Value, query: &str) -> Vec<McpMarketServer> {
    let mut scored: Vec<(i32, McpMarketServer)> = Vec::new();
    let mut seen = HashSet::new();
    let entries = body
        .get("servers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in entries {
        let status = entry
            .pointer("/_meta")
            .and_then(|meta| meta.get(REGISTRY_STATUS_KEY))
            .and_then(|meta| meta.get("status"))
            .and_then(|status| status.as_str())
            .unwrap_or_default();
        if !status.is_empty() && status != "active" {
            continue;
        }
        let Some(raw) = entry.get("server") else {
            continue;
        };
        let Ok(registry) = serde_json::from_value::<RegistryServer>(raw.clone()) else {
            continue;
        };
        if let Some(server) = from_registry(&registry) {
            if seen.insert(server_key(&server)) {
                scored.push((rank(&registry, &server, query), server));
            }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(MAX_SEARCH_RESULTS)
        .map(|(_, server)| server)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_has_no_magpie_servers_and_every_entry_can_be_installed() {
        assert_eq!(curated().len(), 27);
        for server in curated() {
            assert!(!server.id.starts_with("magpie"), "{}", server.id);
            assert!(!server.description_zh.is_empty(), "{}", server.id);
            assert!(
                !server.url.is_empty() || !server.command.is_empty(),
                "{} has nothing to run",
                server.id
            );
        }
    }

    #[test]
    fn popular_snapshot_converts_and_dedupes_against_curated() {
        let list = popular();
        assert!(list.len() > 300, "only {} converted", list.len());
        let curated_keys: HashSet<String> = curated().iter().map(server_key).collect();
        assert!(list
            .iter()
            .all(|server| !curated_keys.contains(&server_key(server))));
    }

    #[test]
    fn short_name_strips_mcp_affixes() {
        assert_eq!(short_name("io.github.upstash/context7-mcp"), "context7");
        assert_eq!(short_name("x/mcp-server-postgres"), "postgres");
        assert_eq!(short_name("x/@@@"), "server");
    }

    #[test]
    fn registry_prefers_remote_and_turns_placeholders_into_inputs() {
        let registry: RegistryServer = serde_json::from_value(serde_json::json!({
            "name": "io.github.acme/foo-mcp",
            "repository": { "url": "https://github.com/acme/foo" },
            "remotes": [{ "type": "streamable-http", "url": "https://foo.dev/mcp", "headers": [
                { "name": "Authorization", "value": "Bearer {token}", "isRequired": true, "isSecret": true },
                { "name": "X-Fixed", "value": "1" }
            ]}],
            "packages": [{ "registryType": "npm", "identifier": "foo" }]
        }))
        .unwrap();
        let server = from_registry(&registry).unwrap();
        assert_eq!(server.name, "foo");
        assert_eq!(server.transport, "http");
        assert_eq!(server.headers.get("X-Fixed").map(String::as_str), Some("1"));
        assert_eq!(server.inputs[0].format, "Bearer {}");
        assert!(server.inputs[0].secret);
        assert_eq!(server.icon, "https://github.com/acme.png?size=96");
    }

    #[test]
    fn registry_package_rules() {
        let required_named: RegistryServer = serde_json::from_value(serde_json::json!({
            "name": "a/b",
            "packages": [{ "registryType": "npm", "identifier": "b",
              "packageArguments": [{ "type": "named", "name": "--key", "isRequired": true }] }]
        }))
        .unwrap();
        assert!(from_registry(&required_named).is_none());

        let oci: RegistryServer = serde_json::from_value(serde_json::json!({
            "name": "a/c",
            "packages": [{ "registryType": "oci", "identifier": "img",
              "environmentVariables": [{ "name": "K", "isRequired": true, "isSecret": true }] }]
        }))
        .unwrap();
        let server = from_registry(&oci).unwrap();
        assert_eq!(server.args, vec!["run", "-i", "--rm", "-e", "K", "img"]);
        assert_eq!(server.runs, "docker");
    }

    #[test]
    fn registry_response_drops_inactive_and_ranks_exact_name_first() {
        let body = serde_json::json!({ "servers": [
            { "server": { "name": "a/postgres-helper", "packages": [{ "registryType": "npm", "identifier": "h" }] } },
            { "server": { "name": "b/postgres", "packages": [{ "registryType": "npm", "identifier": "p" }] } },
            { "server": { "name": "c/postgres-old", "packages": [{ "registryType": "npm", "identifier": "o" }] },
              "_meta": { REGISTRY_STATUS_KEY: { "status": "deleted" } } }
        ]});
        let names: Vec<String> = parse_registry_response(&body, "postgres")
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["postgres", "postgres-helper"]);
    }

    #[tokio::test]
    async fn empty_query_needs_no_network_and_icon_rejects_unknown_urls() {
        let dir = tempfile::tempdir().unwrap();
        let service = McpMarketService::new(dir.path().to_path_buf());
        let result = service.search("  ").await;
        assert!(!result.partial);
        assert!(result.servers[0].featured);
        assert!(service.icon("https://evil.example/x.png").await.is_err());
    }
}
