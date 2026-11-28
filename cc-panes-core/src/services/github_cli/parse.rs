//! `gh` 输出的解析与截断（纯函数，单测全覆盖，不碰进程）。
//!
//! 所有返回给 agent 的结构都是「摘要」：字段裁到够判断下一步即可，正文/日志一律截断，
//! 避免一次工具调用把几十 KB 的 CI 日志灌进上下文。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// PR 视图要的字段（`gh pr view --json`）。
pub const PR_VIEW_FIELDS: &str = "number,title,url,state,isDraft,reviewDecision,mergeable,\
mergeStateStatus,headRefName,headRefOid,baseRefName,statusCheckRollup";
/// Issue 列表字段。
pub const ISSUE_LIST_FIELDS: &str = "number,title,url,state,labels,author,updatedAt";
/// Issue 详情字段。
pub const ISSUE_VIEW_FIELDS: &str =
    "number,title,url,state,body,labels,author,createdAt,updatedAt,comments";
/// run 列表字段。
pub const RUN_LIST_FIELDS: &str =
    "databaseId,displayTitle,workflowName,url,headBranch,headSha,status,conclusion,createdAt";
/// run 详情字段（含 jobs）。
pub const RUN_VIEW_FIELDS: &str =
    "databaseId,displayTitle,workflowName,url,headBranch,status,conclusion,jobs";

/// 失败 check 名单最多列几个（其余只计数）。
const MAX_FAILING_CHECKS: usize = 10;
/// Issue 正文上限（字符）。
pub const ISSUE_BODY_MAX_CHARS: usize = 6_000;
/// Issue 详情带最近几条评论。
const ISSUE_COMMENTS_MAX: usize = 5;
/// 单条评论上限（字符）。
const ISSUE_COMMENT_MAX_CHARS: usize = 800;

// ============ 通用截断 ============

/// 按字符数截断（不切坏 UTF-8），返回 (结果, 是否截断)。
pub fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte_index, _)) => (format!("{}…", &text[..byte_index]), true),
        None => (text.to_string(), false),
    }
}

/// 保留末尾不超过 `max_bytes` 字节（落在字符边界上）。
pub fn tail_bytes(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

/// 去掉 ANSI 转义（CSI `ESC [ ... final` 与 OSC `ESC ] ... BEL/ST`）。
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

// ============ auth ============

/// `gh auth status --json hosts` 的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSummary {
    pub authenticated: bool,
    pub account: Option<String>,
    pub host: Option<String>,
}

/// 任一 host 上存在 `active && state == success` 的账号即视为已登录。
pub fn parse_auth_status_json(raw: &str) -> Option<AuthSummary> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let hosts = value.get("hosts")?.as_object()?;
    let mut fallback = None;
    for (host, entries) in hosts {
        for entry in entries.as_array().into_iter().flatten() {
            let ok = entry.get("state").and_then(Value::as_str) == Some("success");
            if !ok {
                continue;
            }
            let summary = AuthSummary {
                authenticated: true,
                account: str_field(entry, "login"),
                host: Some(host.clone()),
            };
            if entry.get("active").and_then(Value::as_bool) == Some(true) {
                return Some(summary);
            }
            fallback.get_or_insert(summary);
        }
    }
    Some(fallback.unwrap_or(AuthSummary {
        authenticated: false,
        account: None,
        host: None,
    }))
}

/// 旧版 gh 不认 `--json`：只能看到 "unknown flag"。
pub fn is_unknown_flag_error(stderr: &str) -> bool {
    stderr.contains("unknown flag")
}

// ============ PR ============

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailingCheck {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChecksSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub pending: usize,
    pub skipped: usize,
    /// 失败的 check（最多 [`MAX_FAILING_CHECKS`] 个）。
    pub failing: Vec<FailingCheck>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mergeable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_state_status: Option<String>,
    pub head_ref_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref_oid: Option<String>,
    pub base_ref_name: String,
    pub checks: ChecksSummary,
}

