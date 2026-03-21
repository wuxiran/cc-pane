use crate::services::{WorktreeInfo, WorktreeService};
use crate::utils::{validate_path, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// Worktree 命令层 - 管理 Git Worktree

#[tauri::command]
pub fn is_git_repo(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<bool> {
    validate_path(&project_path)?;
    Ok(service.is_git_repo(&project_path))
}

#[tauri::command]
pub fn list_worktrees(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<Vec<WorktreeInfo>> {
    validate_path(&project_path)?;
    Ok(service.list_worktrees(&project_path)?)
}

#[tauri::command]
pub fn add_worktree(
    project_path: String,
    name: String,
    branch: Option<String>,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<String> {
    debug!("cmd::add_worktree name={}", name);
    validate_path(&project_path)?;
    Ok(service.add_worktree(&project_path, &name, branch.as_deref())?)
}

#[tauri::command]
pub fn remove_worktree(
    project_path: String,
    worktree_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<()> {
    debug!("cmd::remove_worktree worktree_path={}", worktree_path);
    validate_path(&project_path)?;
    validate_path(&worktree_path)?;
    Ok(service.remove_worktree(&project_path, &worktree_path)?)
}
