use serde::{Deserialize, Serialize};

/// CC-Panes workspace UI state snapshot.
///
/// This is not an agent conversation identity. Claude/Codex resume uses their
/// own resume IDs; this snapshot only preserves workspace layout and launch context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub title: String,
    pub created_at: String,
    pub saved_at: String,
    pub entries: Vec<WorkspaceSnapshotEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshotSummary {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub title: String,
    pub created_at: String,
    pub saved_at: String,
    pub entry_count: usize,
}

impl From<&WorkspaceSnapshot> for WorkspaceSnapshotSummary {
    fn from(snapshot: &WorkspaceSnapshot) -> Self {
        Self {
            id: snapshot.id.clone(),
            workspace_id: snapshot.workspace_id.clone(),
            workspace_name: snapshot.workspace_name.clone(),
            workspace_path: snapshot.workspace_path.clone(),
            title: snapshot.title.clone(),
            created_at: snapshot.created_at.clone(),
            saved_at: snapshot.saved_at.clone(),
            entry_count: snapshot.entries.len(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshotEntry {
    pub pty_session_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub project_path: String,
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_selection: Option<String>,
    pub launch_profile_id: Option<String>,
    pub agent_tool: String,
    pub runtime_kind: Option<String>,
    pub agent_resume_id: Option<String>,
    pub custom_title: Option<String>,
    pub created_at: String,
    pub saved_at: String,
}
