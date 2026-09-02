//! Layered MCP server configuration (docs/98 workspace-first).
//!
//! Two writable layers, both in the Claude-native `{ "mcpServers": { name: {...} } }` shape:
//!
//! - **workspace**: `~/.cc-panes/workspaces/<name>/mcp.json` — applies to every project in the
//!   workspace; the default place to put servers.
//! - **project overlay**: `<repo>/.ccpanes/mcp.json` — committable, overrides same-named
//!   workspace entries for that repo only.
//!
//! Neither is read natively by any CLI. CC-Panes merges them per launch and injects the result
//! (Claude `--mcp-config`, Codex `-c mcp_servers.*`), so nothing is written into the user's CLI
//! home or into `.claude/`. The pre-0.12.10 location, `<repo>/.claude/settings.local.json`
//! (`mcpServers`), is kept **read-only** for one-click import.

use crate::utils::project_dirs;
use crate::utils::AppPaths;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MCP_LAYER_FILE: &str = "mcp.json";

/// One MCP server entry. `command`/`args`/`env` cover stdio servers (what the UI edits);
/// `extra` keeps anything else (`type`, `url`, `headers`, ...) so HTTP entries and unknown
/// fields survive a read-modify-write round trip.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct McpServerConfig {
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl McpServerConfig {
    pub fn is_http(&self) -> bool {
        self.command.trim().is_empty() && self.extra.get("url").and_then(|v| v.as_str()).is_some()
    }
}

/// `mcp.json` (and the legacy `.claude/settings.local.json`) top level.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpLayerFile {
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
    /// Unknown top-level keys are preserved (the legacy file carries hooks/permissions).
    #[serde(flatten)]
    pub other: HashMap<String, serde_json::Value>,
}

/// Kept as a type alias so existing call sites reading the legacy file still compile.
pub type ClaudeLocalSettings = McpLayerFile;

/// Which layer a read/write targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpLayer {
    Workspace { workspace_name: String },
    Project { project_path: String },
}

impl McpLayer {
    /// Command/route parameter convention: a workspace name selects the workspace layer,
    /// otherwise a project path selects that project's overlay.
    pub fn resolve(
        workspace_name: Option<&str>,
        project_path: Option<&str>,
    ) -> Result<Self, String> {
        if let Some(name) = workspace_name.map(str::trim).filter(|n| !n.is_empty()) {
            return Ok(McpLayer::Workspace {
                workspace_name: name.to_string(),
            });
        }
        if let Some(path) = project_path.map(str::trim).filter(|p| !p.is_empty()) {
            return Ok(McpLayer::Project {
                project_path: path.to_string(),
            });
        }
        Err("either workspaceName or projectPath is required".to_string())
    }
}

/// Where a merged server came from (for UI badges / launch diagnostics).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum McpLayerKind {
    Workspace,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveMcpServer {
    pub name: String,
    pub config: McpServerConfig,
    pub layer: McpLayerKind,
}

pub struct McpConfigService {
    app_paths: Option<Arc<AppPaths>>,
}

impl Default for McpConfigService {
    fn default() -> Self {
        Self::new()
    }
}

impl McpConfigService {
    /// Project-layer-only service (no workspace layer). Prefer `with_paths`.
    pub fn new() -> Self {
        Self { app_paths: None }
    }

    pub fn with_paths(app_paths: Arc<AppPaths>) -> Self {
        Self {
            app_paths: Some(app_paths),
        }
    }

    // ---------- paths ----------

    fn legacy_settings_path(project_path: &str) -> PathBuf {
        Path::new(project_path)
            .join(".claude")
            .join("settings.local.json")
    }

    pub fn project_layer_path(project_path: &str) -> PathBuf {
        project_dirs::ccpanes_dir(Path::new(project_path)).join(MCP_LAYER_FILE)
    }

