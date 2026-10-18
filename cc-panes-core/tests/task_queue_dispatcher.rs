use cc_panes_core::models::task_queue::{
    QueueItemState, TaskQueueItemDraft, TaskQueueReason, TaskQueueState,
};
use cc_panes_core::repository::{Database, TaskQueueRepository};
use cc_panes_core::services::{
    TaskQueueDispatchGateway, TaskQueueDispatchOutcome, TaskQueueDispatcher, TaskQueueReadiness,
    TaskQueueService, TaskQueueSubmitFailure,
};
use cc_panes_core::utils::error::{AppError, AppResult};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type ReadinessHook = Box<dyn FnOnce() + Send>;

struct FakeGateway {
    readiness: Mutex<VecDeque<TaskQueueReadiness>>,
    fallback_readiness: Mutex<TaskQueueReadiness>,
    submit_failure: Mutex<Option<TaskQueueSubmitFailure>>,
    submitted: Mutex<Vec<String>>,
    readiness_calls: AtomicUsize,
    readiness_hook: Mutex<Option<(usize, ReadinessHook)>>,
    fail_readiness_call: AtomicUsize,
}

impl FakeGateway {
    fn new(readiness: impl IntoIterator<Item = TaskQueueReadiness>) -> Self {
        Self {
            readiness: Mutex::new(readiness.into_iter().collect()),
            fallback_readiness: Mutex::new(TaskQueueReadiness::Ready),
            submit_failure: Mutex::new(None),
            submitted: Mutex::new(Vec::new()),
            readiness_calls: AtomicUsize::new(0),
            readiness_hook: Mutex::new(None),
            fail_readiness_call: AtomicUsize::new(0),
        }
    }

    fn fail_submit(&self, failure: TaskQueueSubmitFailure) {
        *self.submit_failure.lock().unwrap() = Some(failure);
    }

    fn on_readiness_call(&self, call: usize, hook: impl FnOnce() + Send + 'static) {
        *self.readiness_hook.lock().unwrap() = Some((call, Box::new(hook)));
    }
}

impl TaskQueueDispatchGateway for FakeGateway {
    fn readiness(&self, _session_id: &str) -> AppResult<TaskQueueReadiness> {
        let call = self.readiness_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let hook = {
            let mut hook = self.readiness_hook.lock().unwrap();
            if hook.as_ref().is_some_and(|(target, _)| *target == call) {
                hook.take().map(|(_, hook)| hook)
            } else {
                None
            }
        };
        if let Some(hook) = hook {
            hook();
        }
        if call == self.fail_readiness_call.load(Ordering::SeqCst) {
            return Err(AppError::coded(
                "DAEMON_UNAVAILABLE",
                "temporary status lookup failure",
            ));
        }
        Ok(self
            .readiness
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(*self.fallback_readiness.lock().unwrap()))
    }

    fn submit_text(&self, _session_id: &str, prompt: &str) -> Result<(), TaskQueueSubmitFailure> {
        if let Some(failure) = self.submit_failure.lock().unwrap().take() {
            return Err(failure);
        }
        self.submitted.lock().unwrap().push(prompt.to_string());
        Ok(())
    }

    fn mark_submit_started(&self, _session_id: &str) {
        *self.fallback_readiness.lock().unwrap() = TaskQueueReadiness::ConfirmingIdle;
    }
}

struct Fixture {
    database: Arc<Database>,
    service: Arc<TaskQueueService>,
    repository: Arc<TaskQueueRepository>,
    dispatcher: TaskQueueDispatcher,
    gateway: Arc<FakeGateway>,
    _image_root: tempfile::TempDir,
    _trusted_root: tempfile::TempDir,
}

