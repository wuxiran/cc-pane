use cc_cli_adapters::{
    CliToolAdapter, CliToolRegistry, CodexAdapter, ProjectHookDefinition, ProjectHookStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCliHookGroupStatus {
    pub cli_tool: String,
    pub label: String,
    pub supported: bool,
    pub reason: Option<String>,
    pub hooks: Vec<ProjectHookStatus>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectCliHooks {
    #[serde(default)]
    tools: HashMap<String, HashMap<String, bool>>,
}

/// 项目级 CLI hooks 服务 - 聚合 adapter 状态并持久化用户偏好
pub struct ProjectCliHooksService {
    cli_registry: Arc<CliToolRegistry>,
}

impl ProjectCliHooksService {
    pub fn new(cli_registry: Arc<CliToolRegistry>) -> Self {
        Self { cli_registry }
    }

    fn get_ccpanes_dir(project_path: &Path) -> PathBuf {
        project_path.join(".ccpanes")
    }

    fn get_state_path(project_path: &Path) -> PathBuf {
        Self::get_ccpanes_dir(project_path).join("cli-hooks.json")
    }

    fn read_state(project_path: &Path) -> Result<StoredProjectCliHooks, String> {
        let path = Self::get_state_path(project_path);
        if !path.exists() {
            return Ok(StoredProjectCliHooks::default());
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read cli-hooks.json: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse cli-hooks.json: {}", e))
    }

    fn write_state(project_path: &Path, state: &StoredProjectCliHooks) -> Result<(), String> {
        let ccpanes_dir = Self::get_ccpanes_dir(project_path);
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create .ccpanes directory: {}", e))?;
        let content = serde_json::to_string_pretty(state)
            .map_err(|e| format!("Failed to serialize cli-hooks.json: {}", e))?;
        fs::write(Self::get_state_path(project_path), content)
            .map_err(|e| format!("Failed to write cli-hooks.json: {}", e))
    }

    pub fn get_hook_binary_path() -> Result<PathBuf, String> {
        if let Ok(explicit) = std::env::var("CC_PANES_CLI_HOOK_BINARY") {
            let path = PathBuf::from(explicit);
            if path.exists() {
                return Ok(path);
            }
        }

        if let Ok(explicit) = std::env::var("CC_PANES_HOOK_BINARY") {
            let path = PathBuf::from(explicit);
            if path.exists() {
                return Ok(path);
            }
        }

        let binary_name = if cfg!(windows) {
            "cc-panes-cli-hook.exe"
        } else {
            "cc-panes-cli-hook"
        };
        let legacy_binary_name = if cfg!(windows) {
            "cc-panes-hook.exe"
        } else {
            "cc-panes-hook"
        };

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let candidate = exe_dir.join(binary_name);
                if candidate.exists() {
                    return Ok(candidate);
                }
                let legacy_candidate = exe_dir.join(legacy_binary_name);
                if legacy_candidate.exists() {
                    return Ok(legacy_candidate);
                }

                let resources_candidate = exe_dir.join("binaries").join(binary_name);
                if resources_candidate.exists() {
                    return Ok(resources_candidate);
                }
                let legacy_resources_candidate = exe_dir.join("binaries").join(legacy_binary_name);
                if legacy_resources_candidate.exists() {
                    return Ok(legacy_resources_candidate);
                }

                #[cfg(target_os = "macos")]
                {
                    if let Some(contents_dir) = exe_dir.parent() {
                        let macos_resources = contents_dir
                            .join("Resources")
                            .join("binaries")
                            .join(binary_name);
                        if macos_resources.exists() {
                            return Ok(macos_resources);
                        }
                        let legacy_macos_resources = contents_dir
                            .join("Resources")
                            .join("binaries")
                            .join(legacy_binary_name);
                        if legacy_macos_resources.exists() {
                            return Ok(legacy_macos_resources);
                        }
                    }
                }
            }
        }

        let workspace_root = Self::find_workspace_root()?;
        let release_candidate = workspace_root
            .join("target")
            .join("release")
            .join(binary_name);
        if release_candidate.exists() {
            return Ok(release_candidate);
        }
        let legacy_release_candidate = workspace_root
            .join("target")
            .join("release")
            .join(legacy_binary_name);
        if legacy_release_candidate.exists() {
            return Ok(legacy_release_candidate);
        }

        let debug_candidate = workspace_root
            .join("target")
            .join("debug")
            .join(binary_name);
        if debug_candidate.exists() {
            return Ok(debug_candidate);
        }
        let legacy_debug_candidate = workspace_root
            .join("target")
            .join("debug")
            .join(legacy_binary_name);
        if legacy_debug_candidate.exists() {
            return Ok(legacy_debug_candidate);
        }

        Err(
            "cc-panes-cli-hook binary not found. Please build it first: cargo build -p cc-panes-cli-hook"
                .to_string(),
        )
    }

    fn find_workspace_root() -> Result<PathBuf, String> {
        if let Ok(exe_path) = std::env::current_exe() {
            let mut dir = exe_path
                .parent()
                .map(|path| path.to_path_buf())
                .unwrap_or_default();
            for _ in 0..5 {
                if dir.join("Cargo.toml").exists() {
                    return Ok(dir);
                }
                if let Some(parent) = dir.parent() {
                    dir = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }

        std::env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))
    }

    fn unsupported_statuses(
        definitions: Vec<ProjectHookDefinition>,
        reason: String,
    ) -> Vec<ProjectHookStatus> {
        definitions
            .into_iter()
            .map(|def| ProjectHookStatus {
                name: def.name,
                label: def.label,
                enabled: false,
                supported: false,
                reason: Some(reason.clone()),
            })
            .collect()
    }

    fn common_unsupported_reason(hooks: &[ProjectHookStatus]) -> Option<String> {
        if hooks.is_empty() || hooks.iter().any(|hook| hook.supported) {
            return None;
        }

        let first = hooks.first()?.reason.as_ref()?.clone();
        if hooks
            .iter()
            .all(|hook| hook.reason.as_ref() == Some(&first))
        {
            Some(first)
        } else {
            None
        }
    }

    fn get_supported_adapter(&self, cli_tool: &str) -> Result<&Arc<dyn CliToolAdapter>, String> {
        let adapter = self
            .cli_registry
            .get(cli_tool)
            .ok_or_else(|| format!("Unknown CLI tool: {}", cli_tool))?;
        if !adapter.capabilities().supports_project_hooks {
            return Err(format!(
                "CLI tool '{}' does not support project hooks",
                cli_tool
            ));
        }
        Ok(adapter)
    }

    pub fn list_project_cli_hooks(
        &self,
        project_path: &str,
    ) -> Result<Vec<ProjectCliHookGroupStatus>, String> {
        let project_path = Path::new(project_path);
        let mut groups = Vec::new();

        for (cli_tool, caps) in self.cli_registry.list_capabilities() {
            if !caps.supports_project_hooks {
                continue;
            }

            let adapter = match self.cli_registry.get(&cli_tool) {
                Some(adapter) => adapter,
                None => continue,
            };
            let definitions = adapter.project_hooks();
            let hooks = match adapter.get_project_hook_statuses(project_path) {
                Ok(hooks) => hooks,
                Err(error) => Self::unsupported_statuses(definitions, error.to_string()),
            };

            groups.push(ProjectCliHookGroupStatus {
                cli_tool: cli_tool.clone(),
                label: adapter.info().display_name.clone(),
                supported: hooks.iter().any(|hook| hook.supported),
                reason: Self::common_unsupported_reason(&hooks),
                hooks,
            });
        }

        Ok(groups)
    }

    pub fn set_project_cli_hook_enabled(
        &self,
        project_path: &str,
        cli_tool: &str,
        hook_name: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let project_path = Path::new(project_path);
        let adapter = self.get_supported_adapter(cli_tool)?;
        let hook_statuses = adapter
            .get_project_hook_statuses(project_path)
            .map_err(|e| e.to_string())?;
        let hook = hook_statuses
            .into_iter()
            .find(|status| status.name == hook_name)
            .ok_or_else(|| format!("Unknown hook '{}'", hook_name))?;

        if !hook.supported {
            return Err(hook.reason.unwrap_or_else(|| {
                format!("Hook '{}' is not supported by {}", hook_name, cli_tool)
            }));
        }

        let mut state = Self::read_state(project_path)?;
        state
            .tools
            .entry(cli_tool.to_string())
            .or_default()
            .insert(hook_name.to_string(), enabled);
        self.sync_project_cli_hooks_for_state(project_path, cli_tool, &state)?;
        Self::write_state(project_path, &state)
    }

    pub fn sync_project_cli_hooks(&self, project_path: &str, cli_tool: &str) -> Result<(), String> {
        let project_path = Path::new(project_path);
        let state = Self::read_state(project_path)?;
        self.sync_project_cli_hooks_for_state(project_path, cli_tool, &state)
    }

    pub fn sync_project_cli_hooks_with_binary(
        &self,
        project_path: &str,
        cli_tool: &str,
        hook_binary_path: &Path,
    ) -> Result<(), String> {
        let project_path = Path::new(project_path);
        let state = Self::read_state(project_path)?;
        self.sync_project_cli_hooks_for_state_with_binary(
            project_path,
            cli_tool,
            &state,
            Some(hook_binary_path),
        )
    }

    pub fn sync_wsl_codex_project_hooks(
        &self,
        state_project_path: &str,
        target_project_path: &str,
        wsl_hook_binary_path: &Path,
    ) -> Result<(), String> {
        let state = Self::read_state(Path::new(state_project_path))?;
        let session_enabled = state
            .tools
            .get("codex")
            .and_then(|tool_state| tool_state.get("session-inject").copied())
            .unwrap_or(true);
        let desired = HashMap::from([("session-inject".to_string(), session_enabled)]);

        CodexAdapter::new()
            .sync_project_hooks_for_wsl_launch(
                Path::new(target_project_path),
                wsl_hook_binary_path,
                &desired,
            )
            .map_err(|e| e.to_string())
    }

    fn sync_project_cli_hooks_for_state(
        &self,
        project_path: &Path,
        cli_tool: &str,
        state: &StoredProjectCliHooks,
    ) -> Result<(), String> {
        self.sync_project_cli_hooks_for_state_with_binary(project_path, cli_tool, state, None)
    }

    fn sync_project_cli_hooks_for_state_with_binary(
        &self,
        project_path: &Path,
        cli_tool: &str,
        state: &StoredProjectCliHooks,
        hook_binary_override: Option<&Path>,
    ) -> Result<(), String> {
        let adapter = self.get_supported_adapter(cli_tool)?;
        let hook_statuses = adapter
            .get_project_hook_statuses(project_path)
            .map_err(|e| e.to_string())?;

        let mut desired = HashMap::new();
        for hook in hook_statuses {
            if hook.supported {
                let enabled = state
                    .tools
                    .get(cli_tool)
                    .and_then(|tool_state| tool_state.get(&hook.name).copied())
                    .unwrap_or(true);
                desired.insert(hook.name, enabled);
            }
        }

        let hook_binary_path = if desired.values().any(|enabled| *enabled) {
            match hook_binary_override {
                Some(path) => Some(path.to_path_buf()),
                None => Some(Self::get_hook_binary_path()?),
            }
        } else {
            None
        };

        adapter
            .sync_project_hooks(project_path, hook_binary_path.as_deref(), &desired)
            .map_err(|e| e.to_string())
    }
}

impl Default for ProjectCliHooksService {
    fn default() -> Self {
        Self::new(Arc::new(CliToolRegistry::new()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_cli_adapters::{ClaudeAdapter, CodexAdapter};
    use tempfile::tempdir;

    fn build_registry() -> Arc<CliToolRegistry> {
        let mut registry = CliToolRegistry::new();
        registry.register(Arc::new(ClaudeAdapter::new()));
        registry.register(Arc::new(CodexAdapter::new()));
        Arc::new(registry)
    }

    #[test]
    fn set_project_cli_hook_enabled_persists_desired_state() {
        let dir = tempdir().unwrap();
        let hook_binary = dir.path().join("cc-panes-cli-hook");
        fs::write(&hook_binary, b"hook").unwrap();
        std::env::set_var("CC_PANES_CLI_HOOK_BINARY", &hook_binary);

        let service = ProjectCliHooksService::new(build_registry());
        let project_path = dir.path().join("project");
        fs::create_dir_all(&project_path).unwrap();

        service
            .set_project_cli_hook_enabled(
                project_path.to_string_lossy().as_ref(),
                "claude",
                "plan-archive",
                false,
            )
            .unwrap();

        let groups = service
            .list_project_cli_hooks(project_path.to_string_lossy().as_ref())
            .unwrap();
        let claude_group = groups
            .iter()
            .find(|group| group.cli_tool == "claude")
            .unwrap();
        let plan_hook = claude_group
            .hooks
            .iter()
            .find(|hook| hook.name == "plan-archive")
            .unwrap();

        assert!(!plan_hook.enabled);
        assert!(ProjectCliHooksService::get_state_path(&project_path).exists());

        std::env::remove_var("CC_PANES_CLI_HOOK_BINARY");
    }
}
