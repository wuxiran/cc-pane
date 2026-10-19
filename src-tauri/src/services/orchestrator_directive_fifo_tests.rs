fn ordered_directive(
    leader: &TaskBinding,
    worker: &TaskBinding,
    message: &str,
) -> PendingDirective {
    let mut directive = test_pending_directive(
        &leader.id,
        &worker.id,
        worker.session_id.as_deref().unwrap(),
        message,
        std::time::Instant::now(),
    );
    directive.message = message.to_owned();
    directive
}

fn submitted_directive_messages(backend: &DirectiveTestBackend) -> Vec<String> {
    backend
        .submits()
        .into_iter()
        .map(|(_, message)| message)
        .collect()
}

#[tokio::test]
async fn different_messages_from_one_leader_survive_waiting_input_in_fifo_order() {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["fifo-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status("fifo-worker", SessionStatus::Thinking);
    let runtime = directive_test_runtime(backend.clone(), service);
    for message in ["Implement feature A", "Also add regression tests"] {
        assert!(matches!(
            dispatch_directive(
                runtime.clone(),
                ordered_directive(&leader, &workers[0], message),
                DirectiveDeliverySource::Initial
            )
            .await,
            DirectiveAttempt::Queued
        ));
    }
    assert_eq!(
        runtime.pending_directives.lock().unwrap()["fifo-worker"].len(),
        2
    );
    backend.set_status("fifo-worker", SessionStatus::WaitingInput);
    flush_pending_directives(runtime.clone(), "fifo-worker".into()).await;
    assert!(backend.submits().is_empty());
    assert!(backend.writes().is_empty());
    assert_eq!(
        runtime.pending_directives.lock().unwrap()["fifo-worker"].len(),
        2
    );

    backend.set_status("fifo-worker", SessionStatus::Idle);
    tokio::join!(
        flush_pending_directives(runtime.clone(), "fifo-worker".into()),
        flush_ready_pending_directives(runtime.clone(), "fifo-worker".into()),
    );
    assert_eq!(
        submitted_directive_messages(&backend),
        [
            "[leader-directive] Implement feature A",
            "[leader-directive] Also add regression tests",
        ]
    );
    assert!(runtime.pending_directives.lock().unwrap().is_empty());
}

#[tokio::test]
async fn new_message_cannot_overtake_queued_messages_when_the_worker_becomes_idle() {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["fifo-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status("fifo-worker", SessionStatus::Thinking);
    let runtime = directive_test_runtime(backend.clone(), service);
    for message in ["first", "second"] {
        let _ = dispatch_directive(
            runtime.clone(),
            ordered_directive(&leader, &workers[0], message),
            DirectiveDeliverySource::Initial,
        )
        .await;
    }
    backend.set_status("fifo-worker", SessionStatus::Idle);
    *backend.after_submit_status.lock().unwrap() = Some(SessionStatus::Thinking);
    // The first queued message is accepted, then the CLI becomes busy again.
    // Both the old second message and a fresh third message must wait in that order.
    assert!(matches!(
        dispatch_directive(
            runtime.clone(),
            ordered_directive(&leader, &workers[0], "third"),
            DirectiveDeliverySource::Initial
        )
        .await,
        DirectiveAttempt::Queued
    ));
    assert_eq!(
        submitted_directive_messages(&backend),
        ["[leader-directive] first"]
    );
    let queued = runtime.pending_directives.lock().unwrap()["fifo-worker"]
        .iter()
        .map(|directive| directive.message.clone())
        .collect::<Vec<_>>();
    assert_eq!(queued, ["second", "third"]);
    backend.set_status("fifo-worker", SessionStatus::Idle);
    flush_pending_directives(runtime.clone(), "fifo-worker".into()).await;
    assert_eq!(
        submitted_directive_messages(&backend),
        [
            "[leader-directive] first",
            "[leader-directive] second",
            "[leader-directive] third",
        ]
    );
}

#[tokio::test]
async fn repeated_internal_id_is_delivered_once_but_equal_text_with_new_id_is_independent() {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["fifo-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status("fifo-worker", SessionStatus::Thinking);
    let runtime = directive_test_runtime(backend.clone(), service);
    let first = ordered_directive(&leader, &workers[0], "repeat this check");
    for directive in [
        first.clone(),
        first,
        ordered_directive(&leader, &workers[0], "repeat this check"),
    ] {
        assert!(matches!(
            dispatch_directive(runtime.clone(), directive, DirectiveDeliverySource::Initial).await,
            DirectiveAttempt::Queued
        ));
    }
    assert_eq!(
        runtime.pending_directives.lock().unwrap()["fifo-worker"].len(),
        2
    );
    backend.set_status("fifo-worker", SessionStatus::Idle);
    flush_pending_directives(runtime.clone(), "fifo-worker".into()).await;
    flush_pending_directives(runtime.clone(), "fifo-worker".into()).await;
    assert_eq!(backend.submits().len(), 2);
    assert!(runtime.pending_directives.lock().unwrap().is_empty());
}

#[test]
fn directive_delivery_locks_are_per_worker_and_release_unused_entries() {
    let runtime = directive_test_runtime(
        Arc::new(DirectiveTestBackend::default()),
        directive_test_service(),
    );
    let first = directive_delivery_lock(&runtime, "first");
    assert!(Arc::ptr_eq(
        &first,
        &directive_delivery_lock(&runtime, "first")
    ));
    let second = directive_delivery_lock(&runtime, "second");
    assert!(!Arc::ptr_eq(&first, &second));
    drop(first);
    let _third = directive_delivery_lock(&runtime, "third");
    assert!(!runtime
        .directive_delivery_locks
        .lock()
        .unwrap()
        .contains_key("first"));
}

#[tokio::test]
async fn pending_id_repeated_on_idle_does_not_flush_then_resubmit_it() {
    let service = directive_test_service();
    let (leader, workers) = register_directive_plan(&service, &["fifo-worker"]);
    let backend = Arc::new(DirectiveTestBackend::default());
    backend.set_status("fifo-worker", SessionStatus::Thinking);
    let runtime = directive_test_runtime(backend.clone(), service);
    let directive = ordered_directive(&leader, &workers[0], "only once");
    let _ = dispatch_directive(
        runtime.clone(),
        directive.clone(),
        DirectiveDeliverySource::Initial,
    )
    .await;
    backend.set_status("fifo-worker", SessionStatus::Idle);
    assert!(matches!(
        dispatch_directive(runtime.clone(), directive, DirectiveDeliverySource::Initial).await,
        DirectiveAttempt::Queued
    ));
    flush_pending_directives(runtime.clone(), "fifo-worker".into()).await;
    assert_eq!(
        submitted_directive_messages(&backend),
        ["[leader-directive] only once"]
    );
    assert!(runtime.pending_directives.lock().unwrap().is_empty());
}
