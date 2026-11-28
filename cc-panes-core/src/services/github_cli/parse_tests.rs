use super::*;

#[test]
fn truncate_chars_respects_utf8_and_reports_cut() {
    assert_eq!(truncate_chars("你好世界", 2), ("你好…".to_string(), true));
    assert_eq!(truncate_chars("abc", 3), ("abc".to_string(), false));
    assert_eq!(truncate_chars("", 0), (String::new(), false));
}

#[test]
fn tail_bytes_lands_on_char_boundary() {
    let (tail, cut) = tail_bytes("ab你好", 4);
    assert!(cut);
    assert_eq!(tail, "好");
    assert_eq!(tail_bytes("abc", 10), ("abc", false));
}

#[test]
fn strip_ansi_removes_csi_and_osc() {
    let raw = "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}plain";
    assert_eq!(strip_ansi(raw), "red plain");
}

#[test]
fn auth_status_prefers_active_success_account() {
    let raw = r#"{"hosts":{"github.com":[
        {"state":"success","active":false,"host":"github.com","login":"old"},
        {"state":"success","active":true,"host":"github.com","login":"me"}
    ]}}"#;
    let summary = parse_auth_status_json(raw).unwrap();
    assert!(summary.authenticated);
    assert_eq!(summary.account.as_deref(), Some("me"));
    assert_eq!(summary.host.as_deref(), Some("github.com"));
}

#[test]
fn auth_status_failed_tokens_are_not_logged_in() {
    let raw = r#"{"hosts":{"github.com":[{"state":"error","active":true,"login":"me"}]}}"#;
    assert!(!parse_auth_status_json(raw).unwrap().authenticated);
    assert!(
        !parse_auth_status_json(r#"{"hosts":{}}"#)
            .unwrap()
            .authenticated
    );
    assert!(parse_auth_status_json("not json").is_none());
}

#[test]
fn unknown_flag_is_detected_for_old_gh() {
    assert!(is_unknown_flag_error("unknown flag: --json\n\nUsage: ..."));
    assert!(!is_unknown_flag_error(
        "You are not logged into any GitHub hosts"
    ));
}

fn sample_pr() -> String {
    r#"{
      "number": 42, "title": "feat: x", "url": "https://github.com/o/r/pull/42",
      "state": "OPEN", "isDraft": false, "reviewDecision": "APPROVED",
      "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED",
      "headRefName": "feat/x", "headRefOid": "abc123", "baseRefName": "dev/v0.13.5",
      "statusCheckRollup": [
        {"__typename":"CheckRun","name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"u1"},
        {"__typename":"CheckRun","name":"test","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"u2"},
        {"__typename":"CheckRun","name":"lint","workflowName":"","status":"IN_PROGRESS","conclusion":""},
        {"__typename":"CheckRun","name":"docs","status":"COMPLETED","conclusion":"SKIPPED"},
        {"__typename":"StatusContext","context":"ci/legacy","state":"ERROR","targetUrl":"u3"},
        {"__typename":"StatusContext","context":"ci/wait","state":"PENDING"}
      ]
    }"#
    .to_string()
}

#[test]
fn pr_view_is_summarized_with_checks() {
    let pr = parse_pr_view(&sample_pr()).unwrap();
    assert_eq!(pr.number, 42);
    assert_eq!(pr.review_decision.as_deref(), Some("APPROVED"));
    assert_eq!(pr.base_ref_name, "dev/v0.13.5");
    assert_eq!(pr.head_ref_oid.as_deref(), Some("abc123"));
    let checks = &pr.checks;
    assert_eq!(
        (
            checks.total,
            checks.passed,
            checks.failed,
            checks.pending,
            checks.skipped
        ),
        (6, 1, 2, 2, 1)
    );
    assert_eq!(checks.failing[0].name, "CI / test");
    assert_eq!(checks.failing[0].url.as_deref(), Some("u2"));
    assert_eq!(checks.failing[1].name, "ci/legacy");
}

#[test]
fn pr_view_without_review_or_checks_omits_fields() {
    let raw = r#"{"number":1,"title":"t","url":"u","state":"OPEN","isDraft":true,
        "reviewDecision":"","headRefName":"h","baseRefName":"main","statusCheckRollup":[]}"#;
    let pr = parse_pr_view(raw).unwrap();
    assert!(pr.is_draft);
    assert_eq!(pr.review_decision, None);
    assert_eq!(pr.checks, ChecksSummary::default());
    let json = serde_json::to_value(&pr).unwrap();
    assert!(json.get("reviewDecision").is_none());
    assert!(json.get("headRefName").is_some());
}

#[test]
fn failing_check_list_is_capped() {
    let items: Vec<String> = (0..25)
        .map(|i| format!(r#"{{"name":"c{i}","status":"COMPLETED","conclusion":"FAILURE"}}"#))
        .collect();
    let rollup: Value = serde_json::from_str(&format!("[{}]", items.join(","))).unwrap();
    let summary = summarize_checks(Some(&rollup));
    assert_eq!(summary.failed, 25);
    assert_eq!(summary.failing.len(), 10);
}

#[test]
fn no_pr_error_and_created_url_are_recognized() {
    assert!(is_no_pr_error(
        "no pull requests found for branch \"feat/x\""
    ));
    assert!(!is_no_pr_error("HTTP 401: Bad credentials"));
    let stdout =
        "\nCreating pull request for feat/x into main in o/r\n\nhttps://github.com/o/r/pull/7\n";
    let url = parse_created_pr_url(stdout).unwrap();
    assert_eq!(url, "https://github.com/o/r/pull/7");
    assert_eq!(number_from_url(&url), Some(7));
    assert_eq!(number_from_url("https://github.com/o/r/pull/"), None);
}

#[test]
fn default_branch_is_parsed() {
    assert_eq!(
        parse_default_branch(r#"{"defaultBranchRef":{"name":"main"}}"#).unwrap(),
        "main"
    );
    assert!(parse_default_branch(r#"{"defaultBranchRef":null}"#).is_err());
}

#[test]
fn issue_list_flattens_labels_and_author() {
    let raw = r#"[{"number":3,"title":"bug","url":"https://github.com/o/r/issues/3","state":"OPEN",
        "labels":[{"name":"bug"},{"name":"p1"}],"author":{"login":"alice"},"updatedAt":"2026-01-01"}]"#;
    let issues = parse_issue_list(raw).unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].labels, vec!["bug", "p1"]);
    assert_eq!(issues[0].author.as_deref(), Some("alice"));
    assert!(parse_issue_list(r#"{"a":1}"#).is_err());
}

#[test]
fn issue_view_truncates_body_and_keeps_recent_comments() {
    let body = "x".repeat(ISSUE_BODY_MAX_CHARS + 50);
    let comments: Vec<String> = (0..8)
        .map(|i| format!(r#"{{"author":{{"login":"u{i}"}},"body":"c{i}","createdAt":"t{i}"}}"#))
        .collect();
    let raw = format!(
        r#"{{"number":9,"title":"t","url":"u","state":"OPEN","labels":[],"author":null,
            "body":"{body}","comments":[{}]}}"#,
        comments.join(",")
    );
    let detail = parse_issue_view(&raw).unwrap();
    assert!(detail.body_truncated);
    assert_eq!(detail.body.chars().count(), ISSUE_BODY_MAX_CHARS + 1);
    assert_eq!(detail.comment_count, 8);
    assert_eq!(detail.recent_comments.len(), 5);
    assert_eq!(detail.recent_comments[0].body, "c3");
    assert_eq!(detail.summary.author, None);
    let json = serde_json::to_value(&detail).unwrap();
    assert_eq!(json["number"], 9, "summary fields are flattened");
}

#[test]
fn run_list_and_view_are_parsed() {
    let list = r#"[{"databaseId":123,"displayTitle":"fix","workflowName":"CI","url":"u",
        "headBranch":"feat/x","status":"completed","conclusion":"failure"}]"#;
    let run = parse_first_run(list).unwrap().unwrap();
    assert_eq!(run.run_id, 123);
    assert_eq!(parse_first_run("[]").unwrap(), None);

    let view = r#"{"databaseId":123,"displayTitle":"fix","url":"u","jobs":[
        {"name":"build","conclusion":"success","steps":[]},
        {"name":"test","conclusion":"failure","url":"ju","steps":[
            {"name":"Set up","conclusion":"success"},{"name":"Run tests","conclusion":"failure"}]},
        {"name":"e2e","conclusion":"timed_out","steps":[]}
    ]}"#;
    let (summary, jobs) = parse_run_view(view).unwrap();
    assert_eq!(summary.run_id, 123);
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[0].failed_steps, vec!["Run tests"]);
    assert_eq!(jobs[1].name, "e2e");
}

