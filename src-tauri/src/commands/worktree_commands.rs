use crate::services::{WorktreeService, WorktreeInfo};
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

/// Worktree 命令层 - 管理 Git Worktree

#[tauri::command]
pub fn is_git_repo(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<bool> {
    Ok(service.is_git_repo(&project_path))
}

#[tauri::command]
pub fn list_worktrees(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<Vec<WorktreeInfo>> {
    Ok(service.list_worktrees(&project_path)?)
}

#[tauri::command]
pub fn add_worktree(
    project_path: String,
    name: String,
    branch: Option<String>,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<String> {
    Ok(service.add_worktree(&project_path, &name, branch.as_deref())?)
}

#[tauri::command]
pub fn remove_worktree(
    project_path: String,
    worktree_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<()> {
    Ok(service.remove_worktree(&project_path, &worktree_path)?)
}
