//! GitHub PR / CI / Issue 能力（docs/1xx-github-delivery）。
//!
//! 一律走用户本机的 `gh` CLI，复用其登录态；CC-Panes 不保存任何 token。
//! 没装 / 没登录时入口隐藏，调用返回可操作的错误提示。

mod import;
pub mod parse;
mod runner;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tracing::{info, warn};

use crate::utils::{AppError, AppResult};

pub use import::{issue_to_todo_request, mark_imported, IssueImportResult, IssueListItem};
pub use parse::{
    FailedJob, FailedLogs, IssueDetail, IssueSummary, LogBudget, PrStatus, RunSummary,
};
pub use runner::{CliOutput, CliProgram, CliRunner, SystemCliRunner};

/// `gh` 可用性（启动探测 + 未就绪时按需重探）。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhAvailability {
    pub installed: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

impl GhAvailability {
    pub fn ready(&self) -> bool {
        self.installed && self.authenticated
    }

    /// 未就绪时给 agent / 用户的可操作提示。
    pub fn unready_message(&self) -> Option<&'static str> {
        if !self.installed {
            Some("未检测到 GitHub CLI（gh）。请安装 https://cli.github.com 后重试。")
        } else if !self.authenticated {
            Some("gh 未登录。请在终端运行 `gh auth login` 后重试。")
        } else {
            None
        }
    }
}