enum CheckOutcome {
    Passed,
    Failed,
    Pending,
    Skipped,
}

fn classify_check(item: &Value) -> (String, Option<String>, CheckOutcome) {
    let upper = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_uppercase()
    };
    // StatusContext（老式 commit status）：context/state/targetUrl。
    if item.get("__typename").and_then(Value::as_str) == Some("StatusContext")
        || (item.get("context").is_some() && item.get("conclusion").is_none())
    {
        let name = str_field(item, "context").unwrap_or_default();
        let outcome = match upper("state").as_str() {
            "SUCCESS" => CheckOutcome::Passed,
            "FAILURE" | "ERROR" => CheckOutcome::Failed,
            _ => CheckOutcome::Pending,
        };
        return (name, str_field(item, "targetUrl"), outcome);
    }
    let name = match (str_field(item, "workflowName"), str_field(item, "name")) {
        (Some(workflow), Some(name)) if !workflow.is_empty() => format!("{workflow} / {name}"),
        (_, Some(name)) => name,
        _ => String::new(),
    };
    let outcome = if upper("status") != "COMPLETED" {
        CheckOutcome::Pending
    } else {
        match upper("conclusion").as_str() {
            "SUCCESS" => CheckOutcome::Passed,
            "SKIPPED" | "NEUTRAL" | "STALE" => CheckOutcome::Skipped,
            _ => CheckOutcome::Failed,
        }
    };
    (name, str_field(item, "detailsUrl"), outcome)
}

/// 汇总 `statusCheckRollup`。
pub fn summarize_checks(rollup: Option<&Value>) -> ChecksSummary {
    let mut summary = ChecksSummary::default();
    for item in rollup.and_then(Value::as_array).into_iter().flatten() {
        summary.total += 1;
        let (name, url, outcome) = classify_check(item);
        match outcome {
            CheckOutcome::Passed => summary.passed += 1,
            CheckOutcome::Pending => summary.pending += 1,
            CheckOutcome::Skipped => summary.skipped += 1,
            CheckOutcome::Failed => {
                summary.failed += 1;
                if summary.failing.len() < MAX_FAILING_CHECKS {
                    summary.failing.push(FailingCheck { name, url });
                }
            }
        }
    }
    summary
}

pub fn parse_pr_view(raw: &str) -> Result<PrStatus, String> {
    let value: Value = parse_json(raw)?;
    Ok(PrStatus {
        number: value.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: str_field(&value, "title").unwrap_or_default(),
        url: str_field(&value, "url").unwrap_or_default(),
        state: str_field(&value, "state").unwrap_or_default(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        review_decision: non_empty_field(&value, "reviewDecision"),
        mergeable: non_empty_field(&value, "mergeable"),
        merge_state_status: non_empty_field(&value, "mergeStateStatus"),
        head_ref_name: str_field(&value, "headRefName").unwrap_or_default(),
        head_ref_oid: non_empty_field(&value, "headRefOid"),
        base_ref_name: str_field(&value, "baseRefName").unwrap_or_default(),
        checks: summarize_checks(value.get("statusCheckRollup")),
    })
}

/// `gh pr view` 在当前分支没有 PR 时报的错。
pub fn is_no_pr_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("no pull requests found") || lower.contains("no open pull requests")
}

/// `gh repo view --json defaultBranchRef`。
pub fn parse_default_branch(raw: &str) -> Result<String, String> {
    let value: Value = parse_json(raw)?;
    value
        .get("defaultBranchRef")
        .and_then(|branch| branch.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "仓库没有默认分支信息".to_string())
}

/// `gh pr create` 成功时 stdout 最后一行是 PR URL。
pub fn parse_created_pr_url(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .map(str::to_string)
}

/// URL 末尾的 PR/Issue 编号（`.../pull/12` → 12）。
pub fn number_from_url(url: &str) -> Option<u64> {
    url.trim_end_matches('/').rsplit('/').next()?.parse().ok()
}

