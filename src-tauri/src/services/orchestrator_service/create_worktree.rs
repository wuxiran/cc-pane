//! `create_worktree`（仅 `/mcp-full`，skill 经 ctl 调）：建 worktree、可选登记进工作空间，
//! 再按 `.ccpanes/worktree.json` 处理 setup（docs/116）。
//!
//! 派发路径上没有人能点确认框，所以 setup 只在**已有「始终允许」记录**时自动执行，
//! 否则跳过并在返回值里说明；绝不等待批准、也不等 setup 跑完。
use super::*;
use cc_panes_core::services::{WorktreeService, WorktreeSetupPlan, WorktreeSetupService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub(super) struct McpCreateWorktreeParams {
    /// 主仓库路径（或仓库内任意目录）
    #[serde(rename = "projectPath")]
    pub(super) project_path: String,
    /// worktree 目录名，建在 `<repo>-worktrees/<name>`
    pub(super) name: String,
    /// 新分支名（省略用 name）
    pub(super) branch: Option<String>,
    /// 起点 ref（省略用 HEAD）
    #[serde(rename = "baseRef")]
    pub(super) base_ref: Option<String>,
    /// 同时登记进这个工作空间（可选）
    #[serde(rename = "workspaceName")]
    pub(super) workspace_name: Option<String>,
}

/// setup 在派发路径上怎么处理。纯函数，便于测试。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DispatchSetupDecision {
    /// 没有配置或没有 setup 命令
    None,
    /// 有命令但未批准：跳过
    NotApproved,
    /// 已「始终允许」：执行这一行
    Run(String),
}

pub(super) fn dispatch_setup_decision(plan: Option<&WorktreeSetupPlan>) -> DispatchSetupDecision {
    match plan {
        Some(plan) if !plan.setup.is_empty() => {
            if plan.always_allowed {
                DispatchSetupDecision::Run(plan.command_line.clone())
            } else {
                DispatchSetupDecision::NotApproved
            }
        }
        _ => DispatchSetupDecision::None,
    }
}

fn setup_summary(
    plan: Option<&WorktreeSetupPlan>,
    decision: &DispatchSetupDecision,
    error: Option<&str>,
) -> serde_json::Value {
    let (status, note) = match (decision, error) {
        (_, Some(error)) => ("error", Some(error.to_string())),
        (DispatchSetupDecision::None, _) => ("none", None),
        (DispatchSetupDecision::NotApproved, _) => (
            "skipped",
            Some(
                "setup 未获「始终允许」，已跳过；请在 CC-Panes 里用 worktree 管理建一次并选「始终允许」，或手动在 worktree 里执行"
                    .to_string(),
            ),
        ),
        (DispatchSetupDecision::Run(_), _) => ("started", None),
    };
    serde_json::json!({
        "status": status,
        "commands": plan.map(|plan| plan.setup.clone()).unwrap_or_default(),
        "copiedFiles": plan.map(|plan| plan.copied_files.clone()).unwrap_or_default(),
        "warnings": plan.map(|plan| plan.warnings.clone()).unwrap_or_default(),
        "note": note,
    })
}

impl McpToolHandler {
    pub(super) async fn create_worktree_impl(
        &self,
        params: McpCreateWorktreeParams,
        extensions: Extensions,
    ) -> String {
        info!(project = %params.project_path, name = %params.name, "mcp::create_worktree");
        if let Err(error) = validate_path(&params.project_path) {
            return format!("错误: {}", error);
        }
        let project_path = params.project_path.clone();
        let name = params.name.clone();
        let branch = params.branch.clone();
        let base_ref = params.base_ref.clone();
        let created = tokio::task::spawn_blocking(move || {
            WorktreeService::new().add_worktree_from_ref(
                &project_path,
                &name,
                Some(branch.as_deref().unwrap_or(&name)),
                base_ref.as_deref(),
            )
        })
        .await;
        let worktree_path = match created {
            Ok(Ok(path)) => path,
            Ok(Err(error)) => return format!("错误: {}", error),
            Err(error) => return format!("错误: {}", error),
        };

        let registered = params
            .workspace_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|workspace| {
                self.state
                    .workspace_service
                    .add_project(workspace, &worktree_path)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            });

