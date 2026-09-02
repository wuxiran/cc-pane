//! Workspace-scoped Cursor Bridge registries (docs/98 workspace-first).
//!
//! Each workspace owns its own registry folder, `~/.cc-panes/workspaces/<name>/cursor-bridge/`,
//! holding the session registry, model preferences and the default project. The hub hands out
//! **one shared `CursorBridgeService` per workspace** (the registry is file-level read-modify-
//! write, so every writer in the process must share the same lock) and remembers which workspace
//! `init` bound last so callers that carry no workspace context still land somewhere sensible.
//!
//! The pre-0.12.10 global folder (`~/.cc-panes/cursor-bridge/`) is kept read-only as a fallback
//! for resume-id binding and for the "current workspace" pointer file.

use crate::services::cursor_bridge_service::CursorBridgeService;
use crate::utils::error::{AppError, AppResult};
use crate::utils::AppPaths;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::debug;

const CURRENT_FILE: &str = "current-v1.json";
const REGISTRY_SUBDIR: &str = "cursor-bridge";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CurrentWorkspace {
    schema_version: u32,
    workspace_name: String,
}

pub struct CursorBridgeHub {
    app_paths: Arc<AppPaths>,
    services: Mutex<HashMap<String, Arc<CursorBridgeService>>>,
    legacy: Arc<CursorBridgeService>,
}

impl CursorBridgeHub {
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        let legacy = Arc::new(CursorBridgeService::open(app_paths.cursor_bridge_dir()));
        Self {
            app_paths,
            services: Mutex::new(HashMap::new()),
            legacy,
        }
    }

    /// Registry folder for a workspace.
    pub fn registry_dir(&self, workspace_name: &str) -> PathBuf {
        self.app_paths
            .workspace_dir(workspace_name.trim())
            .join(REGISTRY_SUBDIR)
    }

    /// The single shared service for a workspace's registry.
    pub fn for_workspace(&self, workspace_name: &str) -> AppResult<Arc<CursorBridgeService>> {
        let name = validate_workspace_name(workspace_name)?;
        let mut services = self.services.lock();
        if let Some(existing) = services.get(&name) {
            return Ok(existing.clone());
        }
        let service = Arc::new(CursorBridgeService::open(self.registry_dir(&name)));
        services.insert(name, service.clone());
        Ok(service)
    }

    /// The pre-workspace global registry. Read-only fallback; new sessions never go here.
    pub fn legacy(&self) -> Arc<CursorBridgeService> {
        self.legacy.clone()
    }

    /// Workspace bound by the most recent `init`, if any.
    pub fn current_workspace(&self) -> Option<String> {
        let path = self.current_file();
        let raw = std::fs::read_to_string(path).ok()?;
        let current: CurrentWorkspace = serde_json::from_str(&raw).ok()?;
        let name = current.workspace_name.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    pub fn set_current_workspace(&self, workspace_name: &str) -> AppResult<()> {
        let name = validate_workspace_name(workspace_name)?;
        let payload = CurrentWorkspace {
            schema_version: 1,
            workspace_name: name,
        };
        let json = serde_json::to_string_pretty(&payload)
            .map_err(|error| AppError::from(format!("serialize current workspace: {error}")))?;
        crate::utils::atomic_file::write_atomic(&self.current_file(), json)
            .map_err(|error| AppError::from(format!("write current workspace: {error}")))?;
        Ok(())
    }

    /// Workspaces that currently have a registry on disk (plus the legacy folder if present).
    pub fn registries_on_disk(&self) -> Vec<Arc<CursorBridgeService>> {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.app_paths.workspaces_dir()) {
            for entry in entries.filter_map(|entry| entry.ok()) {
                let dir = entry.path();
                if !dir.join(REGISTRY_SUBDIR).is_dir() {
                    continue;
                }
                let Some(name) = dir.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if let Ok(service) = self.for_workspace(name) {
                    out.push(service);
                }
            }
        }
        if self.app_paths.cursor_bridge_dir().is_dir() {
            out.push(self.legacy.clone());
        }
        out
    }

    /// `cursor-chat-scan` found the chat id for a launch: bind it wherever that launch's session
    /// lives. Returns the workspace-agnostic session snapshot when one matched.
    pub fn bind_resume_chat_id(
        &self,
        launch_id: &str,
        resume_chat_id: &str,
    ) -> AppResult<Option<crate::models::cursor_bridge::CursorBridgeSession>> {
        for service in self.registries_on_disk() {
            if let Some(session) = service.bind_resume_chat_id(launch_id, resume_chat_id)? {
                debug!(launch_id, "cursor-bridge: resume chat id bound");
                return Ok(Some(session));
            }
        }
        Ok(None)
    }

    fn current_file(&self) -> PathBuf {
        self.app_paths.cursor_bridge_dir().join(CURRENT_FILE)
    }
}

