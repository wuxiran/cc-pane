use std::collections::HashMap;
use std::fmt;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

pub const ORCHESTRATOR_SERVICE: &str = "cc-panes-orchestrator";
pub const DAEMON_SERVICE: &str = "cc-panes-daemon";
pub const ORCHESTRATOR_MANIFEST_FILE: &str = "mcp-orchestrator.json";
pub const DAEMON_MANIFEST_FILE: &str = "daemon-manifest.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceKind {
    Orchestrator,
    Daemon,
}

impl ServiceKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Orchestrator => ORCHESTRATOR_SERVICE,
            Self::Daemon => DAEMON_SERVICE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceEndpoint {
    pub kind: ServiceKind,
    pub base_url: String,
    pub token: String,
    pub pid: u32,
    pub started_at: u64,
    pub data_dir: PathBuf,
    /// 身份核对置信度：`Legacy` 表示对面是未上报身份字段的旧版服务。
    pub identity: IdentityConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryError(String);

impl DiscoveryError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DiscoveryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataDirMode {
    Auto,
    Dev,
    Release,
    Custom(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceKind {
    Dev,
    Release,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirCandidate {
    pub kind: InstanceKind,
    pub path: PathBuf,
}

/// 解析命令所需的数据目录。显式模式优先；auto 在管控会话内优先服从
/// `CC_PANES_DATA_DIR`，否则同时返回 release/dev，供只读命令聚合或写命令消歧。
pub fn data_dir_candidates(mode: &DataDirMode) -> Result<Vec<DataDirCandidate>, DiscoveryError> {
    let home = || {
        dirs::home_dir().ok_or_else(|| DiscoveryError::new("无法确定用户主目录，请使用 --data-dir"))
    };
    let candidates = match mode {
        DataDirMode::Custom(path) => vec![DataDirCandidate {
            kind: InstanceKind::Custom,
            path: path.clone(),
        }],
        DataDirMode::Dev => vec![DataDirCandidate {
            kind: InstanceKind::Dev,
            path: home()?.join(".cc-panes-dev"),
        }],
        DataDirMode::Release => vec![DataDirCandidate {
            kind: InstanceKind::Release,
            path: home()?.join(".cc-panes"),
        }],
        DataDirMode::Auto => {
            if let Some(path) = non_empty_var("CC_PANES_DATA_DIR") {
                vec![DataDirCandidate {
                    kind: InstanceKind::Custom,
                    path: PathBuf::from(path),
                }]
            } else {
                let home = home()?;
                vec![
                    DataDirCandidate {
                        kind: InstanceKind::Release,
                        path: home.join(".cc-panes"),
                    },
                    DataDirCandidate {
                        kind: InstanceKind::Dev,
                        path: home.join(".cc-panes-dev"),
                    },
                ]
            }
        }
    };
    Ok(candidates)
}

/// 从 cli-hook 抽出的 orchestrator 端点解析。行为刻意保持不变：
/// env -> 探活 -> manifest -> 原始 env 兜底，并保留 WSL host 改写。
pub fn resolve_orchestrator_endpoint() -> Option<(String, String)> {
    let env_candidate = endpoint_candidate_from_env();
    if let Some(candidate) = env_candidate.clone() {
        if let Some(adapted) = adapt_candidate_for_current_host(candidate) {
            if endpoint_reachable(&adapted.base_url) {
                return Some(endpoint_tuple(adapted));
            }
        }
    }

    if let Some(endpoint) = endpoint_from_manifest() {
        return Some(endpoint);
    }

    env_candidate.map(endpoint_tuple)
}

/// 严格发现 orchestrator。除 token 外还核对服务名、pid、startedAt，避免把端口复用者
/// 当作 CC-Panes。能读取同用户 manifest 的进程处在同一信任域，本核对不防御该类对手。
pub fn discover_orchestrator_endpoint(data_dir: &Path) -> Result<ServiceEndpoint, DiscoveryError> {
    let manifest_path = data_dir.join(ORCHESTRATOR_MANIFEST_FILE);
    let content = std::fs::read_to_string(&manifest_path).map_err(|error| {
        DiscoveryError::new(format!("读取 {} 失败: {error}", manifest_path.display()))
    })?;
    let manifest: OrchestratorManifest = serde_json::from_str(&content).map_err(|error| {
        DiscoveryError::new(format!("解析 {} 失败: {error}", manifest_path.display()))
    })?;
    let server = manifest
        .mcp_servers
        .get("ccpanes")
        .ok_or_else(|| DiscoveryError::new("orchestrator manifest 缺少 mcpServers.ccpanes"))?;
    let base_url = url_base(&server.url)
        .ok_or_else(|| DiscoveryError::new("orchestrator manifest 的 MCP URL 无效"))?;
    let token = manifest_token(server)
        .ok_or_else(|| DiscoveryError::new("orchestrator manifest 缺少有效 token"))?;
    let endpoint = ServiceEndpoint {
        kind: ServiceKind::Orchestrator,
        base_url,
        token,
        pid: manifest.pid.ok_or_else(|| {
            DiscoveryError::new("orchestrator manifest 缺少 pid，请启动新版 CC-Panes")
        })?,
        started_at: manifest.started_at.ok_or_else(|| {
            DiscoveryError::new("orchestrator manifest 缺少 startedAt，请启动新版 CC-Panes")
        })?,
        data_dir: data_dir.to_path_buf(),
        identity: IdentityConfidence::Verified,
    };
    finalize_identity(endpoint)
}

/// 从 `runtime/daemon-manifest.json` 严格发现 daemon。
pub fn discover_daemon_endpoint(data_dir: &Path) -> Result<ServiceEndpoint, DiscoveryError> {
    let manifest_path = data_dir.join("runtime").join(DAEMON_MANIFEST_FILE);
    let content = std::fs::read_to_string(&manifest_path).map_err(|error| {
        DiscoveryError::new(format!("读取 {} 失败: {error}", manifest_path.display()))
    })?;
    let manifest: DaemonManifest = serde_json::from_str(&content).map_err(|error| {
        DiscoveryError::new(format!("解析 {} 失败: {error}", manifest_path.display()))
    })?;
    let endpoint = ServiceEndpoint {
        kind: ServiceKind::Daemon,
        base_url: format!("http://{}", manifest.addr.trim_end_matches('/')),
        token: manifest.token,
        pid: manifest.pid,
        started_at: manifest.started_at,
        data_dir: data_dir.to_path_buf(),
        identity: IdentityConfidence::Verified,
    };
    finalize_identity(endpoint)
}

/// 探活并回填身份置信度。
fn finalize_identity(mut endpoint: ServiceEndpoint) -> Result<ServiceEndpoint, DiscoveryError> {
    endpoint.identity = verify_endpoint_identity(&endpoint)?;
    Ok(endpoint)
}

fn verify_endpoint_identity(
    endpoint: &ServiceEndpoint,
) -> Result<IdentityConfidence, DiscoveryError> {
    let url = format!("{}/api/health", endpoint.base_url.trim_end_matches('/'));
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(750)))
        .build()
        .new_agent();
    let response = agent.get(&url).call().map_err(|error| {
        DiscoveryError::new(format!("{} 身份探活失败: {error}", endpoint.kind.name()))
    })?;
    let body = response
        .into_body()
        .with_config()
        .limit(16 * 1024)
        .read_to_string()
        .map_err(|error| {
            DiscoveryError::new(format!(
                "{} 身份响应读取失败: {error}",
                endpoint.kind.name()
            ))
        })?;
    let health: HealthIdentity = serde_json::from_str(&body).map_err(|error| {
        DiscoveryError::new(format!("{} 身份响应无效: {error}", endpoint.kind.name()))
    })?;
    validate_identity(endpoint, &health)
}

/// 身份核对置信度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityConfidence {
    /// service/pid/startedAt 全部提供且与 manifest 一致。
    Verified,
    /// 旧版服务未上报身份字段，仅由 Bearer token 认证（token 是主认证，身份字段是纵深防御）。
    Legacy,
}

/// 分级判定身份。
///
/// - 字段**存在但对不上** → 硬失败（这才是真正的冒充/串实例信号）；
/// - 字段**缺失** → `Legacy`，带警告继续可用（token 已认证成功）。
fn validate_identity(
    endpoint: &ServiceEndpoint,
    health: &HealthIdentity,
) -> Result<IdentityConfidence, DiscoveryError> {
    if health.status != "ok" {
        return Err(DiscoveryError::new(format!(
            "{} health 状态异常: status={}",
            endpoint.kind.name(),
            health.status
        )));
    }

    let mismatch = health
        .service
        .as_deref()
        .is_some_and(|service| service != endpoint.kind.name())
        || health.pid.is_some_and(|pid| pid != endpoint.pid)
        || health
            .started_at
            .is_some_and(|started_at| started_at != endpoint.started_at);
    if mismatch {
        return Err(DiscoveryError::new(format!(
            "{} 身份不匹配: manifest pid/startedAt={}/{}, health service/pid/startedAt={}/{}/{}",
            endpoint.kind.name(),
            endpoint.pid,
            endpoint.started_at,
            health.service.as_deref().unwrap_or("-"),
            display_opt(health.pid),
            display_opt(health.started_at)
        )));
    }

    if health.service.is_none() && health.pid.is_none() && health.started_at.is_none() {
        return Ok(IdentityConfidence::Legacy);
    }
    Ok(IdentityConfidence::Verified)
}

fn display_opt<T: std::fmt::Display>(value: Option<T>) -> String {
    value.map(|v| v.to_string()).unwrap_or_else(|| "-".into())
}

/// health 响应的身份字段。
///
/// `service`/`pid`/`startedAt` 是 2026-07-25 才加到 daemon 与 orchestrator 上的，
/// 因此**必须可缺失**：升级窗口期内跑着的仍是旧二进制（安装版更要等下次发版）。
/// 把缺失当失败会让 ctl 恰好在最需要它的版本错配时段完全不可用。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthIdentity {
    status: String,
    service: Option<String>,
    pid: Option<u32>,
    started_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonManifest {
    addr: String,
    token: String,
    pid: u32,
    started_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorManifest {
    #[serde(rename = "mcpServers")]
    mcp_servers: HashMap<String, OrchestratorServerEntry>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    started_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OrchestratorServerEntry {
    url: String,
    headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
struct EndpointCandidate {
    base_url: String,
    token: String,
    modified: SystemTime,
}

fn endpoint_candidate_from_env() -> Option<EndpointCandidate> {
    let (base_url, token) = endpoint_from_env()?;
    Some(EndpointCandidate {
        base_url,
        token,
        modified: SystemTime::UNIX_EPOCH,
    })
}

fn endpoint_tuple(candidate: EndpointCandidate) -> (String, String) {
    (
        candidate.base_url.trim_end_matches('/').to_string(),
        candidate.token,
    )
}

fn endpoint_from_env() -> Option<(String, String)> {
    let base = non_empty_var("CC_PANES_API_BASE_URL").or_else(|| {
        non_empty_var("CC_PANES_API_PORT").map(|port| format!("http://127.0.0.1:{port}"))
    })?;
    let token = non_empty_var("CC_PANES_API_TOKEN")?;
    Some((base, token))
}

fn endpoint_from_manifest() -> Option<(String, String)> {
    if let Some(dir) = non_empty_var("CC_PANES_DATA_DIR") {
        let candidate =
            read_manifest_candidate(PathBuf::from(dir).join(ORCHESTRATOR_MANIFEST_FILE))?;
        return adapt_candidate_for_current_host(candidate).map(endpoint_tuple);
    }
    select_manifest_endpoint(find_orchestrator_config_candidates())
}

fn parse_manifest(content: &str) -> Option<(String, String)> {
    let config: OrchestratorManifest = serde_json::from_str(content).ok()?;
    let server = config.mcp_servers.get("ccpanes")?;
    Some((url_base(&server.url)?, manifest_token(server)?))
}

fn manifest_token(server: &OrchestratorServerEntry) -> Option<String> {
    server
        .headers
        .as_ref()
        .and_then(|headers| headers.get("Authorization"))
        .and_then(|auth| auth.strip_prefix("Bearer ").map(str::to_string))
        .or_else(|| token_from_query(&server.url))
        .filter(|token| !token.is_empty())
}

fn read_manifest_candidate(path: PathBuf) -> Option<EndpointCandidate> {
    let content = std::fs::read_to_string(&path).ok()?;
    let (base_url, token) = parse_manifest(&content)?;
    let modified = std::fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    Some(EndpointCandidate {
        base_url,
        token,
        modified,
    })
}

fn find_orchestrator_config_candidates() -> Vec<EndpointCandidate> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [".cc-panes", ".cc-panes-dev"]
        .into_iter()
        .filter_map(|name| {
            read_manifest_candidate(home.join(name).join(ORCHESTRATOR_MANIFEST_FILE))
        })
        .collect()
}

fn select_manifest_endpoint(candidates: Vec<EndpointCandidate>) -> Option<(String, String)> {
    let mut candidates = candidates
        .into_iter()
        .filter_map(adapt_candidate_for_current_host)
        .collect::<Vec<_>>();
    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| endpoint_reachable(&candidate.base_url))
    {
        return Some((
            candidate.base_url.trim_end_matches('/').to_string(),
            candidate.token.clone(),
        ));
    }
    if running_in_wsl() {
        return None;
    }
    candidates.sort_by_key(|candidate| candidate.modified);
    candidates.pop().map(endpoint_tuple)
}

fn adapt_candidate_for_current_host(candidate: EndpointCandidate) -> Option<EndpointCandidate> {
    if !running_in_wsl() || !is_loopback_base_url(&candidate.base_url) {
        return Some(candidate);
    }
    wsl_windows_host_candidates()
        .into_iter()
        .filter_map(|host| rewrite_base_url_host(&candidate.base_url, &host))
        .find(|base_url| endpoint_reachable(base_url))
        .map(|base_url| EndpointCandidate {
            base_url,
            token: candidate.token,
            modified: candidate.modified,
        })
}

fn non_empty_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn url_base(raw: &str) -> Option<String> {
    let mut parsed = url::Url::parse(raw).ok()?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn token_from_query(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()?
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
}

fn endpoint_reachable(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    (host, port)
        .to_socket_addrs()
        .ok()
        .into_iter()
        .flatten()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok())
}

fn is_loopback_base_url(base_url: &str) -> bool {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "::1")
}

fn rewrite_base_url_host(base_url: &str, host: &str) -> Option<String> {
    let mut url = url::Url::parse(base_url).ok()?;
    url.set_host(Some(host)).ok()?;
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn running_in_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::fs::read_to_string("/proc/version")
            .map(|version| version.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false)
}

fn wsl_windows_host_candidates() -> Vec<String> {
    let mut hosts = vec!["127.0.0.1".to_string()];
    if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in content.lines() {
            if let Some(host) = line
                .trim()
                .strip_prefix("nameserver")
                .and_then(|rest| rest.split_whitespace().next())
            {
                if !hosts.iter().any(|existing| existing == host) {
                    hosts.push(host.to_string());
                }
            }
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_health_server(body: String) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).expect("read request");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("response");
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn parses_legacy_manifest_without_identity_for_hook_compatibility() {
        let content = r#"{"mcpServers":{"ccpanes":{"type":"http","url":"http://127.0.0.1:61012/mcp?token=deadbeef","headers":{"Authorization":"Bearer deadbeef"}}}}"#;
        assert_eq!(
            parse_manifest(content),
            Some(("http://127.0.0.1:61012".to_string(), "deadbeef".to_string()))
        );
    }

    #[test]
    fn falls_back_to_decoded_token_query_when_no_header() {
        let content = r#"{"mcpServers":{"ccpanes":{"url":"http://127.0.0.1:5/mcp?token=a%20b"}}}"#;
        assert_eq!(
            parse_manifest(content),
            Some(("http://127.0.0.1:5".to_string(), "a b".to_string()))
        );
    }

    #[test]
    fn rejects_malformed_or_missing_manifest() {
        assert_eq!(parse_manifest("{}"), None);
        assert_eq!(parse_manifest("not json"), None);
        let no_token = r#"{"mcpServers":{"ccpanes":{"url":"http://127.0.0.1:5/mcp"}}}"#;
        assert_eq!(parse_manifest(no_token), None);
    }

    #[test]
    fn discovers_orchestrator_only_after_identity_matches_manifest() {
        let pid = 42;
        let started_at = 100;
        let body = serde_json::json!({
            "status": "ok",
            "service": ORCHESTRATOR_SERVICE,
            "pid": pid,
            "startedAt": started_at,
        })
        .to_string();
        let (base_url, handle) = spawn_health_server(body);
        let dir = tempfile::tempdir().expect("tempdir");
        let mcp_url = format!("{base_url}/mcp?token=secret");
        std::fs::write(
            dir.path().join(ORCHESTRATOR_MANIFEST_FILE),
            serde_json::json!({
                "service": ORCHESTRATOR_SERVICE,
                "pid": pid,
                "startedAt": started_at,
                "mcpServers": {
                    "ccpanes": {
                        "url": mcp_url,
                        "headers": { "Authorization": "Bearer secret" }
                    }
                }
            })
            .to_string(),
        )
        .expect("manifest");

        let endpoint = discover_orchestrator_endpoint(dir.path()).expect("discover");
        handle.join().expect("server");
        assert_eq!(endpoint.base_url, base_url);
        assert_eq!(endpoint.pid, pid);
    }

    #[test]
    fn strict_identity_rejects_wrong_service_or_generation() {
        let endpoint = ServiceEndpoint {
            kind: ServiceKind::Daemon,
            base_url: "http://127.0.0.1:1".to_string(),
            token: "secret".to_string(),
            pid: 42,
            started_at: 100,
            data_dir: PathBuf::from("/tmp/test"),
            identity: IdentityConfidence::Verified,
        };
        let wrong_service = HealthIdentity {
            status: "ok".to_string(),
            service: Some(ORCHESTRATOR_SERVICE.to_string()),
            pid: Some(42),
            started_at: Some(100),
        };
        assert!(validate_identity(&endpoint, &wrong_service).is_err());
        let stale = HealthIdentity {
            status: "ok".to_string(),
            service: Some(DAEMON_SERVICE.to_string()),
            pid: Some(42),
            started_at: Some(99),
        };
        assert!(validate_identity(&endpoint, &stale).is_err());
    }

    fn daemon_endpoint_fixture() -> ServiceEndpoint {
        ServiceEndpoint {
            kind: ServiceKind::Daemon,
            base_url: "http://127.0.0.1:1".to_string(),
            token: "secret".to_string(),
            pid: 42,
            started_at: 100,
            data_dir: PathBuf::from("/tmp/test"),
            identity: IdentityConfidence::Verified,
        }
    }

    #[test]
    fn full_identity_match_is_verified() {
        let health = HealthIdentity {
            status: "ok".to_string(),
            service: Some(DAEMON_SERVICE.to_string()),
            pid: Some(42),
            started_at: Some(100),
        };
        assert_eq!(
            validate_identity(&daemon_endpoint_fixture(), &health),
            Ok(IdentityConfidence::Verified)
        );
    }

    /// 旧版 daemon/orchestrator 不上报身份字段：必须降级可用而非硬失败，
    /// 否则 ctl 恰好在版本错配（最需要兜底）的时段完全不可用。
    #[test]
    fn missing_identity_fields_degrade_to_legacy() {
        let health = HealthIdentity {
            status: "ok".to_string(),
            service: None,
            pid: None,
            started_at: None,
        };
        assert_eq!(
            validate_identity(&daemon_endpoint_fixture(), &health),
            Ok(IdentityConfidence::Legacy)
        );
    }

    /// 旧版 health 的原始响应体（只有 status）必须能反序列化。
    #[test]
    fn legacy_health_body_parses() {
        let health: HealthIdentity =
            serde_json::from_str(r#"{"status":"ok"}"#).expect("legacy health parses");
        assert_eq!(
            validate_identity(&daemon_endpoint_fixture(), &health),
            Ok(IdentityConfidence::Legacy)
        );
    }

    /// 部分上报但对不上 → 仍然硬失败（真冒充信号）。
    #[test]
    fn partial_identity_mismatch_still_fails() {
        let health = HealthIdentity {
            status: "ok".to_string(),
            service: None,
            pid: Some(999),
            started_at: None,
        };
        assert!(validate_identity(&daemon_endpoint_fixture(), &health).is_err());
    }

    #[test]
    fn non_ok_status_fails() {
        let health = HealthIdentity {
            status: "degraded".to_string(),
            service: Some(DAEMON_SERVICE.to_string()),
            pid: Some(42),
            started_at: Some(100),
        };
        assert!(validate_identity(&daemon_endpoint_fixture(), &health).is_err());
    }

    #[test]
    fn parses_daemon_manifest_from_runtime_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(&runtime).expect("runtime");
        std::fs::write(
            runtime.join(DAEMON_MANIFEST_FILE),
            r#"{"addr":"127.0.0.1:9","token":"secret","pid":42,"startedAt":100}"#,
        )
        .expect("manifest");
        let content = std::fs::read_to_string(runtime.join(DAEMON_MANIFEST_FILE)).expect("read");
        let manifest: DaemonManifest = serde_json::from_str(&content).expect("parse");
        assert_eq!(manifest.addr, "127.0.0.1:9");
        assert_eq!(manifest.started_at, 100);
    }

    #[test]
    fn selects_reachable_manifest_over_newer_unreachable_manifest() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let reachable = EndpointCandidate {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "reachable".to_string(),
            modified: SystemTime::UNIX_EPOCH,
        };
        let unreachable = EndpointCandidate {
            base_url: "http://127.0.0.1:9".to_string(),
            token: "newer".to_string(),
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(60),
        };
        assert_eq!(
            select_manifest_endpoint(vec![unreachable, reachable]),
            Some((format!("http://127.0.0.1:{port}"), "reachable".to_string()))
        );
    }

    #[test]
    fn selects_newest_manifest_when_none_reachable_outside_wsl() {
        if running_in_wsl() {
            return;
        }
        let old = EndpointCandidate {
            base_url: "http://127.0.0.1:9".to_string(),
            token: "old".to_string(),
            modified: SystemTime::UNIX_EPOCH,
        };
        let new = EndpointCandidate {
            base_url: "http://127.0.0.1:10".to_string(),
            token: "new".to_string(),
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(60),
        };
        assert_eq!(
            select_manifest_endpoint(vec![old, new]),
            Some(("http://127.0.0.1:10".to_string(), "new".to_string()))
        );
    }

    #[test]
    fn rewrites_loopback_base_url_host() {
        assert_eq!(
            rewrite_base_url_host("http://127.0.0.1:61012", "172.20.16.1"),
            Some("http://172.20.16.1:61012".to_string())
        );
    }
}
