#[tokio::test]
async fn same_completed_report_version_is_delivered_once_and_new_version_can_follow() {
    let service = directive_test_service();
    let (leader, mut workers) = register_directive_plan(&service, &["report-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status(leader.session_id.as_deref().unwrap(), SessionStatus::Idle);
    let directive_runtime = directive_test_runtime(backend.clone(), service.clone());
    let tmp = tempfile::tempdir().expect("report idempotency temp");
    let paths = AppPaths::new(Some(tmp.path().to_string_lossy().into_owned()));
    let runtime = ReportRuntime {
        terminal_backend: directive_runtime.terminal_backend,
        session_state_machine: directive_runtime.session_state_machine,
        task_binding_service: service,
        pending_worker_reports: Arc::new(Mutex::new(PendingReportMap::new())),
        report_delivery_locks: Arc::new(Mutex::new(HashMap::new())),
        sent_report_keys: Arc::new(Mutex::new(HashSet::new())),
        failed_report_events: Arc::new(Mutex::new(HashSet::new())),
        pipe_event_service: directive_runtime.pipe_event_service,
        dsh_service: Arc::new(cc_panes_core::services::DshService::new(&paths)),
    };
    let leader_sid = leader.session_id.as_deref().unwrap();
    runtime.session_state_machine.on_event(
        leader_sid,
        &cc_cli_adapters::CcPaneEvent::PromptBefore,
        None,
        &serde_json::json!({}),
    );
    runtime.session_state_machine.on_event(
        leader_sid,
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    let mut worker = workers.remove(0);
    worker.status = TaskBindingStatus::Completed;
    worker.completion_summary = Some("first completion".into());
    let first = send_worker_report_to_leader_with_attempt(runtime.clone(), worker.clone(), 0).await;
    assert!(first.sent);
    let duplicate =
        send_worker_report_to_leader_with_attempt(runtime.clone(), worker.clone(), 0).await;
    assert!(!duplicate.sent);
    assert_eq!(backend.submits().len(), 1);

    worker.updated_at = "2026-10-19T03:50:00Z".into();
    worker.completion_summary = Some("revised completion".into());
    let next = send_worker_report_to_leader_with_attempt(runtime, worker, 0).await;
    assert!(next.sent);
    assert_eq!(backend.submits().len(), 2);
}

#[tokio::test]
async fn duplicate_report_race_serializes_and_only_one_transport_write_succeeds() {
    let service = directive_test_service();
    let (leader, mut workers) = register_directive_plan(&service, &["race-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status(leader.session_id.as_deref().unwrap(), SessionStatus::Idle);
    let directive_runtime = directive_test_runtime(backend.clone(), service.clone());
    let tmp = tempfile::tempdir().expect("report race temp");
    let paths = AppPaths::new(Some(tmp.path().to_string_lossy().into_owned()));
    let runtime = ReportRuntime {
        terminal_backend: directive_runtime.terminal_backend,
        session_state_machine: directive_runtime.session_state_machine,
        task_binding_service: service,
        pending_worker_reports: Arc::new(Mutex::new(PendingReportMap::new())),
        report_delivery_locks: Arc::new(Mutex::new(HashMap::new())),
        sent_report_keys: Arc::new(Mutex::new(HashSet::new())),
        failed_report_events: Arc::new(Mutex::new(HashSet::new())),
        pipe_event_service: directive_runtime.pipe_event_service,
        dsh_service: Arc::new(cc_panes_core::services::DshService::new(&paths)),
    };
    let leader_sid = leader.session_id.as_deref().unwrap();
    runtime.session_state_machine.on_event(
        leader_sid,
        &cc_cli_adapters::CcPaneEvent::PromptBefore,
        None,
        &serde_json::json!({}),
    );
    runtime.session_state_machine.on_event(
        leader_sid,
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    let mut worker = workers.remove(0);
    worker.status = TaskBindingStatus::Completed;
    worker.completion_summary = Some("race completion".into());
    let (left, right) = tokio::join!(
        send_worker_report_to_leader_with_attempt(runtime.clone(), worker.clone(), 0),
        send_worker_report_to_leader_with_attempt(runtime, worker, 0),
    );
    assert_eq!(usize::from(left.sent) + usize::from(right.sent), 1);
    assert_eq!(backend.submits().len(), 1);
}
