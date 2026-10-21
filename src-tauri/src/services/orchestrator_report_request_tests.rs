struct ReportRequestFixture {
    runtime: ReportRuntime,
    backend: Arc<DirectiveTestBackend>,
    worker_id: String,
    leader_id: String,
    events: Arc<Mutex<Vec<serde_json::Value>>>,
    _temp: tempfile::TempDir,
}

fn report_request_fixture() -> ReportRequestFixture {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["request-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    let (directive_runtime, events) =
        directive_test_runtime_with_events(backend.clone(), service.clone());
    let temp = tempfile::tempdir().unwrap();
    let paths = AppPaths::new(Some(temp.path().to_string_lossy().into_owned()));
    let runtime = ReportRuntime {
        terminal_backend: directive_runtime.terminal_backend,
        session_state_machine: directive_runtime.session_state_machine,
        task_binding_service: service,
        pending_worker_reports: Arc::new(Mutex::new(PendingReportMap::new())),
        report_delivery_locks: Arc::new(Mutex::new(HashMap::new())),
        sent_report_keys: Arc::new(Mutex::new(SentReportCache::default())),
        failed_report_events: Arc::new(Mutex::new(FailedReportCache::default())),
        pipe_event_service: directive_runtime.pipe_event_service,
        dsh_service: Arc::new(cc_panes_core::services::DshService::new(&paths)),
    };
    let sid = leader.session_id.as_deref().unwrap();
    backend.set_status(sid, SessionStatus::Idle);
    runtime.session_state_machine.on_event(
        sid,
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    ReportRequestFixture {
        runtime,
        backend,
        worker_id: workers[0].id.clone(),
        leader_id: leader.id,
        events,
        _temp: temp,
    }
}

async fn wait_for_report_writes(backend: &DirectiveTestBackend, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while backend.submits().len() < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("automatic report should be delivered");
}

fn complete_request_worker(fixture: &ReportRequestFixture) -> TaskBinding {
    worker_report_requests::update_binding_and_notify(
        fixture.runtime.clone(),
        &fixture.worker_id,
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Completed),
            progress: Some(100),
            completion_summary: Some("已完成 2 个 phase,改动 3 文件".into()),
            ..Default::default()
        },
    )
    .unwrap()
}

fn explicit_completion_request(fixture: &ReportRequestFixture) -> McpReportToLeaderParams {
    McpReportToLeaderParams {
        worker_id: fixture.worker_id.clone(),
        status: Some("completed".into()),
        summary: Some("Codex 执行完成,改动 3 文件,详见 PTY".into()),
    }
}

#[tokio::test]
async fn r10_template_summaries_share_one_successful_completion_delivery() {
    let fixture = report_request_fixture();
    let persisted = complete_request_worker(&fixture);
    wait_for_report_writes(&fixture.backend, 1).await;
    let result = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert!(!result.queued);
    assert_eq!(fixture.backend.submits().len(), 1, "update auto-report and explicit template summary must share the same persisted completion version");
    let after = fixture
        .runtime
        .task_binding_service
        .get(&fixture.worker_id)
        .unwrap()
        .unwrap();
    assert_eq!(after.updated_at, persisted.updated_at);
    assert_eq!(
        after.completion_summary, persisted.completion_summary,
        "the explicit override is delivery text, not a new durable result"
    );
}

fn set_report_leader_status(fixture: &ReportRequestFixture, status: SessionStatus) {
    fixture.backend.set_status("leader-session", status);
    let event = match status {
        SessionStatus::Idle => cc_cli_adapters::CcPaneEvent::TurnEnd,
        SessionStatus::WaitingInput => cc_cli_adapters::CcPaneEvent::WaitingInput,
        _ => cc_cli_adapters::CcPaneEvent::PromptBefore,
    };
    fixture.runtime.session_state_machine.on_event(
        "leader-session",
        &event,
        None,
        &serde_json::json!({}),
    );
}

async fn wait_for_report_phase(fixture: &ReportRequestFixture, phase: &str, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let observed = fixture
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event["phase"] == phase)
                .count();
            if observed >= count {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("report event should be recorded");
}

#[tokio::test]
async fn r10_unrelated_metadata_and_progress_do_not_renotify_a_completed_result() {
    let fixture = report_request_fixture();
    let completed = complete_request_worker(&fixture);
    wait_for_report_writes(&fixture.backend, 1).await;
    fixture.runtime.task_binding_service.update_patch(&fixture.worker_id, serde_json::json!({
        "title":"renamed", "progress":90, "metadata":{"ui":{"muted":true},"reportDropped":true}
    })).unwrap();
    let current = fixture
        .runtime
        .task_binding_service
        .get(&fixture.worker_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.report_revision, completed.report_revision);
    let _ = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert_eq!(fixture.backend.submits().len(), 1);
}

