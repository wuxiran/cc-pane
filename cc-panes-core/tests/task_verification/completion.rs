use super::*;
use cc_panes_core::models::task_binding::{TaskBindingStatus, UpdateTaskBindingRequest};
use cc_panes_core::models::task_verification::{
    AcceptTaskCompletionRequest, CompletionCheckStatus, SetTaskCompletionCriteriaRequest,
    TaskCompletionCriteria,
};

impl Fixture {
    fn criteria(
        &self,
        commands: &[&str],
    ) -> cc_panes_core::models::task_verification::TaskVerificationReport {
        let revision = self
            .service
            .list(&self.task_id)
            .unwrap()
            .completion
            .criteria_revision;
        self.service
            .set_criteria(
                &self.task_id,
                SetTaskCompletionCriteriaRequest {
                    expected_revision: revision,
                    criteria: TaskCompletionCriteria {
                        definition_of_done: "Review the expected behavior".into(),
                        required_commands: commands
                            .iter()
                            .map(|command| command.to_string())
                            .collect(),
                    },
                },
            )
            .unwrap()
    }

    fn finish(&self) {
        self.bindings
            .update(
                &self.task_id,
                UpdateTaskBindingRequest {
                    status: Some(TaskBindingStatus::Completed),
                    completion_summary: Some("Agent says done".into()),
                    progress: Some(100),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    fn acceptance_request(&self) -> AcceptTaskCompletionRequest {
        let completion = self.service.list(&self.task_id).unwrap().completion;
        AcceptTaskCompletionRequest {
            expected_criteria_revision: completion.criteria_revision,
            expected_report_revision: completion.report_revision,
            expected_fingerprint: completion.code_fingerprint,
            expected_evidence_ids: completion
                .checks
                .iter()
                .filter_map(|check| check.evidence_id.clone())
                .collect(),
            note: "Checked behavior manually".into(),
        }
    }

    fn accept_result(
        &self,
    ) -> cc_panes_core::utils::AppResult<
        cc_panes_core::models::task_verification::TaskVerificationReport,
    > {
        self.service
            .accept(&self.task_id, self.acceptance_request())
    }
}

#[test]
fn agent_completion_does_not_manufacture_checks_or_human_acceptance() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo required"]);
    fixture.finish();
    fixture
        .bindings
        .update_patch(
            &fixture.task_id,
            serde_json::json!({
                "status":"completed", "metadata":{"userAccepted":true,"checksPassed":true}
            }),
        )
        .unwrap();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert!(report.completion.agent_finished);
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::Missing
    );
    assert!(!report.completion.user_accepted);
    assert!(!report.completion.can_accept);
    assert_eq!(
        fixture.accept_result().unwrap_err().code(),
        Some("COMPLETION_NOT_READY")
    );
}

#[test]
fn acceptance_requires_all_configured_commands_and_finished_execution() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo first", "echo second"]);
    fixture.run("echo first");
    fixture.finish();
    assert!(
        !fixture
            .service
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .can_accept
    );
    let report = fixture.run("echo second");
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::Passed
    );
    assert!(!report.completion.user_accepted);
    let accepted = fixture.accept_result().unwrap();
    assert!(accepted.completion.user_accepted);
    assert_eq!(
        accepted.completion.acceptance.unwrap().evidence_ids.len(),
        2
    );
    let restarted = TaskVerificationService::new(fixture.data.clone(), fixture.bindings.clone());
    assert!(
        restarted
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .user_accepted
    );
}

#[test]
fn checks_can_pass_without_agent_completion_but_acceptance_cannot() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo ready"]);
    let report = fixture.run("echo ready");
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::Passed
    );
    assert!(!report.completion.agent_finished);
    assert!(!report.completion.can_accept);
    assert!(fixture.accept_result().is_err());
}