fn validate_workspace_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains(['/', '\\']) || trimmed.contains("..") {
        return Err(AppError::from(format!("Invalid workspace name '{}'", name)));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::cursor_bridge::CursorBridgeSessionMode;
    use crate::services::cursor_bridge_service::CursorBridgeCreateSpec;
    use tempfile::TempDir;

    fn hub() -> (TempDir, CursorBridgeHub) {
        let tmp = TempDir::new().unwrap();
        let paths = AppPaths::new(Some(tmp.path().to_string_lossy().to_string()));
        (tmp, CursorBridgeHub::new(Arc::new(paths)))
    }

    fn spec(task: &str) -> CursorBridgeCreateSpec {
        CursorBridgeCreateSpec {
            workspace: "D:/repo".into(),
            runtime_kind: None,
            read_only: true,
            allowed_paths: vec![],
            request_id: None,
            model_id: None,
            effort: None,
            task: task.into(),
            print: false,
        }
    }

    #[test]
    fn per_workspace_registries_are_isolated_and_shared_per_name() {
        let (tmp, hub) = hub();
        let alpha = hub.for_workspace("alpha").unwrap();
        let beta = hub.for_workspace("beta").unwrap();
        assert!(Arc::ptr_eq(&alpha, &hub.for_workspace("alpha").unwrap()));
        assert!(!Arc::ptr_eq(&alpha, &beta));

        alpha
            .plan_do(CursorBridgeSessionMode::Create, spec("a"), None)
            .unwrap();
        assert_eq!(alpha.list_sessions().unwrap().len(), 1);
        assert!(beta.list_sessions().unwrap().is_empty());
        assert!(tmp
            .path()
            .join("workspaces/alpha/cursor-bridge/sessions-v1.json")
            .is_file());
        assert!(hub.for_workspace("../x").is_err());
    }

    #[test]
    fn current_workspace_roundtrips_and_starts_empty() {
        let (_tmp, hub) = hub();
        assert!(hub.current_workspace().is_none());
        hub.set_current_workspace("alpha").unwrap();
        assert_eq!(hub.current_workspace().as_deref(), Some("alpha"));
        assert!(hub.set_current_workspace("  ").is_err());
    }

    #[test]
    fn bind_resume_chat_id_searches_every_registry_including_legacy() {
        let (_tmp, hub) = hub();
        let beta = hub.for_workspace("beta").unwrap();
        let created = beta
            .plan_do(CursorBridgeSessionMode::Create, spec("b"), None)
            .unwrap();
        let session_id = created.session_id.unwrap();
        beta.attach_launch(&session_id, "launch-beta", "pty-1")
            .unwrap();
        // 另一个工作空间和 legacy 都有登记簿，但只有 beta 持有该 launch
        hub.for_workspace("alpha")
            .unwrap()
            .plan_do(CursorBridgeSessionMode::Create, spec("a"), None)
            .unwrap();
        hub.legacy()
            .plan_do(CursorBridgeSessionMode::Create, spec("l"), None)
            .unwrap();

        let bound = hub
            .bind_resume_chat_id("launch-beta", "chat-42")
            .unwrap()
            .expect("bound");
        assert_eq!(bound.session_id, session_id);
        assert_eq!(bound.resume_chat_id.as_deref(), Some("chat-42"));
        assert!(hub
            .bind_resume_chat_id("launch-unknown", "chat-x")
            .unwrap()
            .is_none());
    }
}