// ============ Issue ============

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(flatten)]
    pub summary: IssueSummary,
    pub body: String,
    pub body_truncated: bool,
    pub comment_count: usize,
    /// 最近几条评论（各自截断）。
    pub recent_comments: Vec<IssueComment>,
}

fn issue_summary(value: &Value) -> IssueSummary {
    let labels = value
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| str_field(label, "name"))
        .collect();
    IssueSummary {
        number: value.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: str_field(value, "title").unwrap_or_default(),
        url: str_field(value, "url").unwrap_or_default(),
        state: str_field(value, "state").unwrap_or_default(),
        labels,
        author: value.get("author").and_then(|a| str_field(a, "login")),
        updated_at: non_empty_field(value, "updatedAt"),
    }
}

pub fn parse_issue_list(raw: &str) -> Result<Vec<IssueSummary>, String> {
    let value: Value = parse_json(raw)?;
    let items = value.as_array().ok_or("gh 返回的不是数组")?;
    Ok(items.iter().map(issue_summary).collect())
}

pub fn parse_issue_view(raw: &str) -> Result<IssueDetail, String> {
    let value: Value = parse_json(raw)?;
    let (body, body_truncated) = truncate_chars(
        value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        ISSUE_BODY_MAX_CHARS,
    );
    let comments: Vec<&Value> = value
        .get("comments")
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default();
    let skip = comments.len().saturating_sub(ISSUE_COMMENTS_MAX);
    let recent_comments = comments[skip..]
        .iter()
        .map(|comment| IssueComment {
            author: comment.get("author").and_then(|a| str_field(a, "login")),
            body: truncate_chars(
                comment
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                ISSUE_COMMENT_MAX_CHARS,
            )
            .0,
            created_at: non_empty_field(comment, "createdAt"),
        })
        .collect();
    Ok(IssueDetail {
        summary: issue_summary(&value),
        body,
        body_truncated,
        comment_count: comments.len(),
        recent_comments,
    })
}

// ============ CI ============

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: u64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
}

fn run_summary(value: &Value) -> RunSummary {
    RunSummary {
        run_id: value.get("databaseId").and_then(Value::as_u64).unwrap_or(0),
        title: str_field(value, "displayTitle").unwrap_or_default(),
        workflow: non_empty_field(value, "workflowName"),
        url: str_field(value, "url").unwrap_or_default(),
        branch: non_empty_field(value, "headBranch"),
        status: non_empty_field(value, "status"),
        conclusion: non_empty_field(value, "conclusion"),
    }
}

