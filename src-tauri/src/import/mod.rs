//! CC-Panes 一键导入协议。
//!
//! URL 形如 `ccpanes://v1/import?resource={provider|skill|mcp}&…`，由 deep-link（应用关着也能
//! 唤起）或前端直接调用解析。解析结果 `ImportRequest` 会先发到前端**确认弹窗**，用户确认后才
//! 落盘（`execute_*`）。与 cc-switch 的 `ccswitch://` 同构（参考 `_reference/cc-switch`）。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;

/// 解析后的导入请求（serde 内部标签 `resource`，直接发给前端展示确认）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "resource", rename_all = "camelCase")]
pub enum ImportRequest {
    Provider(ProviderImport),
    Skill(SkillImport),
    Mcp(McpImport),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderImport {
    pub name: String,
    /// claude | codex | gemini | kimi | glm | cursor | opencode
    pub app: String,
    /// 逗号分隔的多 endpoint，首个为主 base_url
    #[serde(default)]
    pub endpoints: Vec<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillImport {
    /// 市场 skill id（走 install_market_skill）
    #[serde(default)]
    pub id: Option<String>,
    /// owner/name git 仓库（后续支持）
    #[serde(default)]
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpImport {
    pub name: String,
    /// 标准 MCP server 定义 { command, args?, env? }
    pub config: serde_json::Value,
}

/// 该 URL 是否是本协议的 deep-link。仅认**当前构建**对应的 scheme：
/// release 只认 `ccpanes://`、dev 只认 `ccpanes-dev://`——避免手工 argv / 陈旧注册跨版触发。
pub fn is_import_url(url: &str) -> bool {
    let u = url.trim();
    if cfg!(debug_assertions) {
        u.starts_with("ccpanes-dev://")
    } else {
        u.starts_with("ccpanes://")
    }
}

/// 返回资源类型字符串（用于**脱敏日志**，绝不打印含密钥的完整 URL）。
pub fn request_kind(req: &ImportRequest) -> &'static str {
    match req {
        ImportRequest::Provider(_) => "provider",
        ImportRequest::Skill(_) => "skill",
        ImportRequest::Mcp(_) => "mcp",
    }
}

/// 冷启动待领取的导入请求。应用**关着**时点链接，URL 经首进程 argv 到达时前端监听器
/// 尚未挂载，事件会丢；这里暂存，前端挂载后调 `take_pending_import` 补领。
#[derive(Default)]
pub struct PendingImportStore(std::sync::Mutex<Option<ImportRequest>>);

impl PendingImportStore {
    pub fn set(&self, req: ImportRequest) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(req);
    }
    pub fn take(&self) -> Option<ImportRequest> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// 解析 `ccpanes://v1/import?...` → ImportRequest。
pub fn parse_import_url(url_str: &str) -> Result<ImportRequest, String> {
    let url = Url::parse(url_str.trim()).map_err(|e| format!("非法导入链接: {e}"))?;

    match url.scheme() {
        "ccpanes" | "ccpanes-dev" => {}
        other => return Err(format!("scheme 应为 ccpanes，实际 '{other}'")),
    }
    // host = 版本
    match url.host_str() {
        Some("v1") => {}
        Some(v) => return Err(format!("不支持的协议版本: {v}")),
        None => return Err("链接缺少版本(host)".into()),
    }
    if url.path() != "/import" {
        return Err(format!("路径应为 /import，实际 '{}'", url.path()));
    }

    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let resource = params.get("resource").ok_or("缺少 resource 参数")?.as_str();

    match resource {
        "provider" => parse_provider(&params).map(ImportRequest::Provider),
        "skill" => parse_skill(&params).map(ImportRequest::Skill),
        "mcp" => parse_mcp(&params).map(ImportRequest::Mcp),
        other => Err(format!("不支持的 resource 类型: {other}")),
    }
}

fn parse_provider(p: &HashMap<String, String>) -> Result<ProviderImport, String> {
    let name = req(p, "name")?;
    let app = req(p, "app")?;
    if !matches!(
        app.as_str(),
        "claude" | "codex" | "gemini" | "kimi" | "glm" | "cursor" | "opencode"
    ) {
        return Err(format!("不支持的 app 类型: {app}"));
    }
    let endpoints = p
        .get("endpoint")
        .map(|e| {
            e.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Ok(ProviderImport {
        name,
        app,
        endpoints,
        api_key: p.get("apiKey").cloned().filter(|s| !s.is_empty()),
    })
}

fn parse_skill(p: &HashMap<String, String>) -> Result<SkillImport, String> {
    let id = p.get("id").cloned().filter(|s| !s.is_empty());
    let repo = p.get("repo").cloned().filter(|s| !s.is_empty());
    if id.is_none() && repo.is_none() {
        return Err("skill 导入需要 id 或 repo".into());
    }
    Ok(SkillImport { id, repo })
}

fn parse_mcp(p: &HashMap<String, String>) -> Result<McpImport, String> {
    let name = req(p, "name")?;
    let raw = req(p, "config")?;
    // config 是 base64(JSON)
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.as_bytes())
        .map_err(|e| format!("config base64 解码失败: {e}"))?;
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("config JSON 解析失败: {e}"))?;
    if config
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Err("mcp config 缺少 command".into());
    }
    Ok(McpImport { name, config })
}

fn req(p: &HashMap<String, String>, key: &str) -> Result<String, String> {
    p.get(key)
        .filter(|s| !s.is_empty())
        .cloned()
        .ok_or_else(|| format!("缺少 {key} 参数"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_provider() {
        let u = "ccpanes://v1/import?resource=provider&name=Test&app=claude&endpoint=https://a.com,https://b.com&apiKey=sk-x";
        let r = parse_import_url(u).unwrap();
        match r {
            ImportRequest::Provider(p) => {
                assert_eq!(p.name, "Test");
                assert_eq!(p.app, "claude");
                assert_eq!(p.endpoints, vec!["https://a.com", "https://b.com"]);
                assert_eq!(p.api_key.as_deref(), Some("sk-x"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_skill_by_id() {
        let r = parse_import_url("ccpanes://v1/import?resource=skill&id=rust-patterns").unwrap();
        assert_eq!(
            r,
            ImportRequest::Skill(SkillImport {
                id: Some("rust-patterns".into()),
                repo: None
            })
        );
    }

    #[test]
    fn parses_mcp_base64_config() {
        let cfg = base64::engine::general_purpose::STANDARD
            .encode(br#"{"command":"npx","args":["-y","x"]}"#);
        let u = format!("ccpanes://v1/import?resource=mcp&name=srv&config={cfg}");
        match parse_import_url(&u).unwrap() {
            ImportRequest::Mcp(m) => {
                assert_eq!(m.name, "srv");
                assert_eq!(m.config.get("command").unwrap(), "npx");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn rejects_bad_scheme_and_version() {
        assert!(parse_import_url("https://v1/import?resource=provider").is_err());
        assert!(
            parse_import_url("ccpanes://v2/import?resource=provider&name=a&app=claude").is_err()
        );
        assert!(parse_import_url("ccpanes://v1/import?resource=skill").is_err());
    }

    #[test]
    fn dev_scheme_accepted() {
        assert!(is_import_url("ccpanes-dev://v1/import?resource=skill&id=x"));
        assert!(parse_import_url("ccpanes-dev://v1/import?resource=skill&id=x").is_ok());
    }
}
