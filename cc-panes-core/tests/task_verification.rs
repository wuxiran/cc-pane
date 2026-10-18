use cc_panes_core::models::task_binding::CreateTaskBindingRequest;
use cc_panes_core::models::task_verification::{RunTaskVerificationRequest, VerificationFreshness};
use cc_panes_core::repository::{Database, TaskBindingRepository};
use cc_panes_core::services::{TaskBindingService, TaskVerificationService};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tempfile::TempDir;

struct Fixture {
    _temporary: TempDir,
    repo: PathBuf,
    data: PathBuf,
    bindings: Arc<TaskBindingService>,
    task_id: String,
    service: Arc<TaskVerificationService>,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let repo = temporary.path().join("repo");
        let data = temporary.path().join("app-data");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.name", "Verification Test"]);
        git(
            &repo,
            &["config", "user.email", "verification@example.invalid"],
        );
        std::fs::write(repo.join("code.txt"), "original\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "build-output/\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "fixture"]);
        let db = Arc::new(Database::new_fallback().unwrap());
        let bindings = Arc::new(TaskBindingService::new(Arc::new(
            TaskBindingRepository::new(db),
        )));
        let request: CreateTaskBindingRequest = serde_json::from_value(serde_json::json!({
            "title": "Run acceptance", "projectPath": repo.to_string_lossy()
        }))
        .unwrap();
        let task_id = bindings.create(request).unwrap().id;
        let service = Arc::new(TaskVerificationService::new(data.clone(), bindings.clone()));
        Self {
            _temporary: temporary,
            repo,
            data,
            bindings,
            task_id,
            service,
        }
    }

    fn run(
        &self,
        command: &str,
    ) -> cc_panes_core::models::task_verification::TaskVerificationReport {
        self.service
            .run(
                &self.task_id,
                RunTaskVerificationRequest {
                    command: command.into(),
                    timeout_secs: Some(5),
                },
            )
            .unwrap()
    }
}

fn git(repo: &Path, arguments: &[&str]) {
    let result = Command::new("git")
        .current_dir(repo)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn retains_independent_real_results_and_survives_service_restart() {
    let fixture = Fixture::new();
    let first = fixture.run("echo verified");
    assert_eq!(first.evidence[0].original_head.len(), 40);
    assert_eq!(first.evidence[0].exit_code, Some(0));
    assert!(first.evidence[0].stdout.contains("verified"));
    assert_eq!(first.evidence[0].freshness, VerificationFreshness::Current);
    let failed_command = if cfg!(windows) {
        "echo rejected 1>&2 & exit /b 7"
    } else {
        "echo rejected >&2; exit 7"
    };
    let report = fixture.run(failed_command);
    assert_eq!(report.evidence.len(), 2);
    let failure = report
        .evidence
        .iter()
        .find(|item| item.command == failed_command)
        .unwrap();
    assert_eq!(failure.exit_code, Some(7));
    assert!(failure.stderr.contains("rejected"));
    assert_eq!(
        fixture
            .bindings
            .get(&fixture.task_id)
            .unwrap()
            .unwrap()
            .status
            .as_str(),
        "pending"
    );
    let restarted = TaskVerificationService::new(fixture.data.clone(), fixture.bindings.clone());
    assert_eq!(restarted.list(&fixture.task_id).unwrap().evidence.len(), 2);
    assert!(fixture
        .bindings
        .get(&fixture.task_id)
        .unwrap()
        .unwrap()
        .metadata
        .is_none());
}

#[test]
fn code_changes_invalidate_results_and_unknown_snapshot_never_passes() {
    let fixture = Fixture::new();
    fixture.run("echo verified");
    std::fs::write(fixture.repo.join("code.txt"), "changed\n").unwrap();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert_eq!(report.evidence[0].freshness, VerificationFreshness::Stale);
    fixture.run("echo verified again");
    std::fs::write(fixture.repo.join("new-code.txt"), "new code\n").unwrap();
    assert!(fixture
        .service
        .list(&fixture.task_id)
        .unwrap()
        .evidence
        .iter()
        .all(|item| item.freshness == VerificationFreshness::Stale));
    std::fs::rename(
        fixture.repo.join(".git"),
        fixture.repo.join("git-unavailable"),
    )
    .unwrap();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert!(report.snapshot_error.is_some());
    assert!(report
        .evidence
        .iter()
        .all(|item| item.freshness != VerificationFreshness::Current));
}

#[cfg(unix)]
#[test]
fn editing_then_reverting_during_check_is_stale_but_ignored_build_output_is_not() {
    let fixture = Fixture::new();
    let report =
        fixture.run("printf 'temporary\n' > code.txt; sleep 0.2; printf 'original\n' > code.txt");
    let result = &report.evidence[0];
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(
        result.final_fingerprint.as_deref(),
        Some(result.original_fingerprint.as_str())
    );
    assert!(result.code_changed_during_run);
    assert_eq!(result.freshness, VerificationFreshness::Stale);
    let report = fixture.run(r#"mkdir -p build-output; i=0; while [ "$i" -lt 5000 ]; do echo generated > build-output/"$i"; i=$((i+1)); done"#);
    assert_eq!(report.evidence[0].exit_code, Some(0));
    assert_eq!(
        std::fs::read_dir(fixture.repo.join("build-output"))
            .unwrap()
            .count(),
        5000
    );
    assert_eq!(report.evidence[0].freshness, VerificationFreshness::Current);
}

#[cfg(unix)]
#[test]
fn timeout_preserves_output_and_kills_descendants() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.repo.join("build-output")).unwrap();
    let started = std::time::Instant::now();
    let report = fixture
        .service
        .run(
            &fixture.task_id,
            RunTaskVerificationRequest {
                command:
                    "echo before-timeout; (sleep 2; echo escaped > build-output/escaped) & wait"
                        .into(),
                timeout_secs: Some(1),
            },
        )
        .unwrap();
    assert!(started.elapsed().as_secs() < 8);
    assert!(report.evidence[0].timed_out);
    assert!(report.evidence[0].stdout.contains("before-timeout"));
    assert_ne!(report.evidence[0].exit_code, Some(0));
    std::thread::sleep(std::time::Duration::from_millis(1300));
    assert!(!fixture.repo.join("build-output/escaped").exists());
}

