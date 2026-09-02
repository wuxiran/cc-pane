//! CC-Panes Cursor Bridge 契约类型。
//!
//! 产品面参考 Vanyangyang/cursor-bridge：sessionId ≠ taskId ≠ Cursor chat uuid，
//! continue 不得扩 scope。实现走官方 `cursor-agent` CLI，不走 CDP。

use serde::{Deserialize, Serialize};

pub const CURSOR_BRIDGE_SCHEMA_VERSION: u32 = 1;
pub const CURSOR_BRIDGE_SESSION_PREFIX: &str = "cbrs-";
pub const CURSOR_BRIDGE_TASK_PREFIX: &str = "cbrt-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorBridgeAction {
    Init,
    Context,
    #[serde(rename = "do")]
    Do,
    Status,
    Model,
    Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CursorBridgeSessionMode {
    #[default]
    Isolated,
    Create,
    Continue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorBridgeSessionStatus {
    Creating,
    Busy,
    Ready,
    NeedsAttention,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorBridgeSessionControl {
    Close,
    Forget,
    Reconcile,
    Abandon,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorBridgeModelTarget {
    Context,
    #[serde(rename = "do")]
    Do,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeScope {
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_paths: Vec<String>,
}

impl CursorBridgeScope {
    pub fn read_only() -> Self {
        Self {
            read_only: true,
            allowed_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
    pub scope: CursorBridgeScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub epoch: u64,
    pub turn_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_request_id: Option<String>,
    pub status: CursorBridgeSessionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeModelPref {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeModelPreferences {
    pub schema_version: u32,
    #[serde(default)]
    pub context: CursorBridgeModelPref,
    #[serde(default, rename = "do")]
    pub do_pref: CursorBridgeModelPref,
}

impl Default for CursorBridgeModelPreferences {
    fn default() -> Self {
        Self {
            schema_version: CURSOR_BRIDGE_SCHEMA_VERSION,
            context: CursorBridgeModelPref::default(),
            do_pref: CursorBridgeModelPref::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeWorkspaceBinding {
    pub schema_version: u32,
    /// Default project inside the workspace for `context` / `do` when the caller gives none.
    pub project_path: String,
    /// Owning workspace (docs/98 workspace-first). `None` only in pre-0.12.10 global files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorBridgeRegistry {
    pub schema_version: u32,
    #[serde(default)]
    pub sessions: Vec<CursorBridgeSession>,
}

impl Default for CursorBridgeRegistry {
    fn default() -> Self {
        Self {
            schema_version: CURSOR_BRIDGE_SCHEMA_VERSION,
            sessions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorBridgeTurnPlan {
    pub session_id: Option<String>,
    pub task_id: String,
    pub prompt: String,
    pub print: bool,
    pub read_only: bool,
    pub resume_chat_id: Option<String>,
    pub model_id: Option<String>,
    pub effort: Option<String>,
    pub replay: bool,
    pub workspace: String,
    pub runtime_kind: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_do_renames_in_json() {
        let raw = serde_json::to_string(&CursorBridgeAction::Do).unwrap();
        assert_eq!(raw, "\"do\"");
        let parsed: CursorBridgeAction = serde_json::from_str("\"do\"").unwrap();
        assert_eq!(parsed, CursorBridgeAction::Do);
    }
}
