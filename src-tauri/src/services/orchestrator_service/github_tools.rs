//! GitHub PR / CI / Issue 的 MCP 面（docs/1xx-github-delivery）。
//!
//! 全部经本机 `gh` CLI（`cc_panes_core::services::github_cli`），复用用户登录。
//! `gh_pr_merge` 不可逆：执行前必须在前端弹确认，用户不点确认（含超时 / 前端不在）一律拒绝。
use super::*;
use cc_panes_core::services::github_cli::{
    project_dir, GithubCliService, LogBudget, MergeMethod, PrCreateRequest,
};

/// 等用户确认合并的最长时间；超时按拒绝处理。
const MERGE_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhProjectParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhPrCreateParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    pub(super) title: String,
    #[serde(default)]
    pub(super) body: String,
    /// 默认仓库默认分支
    pub(super) base: Option<String>,
    pub(super) draft: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhPrMergeParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    /// squash（默认）/ merge / rebase
    pub(super) method: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhCiLogsParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    /// 默认当前分支最近一次失败的 run
    #[serde(rename = "runId")]
    pub(super) run_id: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhCiRerunParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    #[serde(rename = "runId")]
    pub(super) run_id: u64,
    /// 默认 true：只重跑失败的 job
    #[serde(rename = "failedOnly")]
    pub(super) failed_only: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhIssueListParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    /// GitHub 搜索语法，如 "is:open label:bug"
    pub(super) query: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpGhIssueViewParams {
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    pub(super) number: u64,
}

/// 前端确认框的请求事件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhMergeConfirmEvent {
    pub(super) request_id: String,
    pub(super) project_path: String,
    pub(super) number: u64,
    pub(super) title: String,
    pub(super) url: String,
    pub(super) base_ref_name: String,
    pub(super) head_ref_name: String,
    pub(super) method: MergeMethod,
}

/// 前端回执 `{"approved": true}` 才算确认；其余一律视为拒绝。
pub(super) fn merge_approved(response: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(response)
        .ok()
        .and_then(|value| value.get("approved").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| format!("错误: 序列化失败: {error}"))
}

impl McpToolHandler {
    fn github_service(&self) -> Result<Arc<GithubCliService>, String> {
        self.state
            .app_handle
            .try_state::<Arc<GithubCliService>>()
            .map(|state| state.inner().clone())
            .ok_or_else(|| "GitHub 服务未初始化".to_string())
    }

    /// 在阻塞线程里跑一次 gh 操作，统一把错误转成 `错误: ...` 文本。
    async fn run_github<T, F>(&self, project_path: &str, task: F) -> String
    where
        T: Serialize + Send + 'static,
        F: FnOnce(&GithubCliService, &std::path::Path) -> cc_panes_core::utils::AppResult<T>
            + Send
            + 'static,
    {
        let service = match self.github_service() {
            Ok(service) => service,
            Err(error) => return format!("错误: {error}"),
        };
        let project_path = project_path.to_string();
        let joined = tokio::task::spawn_blocking(move || {
            let dir = project_dir(&project_path)?;
            task(&service, &dir)
        })
        .await;
        match joined {
            Ok(Ok(value)) => to_json(&value),
            Ok(Err(error)) => format!("错误: {error}"),
            Err(error) => format!("错误: {error}"),
        }
    }

    pub(super) async fn gh_pr_status_impl(&self, params: McpGhProjectParams) -> String {
        info!(project = %params.project_path, "mcp::gh_pr_status");
        self.run_github(&params.project_path, |gh, dir| {
            Ok(serde_json::json!({ "pr": gh.pr_status(dir)? }))
        })
        .await
    }

    pub(super) async fn gh_pr_create_impl(&self, params: McpGhPrCreateParams) -> String {
        info!(project = %params.project_path, "mcp::gh_pr_create");
        let request = PrCreateRequest {
            title: params.title,
            body: params.body,
            base: params.base,
            draft: params.draft.unwrap_or(false),
        };
        self.run_github(&params.project_path, move |gh, dir| {
            gh.pr_create(dir, request)
        })
        .await
    }

    pub(super) async fn gh_ci_failed_logs_impl(&self, params: McpGhCiLogsParams) -> String {
        info!(project = %params.project_path, run_id = ?params.run_id, "mcp::gh_ci_failed_logs");
        let run_id = params.run_id;
        self.run_github(&params.project_path, move |gh, dir| {
            gh.ci_failed_logs(dir, run_id, LogBudget::default())
        })
        .await
    }