#[tokio::test]
async fn r10_queued_explicit_override_retains_the_original_version_body_and_ttl() {
    let fixture = report_request_fixture();
    set_report_leader_status(&fixture, SessionStatus::WaitingInput);
    let completed = complete_request_worker(&fixture);
    wait_for_report_phase(&fixture, "queued", 1).await;
    let queued_at =
        fixture.runtime.pending_worker_reports.lock().unwrap()["leader-session"][0].queued_at;
    let queued = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert!(queued.queued);
    {
        let queues = fixture.runtime.pending_worker_reports.lock().unwrap();
        assert_eq!(queues["leader-session"].len(), 1);
        assert_eq!(queues["leader-session"][0].queued_at, queued_at);
        assert_eq!(
            queues["leader-session"][0].worker.completion_summary,
            completed.completion_summary
        );
        assert_eq!(
            queues["leader-session"][0].worker.report_revision,
            completed.report_revision
        );
    }
    assert!(fixture.backend.submits().is_empty());
    set_report_leader_status(&fixture, SessionStatus::Idle);
    tokio::join!(
        flush_pending_reports(fixture.runtime.clone(), "leader-session".into()),
        scan_pending_reports_once(&fixture.runtime)
    );
    let _ = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert_eq!(fixture.backend.submits().len(), 1);
    assert_eq!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["phase"] == "delivered")
            .count(),
        1
    );
}

#[tokio::test]
async fn r10_explicit_different_summary_waits_for_inflight_automatic_delivery() {
    let fixture = report_request_fixture();
    let entered = Arc::new(tokio::sync::Notify::new());
    let hook_entered = entered.clone();
    let (release, wait) = std::sync::mpsc::channel();
    *fixture.backend.before_submit.lock().unwrap() = Some(Box::new(move || {
        hook_entered.notify_one();
        wait.recv_timeout(std::time::Duration::from_secs(3))
            .expect("release blocked transport");
    }));
    complete_request_worker(&fixture);
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let runtime = fixture.runtime.clone();
    let params = explicit_completion_request(&fixture);
    let explicit =
        tokio::spawn(async move { worker_report_requests::report(runtime, params).await });
    tokio::task::yield_now().await;
    assert!(!explicit.is_finished());
    release.send(()).unwrap();
    let result = explicit.await.unwrap();
    assert!(!result.queued);
    assert_eq!(fixture.backend.submits().len(), 1);
    assert_eq!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["phase"] == "delivered")
            .count(),
        1
    );
}

#[tokio::test]
async fn r10_failed_delivery_retries_and_later_result_versions_have_distinct_lifecycle_events() {
    let fixture = report_request_fixture();
    *fixture.backend.submit_error.lock().unwrap() = Some("temporary transport failure".into());
    let first = complete_request_worker(&fixture);
    wait_for_report_phase(&fixture, "failed", 1).await;
    let result = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert!(result.sent);
    assert_eq!(fixture.backend.submits().len(), 1);
    *fixture.backend.submit_error.lock().unwrap() = Some("new revision transport failure".into());
    let changed = worker_report_requests::update_binding_and_notify(
        fixture.runtime.clone(),
        &fixture.worker_id,
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Failed),
            completion_summary: Some("new result failed".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(changed.report_revision > first.report_revision);
    wait_for_report_phase(&fixture, "failed", 2).await;
    let failed = fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["phase"] == "failed")
        .map(|event| event["correlationId"].clone())
        .collect::<Vec<_>>();
    assert_ne!(
        failed[0], failed[1],
        "new versions must not collapse into the prior failed pipe attempt"
    );
    let retry = worker_report_requests::report(
        fixture.runtime.clone(),
        McpReportToLeaderParams {
            worker_id: fixture.worker_id.clone(),
            status: None,
            summary: Some("retry failed outcome report".into()),
        },
    )
    .await;
    assert!(retry.sent);
    assert_eq!(fixture.backend.submits().len(), 2);
    let events = fixture.events.lock().unwrap();
    assert!(events
        .iter()
        .filter(|event| event["phase"] == "delivered")
        .all(|event| event["attempt"] == 1));
}

#[tokio::test]
async fn r10_new_attempt_can_complete_again_and_old_flush_cannot_override_it() {
    let fixture = report_request_fixture();
    set_report_leader_status(&fixture, SessionStatus::Thinking);
    let old = complete_request_worker(&fixture);
    wait_for_report_phase(&fixture, "queued", 1).await;
    let old_batch = take_pending_reports(
        &mut fixture.runtime.pending_worker_reports.lock().unwrap(),
        "leader-session",
        std::time::Instant::now(),
    );
    worker_report_requests::update_binding_and_notify(
        fixture.runtime.clone(),
        &fixture.worker_id,
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Running),
            ..Default::default()
        },
    )
    .unwrap();
    let new = complete_request_worker(&fixture);
    assert!(new.report_revision > old.report_revision);
    wait_for_report_phase(&fixture, "queued", 2).await;
    let stale = send_worker_report_to_leader_with_attempt_and_queued_at(
        fixture.runtime.clone(),
        old_batch.reports[0].worker.clone(),
        1,
        Some(old_batch.reports[0].queued_at),
    )
    .await;
    assert!(!stale.sent && !stale.queued);
    assert_eq!(
        fixture.runtime.pending_worker_reports.lock().unwrap()["leader-session"][0]
            .worker
            .report_revision,
        new.report_revision
    );
    set_report_leader_status(&fixture, SessionStatus::Idle);
    flush_pending_reports(fixture.runtime.clone(), "leader-session".into()).await;
    assert_eq!(fixture.backend.submits().len(), 1);
    let _ = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert_eq!(fixture.backend.submits().len(), 1);
}

