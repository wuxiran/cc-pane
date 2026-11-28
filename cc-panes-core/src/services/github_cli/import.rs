//! GitHub Issue → 项目 Todo。issue URL 是去重键，同一 issue 只导入一次。

use std::path::Path;

use serde::Serialize;

use super::{GithubCliService, IssueDetail, IssueSummary};
use crate::models::todo::{CreateTodoRequest, TodoItem, TodoScope};
use crate::services::TodoService;
use crate::utils::AppResult;

/// 单个 issue 的导入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueImportResult {
    pub number: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo: Option<TodoItem>,
    /// 之前已导入过（返回的是已有任务）。
    pub already_imported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Issue 列表项，带「是否已导入」标记（前端据此置灰）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueListItem {
    #[serde(flatten)]
    pub issue: IssueSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_todo_id: Option<String>,
}

/// 给 issue 列表标上已导入的 Todo id。
pub fn mark_imported(
    todo_service: &TodoService,
    issues: Vec<IssueSummary>,
) -> AppResult<Vec<IssueListItem>> {
    issues
        .into_iter()
        .map(|issue| {
            let imported_todo_id = todo_service.issue_todo_id(&issue.url)?;
            Ok(IssueListItem {
                issue,
                imported_todo_id,
            })
        })
        .collect()
}

/// issue → 项目级 Todo：描述首行是 issue 链接，标签沿用 issue labels。
pub fn issue_to_todo_request(project_path: &str, issue: &IssueDetail) -> CreateTodoRequest {
    let summary = &issue.summary;
    let body = issue.body.trim();
    let description = if body.is_empty() {
        summary.url.clone()
    } else {
        format!("{}\n\n{}", summary.url, body)
    };
    CreateTodoRequest {
        title: format!("#{} {}", summary.number, summary.title.trim()),
        description: Some(description),
        scope: Some(TodoScope::Project),
        scope_ref: Some(project_path.to_string()),
        tags: (!summary.labels.is_empty()).then(|| summary.labels.clone()),
        issue_url: Some(summary.url.clone()),
        issue_number: i64::try_from(summary.number).ok(),
        ..Default::default()
    }
}

impl GithubCliService {
    /// 逐个拉 issue 详情并导入；单个失败不影响其余。
    pub fn import_issues(
        &self,
        todo_service: &TodoService,
        project: &Path,
        project_path: &str,
        numbers: &[u64],
    ) -> AppResult<Vec<IssueImportResult>> {
        self.ensure_ready()?;
        let results = numbers
            .iter()
            .map(|&number| {
                let imported = self.issue_view(project, number).and_then(|issue| {
                    todo_service
                        .create_or_get_issue_todo(issue_to_todo_request(project_path, &issue))
                });
                match imported {
                    Ok((todo, already_imported)) => IssueImportResult {
                        number,
                        todo: Some(todo),
                        already_imported,
                        error: None,
                    },
                    Err(error) => IssueImportResult {
                        number,
                        todo: None,
                        already_imported: false,
                        error: Some(error.to_string()),
                    },
                }
            })
            .collect();
        Ok(results)
    }
}