fn fixture(readiness: impl IntoIterator<Item = TaskQueueReadiness>) -> Fixture {
    let database = Arc::new(Database::new_fallback().expect("database"));
    let repository = Arc::new(TaskQueueRepository::new(database.clone()));
    let image_root = tempfile::tempdir().expect("image root");
    let trusted_root = tempfile::tempdir().expect("trusted root");
    let service = Arc::new(TaskQueueService::new(
        repository.clone(),
        image_root.path().to_path_buf(),
        trusted_root.path().to_path_buf(),
    ));
    let gateway = Arc::new(FakeGateway::new(readiness));
    let dispatcher = TaskQueueDispatcher::new(service.clone(), gateway.clone());
    Fixture {
        database,
        service,
        repository,
        dispatcher,
        gateway,
        _image_root: image_root,
        _trusted_root: trusted_root,
    }
}

fn queue(repository: &TaskQueueRepository, text: &str, now: i64) {
    repository
        .add_item(
            "pty-1",
            &TaskQueueItemDraft::new(text, vec![]).unwrap(),
            now,
        )
        .unwrap();
}

#[test]
fn idle_dispatch_submits_only_one_fifo_item_until_a_new_idle_observation() {
    let fixture = fixture([TaskQueueReadiness::Ready, TaskQueueReadiness::Ready]);
    queue(&fixture.repository, "first", 1);
    queue(&fixture.repository, "second", 2);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 3).unwrap(),
        TaskQueueDispatchOutcome::Submitted { .. }
    ));
    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 4).unwrap(),
        TaskQueueDispatchOutcome::Blocked(TaskQueueReadiness::ConfirmingIdle)
    ));

    assert_eq!(
        fixture.gateway.submitted.lock().unwrap().as_slice(),
        ["first"]
    );
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.items[0].text, "second");
}

#[test]
fn one_hundred_fresh_idle_rounds_submit_each_fifo_item_exactly_once() {
    let fixture = fixture(std::iter::repeat_n(TaskQueueReadiness::Ready, 300));
    let expected = (0..100)
        .map(|index| format!("task-{index:03}"))
        .collect::<Vec<_>>();
    for (index, task) in expected.iter().enumerate() {
        queue(&fixture.repository, task, index as i64 + 1);
    }

    for index in 0..100 {
        assert!(matches!(
            fixture
                .dispatcher
                .check_session("pty-1", 1_000 + index)
                .unwrap(),
            TaskQueueDispatchOutcome::Submitted { .. }
        ));
    }

    assert_eq!(*fixture.gateway.submitted.lock().unwrap(), expected);
    assert!(fixture
        .repository
        .snapshot("pty-1")
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn readiness_race_after_claim_returns_the_same_head_to_queued() {
    let fixture = fixture([
        TaskQueueReadiness::Ready,
        TaskQueueReadiness::ConfirmingIdle,
    ]);
    queue(&fixture.repository, "first", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::Requeued {
            readiness: TaskQueueReadiness::ConfirmingIdle,
            ..
        }
    ));
    assert!(fixture.gateway.submitted.lock().unwrap().is_empty());
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::Queued);
    assert_eq!(snapshot.state, TaskQueueState::ConfirmingIdle);
}

#[test]
fn global_disable_after_post_claim_check_prevents_the_terminal_write() {
    let fixture = fixture([TaskQueueReadiness::Ready, TaskQueueReadiness::Ready]);
    let repository = fixture.repository.clone();
    fixture.gateway.on_readiness_call(2, move || {
        repository.set_global_enabled(false, 3).unwrap();
    });
    queue(&fixture.repository, "first", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::Requeued {
            readiness: TaskQueueReadiness::GlobalDisabled,
            ..
        }
    ));
    assert!(fixture.gateway.submitted.lock().unwrap().is_empty());
    assert_eq!(
        fixture.repository.snapshot("pty-1").unwrap().items[0].state,
        QueueItemState::Queued
    );
}

#[test]
fn write_authority_loss_at_submit_returns_the_same_head_to_queued() {
    let fixture = fixture([TaskQueueReadiness::Ready, TaskQueueReadiness::Ready]);
    fixture
        .gateway
        .fail_submit(TaskQueueSubmitFailure::NotReady(
            TaskQueueReadiness::AutomaticWriteUnavailable,
        ));
    queue(&fixture.repository, "first", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::Requeued {
            readiness: TaskQueueReadiness::AutomaticWriteUnavailable,
            ..
        }
    ));
    assert!(fixture.gateway.submitted.lock().unwrap().is_empty());
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::Queued);
    assert_eq!(
        snapshot.reason,
        Some(TaskQueueReason::AutomaticWriteUnavailable)
    );
}