#[tokio::test]
async fn r10_new_leader_session_can_receive_the_same_result_once() {
    let fixture = report_request_fixture();
    complete_request_worker(&fixture);
    wait_for_report_writes(&fixture.backend, 1).await;
    fixture
        .runtime
        .task_binding_service
        .update(
            &fixture.leader_id,
            UpdateTaskBindingRequest {
                session_id: Some("replacement-leader".into()),
                ..Default::default()
            },
        )
        .unwrap();
    fixture
        .backend
        .set_status("replacement-leader", SessionStatus::Idle);
    fixture.runtime.session_state_machine.on_event(
        "replacement-leader",
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    *fixture.backend.submit_error.lock().unwrap() = Some("replacement receiver unavailable".into());
    let failed = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert!(!failed.sent);
    {
        let events = fixture.events.lock().unwrap();
        let old_success = events
            .iter()
            .find(|event| event["phase"] == "delivered")
            .unwrap();
        let new_failure = events
            .iter()
            .find(|event| event["phase"] == "failed")
            .unwrap();
        assert_ne!(old_success["correlationId"], new_failure["correlationId"], "a failure to the replacement receiver must not overwrite the original receiver's successful delivery");
    }
    assert!(
        worker_report_requests::report(
            fixture.runtime.clone(),
            explicit_completion_request(&fixture)
        )
        .await
        .sent
    );
    let _ = worker_report_requests::report(
        fixture.runtime.clone(),
        explicit_completion_request(&fixture),
    )
    .await;
    assert_eq!(fixture.backend.submits().len(), 2);
    assert_eq!(fixture.backend.submits()[1].0, "replacement-leader");
}

#[tokio::test]
async fn r10_stale_successful_version_cannot_be_reclassified_as_a_failed_delivery() {
    let fixture = report_request_fixture();
    let first = complete_request_worker(&fixture);
    wait_for_report_writes(&fixture.backend, 1).await;
    fixture
        .runtime
        .task_binding_service
        .update(
            &fixture.worker_id,
            UpdateTaskBindingRequest {
                status: Some(TaskBindingStatus::Running),
                ..Default::default()
            },
        )
        .unwrap();
    let stale =
        send_worker_report_to_leader_with_attempt(fixture.runtime.clone(), first.clone(), 0).await;
    assert!(!stale.sent && !stale.queued);
    assert_eq!(fixture.backend.submits().len(), 1);
    let first_correlation = report_correlation_id(&first, Some("leader-session"));
    let events = fixture.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["correlationId"] == first_correlation
                && event["phase"] == "delivered")
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| event["correlationId"] == first_correlation && event["phase"] == "failed"));
}

#[test]
fn r10_same_revision_drained_batch_restores_earliest_body_and_ttl() {
    let mut map = PendingReportMap::new();
    let first_at = std::time::Instant::now();
    let original = test_pending_report_worker("ttl-worker");
    enqueue_pending_report_at_attempt(&mut map, "leader-session", original.clone(), 0, first_at);
    let batch = take_pending_reports(&mut map, "leader-session", first_at);
    let later_at = first_at + std::time::Duration::from_secs(60);
    let mut explicit = original.clone();
    explicit.completion_summary = Some("later explicit override".into());
    enqueue_pending_report_at_attempt(&mut map, "leader-session", explicit, 1, later_at);
    let merged = enqueue_pending_report_with_queued_at(
        &mut map,
        "leader-session",
        batch.reports[0].worker.clone(),
        2,
        later_at,
        batch.reports[0].queued_at,
    );
    assert!(merged.accepted);
    let queued = &map["leader-session"][0];
    assert_eq!(queued.queued_at, first_at);
    assert_eq!(
        queued.worker.completion_summary,
        original.completion_summary
    );
    assert_eq!(queued.attempt, 2);
    let expired = take_pending_reports(
        &mut map,
        "leader-session",
        first_at + std::time::Duration::from_secs(PENDING_REPORT_TTL_SECS + 1),
    );
    assert!(
        expired.reports.is_empty(),
        "a later explicit override must not extend the original report's lifetime"
    );
    assert_eq!(expired.dropped.len(), 1);
    assert_eq!(expired.dropped[0].reason, "expired");
}