    pub fn workspace_layer_path(&self, workspace_name: &str) -> Result<PathBuf, String> {
        let paths = self
            .app_paths
            .as_ref()
            .ok_or_else(|| "workspace MCP layer unavailable (no app paths)".to_string())?;
        let name = workspace_name.trim();
        if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
            return Err(format!("Invalid workspace name '{workspace_name}'"));
        }
        Ok(paths.workspace_dir(name).join(MCP_LAYER_FILE))
    }

    fn layer_path(&self, layer: &McpLayer) -> Result<PathBuf, String> {
        match layer {
            McpLayer::Workspace { workspace_name } => self.workspace_layer_path(workspace_name),
            McpLayer::Project { project_path } => Ok(Self::project_layer_path(project_path)),
        }
    }

    // ---------- file io ----------

    fn read_file(path: &Path) -> Result<McpLayerFile, String> {
        if !path.exists() {
            return Ok(McpLayerFile::default());
        }
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        if content.trim().is_empty() {
            return Ok(McpLayerFile::default());
        }
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
    }

    fn write_layer(&self, layer: &McpLayer, file: &McpLayerFile) -> Result<(), String> {
        let path = self.layer_path(layer)?;
        match layer {
            McpLayer::Project { project_path } => {
                // Goes through project_dirs so the `.ccpanes/.gitignore` guard is written too.
                project_dirs::ensure_ccpanes_dir(Path::new(project_path))
                    .map_err(|e| format!("Failed to create .ccpanes: {}", e))?;
            }
            McpLayer::Workspace { .. } => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create workspace dir: {}", e))?;
                }
            }
        }
        let content = serde_json::to_string_pretty(file)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        crate::utils::atomic_file::write_atomic(&path, content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    }

    pub fn read_layer(&self, layer: &McpLayer) -> Result<McpLayerFile, String> {
        Self::read_file(&self.layer_path(layer)?)
    }

    // ---------- layer CRUD ----------

    pub fn list(&self, layer: &McpLayer) -> Result<BTreeMap<String, McpServerConfig>, String> {
        Ok(self.read_layer(layer)?.mcp_servers)
    }

    pub fn get(&self, layer: &McpLayer, name: &str) -> Result<Option<McpServerConfig>, String> {
        Ok(self.read_layer(layer)?.mcp_servers.get(name).cloned())
    }

    pub fn upsert(
        &self,
        layer: &McpLayer,
        name: &str,
        config: McpServerConfig,
    ) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("MCP server name cannot be empty".to_string());
        }
        let mut file = self.read_layer(layer)?;
        file.mcp_servers.insert(name.to_string(), config);
        self.write_layer(layer, &file)
    }

    pub fn remove(&self, layer: &McpLayer, name: &str) -> Result<bool, String> {
        let mut file = self.read_layer(layer)?;
        let removed = file.mcp_servers.remove(name).is_some();
        if removed {
            self.write_layer(layer, &file)?;
        }
        Ok(removed)
    }

    // ---------- project-layer shorthands (kept for existing callers) ----------

    pub fn list_mcp_servers(
        &self,
        project_path: &str,
    ) -> Result<BTreeMap<String, McpServerConfig>, String> {
        self.list(&McpLayer::Project {
            project_path: project_path.to_string(),
        })
    }

    pub fn get_mcp_server(
        &self,
        project_path: &str,
        name: &str,
    ) -> Result<Option<McpServerConfig>, String> {
        self.get(
            &McpLayer::Project {
                project_path: project_path.to_string(),
            },
            name,
        )
    }

    pub fn upsert_mcp_server(
        &self,
        project_path: &str,
        name: &str,
        config: McpServerConfig,
    ) -> Result<(), String> {
        self.upsert(
            &McpLayer::Project {
                project_path: project_path.to_string(),
            },
            name,
            config,
        )
    }

    pub fn remove_mcp_server(&self, project_path: &str, name: &str) -> Result<bool, String> {
        self.remove(
            &McpLayer::Project {
                project_path: project_path.to_string(),
            },
            name,
        )
    }

    // ---------- legacy `.claude/settings.local.json` (read-only) ----------

    /// Full legacy file. Read-only: CC-Panes no longer writes `mcpServers` there.
    pub fn read_settings(project_path: &str) -> Result<ClaudeLocalSettings, String> {
        Self::read_file(&Self::legacy_settings_path(project_path))
    }

    pub fn list_legacy_project_servers(
        &self,
        project_path: &str,
    ) -> Result<BTreeMap<String, McpServerConfig>, String> {
        Ok(Self::read_settings(project_path)?.mcp_servers)
    }

    /// Copy the legacy project servers into `into`. Existing names in the target are kept
    /// unless `overwrite`. The legacy file is left untouched. Returns the imported names.
    pub fn import_legacy_project_servers(
        &self,
        project_path: &str,
        into: &McpLayer,
        overwrite: bool,
    ) -> Result<Vec<String>, String> {
        let legacy = self.list_legacy_project_servers(project_path)?;
        if legacy.is_empty() {
            return Ok(Vec::new());
        }
        let mut file = self.read_layer(into)?;
        let mut imported = Vec::new();
        for (name, config) in legacy {
            if !overwrite && file.mcp_servers.contains_key(&name) {
                continue;
            }
            file.mcp_servers.insert(name.clone(), config);
            imported.push(name);
        }
        if !imported.is_empty() {
            self.write_layer(into, &file)?;
        }
        Ok(imported)
    }

    // ---------- launch-time merge ----------

    /// Workspace layer, then the project overlay on top (same name → project wins).
    /// Read failures in either layer degrade to "no servers from that layer" — a broken
    /// `mcp.json` must not block launching a terminal.
    pub fn effective_servers(
        &self,
        workspace_name: Option<&str>,
        project_path: &str,
    ) -> Vec<EffectiveMcpServer> {
        let mut merged: BTreeMap<String, EffectiveMcpServer> = BTreeMap::new();
        if let Some(name) = workspace_name.map(str::trim).filter(|n| !n.is_empty()) {
            let layer = McpLayer::Workspace {
                workspace_name: name.to_string(),
            };
            match self.list(&layer) {
                Ok(servers) => {
                    for (name, config) in servers {
                        merged.insert(
                            name.clone(),
                            EffectiveMcpServer {
                                name,
                                config,
                                layer: McpLayerKind::Workspace,
                            },
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(workspace = name, %error, "workspace mcp.json unreadable; skipped")
                }
            }
        }
        match self.list_mcp_servers(project_path) {
            Ok(servers) => {
                for (name, config) in servers {
                    merged.insert(
                        name.clone(),
                        EffectiveMcpServer {
                            name,
                            config,
                            layer: McpLayerKind::Project,
                        },
                    );
                }
            }
            Err(error) => {
                tracing::warn!(project = project_path, %error, "project .ccpanes/mcp.json unreadable; skipped")
            }
        }
        merged.into_values().collect()
    }
}

/// Convert entries to the Claude-native JSON shape the adapters consume.
pub fn effective_servers_to_json(
    servers: &[EffectiveMcpServer],
) -> BTreeMap<String, serde_json::Value> {
    servers
        .iter()
        .map(|server| {
            (
                server.name.clone(),
                serde_json::to_value(&server.config).unwrap_or(serde_json::Value::Null),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service() -> (TempDir, TempDir, McpConfigService) {
        let data = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let paths = AppPaths::new(Some(data.path().to_string_lossy().to_string()));
        (data, project, McpConfigService::with_paths(Arc::new(paths)))
    }

    fn stdio(command: &str) -> McpServerConfig {
        McpServerConfig {
            command: command.to_string(),
            args: vec!["-y".into(), "pkg".into()],
            env: HashMap::from([("API_KEY".to_string(), "k".to_string())]),
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn project_layer_lives_in_ccpanes_and_writes_gitignore_guard() {
        let (_data, project, svc) = service();
        let path = project.path().to_string_lossy().to_string();
        assert!(svc.list_mcp_servers(&path).unwrap().is_empty());

        svc.upsert_mcp_server(&path, "fetch", stdio("npx")).unwrap();
        assert!(project.path().join(".ccpanes/mcp.json").is_file());
        assert!(project.path().join(".ccpanes/.gitignore").is_file());
        assert!(
            !project.path().join(".claude").exists(),
            "legacy file must not be written"
        );

        let servers = svc.list_mcp_servers(&path).unwrap();
        assert_eq!(servers["fetch"].command, "npx");
        assert_eq!(servers["fetch"].env["API_KEY"], "k");
        assert!(svc.remove_mcp_server(&path, "fetch").unwrap());
        assert!(!svc.remove_mcp_server(&path, "fetch").unwrap());
    }

    #[test]
    fn workspace_layer_lives_under_workspace_dir() {
        let (data, _project, svc) = service();
        let layer = McpLayer::Workspace {
            workspace_name: "team".into(),
        };
        svc.upsert(&layer, "context7", stdio("npx")).unwrap();
        assert!(data.path().join("workspaces/team/mcp.json").is_file());
        assert_eq!(svc.get(&layer, "context7").unwrap().unwrap().command, "npx");
        assert!(svc
            .upsert(
                &McpLayer::Workspace {
                    workspace_name: "../x".into()
                },
                "a",
                stdio("a")
            )
            .is_err());
    }

    #[test]
    fn effective_merge_project_overrides_workspace() {
        let (_data, project, svc) = service();
        let path = project.path().to_string_lossy().to_string();
        let ws = McpLayer::Workspace {
            workspace_name: "team".into(),
        };
        svc.upsert(&ws, "shared", stdio("ws-cmd")).unwrap();
        svc.upsert(&ws, "only-ws", stdio("ws-only")).unwrap();
        svc.upsert_mcp_server(&path, "shared", stdio("proj-cmd"))
            .unwrap();
        svc.upsert_mcp_server(&path, "only-proj", stdio("proj-only"))
            .unwrap();

        let effective = svc.effective_servers(Some("team"), &path);
        let by_name: BTreeMap<_, _> = effective.iter().map(|s| (s.name.as_str(), s)).collect();
        assert_eq!(by_name.len(), 3);
        assert_eq!(by_name["shared"].config.command, "proj-cmd");
        assert_eq!(by_name["shared"].layer, McpLayerKind::Project);
        assert_eq!(by_name["only-ws"].layer, McpLayerKind::Workspace);
        assert_eq!(by_name["only-proj"].layer, McpLayerKind::Project);

        // 没有工作空间时只剩项目层
        assert_eq!(svc.effective_servers(None, &path).len(), 2);

        let json = effective_servers_to_json(&effective);
        assert_eq!(json["only-ws"]["command"], "ws-only");
        assert!(
            json["only-ws"].get("extra").is_none(),
            "extra must be flattened, not nested"
        );
    }

    #[test]
    fn http_entries_and_unknown_fields_round_trip() {
        let (_data, project, svc) = service();
        let path = project.path().to_string_lossy().to_string();
        std::fs::create_dir_all(project.path().join(".ccpanes")).unwrap();
        std::fs::write(
            project.path().join(".ccpanes/mcp.json"),
            r#"{"mcpServers":{"remote":{"type":"http","url":"https://x/mcp","headers":{"A":"b"}}},"note":"keep"}"#,
        )
        .unwrap();
        let remote = svc.get_mcp_server(&path, "remote").unwrap().unwrap();
        assert!(remote.is_http());
        assert_eq!(remote.extra["url"], "https://x/mcp");

        svc.upsert_mcp_server(&path, "local", stdio("node"))
            .unwrap();
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(project.path().join(".ccpanes/mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["note"], "keep");
        assert_eq!(raw["mcpServers"]["remote"]["type"], "http");
        assert_eq!(raw["mcpServers"]["remote"]["headers"]["A"], "b");
        assert!(raw["mcpServers"]["local"].get("extra").is_none());
    }

    #[test]
    fn legacy_settings_are_read_only_and_importable() {
        let (data, project, svc) = service();
        let path = project.path().to_string_lossy().to_string();
        let claude_dir = project.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let legacy_raw = r#"{"mcpServers":{"fetch":{"command":"npx","args":["-y","fetch"]},"db":{"command":"db"}},"permissions":{"allow":["Bash"]}}"#;
        std::fs::write(claude_dir.join("settings.local.json"), legacy_raw).unwrap();

        let legacy = svc.list_legacy_project_servers(&path).unwrap();
        assert_eq!(legacy.len(), 2);

        let ws = McpLayer::Workspace {
            workspace_name: "team".into(),
        };
        svc.upsert(&ws, "db", stdio("mine")).unwrap();
        let imported = svc
            .import_legacy_project_servers(&path, &ws, false)
            .unwrap();
        assert_eq!(
            imported,
            vec!["fetch".to_string()],
            "existing 'db' kept without overwrite"
        );
        assert_eq!(svc.get(&ws, "db").unwrap().unwrap().command, "mine");
        assert!(data.path().join("workspaces/team/mcp.json").is_file());

        let imported = svc.import_legacy_project_servers(&path, &ws, true).unwrap();
        assert_eq!(imported.len(), 2);
        assert_eq!(svc.get(&ws, "db").unwrap().unwrap().command, "db");

        // 旧文件一个字节都没动
        assert_eq!(
            std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap(),
            legacy_raw
        );
    }
}