#[test]
fn changing_code_invalidates_acceptance_and_rejects_accepting_stale_evidence() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo ok"]);
    fixture.run("echo ok");
    fixture.finish();
    assert!(fixture.accept_result().unwrap().completion.user_accepted);
    std::fs::write(fixture.repo.join("code.txt"), "changed\n").unwrap();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::Stale
    );
    assert!(!report.completion.user_accepted);
    assert!(report.completion.acceptance.is_some());
    assert!(fixture.accept_result().is_err());
    fixture.run("echo ok");
    assert!(
        !fixture
            .service
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .user_accepted
    );
    assert!(fixture.accept_result().unwrap().completion.user_accepted);
}

#[test]
fn changed_task_result_requires_a_fresh_human_acceptance() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo ok"]);
    fixture.run("echo ok");
    fixture.finish();
    let stale_request = fixture.acceptance_request();
    fixture.accept_result().unwrap();
    fixture
        .bindings
        .update(
            &fixture.task_id,
            UpdateTaskBindingRequest {
                completion_summary: Some("Different result".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        !fixture
            .service
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .user_accepted
    );
    assert_eq!(
        fixture
            .service
            .accept(&fixture.task_id, stale_request)
            .unwrap_err()
            .code(),
        Some("COMPLETION_CONFLICT")
    );
    assert!(fixture.accept_result().unwrap().completion.user_accepted);
}

#[test]
fn changed_criteria_clear_acceptance_and_stale_edit_conflicts() {
    let fixture = Fixture::new();
    fixture.finish();
    fixture.accept_result().unwrap();
    let report = fixture.criteria(&["echo new"]);
    assert!(report.completion.acceptance.is_none());
    assert!(!report.completion.can_accept);
    let error = fixture
        .service
        .set_criteria(
            &fixture.task_id,
            SetTaskCompletionCriteriaRequest {
                expected_revision: 0,
                criteria: TaskCompletionCriteria::default(),
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), Some("COMPLETION_CONFLICT"));
}

#[test]
fn manual_acceptance_is_explicit_and_never_claims_checks_passed() {
    let fixture = Fixture::new();
    fixture.finish();
    let report = fixture.service.list(&fixture.task_id).unwrap();
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::NotConfigured
    );
    assert!(!report.completion.user_accepted);
    assert!(report.completion.can_accept);
    assert!(fixture.accept_result().unwrap().completion.user_accepted);
}

#[test]
fn invalid_criteria_are_rejected_without_changing_previous_policy() {
    let fixture = Fixture::new();
    for commands in [vec![" ".to_string()], vec!["echo ok".to_string(); 17]] {
        let result = fixture.service.set_criteria(
            &fixture.task_id,
            SetTaskCompletionCriteriaRequest {
                expected_revision: 0,
                criteria: TaskCompletionCriteria {
                    definition_of_done: String::new(),
                    required_commands: commands,
                },
            },
        );
        assert_eq!(
            result.unwrap_err().code(),
            Some("VERIFICATION_INVALID_REQUEST")
        );
    }
    assert_eq!(
        fixture
            .service
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .criteria_revision,
        0
    );
}

#[test]
fn later_failed_run_of_same_command_overrides_an_earlier_success() {
    let fixture = Fixture::new();
    // Ignored output does not change the repository fingerprint.
    let command = if cfg!(windows) {
        "if exist build-output\\fail (exit /b 1) else (echo ok)"
    } else {
        "test ! -f build-output/fail"
    };
    fixture.criteria(&[command]);
    fixture.finish();
    fixture.run(command);
    fixture.accept_result().unwrap();
    std::fs::create_dir(fixture.repo.join("build-output")).unwrap();
    std::fs::write(fixture.repo.join("build-output/fail"), "fail").unwrap();
    let report = fixture.run(command);
    assert_eq!(
        report.completion.checks_status,
        CompletionCheckStatus::Failed
    );
    assert!(!report.completion.user_accepted);
    assert!(fixture.accept_result().is_err());
}

