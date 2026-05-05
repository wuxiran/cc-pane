use cc_panes_core::models::workspace_snapshot::{WorkspaceSnapshot, WorkspaceSnapshotSummary};
use cc_panes_core::services::SessionRestoreService;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn list_workspace_snapshots(
    workspace_id: String,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<Vec<WorkspaceSnapshotSummary>, String> {
    service.list_workspace_snapshots(&workspace_id)
}

#[tauri::command]
pub async fn get_workspace_snapshot(
    workspace_id: String,
    snapshot_id: String,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    service.get_workspace_snapshot(&workspace_id, &snapshot_id)
}

#[tauri::command]
pub async fn delete_workspace_snapshot(
    workspace_id: String,
    snapshot_id: String,
    service: State<'_, Arc<SessionRestoreService>>,
) -> Result<bool, String> {
    service.delete_workspace_snapshot(&workspace_id, &snapshot_id)
}
