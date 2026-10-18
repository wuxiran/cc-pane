// These regressions exercise the real queues and dispatch functions against a recording
// backend. Neither an approval dialog nor a stale idle observation may receive input.

#[tokio::test]
async fn waiting_input_directives_stay_queued_then_deliver_once_on_idle() {
    for submit in [true, false] {
        let service = directive_test_service();
        let (leader, workers) = register_directive_plan(&service, &["worker-waiting"]);
        let backend = Arc::new(DirectiveTestBackend::default());
        backend.set_status("worker-waiting", SessionStatus::WaitingInput);
        let runtime = directive_test_runtime(backend.clone(), service);
        runtime.session_state_machine.on_event(
            "worker-waiting",
            &cc_cli_adapters::CcPaneEvent::WaitingInput,
            None,
            &serde_json::json!({}),
        );
        let transitions = runtime.session_state_machine.subscribe_transitions();
        let consumer = tokio::spawn(run_pending_directive_transition_consumer(
            runtime.clone(),
            transitions,
        ));
        let mut directive = test_pending_directive(
            &leader.id,
            &workers[0].id,
            "worker-waiting",
            &leader.id,
            std::time::Instant::now(),
        );
        directive.submit = submit;
        assert!(matches!(
            dispatch_directive(runtime.clone(), directive, DirectiveDeliverySource::Initial).await,
            DirectiveAttempt::Queued
        ));

        // Initial delivery, scheduled scan and stale idle-triggered flushes all retain it.
        scan_pending_directives_once(&runtime).await;
        flush_ready_pending_directives(runtime.clone(), "worker-waiting".to_string()).await;
        flush_pending_directives(runtime.clone(), "worker-waiting".to_string()).await;
        assert!(backend.writes().is_empty());
        assert!(backend.submits().is_empty());
        assert_eq!(
            runtime.pending_directives.lock().unwrap()["worker-waiting"].len(),
            1
        );

        // A lagging backend Idle cache must not override the hook's WaitingInput state.
        backend.set_status("worker-waiting", SessionStatus::Idle);
        scan_pending_directives_once(&runtime).await;
        flush_pending_directives(runtime.clone(), "worker-waiting".to_string()).await;
        assert!(backend.writes().is_empty());
        assert!(backend.submits().is_empty());
        assert_eq!(
            runtime.pending_directives.lock().unwrap()["worker-waiting"].len(),
            1
        );

        runtime.session_state_machine.on_event(
            "worker-waiting",
            &cc_cli_adapters::CcPaneEvent::TurnEnd,
            None,
            &serde_json::json!({}),
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if backend.writes().len() + backend.submits().len() == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Idle transition should release exactly one queued directive");
        // Level scans and an additional flush must not duplicate edge-triggered delivery.
        scan_pending_directives_once(&runtime).await;
        flush_pending_directives(runtime.clone(), "worker-waiting".to_string()).await;
        consumer.abort();
        let _ = consumer.await;
        assert!(runtime.pending_directives.lock().unwrap().is_empty());
        assert_eq!(backend.submits().len(), usize::from(submit));
        assert_eq!(backend.writes().len(), usize::from(!submit));
    }
}

#[tokio::test]
async fn busy_directive_is_not_flushed_into_a_waiting_input_dialog() {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["worker-busy-to-waiting"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    let sid = "worker-busy-to-waiting";
    backend.set_status(sid, SessionStatus::Thinking);
    let runtime = directive_test_runtime(backend.clone(), service);
    let directive = test_pending_directive(
        &leader.id,
        &workers[0].id,
        sid,
        &leader.id,
        std::time::Instant::now(),
    );
    assert!(matches!(
        dispatch_directive(runtime.clone(), directive, DirectiveDeliverySource::Initial).await,
        DirectiveAttempt::Queued
    ));
    backend.set_status(sid, SessionStatus::WaitingInput);
    runtime.session_state_machine.on_event(
        sid,
        &cc_cli_adapters::CcPaneEvent::WaitingInput,
        None,
        &serde_json::json!({}),
    );
    scan_pending_directives_once(&runtime).await;
    // Also exercise a previously scheduled idle flush after the dialog has opened.
    flush_pending_directives(runtime.clone(), sid.to_string()).await;
    assert!(backend.writes().is_empty());
    assert!(backend.submits().is_empty());
    assert_eq!(runtime.pending_directives.lock().unwrap()[sid].len(), 1);

    backend.set_status(sid, SessionStatus::Idle);
    runtime.session_state_machine.on_event(
        sid,
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    scan_pending_directives_once(&runtime).await;
    scan_pending_directives_once(&runtime).await;
    assert_eq!(backend.submits().len(), 1);
    assert!(runtime.pending_directives.lock().unwrap().is_empty());
}

#[tokio::test]
async fn waiting_input_reports_survive_redelivery_and_flush_once_after_idle() {
    let service = directive_test_service();
    let (leader, mut workers) = register_directive_plan(&service, &["reporting-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    let directive_runtime = directive_test_runtime(backend.clone(), service.clone());
    let tmp = tempfile::tempdir().expect("isolated report test directory");
    let paths = AppPaths::new(Some(tmp.path().to_string_lossy().to_string()));
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
    let sid = leader.session_id.as_deref().unwrap();
    backend.set_status(sid, SessionStatus::WaitingInput);
    runtime.session_state_machine.on_event(
        sid,
        &cc_cli_adapters::CcPaneEvent::WaitingInput,
        None,
        &serde_json::json!({}),
    );
    let mut worker = workers.remove(0);
    worker.status = TaskBindingStatus::Completed;
    worker.completion_summary = Some("finished safely".to_string());
    let result = send_worker_report_to_leader_with_attempt(runtime.clone(), worker, 0).await;
    assert!(result.queued);
    assert!(!result.sent);
    let queued_at = runtime.pending_worker_reports.lock().unwrap()[sid][0].queued_at;

    scan_pending_reports_once(&runtime).await;
    flush_pending_reports(runtime.clone(), sid.to_string()).await;
    // Both the initial and queued report paths must obey the state machine if the
    // daemon cache still says Idle while the permission/question dialog is open.
    backend.set_status(sid, SessionStatus::Idle);
    scan_pending_reports_once(&runtime).await;
    flush_pending_reports(runtime.clone(), sid.to_string()).await;
    assert!(backend.writes().is_empty());
    assert!(backend.submits().is_empty());
    {
        let queue = runtime.pending_worker_reports.lock().unwrap();
        assert_eq!(queue[sid].len(), 1);
        assert_eq!(
            queue[sid][0].queued_at, queued_at,
            "requeue must retain the TTL origin"
        );
    }

    runtime.session_state_machine.on_event(
        sid,
        &cc_cli_adapters::CcPaneEvent::TurnEnd,
        None,
        &serde_json::json!({}),
    );
    // An idle edge and its level-scan fallback can race; only one may take the report.
    tokio::join!(
        flush_pending_reports(runtime.clone(), sid.to_string()),
        scan_pending_reports_once(&runtime),
    );
    scan_pending_reports_once(&runtime).await;
    assert!(runtime.pending_worker_reports.lock().unwrap().is_empty());
    assert_eq!(backend.submits().len(), 1);
    assert!(backend.submits()[0].1.contains("finished safely"));
    assert!(backend.writes().is_empty());
}