#[test]
fn completion_criteria_and_acceptance_survive_database_reopen() {
    let fixture = Fixture::new();
    let db_path = fixture._temporary.path().join("persistent.db");
    let create = || {
        Arc::new(TaskBindingService::new(Arc::new(
            TaskBindingRepository::new(Arc::new(Database::new(db_path.clone()).unwrap())),
        )))
    };
    let bindings = create();
    let task = bindings
        .create(
            serde_json::from_value(serde_json::json!({
                "title":"Persistent acceptance", "projectPath": fixture.repo.to_string_lossy()
            }))
            .unwrap(),
        )
        .unwrap();
    let service = TaskVerificationService::new(fixture.data.clone(), bindings.clone());
    service
        .set_criteria(
            &task.id,
            SetTaskCompletionCriteriaRequest {
                expected_revision: 0,
                criteria: TaskCompletionCriteria {
                    definition_of_done: "Review expected behavior".into(),
                    required_commands: vec!["echo persistent".into()],
                },
            },
        )
        .unwrap();
    bindings
        .update(
            &task.id,
            UpdateTaskBindingRequest {
                status: Some(TaskBindingStatus::Completed),
                ..Default::default()
            },
        )
        .unwrap();
    let report = service
        .run(
            &task.id,
            RunTaskVerificationRequest {
                command: "echo persistent".into(),
                timeout_secs: Some(5),
            },
        )
        .unwrap();
    service
        .accept(
            &task.id,
            AcceptTaskCompletionRequest {
                expected_criteria_revision: report.completion.criteria_revision,
                expected_report_revision: report.completion.report_revision,
                expected_fingerprint: report.current_fingerprint,
                expected_evidence_ids: report
                    .completion
                    .checks
                    .iter()
                    .filter_map(|check| check.evidence_id.clone())
                    .collect(),
                note: "Reviewed".into(),
            },
        )
        .unwrap();
    drop(service);
    drop(bindings);
    let reopened = TaskVerificationService::new(fixture.data.clone(), create());
    let restored = reopened.list(&task.id).unwrap();
    assert_eq!(
        restored.completion.criteria.required_commands,
        vec!["echo persistent"]
    );
    assert!(restored.completion.user_accepted);
    assert_eq!(restored.completion.acceptance.unwrap().note, "Reviewed");
}

#[cfg(unix)]
#[test]
fn running_check_blocks_both_policy_edits_and_acceptance() {
    let fixture = Fixture::new();
    fixture.criteria(&["sleep 1; echo ok"]);
    fixture.finish();
    let request = fixture.acceptance_request();
    let service = fixture.service.clone();
    let task_id = fixture.task_id.clone();
    let running = std::thread::spawn(move || {
        service.run(
            &task_id,
            RunTaskVerificationRequest {
                command: "sleep 1; echo ok".into(),
                timeout_secs: Some(5),
            },
        )
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !fixture.service.list(&fixture.task_id).unwrap().running {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        fixture
            .service
            .accept(&fixture.task_id, request)
            .unwrap_err()
            .code(),
        Some("VERIFICATION_RUNNING")
    );
    assert_eq!(
        fixture
            .service
            .set_criteria(
                &fixture.task_id,
                SetTaskCompletionCriteriaRequest {
                    expected_revision: 1,
                    criteria: TaskCompletionCriteria::default(),
                }
            )
            .unwrap_err()
            .code(),
        Some("VERIFICATION_RUNNING")
    );
    assert!(running.join().unwrap().is_ok());
}

#[test]
fn accepting_a_replaced_successful_check_requires_reviewing_its_new_evidence() {
    let fixture = Fixture::new();
    fixture.criteria(&["echo ok"]);
    fixture.finish();
    fixture.run("echo ok");
    let reviewed_request = fixture.acceptance_request();
    // Even a fresh successful replacement on identical code is a different
    // reviewed evidence set; the UI must refresh before recording acceptance.
    fixture.run("echo ok");
    let error = fixture
        .service
        .accept(&fixture.task_id, reviewed_request)
        .unwrap_err();
    assert_eq!(error.code(), Some("COMPLETION_CONFLICT"));
    assert!(
        !fixture
            .service
            .list(&fixture.task_id)
            .unwrap()
            .completion
            .user_accepted
    );
    assert!(fixture.accept_result().unwrap().completion.user_accepted);
}