#[test]
fn waiting_input_blocks_normal_queue_dispatch() {
    let fixture = fixture([TaskQueueReadiness::WaitingInput]);
    queue(&fixture.repository, "do not answer the prompt", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::Blocked(TaskQueueReadiness::WaitingInput)
    ));
    assert!(fixture.gateway.submitted.lock().unwrap().is_empty());
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.state, TaskQueueState::ActionRequired);
    assert_eq!(snapshot.reason, Some(TaskQueueReason::WaitingInput));
}

#[test]
fn definite_submit_failure_retains_failed_head_without_retry() {
    let fixture = fixture([TaskQueueReadiness::Ready, TaskQueueReadiness::Ready]);
    fixture
        .gateway
        .fail_submit(TaskQueueSubmitFailure::Definite(AppError::coded(
            "SUBMIT_FAILED",
            "write was rejected before delivery",
        )));
    queue(&fixture.repository, "first", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::Failed { .. }
    ));
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::Failed);
    assert_eq!(snapshot.state, TaskQueueState::SendFailed);
}

#[test]
fn ambiguous_submit_failure_requires_action_and_never_auto_retries() {
    let fixture = fixture([TaskQueueReadiness::Ready, TaskQueueReadiness::Ready]);
    fixture
        .gateway
        .fail_submit(TaskQueueSubmitFailure::DeliveryUnknown(AppError::from(
            "transport closed before acknowledgement",
        )));
    queue(&fixture.repository, "first", 1);

    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 2).unwrap(),
        TaskQueueDispatchOutcome::DeliveryUnknown { .. }
    ));
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::DeliveryUnknown);
    assert_eq!(snapshot.state, TaskQueueState::ActionRequired);
    assert_eq!(snapshot.reason, Some(TaskQueueReason::DeliveryUnknown));
}

#[test]
fn post_claim_lookup_error_is_retryable_and_following_tasks_keep_fifo_order() {
    let fixture = fixture(std::iter::repeat_n(TaskQueueReadiness::Ready, 20));
    fixture
        .gateway
        .fail_readiness_call
        .store(2, Ordering::SeqCst);
    queue(&fixture.repository, "first", 1);
    queue(&fixture.repository, "second", 2);
    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 3).unwrap(),
        TaskQueueDispatchOutcome::Failed { .. }
    ));
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::Failed);
    assert_eq!(
        snapshot.items[0].last_error.as_deref(),
        Some("temporary status lookup failure")
    );
    assert!(fixture.gateway.submitted.lock().unwrap().is_empty());
    assert_eq!(
        fixture.dispatcher.check_session("pty-1", 4).unwrap(),
        TaskQueueDispatchOutcome::Noop
    );
    fixture
        .service
        .retry_item("pty-1", &snapshot.items[0].id, 5)
        .unwrap();
    for now in [6, 7] {
        assert!(matches!(
            fixture.dispatcher.check_session("pty-1", now).unwrap(),
            TaskQueueDispatchOutcome::Submitted { .. }
        ));
    }
    assert_eq!(
        *fixture.gateway.submitted.lock().unwrap(),
        ["first", "second"]
    );
    assert!(fixture
        .repository
        .snapshot("pty-1")
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn failed_claim_finalization_is_retried_without_restarting_the_worker() {
    let fixture = fixture(std::iter::repeat_n(TaskQueueReadiness::Ready, 20));
    fixture
        .gateway
        .fail_readiness_call
        .store(2, Ordering::SeqCst);
    fixture.database.connection().unwrap().execute_batch(
        "CREATE TRIGGER reject_failed_finalization BEFORE UPDATE OF state ON terminal_task_queue_items
         WHEN NEW.state = 'failed' BEGIN SELECT RAISE(FAIL, 'temporary storage error'); END;"
    ).unwrap();
    queue(&fixture.repository, "first", 1);
    queue(&fixture.repository, "second", 2);
    assert!(fixture.dispatcher.check_session("pty-1", 3).is_err());
    assert_eq!(
        fixture.repository.snapshot("pty-1").unwrap().items[0].state,
        QueueItemState::Dispatching
    );
    fixture
        .database
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_failed_finalization")
        .unwrap();
    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 4).unwrap(),
        TaskQueueDispatchOutcome::Failed { .. }
    ));
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    fixture
        .service
        .retry_item("pty-1", &snapshot.items[0].id, 5)
        .unwrap();
    for now in [6, 7] {
        fixture.dispatcher.check_session("pty-1", now).unwrap();
    }
    assert_eq!(
        *fixture.gateway.submitted.lock().unwrap(),
        ["first", "second"]
    );
}