        let approvals_path = self.state.app_paths.worktree_setup_approvals_path();
        let prepare_path = worktree_path.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            WorktreeSetupService::new(approvals_path).prepare(&prepare_path)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        let (plan, prepare_error) = match prepared {
            Ok(plan) => (plan, None),
            Err(error) => {
                warn!(err = %error, "mcp::create_worktree setup prepare failed");
                (None, Some(error))
            }
        };
        let decision = dispatch_setup_decision(plan.as_ref());
        if let DispatchSetupDecision::Run(command_line) = &decision {
            self.spawn_worktree_setup(
                &params.project_path,
                &worktree_path,
                command_line,
                extensions,
            );
        }

        serde_json::json!({
            "success": true,
            "worktreePath": worktree_path,
            "registered": registered.as_ref().map(|result| result.is_ok()),
            "registerError": registered.and_then(|result| result.err()),
            "setup": setup_summary(plan.as_ref(), &decision, prepare_error.as_deref()),
        })
        .to_string()
    }

    /// 后台开一个普通终端标签跑 setup：不阻塞派发，结果只进日志。
    fn spawn_worktree_setup(
        &self,
        source_project: &str,
        worktree_path: &str,
        command_line: &str,
        extensions: Extensions,
    ) {
        // open_terminal_tab 要求一个已登记项目：worktree 已登记用它，否则用主仓库，
        // 都没登记就交给它按调用方项目兜底。cwd 始终显式给 worktree。
        let project_path = [worktree_path, source_project]
            .into_iter()
            .find(|path| is_project_registered(&self.state, path))
            .map(str::to_string);
        let params = McpOpenTerminalTabParams {
            cwd: Some(worktree_path.to_string()),
            project_path,
            command: Some(command_line.to_string()),
            title: Some("worktree setup".to_string()),
            ..McpOpenTerminalTabParams::default()
        };
        let handler = self.clone();
        tokio::spawn(async move {
            let result = handler.open_terminal_tab_impl(params, extensions).await;
            if result.starts_with("错误") {
                warn!(result = %result, "mcp::create_worktree setup terminal failed");
            } else {
                info!("mcp::create_worktree setup terminal opened");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(setup: &[&str], always_allowed: bool) -> WorktreeSetupPlan {
        WorktreeSetupPlan {
            project_path: "/repo".into(),
            worktree_path: "/repo-worktrees/a".into(),
            setup: setup.iter().map(|item| item.to_string()).collect(),
            command_line: setup.join(" && "),
            config_hash: "h".into(),
            always_allowed,
            copied_files: vec![],
            sparse_applied: false,
            warnings: vec![],
        }
    }

    #[test]
    fn only_always_allowed_setup_runs_on_dispatch() {
        assert_eq!(dispatch_setup_decision(None), DispatchSetupDecision::None);
        assert_eq!(
            dispatch_setup_decision(Some(&plan(&[], true))),
            DispatchSetupDecision::None
        );
        assert_eq!(
            dispatch_setup_decision(Some(&plan(&["npm ci"], false))),
            DispatchSetupDecision::NotApproved
        );
        assert_eq!(
            dispatch_setup_decision(Some(&plan(&["npm ci", "make"], true))),
            DispatchSetupDecision::Run("npm ci && make".into())
        );
    }

    #[test]
    fn skipped_setup_explains_itself() {
        let pending = plan(&["npm ci"], false);
        let summary = setup_summary(Some(&pending), &DispatchSetupDecision::NotApproved, None);
        assert_eq!(summary["status"], "skipped");
        assert!(summary["note"].as_str().unwrap().contains("始终允许"));
        let failed = setup_summary(None, &DispatchSetupDecision::None, Some("boom"));
        assert_eq!(failed["status"], "error");
    }
}
