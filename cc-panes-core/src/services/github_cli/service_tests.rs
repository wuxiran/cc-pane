//! 用假 runner 驱动 GithubCliService：校验参数拼装、cwd 传递与错误分支，不碰网络。

use super::*;
use crate::repository::{Database, TodoRepository};
use crate::services::TodoService;
use std::sync::Mutex;

type Call = (CliProgram, PathBuf, Vec<String>);

/// 按「参数前缀」匹配脚本化输出；没匹配到的调用视为失败。
struct FakeRunner {
    installed: bool,
    script: Vec<(CliProgram, Vec<&'static str>, CliOutput)>,
    calls: Mutex<Vec<Call>>,
}

fn ok(stdout: &str) -> CliOutput {
    CliOutput {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
    }
}

fn fail(stderr: &str) -> CliOutput {
    CliOutput {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_string(),
    }
}

const AUTH_OK: &str =
    r#"{"hosts":{"github.com":[{"state":"success","active":true,"login":"me"}]}}"#;

impl FakeRunner {
    fn new(script: Vec<(CliProgram, Vec<&'static str>, CliOutput)>) -> Self {
        let mut full = vec![(CliProgram::Gh, vec!["auth", "status"], ok(AUTH_OK))];
        full.extend(script);
        Self {
            installed: true,
            script: full,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl CliRunner for FakeRunner {
    fn is_installed(&self, _program: CliProgram) -> bool {
        self.installed
    }

    fn run(&self, program: CliProgram, cwd: &Path, argv: &[String]) -> AppResult<CliOutput> {
        self.calls
            .lock()
            .unwrap()
            .push((program, cwd.to_path_buf(), argv.to_vec()));
        let output = self
            .script
            .iter()
            .find(|(p, prefix, _)| {
                *p == program
                    && prefix.len() <= argv.len()
                    && prefix.iter().zip(argv).all(|(a, b)| a == b)
            })
            .map(|(_, _, output)| output.clone())
            .unwrap_or_else(|| fail("unexpected call"));
        Ok(output)
    }
}

fn service(runner: FakeRunner) -> (GithubCliService, Arc<FakeRunner>) {
    let runner = Arc::new(runner);
    (GithubCliService::new(runner.clone()), runner)
}

fn project() -> PathBuf {
    std::env::temp_dir()
}

#[test]
fn not_installed_is_reported_without_spawning() {
    let mut runner = FakeRunner::new(vec![]);
    runner.installed = false;
    let (svc, runner) = service(runner);
    let availability = svc.availability();
    assert!(!availability.installed);
    let error = svc.pr_status(&project()).unwrap_err().to_string();
    assert!(error.contains("cli.github.com"), "{error}");
    assert!(runner.calls().is_empty());
}

#[test]
fn not_logged_in_tells_user_to_run_auth_login() {
    let runner = FakeRunner {
        installed: true,
        script: vec![(
            CliProgram::Gh,
            vec!["auth", "status"],
            ok(r#"{"hosts":{}}"#),
        )],
        calls: Mutex::new(Vec::new()),
    };
    let (svc, _) = service(runner);
    let error = svc.issue_list(&project(), None).unwrap_err().to_string();
    assert!(error.contains("gh auth login"), "{error}");
}

#[test]
fn old_gh_falls_back_to_exit_code() {
    let runner = FakeRunner {
        installed: true,
        script: vec![
            (
                CliProgram::Gh,
                vec!["auth", "status", "--json"],
                fail("unknown flag: --json"),
            ),
            (CliProgram::Gh, vec!["auth", "status"], ok("Logged in")),
        ],
        calls: Mutex::new(Vec::new()),
    };
    let (svc, _) = service(runner);
    assert!(svc.probe().ready());
}

#[test]
fn ready_probe_is_cached() {
    let (svc, runner) = service(FakeRunner::new(vec![]));
    assert!(svc.availability().ready());
    assert!(svc.availability().ready());
    assert_eq!(runner.calls().len(), 1);
}

#[test]
fn pr_status_runs_in_project_dir_and_maps_missing_pr_to_none() {
    let (svc, runner) = service(FakeRunner::new(vec![(
        CliProgram::Gh,
        vec!["pr", "view"],
        fail("no pull requests found for branch \"feat/x\""),
    )]));
    let dir = project();
    assert_eq!(svc.pr_status(&dir).unwrap(), None);
    let (_, cwd, argv) = runner.calls().last().unwrap().clone();
    assert_eq!(cwd, dir, "cwd must be the project, never inherited");
    assert_eq!(argv[..3], ["pr", "view", "--json"]);
}

#[test]
fn pr_create_defaults_base_to_repo_default_branch() {
    let (svc, runner) = service(FakeRunner::new(vec![
        (CliProgram::Git, vec!["branch"], ok("feat/x\n")),
        (
            CliProgram::Gh,
            vec!["repo", "view"],
            ok(r#"{"defaultBranchRef":{"name":"main"}}"#),
        ),
        (
            CliProgram::Gh,
            vec!["pr", "create"],
            ok("https://github.com/o/r/pull/12\n"),
        ),
    ]));
    let created = svc
        .pr_create(
            &project(),
            PrCreateRequest {
                title: "feat: x".into(),
                body: "body".into(),
                base: None,
                draft: true,
            },
        )
        .unwrap();
    assert_eq!(created.number, Some(12));
    assert_eq!(created.base, "main");
    assert_eq!(created.head, "feat/x");
    let (_, _, argv) = runner.calls().last().unwrap().clone();
    assert!(argv.windows(2).any(|w| w == ["--base", "main"]));
    assert!(argv.windows(2).any(|w| w == ["--head", "feat/x"]));
    assert!(argv.contains(&"--draft".to_string()));
}

#[test]
fn pr_create_uses_explicit_base_and_rejects_same_branch() {
    let (svc, runner) = service(FakeRunner::new(vec![
        (CliProgram::Git, vec!["branch"], ok("dev/v0.13.5\n")),
        (CliProgram::Gh, vec!["pr", "create"], ok("https://x/pull/1")),
    ]));
    let request = PrCreateRequest {
        title: "t".into(),
        base: Some("dev/v0.13.5".into()),
        ..Default::default()
    };
    assert!(svc.pr_create(&project(), request).is_err());
    assert!(
        !runner
            .calls()
            .iter()
            .any(|(_, _, argv)| argv.first().map(String::as_str) == Some("repo")),
        "explicit base must not query the default branch"
    );
}

#[test]
fn pr_merge_pins_confirmed_head_commit() {
    let (svc, runner) = service(FakeRunner::new(vec![(
        CliProgram::Gh,
        vec!["pr", "merge"],
        ok("merged\n"),
    )]));
    svc.pr_merge(&project(), 7, Some("abc"), MergeMethod::Rebase)
        .unwrap();
    let (_, _, argv) = runner.calls().last().unwrap().clone();
    assert_eq!(
        argv,
        ["pr", "merge", "7", "--rebase", "--match-head-commit", "abc"]
    );
    assert_eq!(MergeMethod::parse(None).unwrap(), MergeMethod::Squash);
    assert!(MergeMethod::parse(Some("octopus")).is_err());
}

#[test]
fn ci_failed_logs_picks_latest_failed_run_on_branch() {
    let (svc, runner) = service(FakeRunner::new(vec![
        (CliProgram::Git, vec!["branch"], ok("feat/x\n")),
        (
            CliProgram::Gh,
            vec!["run", "list"],
            ok(r#"[{"databaseId":55,"displayTitle":"t","url":"u"}]"#),
        ),
        (
            CliProgram::Gh,
            vec!["run", "view", "55", "--json"],
            ok(
                r#"{"databaseId":55,"displayTitle":"t","url":"u","jobs":[{"name":"test","conclusion":"failure","steps":[]}]}"#,
            ),
        ),
        (
            CliProgram::Gh,
            vec!["run", "view", "55", "--log-failed"],
            ok("test\tRun\tboom\n"),
        ),
    ]));
    let result = svc
        .ci_failed_logs(&project(), None, LogBudget::default())
        .unwrap();
    assert_eq!(result.run.run_id, 55);
    assert_eq!(result.failed_jobs.len(), 1);
    assert_eq!(result.logs.jobs[0].log, "── Run ──\nboom");
    assert_eq!(result.log_error, None);
    let list_call = runner
        .calls()
        .into_iter()
        .find(|(_, _, argv)| argv[..2] == ["run", "list"])
        .unwrap();
    assert!(list_call.2.windows(2).any(|w| w == ["--branch", "feat/x"]));
}

#[test]
fn ci_failed_logs_reports_log_errors_and_missing_runs() {
    let (svc, _) = service(FakeRunner::new(vec![
        (
            CliProgram::Gh,
            vec!["run", "view", "9", "--json"],
            ok(r#"{"databaseId":9,"displayTitle":"t","url":"u","jobs":[]}"#),
        ),
        (
            CliProgram::Gh,
            vec!["run", "view", "9", "--log-failed"],
            fail("run 9 is still in progress"),
        ),
        (CliProgram::Git, vec!["branch"], ok("feat/y\n")),
        (CliProgram::Gh, vec!["run", "list"], ok("[]")),
    ]));
    let result = svc
        .ci_failed_logs(&project(), Some(9), LogBudget::default())
        .unwrap();
    assert!(result.log_error.unwrap().contains("in progress"));
    let error = svc
        .ci_failed_logs(&project(), None, LogBudget::default())
        .unwrap_err()
        .to_string();
    assert!(error.contains("没有失败"), "{error}");
}

#[test]
fn ci_rerun_adds_failed_flag_only_when_asked() {
    let (svc, runner) = service(FakeRunner::new(vec![(
        CliProgram::Gh,
        vec!["run", "rerun"],
        ok(""),
    )]));
    svc.ci_rerun(&project(), 3, true).unwrap();
    svc.ci_rerun(&project(), 3, false).unwrap();
    let calls = runner.calls();
    assert_eq!(calls[calls.len() - 2].2, ["run", "rerun", "3", "--failed"]);
    assert_eq!(calls[calls.len() - 1].2, ["run", "rerun", "3"]);
}

#[test]
fn gh_failures_surface_stderr() {
    let (svc, _) = service(FakeRunner::new(vec![(
        CliProgram::Gh,
        vec!["issue", "view"],
        fail("HTTP 404: Not Found"),
    )]));
    let error = svc.issue_view(&project(), 1).unwrap_err().to_string();
    assert!(error.contains("HTTP 404"), "{error}");
}

fn issue_json(number: u64) -> String {
    format!(
        r#"{{"number":{number},"title":"Crash on start","url":"https://github.com/o/r/issues/{number}",
        "state":"OPEN","labels":[{{"name":"bug"}}],"author":{{"login":"a"}},"body":"steps","comments":[]}}"#
    )
}

fn todo_service() -> TodoService {
    let db = Arc::new(Database::new_in_memory().unwrap());
    TodoService::new(Arc::new(TodoRepository::new(db)))
}

#[test]
fn issue_import_creates_project_todo_once() {
    let json: &'static str = Box::leak(issue_json(5).into_boxed_str());
    let (svc, _) = service(FakeRunner::new(vec![(
        CliProgram::Gh,
        vec!["issue", "view", "5"],
        ok(json),
    )]));
    let todos = todo_service();
    let first = svc
        .import_issues(&todos, &project(), "/repo", &[5, 6])
        .unwrap();
    let todo = first[0].todo.as_ref().unwrap();
    assert!(!first[0].already_imported);
    assert_eq!(todo.title, "#5 Crash on start");
    assert_eq!(todo.scope, crate::models::todo::TodoScope::Project);
    assert_eq!(todo.scope_ref.as_deref(), Some("/repo"));
    assert_eq!(todo.tags, vec!["bug"]);
    assert_eq!(todo.issue_number, Some(5));
    assert!(todo
        .description
        .as_deref()
        .unwrap()
        .starts_with("https://github.com/o/r/issues/5\n\nsteps"));
    assert!(first[1].error.is_some(), "missing issue fails alone");

    let second = svc
        .import_issues(&todos, &project(), "/repo", &[5])
        .unwrap();
    assert!(second[0].already_imported);
    assert_eq!(second[0].todo.as_ref().unwrap().id, todo.id);

    let listed = mark_imported(
        &todos,
        parse::parse_issue_list(&format!("[{}]", issue_json(5))).unwrap(),
    )
    .unwrap();
    assert_eq!(
        listed[0].imported_todo_id.as_deref(),
        Some(todo.id.as_str())
    );
}

#[test]
fn project_dir_must_exist() {
    assert!(project_dir("").is_err());
    assert!(project_dir("/definitely/not/here/xyz").is_err());
    assert_eq!(
        project_dir(&project().to_string_lossy()).unwrap(),
        project()
    );
}