#[test]
fn acknowledgement_persistence_failure_never_automatically_replays_the_prompt() {
    let fixture = fixture(std::iter::repeat_n(TaskQueueReadiness::Ready, 20));
    fixture
        .database
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_acknowledgement BEFORE DELETE ON terminal_task_queue_items
         WHEN OLD.state = 'dispatching' BEGIN SELECT RAISE(FAIL, 'lost acknowledgement'); END;",
        )
        .unwrap();
    queue(&fixture.repository, "first", 1);
    queue(&fixture.repository, "second", 2);
    assert!(matches!(
        fixture.dispatcher.check_session("pty-1", 3).unwrap(),
        TaskQueueDispatchOutcome::DeliveryUnknown { .. }
    ));
    fixture
        .database
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_acknowledgement")
        .unwrap();
    for now in [4, 5, 6] {
        assert_eq!(
            fixture.dispatcher.check_session("pty-1", now).unwrap(),
            TaskQueueDispatchOutcome::Noop
        );
    }
    let snapshot = fixture.repository.snapshot("pty-1").unwrap();
    assert_eq!(snapshot.items[0].state, QueueItemState::DeliveryUnknown);
    assert_eq!(*fixture.gateway.submitted.lock().unwrap(), ["first"]);
    // The user confirms the first prompt was received and removes only that uncertain item.
    fixture
        .service
        .delete_item("pty-1", &snapshot.items[0].id, 7)
        .unwrap();
    fixture.dispatcher.check_session("pty-1", 8).unwrap();
    assert_eq!(
        *fixture.gateway.submitted.lock().unwrap(),
        ["first", "second"]
    );
}

#[test]
fn submitted_images_remain_readable_for_delayed_cli_consumption_and_followup_tasks() {
    let fixture = fixture(std::iter::repeat_n(TaskQueueReadiness::Ready, 20));
    let source = fixture._trusted_root.path().join("clipboard.png");
    let bytes = b"\x89PNG\r\n\x1a\nimage";
    std::fs::write(&source, bytes).unwrap();
    for text in ["first image", "second image"] {
        let staged = fixture.service.stage_image("pty-1", &source, 1, 1).unwrap();
        fixture
            .service
            .add_item(
                "pty-1",
                &TaskQueueItemDraft::new(text, vec![staged.image_ref]).unwrap(),
                1,
            )
            .unwrap();
    }
    for now in [2, 3] {
        assert!(matches!(
            fixture.dispatcher.check_session("pty-1", now).unwrap(),
            TaskQueueDispatchOutcome::Submitted { .. }
        ));
        // A CLI reads the file only after submit_text has acknowledged the terminal write.
        for prompt in fixture.gateway.submitted.lock().unwrap().iter() {
            assert_eq!(
                std::fs::read(prompt.lines().next().unwrap()).unwrap(),
                bytes
            );
        }
        assert_eq!(fixture.service.prune_unreferenced_images().unwrap(), 0);
    }
    assert_eq!(fixture.gateway.submitted.lock().unwrap().len(), 2);
    assert!(fixture
        .repository
        .snapshot("pty-1")
        .unwrap()
        .items
        .is_empty());
    assert_eq!(fixture.service.release_session_images("pty-1").unwrap(), 2);
}