/// PR 合并方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    /// 默认 squash；只认 merge / squash / rebase。
    pub fn parse(value: Option<&str>) -> AppResult<Self> {
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            None | Some("squash") => Ok(Self::Squash),
            Some("merge") => Ok(Self::Merge),
            Some("rebase") => Ok(Self::Rebase),
            Some(other) => Err(AppError::from(format!(
                "不支持的合并方式 '{other}'（可选 merge / squash / rebase）"
            ))),
        }
    }

    fn flag(self) -> &'static str {
        match self {
            Self::Merge => "--merge",
            Self::Squash => "--squash",
            Self::Rebase => "--rebase",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PrCreateRequest {
    pub title: String,
    pub body: String,
    pub base: Option<String>,
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    pub base: String,
    pub head: String,
    pub draft: bool,
}

/// `gh_ci_failed_logs` 的返回体。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiFailedLogs {
    pub run: RunSummary,
    pub failed_jobs: Vec<FailedJob>,
    #[serde(flatten)]
    pub logs: FailedLogs,
    /// 日志拉取失败（run 还在跑 / 日志已过期）时的原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

pub struct GithubCliService {
    runner: Arc<dyn CliRunner>,
    availability: Mutex<Option<GhAvailability>>,
}

/// Issue 列表默认 / 最大条数。
const ISSUE_LIST_LIMIT: u32 = 30;

impl GithubCliService {
    pub fn new(runner: Arc<dyn CliRunner>) -> Self {
        Self {
            runner,
            availability: Mutex::new(None),
        }
    }

    pub fn system() -> Self {
        Self::new(Arc::new(SystemCliRunner))
    }

    // ============ 可用性 ============

    /// 重新探测 `gh` 是否安装、是否登录，并缓存结果。
    pub fn probe(&self) -> GhAvailability {
        let availability = self.detect();
        info!(
            installed = availability.installed,
            authenticated = availability.authenticated,
            "github_cli::probe"
        );
        *self.lock_availability() = Some(availability.clone());
        availability
    }

    /// 缓存的可用性；未就绪时重探（用户可能刚装好 / 刚登录）。
    pub fn availability(&self) -> GhAvailability {
        // 先放锁再探测：match 的临时守卫会活到整个 match 结束，probe 里再加锁就死锁。
        let cached = self.lock_availability().clone();
        match cached {
            Some(cached) if cached.ready() => cached,
            _ => self.probe(),
        }
    }

    pub fn ensure_ready(&self) -> AppResult<()> {
        let availability = self.availability();
        match availability.unready_message() {
            Some(message) => Err(AppError::from(message)),
            None => Ok(()),
        }
    }

    fn lock_availability(&self) -> std::sync::MutexGuard<'_, Option<GhAvailability>> {
        self.availability
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn detect(&self) -> GhAvailability {
        if !self.runner.is_installed(CliProgram::Gh) {
            return GhAvailability::default();
        }
        // auth status 与仓库无关，但 cwd 仍必须显式给，免得继承宿主目录。
        let cwd = std::env::temp_dir();
        let json = self.runner.run(
            CliProgram::Gh,
            &cwd,
            &args(&["auth", "status", "--json", "hosts"]),
        );
        let summary = match json {
            Ok(output) if output.success => parse::parse_auth_status_json(&output.stdout),
            Ok(output) if parse::is_unknown_flag_error(&output.stderr) => {
                // 旧版 gh：只能看退出码。
                self.runner
                    .run(CliProgram::Gh, &cwd, &args(&["auth", "status"]))
                    .ok()
                    .map(|plain| parse::AuthSummary {
                        authenticated: plain.success,
                        account: None,
                        host: None,
                    })
            }
            Ok(output) => {
                warn!(err = %output.error_text(), "github_cli::probe auth status failed");
                None
            }
            Err(error) => {
                warn!(err = %error, "github_cli::probe spawn failed");
                None
            }
        };
        let summary = summary.unwrap_or(parse::AuthSummary {
            authenticated: false,
            account: None,
            host: None,
        });
        GhAvailability {
            installed: true,
            authenticated: summary.authenticated,
            account: summary.account,
            host: summary.host,
        }
    }

    // ============ 执行 ============

    fn exec(&self, program: CliProgram, cwd: &Path, argv: &[String]) -> AppResult<CliOutput> {
        self.runner.run(program, cwd, argv)
    }

    /// 执行 gh，非零退出直接转成错误。
    fn gh_stdout(&self, cwd: &Path, argv: &[String]) -> AppResult<String> {
        let output = self.exec(CliProgram::Gh, cwd, argv)?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(AppError::from(format!(
                "gh 执行失败: {}",
                output.error_text()
            )))
        }
    }

    pub fn current_branch(&self, project: &Path) -> AppResult<String> {
        let output = self.exec(
            CliProgram::Git,
            project,
            &args(&["branch", "--show-current"]),
        )?;
        let branch = output.stdout.trim().to_string();
        if !output.success {
            return Err(AppError::from(format!(
                "读取当前分支失败: {}",
                output.error_text()
            )));
        }
        if branch.is_empty() {
            return Err(AppError::from("当前处于 detached HEAD，没有分支"));
        }
        Ok(branch)
    }

    pub fn default_branch(&self, project: &Path) -> AppResult<String> {
        let raw = self.gh_stdout(
            project,
            &args(&["repo", "view", "--json", "defaultBranchRef"]),
        )?;
        parse::parse_default_branch(&raw).map_err(AppError::from)
    }

    // ============ PR ============

    /// 当前分支对应的 PR；没有 PR 时返回 `None`。
    pub fn pr_status(&self, project: &Path) -> AppResult<Option<PrStatus>> {
        self.ensure_ready()?;
        let output = self.exec(
            CliProgram::Gh,
            project,
            &args(&["pr", "view", "--json", parse::PR_VIEW_FIELDS]),
        )?;
        if !output.success {
            if parse::is_no_pr_error(&output.stderr) {
                return Ok(None);
            }
            return Err(AppError::from(format!(
                "gh 执行失败: {}",
                output.error_text()
            )));
        }
        parse::parse_pr_view(&output.stdout)
            .map(Some)
            .map_err(AppError::from)
    }

    pub fn pr_create(&self, project: &Path, request: PrCreateRequest) -> AppResult<PrCreated> {
        self.ensure_ready()?;
        let title = request.title.trim();
        if title.is_empty() {
            return Err(AppError::from("PR 标题不能为空"));
        }
        let head = self.current_branch(project)?;
        let base = match request.base.as_deref().map(str::trim) {
            Some(base) if !base.is_empty() => base.to_string(),
            _ => self.default_branch(project)?,
        };
        if base == head {
            return Err(AppError::from(format!(
                "当前分支 {head} 就是 base，无法开 PR"
            )));
        }
        let mut argv = args(&["pr", "create", "--title", title, "--body"]);
        argv.push(request.body.clone());
        argv.extend(args(&["--base", &base, "--head", &head]));
        if request.draft {
            argv.push("--draft".to_string());
        }
        let stdout = self.gh_stdout(project, &argv)?;
        let url = parse::parse_created_pr_url(&stdout)
            .ok_or_else(|| AppError::from("gh 未返回 PR 链接"))?;
        Ok(PrCreated {
            number: parse::number_from_url(&url),
            url,
            base,
            head,
            draft: request.draft,
        })
    }

    /// 合并指定 PR。`head_oid` 锁定用户确认时看到的那个提交，期间有新推送则拒绝合并。
    /// 调用方必须先拿到用户确认。
    pub fn pr_merge(
        &self,
        project: &Path,
        number: u64,
        head_oid: Option<&str>,
        method: MergeMethod,
    ) -> AppResult<String> {
        self.ensure_ready()?;
        let mut argv = args(&["pr", "merge", &number.to_string(), method.flag()]);
        if let Some(oid) = head_oid.filter(|oid| !oid.is_empty()) {
            argv.extend(args(&["--match-head-commit", oid]));
        }
        let output = self.gh_stdout(project, &argv)?;
        Ok(output.trim().to_string())
    }

    // ============ CI ============

    /// 当前分支最近一次失败的 run。
    pub fn latest_failed_run(&self, project: &Path) -> AppResult<Option<RunSummary>> {
        let branch = self.current_branch(project)?;
        let raw = self.gh_stdout(
            project,
            &args(&[
                "run",
                "list",
                "--branch",
                &branch,
                "--status",
                "failure",
                "--limit",
                "1",
                "--json",
                parse::RUN_LIST_FIELDS,
            ]),
        )?;
        parse::parse_first_run(&raw).map_err(AppError::from)
    }

    /// 失败 run 的失败 job 与日志尾部。`run_id` 缺省取当前分支最近一次失败。
    pub fn ci_failed_logs(
        &self,
        project: &Path,
        run_id: Option<u64>,
        budget: LogBudget,
    ) -> AppResult<CiFailedLogs> {
        self.ensure_ready()?;
        let run_id = match run_id {
            Some(id) => id,
            None => match self.latest_failed_run(project)? {
                Some(run) => run.run_id,
                None => return Err(AppError::from("当前分支没有失败的 CI run")),
            },
        };
        let id = run_id.to_string();
        let raw = self.gh_stdout(
            project,
            &args(&["run", "view", &id, "--json", parse::RUN_VIEW_FIELDS]),
        )?;
        let (run, failed_jobs) = parse::parse_run_view(&raw).map_err(AppError::from)?;
        let log_output = self.exec(
            CliProgram::Gh,
            project,
            &args(&["run", "view", &id, "--log-failed"]),
        )?;
        let (logs, log_error) = if log_output.success {
            (parse::tail_failed_logs(&log_output.stdout, budget), None)
        } else {
            (FailedLogs::default(), Some(log_output.error_text()))
        };
        Ok(CiFailedLogs {
            run,
            failed_jobs,
            logs,
            log_error,
        })
    }

    pub fn ci_rerun(&self, project: &Path, run_id: u64, failed_only: bool) -> AppResult<()> {
        self.ensure_ready()?;
        let mut argv = args(&["run", "rerun", &run_id.to_string()]);
        if failed_only {
            argv.push("--failed".to_string());
        }
        self.gh_stdout(project, &argv).map(|_| ())
    }

    // ============ Issue ============

    pub fn issue_list(&self, project: &Path, query: Option<&str>) -> AppResult<Vec<IssueSummary>> {
        self.ensure_ready()?;
        let limit = ISSUE_LIST_LIMIT.to_string();
        let mut argv = args(&[
            "issue",
            "list",
            "--limit",
            &limit,
            "--json",
            parse::ISSUE_LIST_FIELDS,
        ]);
        if let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) {
            argv.extend(args(&["--search", query]));
        }
        let raw = self.gh_stdout(project, &argv)?;
        parse::parse_issue_list(&raw).map_err(AppError::from)
    }

    pub fn issue_view(&self, project: &Path, number: u64) -> AppResult<IssueDetail> {
        self.ensure_ready()?;
        let raw = self.gh_stdout(
            project,
            &args(&[
                "issue",
                "view",
                &number.to_string(),
                "--json",
                parse::ISSUE_VIEW_FIELDS,
            ]),
        )?;
        parse::parse_issue_view(&raw).map_err(AppError::from)
    }
}

/// 校验项目路径：必须是已存在的目录（gh / git 都在这里执行）。
pub fn project_dir(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::from("projectPath 不能为空"));
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Err(AppError::from(format!("项目目录不存在: {trimmed}")));
    }
    Ok(dir)
}

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
