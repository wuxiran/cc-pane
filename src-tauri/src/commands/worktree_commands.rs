use crate::services::{WorktreeInfo, WorktreeService};
use crate::utils::{validate_path, AppError, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// Worktree 命令层 - 管理 Git Worktree

#[tauri::command]
pub async fn is_git_repo(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<bool> {
    validate_path(&project_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.is_git_repo(&project_path))
        .await
        .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn list_worktrees(
    project_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<Vec<WorktreeInfo>> {
    validate_path(&project_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.list_worktrees(&project_path))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn add_worktree(
    project_path: String,
    name: String,
    branch: Option<String>,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<String> {
    debug!("cmd::add_worktree name={}", name);
    validate_path(&project_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.add_worktree(&project_path, &name, branch.as_deref())
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn remove_worktree(
    project_path: String,
    worktree_path: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<()> {
    debug!("cmd::remove_worktree worktree_path={}", worktree_path);
    validate_path(&project_path)?;
    validate_path(&worktree_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.remove_worktree(&project_path, &worktree_path)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
    .map_err(AppError::from)
}