#[cfg(unix)]
#[test]
fn large_output_is_bounded_without_pipe_deadlock() {
    let fixture = Fixture::new();
    let report = fixture.run("head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2");
    let evidence = &report.evidence[0];
    assert_eq!(evidence.exit_code, Some(0));
    assert!(evidence.output_truncated);
    assert!(evidence.stdout.len() <= 65536);
    assert!(evidence.stderr.len() <= 65536);
}

#[cfg(unix)]
#[test]
fn separate_service_instances_cannot_run_the_same_task_concurrently() {
    let fixture = Fixture::new();
    let service = fixture.service.clone();
    let task_id = fixture.task_id.clone();
    let running = std::thread::spawn(move || {
        service.run(
            &task_id,
            RunTaskVerificationRequest {
                command: "sleep 1; echo first".into(),
                timeout_secs: Some(5),
            },
        )
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !fixture.service.list(&fixture.task_id).unwrap().running {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let second = TaskVerificationService::new(fixture.data.clone(), fixture.bindings.clone());
    let error = second
        .run(
            &fixture.task_id,
            RunTaskVerificationRequest {
                command: "echo second".into(),
                timeout_secs: Some(5),
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), Some("VERIFICATION_RUNNING"));
    assert_eq!(running.join().unwrap().unwrap().evidence.len(), 1);
}

#[test]
fn rejects_missing_tasks_remote_paths_and_out_of_bounds_requests() {
    let fixture = Fixture::new();
    assert!(fixture.service.list("../../untrusted").is_err());
    assert!(fixture
        .service
        .run(
            &fixture.task_id,
            RunTaskVerificationRequest {
                command: "echo invalid".into(),
                timeout_secs: Some(601),
            }
        )
        .is_err());
    let request = serde_json::from_value(serde_json::json!({
        "title": "Remote", "projectPath": "ssh://example.invalid/repo"
    }))
    .unwrap();
    let remote = fixture.bindings.create(request).unwrap();
    assert!(fixture
        .service
        .run(
            &remote.id,
            RunTaskVerificationRequest {
                command: "echo invalid".into(),
                timeout_secs: None,
            }
        )
        .is_err());
    assert!(
        serde_json::from_value::<RunTaskVerificationRequest>(serde_json::json!({
            "command": "echo invalid", "cwd": "/tmp"
        }))
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn detached_child_fixture() {
    let Some(marker) = std::env::var_os("CCPANES_DETACHED_MARKER") else {
        return;
    };
    let marker = PathBuf::from(marker);
    assert!(unsafe { libc::setsid() } >= 0);
    std::fs::write(
        marker.with_extension("started"),
        format!("{} {}", std::process::id(), unsafe { libc::getsid(0) }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(2));
    std::fs::write(marker, "escaped").unwrap();
}

#[cfg(unix)]
#[test]
fn timeout_kills_a_child_that_created_its_own_session() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.repo.join("build-output")).unwrap();
    let marker = fixture.repo.join("build-output/detached");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let command = format!(
        "CCPANES_DETACHED_MARKER={} {} --exact detached_child_fixture --nocapture & wait",
        quote(&marker),
        quote(&std::env::current_exe().unwrap())
    );
    let report = fixture
        .service
        .run(
            &fixture.task_id,
            RunTaskVerificationRequest {
                command,
                timeout_secs: Some(1),
            },
        )
        .unwrap();
    assert!(report.evidence[0].timed_out);
    let started = std::fs::read_to_string(marker.with_extension("started")).unwrap();
    let identity: Vec<_> = started.split_whitespace().collect();
    assert_eq!(identity.len(), 2);
    assert_eq!(
        identity[0], identity[1],
        "child must actually create its own session"
    );
    assert!(
        report.evidence[0].execution_error.is_none(),
        "{:?}",
        report.evidence[0].execution_error
    );
    std::thread::sleep(std::time::Duration::from_millis(1300));
    assert!(!marker.exists());
}

#[test]
fn an_empty_task_card_does_not_capture_the_repository() {
    let fixture = Fixture::new();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert!(report.evidence.is_empty());
    assert!(report.current_fingerprint.is_none());
    assert!(!fixture.data.join("repository-snapshots").exists());
}

#[cfg(unix)]
#[test]
fn successful_shell_does_not_leave_background_children() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.repo.join("build-output")).unwrap();
    let report = fixture.run("echo finished; (sleep 2; echo escaped > build-output/background) &");
    assert_eq!(report.evidence[0].exit_code, Some(0));
    assert!(
        report.evidence[0].execution_error.is_none(),
        "{:?}",
        report.evidence[0].execution_error
    );
    std::thread::sleep(std::time::Duration::from_millis(2100));
    assert!(!fixture.repo.join("build-output/background").exists());
}
