use crate::services::{WorktreeInfo, WorktreeService, WorktreeSetupPlan, WorktreeSetupService};
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
    base_ref: Option<String>,
    preserve_cwd: Option<bool>,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<String> {
    debug!("cmd::add_worktree name={}", name);
    validate_path(&project_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if preserve_cwd.unwrap_or(false) {
            service.prepare_session_worktree(
                &project_path,
                &name,
                branch
                    .as_deref()
                    .ok_or("A new session branch is required")?,
                base_ref.as_deref(),
            )
        } else {
            service.add_worktree_from_ref(
                &project_path,
                &name,
                branch.as_deref(),
                base_ref.as_deref(),
            )
        }
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

#[tauri::command]
pub async fn fork_chat_worktree(
    cwd: String,
    service: State<'_, Arc<WorktreeService>>,
) -> AppResult<String> {
    validate_path(&cwd)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.fork_chat_worktree(&cwd))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .map_err(AppError::from)
}

/// worktree 建好后调用：应用 copyFiles / sparseCheckout，返回 setup 计划（不执行命令）。
/// 没有 `.ccpanes/worktree.json` 时返回 None。
#[tauri::command]
pub async fn prepare_worktree_setup(
    worktree_path: String,
    service: State<'_, Arc<WorktreeSetupService>>,
) -> AppResult<Option<WorktreeSetupPlan>> {
    validate_path(&worktree_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.prepare(&worktree_path))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(AppError::from)
}

/// 记「始终允许」：按 项目 + 配置 hash，配置一改就失效。
#[tauri::command]
pub async fn approve_worktree_setup(
    project_path: String,
    config_hash: String,
    service: State<'_, Arc<WorktreeSetupService>>,
) -> AppResult<()> {
    validate_path(&project_path)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.approve(&project_path, &config_hash))
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(AppError::from)
}
