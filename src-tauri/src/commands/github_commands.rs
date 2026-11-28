//! GitHub（经本机 `gh` CLI）相关命令：可用性探测、Issue 列表、Issue 导入 Todo。
use crate::services::TodoService;
use crate::utils::{AppError, AppResult};
use cc_panes_core::services::github_cli::{
    mark_imported, project_dir, GhAvailability, GithubCliService, IssueImportResult, IssueListItem,
};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

/// gh 是否已安装且已登录（前端据此显示 / 隐藏 GitHub 入口）。
#[tauri::command]
pub async fn github_cli_status(
    service: State<'_, Arc<GithubCliService>>,
    refresh: Option<bool>,
) -> AppResult<GhAvailability> {
    let service = service.inner().clone();
    blocking(move || {
        Ok(if refresh.unwrap_or(false) {
            service.probe()
        } else {
            service.availability()
        })
    })
    .await
}

/// 列出项目仓库的 Issue（带「已导入」标记）。
#[tauri::command]
pub async fn github_list_issues(
    service: State<'_, Arc<GithubCliService>>,
    todo_service: State<'_, Arc<TodoService>>,
    project_path: String,
    query: Option<String>,
) -> AppResult<Vec<IssueListItem>> {
    debug!(project_path = %project_path, "cmd::github_list_issues");
    let service = service.inner().clone();
    let todo_service = todo_service.inner().clone();
    blocking(move || {
        let dir = project_dir(&project_path)?;
        let issues = service.issue_list(&dir, query.as_deref())?;
        mark_imported(&todo_service, issues)
    })
    .await
}

/// 把选中的 Issue 导入为项目 Todo（按 issue URL 去重）。
#[tauri::command]
pub async fn github_import_issues(
    service: State<'_, Arc<GithubCliService>>,
    todo_service: State<'_, Arc<TodoService>>,
    project_path: String,
    numbers: Vec<u64>,
) -> AppResult<Vec<IssueImportResult>> {
    debug!(project_path = %project_path, count = numbers.len(), "cmd::github_import_issues");
    let service = service.inner().clone();
    let todo_service = todo_service.inner().clone();
    blocking(move || {
        let dir = project_dir(&project_path)?;
        service.import_issues(&todo_service, &dir, &project_path, &numbers)
    })
    .await
}