#[test]
fn failed_logs_group_by_job_strip_noise_and_keep_tail() {
    let mut raw = String::new();
    for i in 0..200 {
        raw.push_str(&format!(
            "test\tRun tests\t2026-11-27T01:02:03.1234567Z \u{1b}[31mline {i}\u{1b}[0m\n"
        ));
    }
    raw.push_str("lint\tclippy\t2026-11-27T01:02:03.1234567Z error: unused\n");
    let logs = tail_failed_logs(&raw, LogBudget::default());
    assert_eq!(logs.jobs.len(), 2);
    let test = &logs.jobs[0];
    assert_eq!(test.job, "test");
    assert_eq!(test.total_lines, 201, "step header + 200 lines");
    assert!(test.truncated);
    assert!(test.log.ends_with("line 199"));
    assert!(!test.log.contains("line 100\n"));
    assert!(!test.log.contains("2026-11-27T"));
    assert!(!test.log.contains('\u{1b}'));
    assert_eq!(logs.jobs[1].log, "── clippy ──\nerror: unused");
    assert!(!logs.jobs[1].truncated);
}

#[test]
fn failed_logs_respect_job_and_byte_budgets() {
    let mut raw = String::new();
    for job in ["a", "b", "c"] {
        for i in 0..50 {
            raw.push_str(&format!("{job}\tstep\t{}{i}\n", "y".repeat(100)));
        }
    }
    let budget = LogBudget {
        max_jobs: 2,
        tail_lines: 1_000,
        max_line_chars: 1_000,
        max_total_bytes: 2_000,
    };
    let logs = tail_failed_logs(&raw, budget);
    assert_eq!(logs.jobs.len(), 2);
    assert_eq!(logs.omitted_jobs, vec!["c"]);
    let total: usize = logs.jobs.iter().map(|job| job.log.len()).sum();
    assert!(total <= 2_000, "total {total}");
    assert!(logs.jobs.iter().all(|job| job.truncated));
}

#[test]
fn failed_logs_cut_overlong_lines_and_handle_untabbed_lines() {
    let raw = format!(
        "build\tcompile\t{}\ncontinuation without tabs\n",
        "z".repeat(1_000)
    );
    let logs = tail_failed_logs(&raw, LogBudget::default());
    assert_eq!(logs.jobs.len(), 1);
    let lines: Vec<&str> = logs.jobs[0].log.lines().collect();
    assert_eq!(lines[1].chars().count(), 401);
    assert_eq!(lines[2], "continuation without tabs");
    assert_eq!(
        tail_failed_logs("", LogBudget::default()),
        FailedLogs::default()
    );
}