/// `gh run list --json ...`：取第一条。
pub fn parse_first_run(raw: &str) -> Result<Option<RunSummary>, String> {
    let value: Value = parse_json(raw)?;
    Ok(value
        .as_array()
        .and_then(|list| list.first())
        .map(run_summary))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedJob {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub failed_steps: Vec<String>,
}

/// `gh run view --json ...jobs`：run 摘要 + 失败 job。
pub fn parse_run_view(raw: &str) -> Result<(RunSummary, Vec<FailedJob>), String> {
    let value: Value = parse_json(raw)?;
    let failed_jobs = value
        .get("jobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|job| is_failed_conclusion(job.get("conclusion")))
        .map(|job| FailedJob {
            name: str_field(job, "name").unwrap_or_default(),
            conclusion: non_empty_field(job, "conclusion"),
            url: non_empty_field(job, "url"),
            failed_steps: job
                .get("steps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|step| is_failed_conclusion(step.get("conclusion")))
                .filter_map(|step| str_field(step, "name"))
                .collect(),
        })
        .collect();
    Ok((run_summary(&value), failed_jobs))
}

fn is_failed_conclusion(conclusion: Option<&Value>) -> bool {
    matches!(
        conclusion
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("failure" | "timed_out" | "cancelled" | "startup_failure" | "action_required")
    )
}

/// 失败日志的体积预算。
#[derive(Debug, Clone, Copy)]
pub struct LogBudget {
    /// 最多展示几个 job 的日志。
    pub max_jobs: usize,
    /// 每个 job 保留末尾多少行。
    pub tail_lines: usize,
    /// 单行字符上限。
    pub max_line_chars: usize,
    /// 所有 job 日志合计字节上限。
    pub max_total_bytes: usize,
}

impl Default for LogBudget {
    fn default() -> Self {
        Self {
            max_jobs: 3,
            tail_lines: 80,
            max_line_chars: 400,
            max_total_bytes: 16 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogTail {
    pub job: String,
    /// 该 job 失败日志总行数（截断前）。
    pub total_lines: usize,
    pub truncated: bool,
    pub log: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedLogs {
    pub jobs: Vec<JobLogTail>,
    /// 超出 `max_jobs` 未展示日志的 job 名。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub omitted_jobs: Vec<String>,
}

/// 行首形如 `2024-01-02T03:04:05.1234567Z ` 的时间戳。
fn strip_timestamp(line: &str) -> &str {
    let bytes = line.as_bytes();
    let looks_like_ts = bytes.len() > 20
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[10] == b'T';
    if !looks_like_ts {
        return line;
    }
    match line.find("Z ") {
        Some(end) if end < 40 => &line[end + 2..],
        _ => line,
    }
}

struct JobLines {
    name: String,
    lines: Vec<String>,
}

/// 把 `gh run view --log-failed` 的 `job\tstep\tline` 输出按 job 分组。
fn group_log_lines(raw: &str, max_line_chars: usize) -> Vec<JobLines> {
    let mut jobs: Vec<JobLines> = Vec::new();
    let mut last_step: Option<(String, String)> = None;
    for raw_line in strip_ansi(raw).lines() {
        let mut parts = raw_line.splitn(3, '\t');
        let (job, step, text) = match (parts.next(), parts.next(), parts.next()) {
            (Some(job), Some(step), Some(text)) => (job.to_string(), step.to_string(), text),
            _ => {
                let job = jobs.last().map(|j| j.name.clone()).unwrap_or_default();
                (job, String::new(), raw_line)
            }
        };
        if jobs.last().map(|j| j.name.as_str()) != Some(job.as_str()) {
            jobs.push(JobLines {
                name: job.clone(),
                lines: Vec::new(),
            });
        }
        let entry = jobs.last_mut().expect("just pushed");
        let key = (job, step.clone());
        if !step.is_empty() && last_step.as_ref() != Some(&key) {
            entry.lines.push(format!("── {step} ──"));
            last_step = Some(key);
        }
        let text = strip_timestamp(text).trim_end();
        entry.lines.push(truncate_chars(text, max_line_chars).0);
    }
    jobs
}

/// 解析并截断失败日志：每个 job 只留尾部，合计不超过字节预算。
pub fn tail_failed_logs(raw: &str, budget: LogBudget) -> FailedLogs {
    let jobs = group_log_lines(raw, budget.max_line_chars);
    let mut result = FailedLogs::default();
    let shown = jobs.len().min(budget.max_jobs);
    let per_job_bytes = budget.max_total_bytes / shown.max(1);
    for (index, job) in jobs.into_iter().enumerate() {
        if index >= budget.max_jobs {
            result.omitted_jobs.push(job.name);
            continue;
        }
        let total_lines = job.lines.len();
        let start = total_lines.saturating_sub(budget.tail_lines);
        let joined = job.lines[start..].join("\n");
        let (tail, cut_by_bytes) = tail_bytes(&joined, per_job_bytes);
        result.jobs.push(JobLogTail {
            job: job.name,
            total_lines,
            truncated: start > 0 || cut_by_bytes,
            log: tail.to_string(),
        });
    }
    result
}

// ============ helpers ============

fn parse_json(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw.trim()).map_err(|error| format!("无法解析 gh 输出: {error}"))
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    str_field(value, key).filter(|text| !text.is_empty())
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
