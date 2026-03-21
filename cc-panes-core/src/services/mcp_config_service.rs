use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// MCP Server 配置项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// `.claude/settings.local.json` 中与 MCP 相关的结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLocalSettings {
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    /// 保留其他字段，避免读写时丢失
    #[serde(flatten)]
    pub other: HashMap<String, serde_json::Value>,
}

/// MCP 配置管理服务 — 操作项目目录下的 `.claude/settings.local.json`
#[derive(Default)]
pub struct McpConfigService;

impl McpConfigService {
    pub fn new() -> Self {
        Self
    }

    /// 获取配置文件路径
    fn settings_path(project_path: &str) -> PathBuf {
        Path::new(project_path)
            .join(".claude")
            .join("settings.local.json")
    }

    /// 读取项目的完整 Claude 本地设置
    pub fn read_settings(project_path: &str) -> Result<ClaudeLocalSettings, String> {
        let path = Self::settings_path(project_path);
        if !path.exists() {
            return Ok(ClaudeLocalSettings::default());
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config file: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config file: {}", e))
    }

    /// 写入项目的完整 Claude 本地设置
    pub fn write_settings(project_path: &str, settings: &ClaudeLocalSettings) -> Result<(), String> {
        let path = Self::settings_path(project_path);
        // 确保 .claude 目录存在
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create .claude directory: {}", e))?;
        }
        let content =
            serde_json::to_string_pretty(settings).map_err(|e| format!("Failed to serialize config: {}", e))?;
        std::fs::write(&path, content).map_err(|e| format!("Failed to write config file: {}", e))
    }

    /// 列出项目的所有 MCP Server 配置
    pub fn list_mcp_servers(
        &self,
        project_path: &str,
    ) -> Result<HashMap<String, McpServerConfig>, String> {
        let settings = Self::read_settings(project_path)?;
        Ok(settings.mcp_servers)
    }

    /// 获取单个 MCP Server 配置
    pub fn get_mcp_server(
        &self,
        project_path: &str,
        name: &str,
    ) -> Result<Option<McpServerConfig>, String> {
        let settings = Self::read_settings(project_path)?;
        Ok(settings.mcp_servers.get(name).cloned())
    }

    /// 添加或更新 MCP Server 配置
    pub fn upsert_mcp_server(
        &self,
        project_path: &str,
        name: &str,
        config: McpServerConfig,
    ) -> Result<(), String> {
        let mut settings = Self::read_settings(project_path)?;
        settings.mcp_servers.insert(name.to_string(), config);
        Self::write_settings(project_path, &settings)
    }

    /// 删除 MCP Server 配置
    pub fn remove_mcp_server(&self, project_path: &str, name: &str) -> Result<bool, String> {
        let mut settings = Self::read_settings(project_path)?;
        let removed = settings.mcp_servers.remove(name).is_some();
        if removed {
            Self::write_settings(project_path, &settings)?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (McpConfigService, PathBuf) {
        let temp = std::env::temp_dir().join(format!("cc-panes-mcp-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        (McpConfigService::new(), temp)
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn test_list_empty() {
        let (svc, tmp) = setup();
        let path = tmp.to_str().unwrap();
        let result = svc.list_mcp_servers(path).unwrap();
        assert!(result.is_empty());
        cleanup(&tmp);
    }

    #[test]
    fn test_upsert_and_list() {
        let (svc, tmp) = setup();
        let path = tmp.to_str().unwrap();
        let config = McpServerConfig {
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@anthropic/mcp-server".to_string()],
            env: HashMap::from([("API_KEY".to_string(), "test-key".to_string())]),
        };
        svc.upsert_mcp_server(path, "test-server", config.clone())
            .unwrap();

        let servers = svc.list_mcp_servers(path).unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("test-server"));
        assert_eq!(servers["test-server"].command, "npx");
        assert_eq!(servers["test-server"].args.len(), 2);
        assert_eq!(servers["test-server"].env["API_KEY"], "test-key");
        cleanup(&tmp);
    }

    #[test]
    fn test_get_single() {
        let (svc, tmp) = setup();
        let path = tmp.to_str().unwrap();
        let config = McpServerConfig {
            command: "node".to_string(),
            args: vec!["server.js".to_string()],
            env: HashMap::new(),
        };
        svc.upsert_mcp_server(path, "my-server", config).unwrap();

        let found = svc.get_mcp_server(path, "my-server").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().command, "node");

        let not_found = svc.get_mcp_server(path, "nope").unwrap();
        assert!(not_found.is_none());
        cleanup(&tmp);
    }

    #[test]
    fn test_remove() {
        let (svc, tmp) = setup();
        let path = tmp.to_str().unwrap();
        let config = McpServerConfig {
            command: "python".to_string(),
            args: vec![],
            env: HashMap::new(),
        };
        svc.upsert_mcp_server(path, "to-remove", config).unwrap();
        assert!(svc.remove_mcp_server(path, "to-remove").unwrap());
        assert!(!svc.remove_mcp_server(path, "to-remove").unwrap());
        assert!(svc.list_mcp_servers(path).unwrap().is_empty());
        cleanup(&tmp);
    }

    #[test]
    fn test_preserves_other_fields() {
        let (svc, tmp) = setup();
        let path = tmp.to_str().unwrap();

        // 手动写入包含其他字段的配置
        let claude_dir = tmp.join(".claude");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(
            claude_dir.join("settings.local.json"),
            r#"{"mcpServers":{},"customField":"preserved","anotherField":42}"#,
        )
        .unwrap();

        // 添加一个 MCP Server
        let config = McpServerConfig {
            command: "test".to_string(),
            args: vec![],
            env: HashMap::new(),
        };
        svc.upsert_mcp_server(path, "new-server", config).unwrap();

        // 重新读取验证其他字段保留
        let raw = fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["customField"], "preserved");
        assert_eq!(parsed["anotherField"], 42);
        assert!(parsed["mcpServers"]["new-server"].is_object());
        cleanup(&tmp);
    }
}