    pub(super) async fn gh_ci_rerun_impl(&self, params: McpGhCiRerunParams) -> String {
        info!(project = %params.project_path, run_id = params.run_id, "mcp::gh_ci_rerun");
        let (run_id, failed_only) = (params.run_id, params.failed_only.unwrap_or(true));
        self.run_github(&params.project_path, move |gh, dir| {
            gh.ci_rerun(dir, run_id, failed_only)?;
            Ok(serde_json::json!({ "runId": run_id, "failedOnly": failed_only, "rerun": true }))
        })
        .await
    }

    pub(super) async fn gh_issue_list_impl(&self, params: McpGhIssueListParams) -> String {
        info!(project = %params.project_path, "mcp::gh_issue_list");
        let query = params.query;
        self.run_github(&params.project_path, move |gh, dir| {
            Ok(serde_json::json!({ "issues": gh.issue_list(dir, query.as_deref())? }))
        })
        .await
    }

    pub(super) async fn gh_issue_view_impl(&self, params: McpGhIssueViewParams) -> String {
        info!(project = %params.project_path, number = params.number, "mcp::gh_issue_view");
        let number = params.number;
        self.run_github(&params.project_path, move |gh, dir| {
            gh.issue_view(dir, number)
        })
        .await
    }

    /// 合并当前分支的 PR：先查 PR，再弹前端确认，确认后锁定 head 提交合并。
    pub(super) async fn gh_pr_merge_impl(&self, params: McpGhPrMergeParams) -> String {
        info!(project = %params.project_path, "mcp::gh_pr_merge");
        let method = match MergeMethod::parse(params.method.as_deref()) {
            Ok(method) => method,
            Err(error) => return format!("错误: {error}"),
        };
        let status = self
            .run_github(&params.project_path, |gh, dir| gh.pr_status(dir))
            .await;
        let pr = match serde_json::from_str::<Option<serde_json::Value>>(&status) {
            Ok(Some(pr)) => pr,
            Ok(None) => return "错误: 当前分支没有 PR".to_string(),
            Err(_) => return status,
        };
        let field = |key: &str| {
            pr.get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        if field("state") != "OPEN" {
            return format!("错误: PR 状态是 {}，不能合并", field("state"));
        }
        let number = pr
            .get("number")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let event = GhMergeConfirmEvent {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_path: params.project_path.clone(),
            number,
            title: field("title"),
            url: field("url"),
            base_ref_name: field("baseRefName"),
            head_ref_name: field("headRefName"),
            method,
        };
        if let Err(error) = self.confirm_merge_with_user(&event).await {
            return format!("错误: {error}");
        }
        let head_oid = Some(field("headRefOid")).filter(|oid| !oid.is_empty());
        info!(number, method = ?method, "mcp::gh_pr_merge confirmed by user");
        self.run_github(&params.project_path, move |gh, dir| {
            let output = gh.pr_merge(dir, number, head_oid.as_deref(), method)?;
            Ok(serde_json::json!({ "merged": true, "number": number, "method": method, "output": output }))
        })
        .await
    }

    /// 前端弹确认框并等待回执；未确认（拒绝 / 超时 / 前端不在）返回 Err。
    async fn confirm_merge_with_user(&self, event: &GhMergeConfirmEvent) -> Result<(), String> {
        let request_id = event.request_id.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let remove_pending = || {
            self.state
                .pending_queries
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&request_id);
        };
        self.state
            .pending_queries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(request_id.clone(), tx);
        if let Err(error) =
            self.state
                .app_handle
                .emit_to("main", "orchestrator-confirm-gh-merge", event)
        {
            remove_pending();
            return Err(format!("无法向用户请求合并确认，已拒绝合并: {error}"));
        }
        match tokio::time::timeout(MERGE_CONFIRM_TIMEOUT, rx).await {
            Ok(Ok(response)) if merge_approved(&response) => Ok(()),
            Ok(Ok(_)) => Err("用户拒绝了合并".to_string()),
            Ok(Err(_)) => Err("确认通道已关闭，已拒绝合并".to_string()),
            Err(_) => {
                remove_pending();
                Err("等待用户确认超时，已拒绝合并".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_approval_counts() {
        assert!(merge_approved(r#"{"approved":true}"#));
        assert!(!merge_approved(r#"{"approved":false}"#));
        assert!(!merge_approved(r#"{"approved":"true"}"#));
        assert!(!merge_approved("{}"));
        assert!(!merge_approved("not json"));
    }

    #[test]
    fn confirm_event_is_camel_case() {
        let event = GhMergeConfirmEvent {
            request_id: "r".into(),
            project_path: "/p".into(),
            number: 3,
            title: "t".into(),
            url: "u".into(),
            base_ref_name: "main".into(),
            head_ref_name: "feat".into(),
            method: MergeMethod::Squash,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["requestId"], "r");
        assert_eq!(value["baseRefName"], "main");
        assert_eq!(value["method"], "squash");
    }
}
