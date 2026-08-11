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
    repository: Arc<TaskQueueRepository>,
    dispatcher: TaskQueueDispatcher,
    gateway: Arc<FakeGateway>,
    _image_root: tempfile::TempDir,
    _trusted_root: tempfile::TempDir,
}

fn fixture(readiness: impl IntoIterator<Item = TaskQueueReadiness>) -> Fixture {
    let repository = Arc::new(TaskQueueRepository::new(Arc::new(
        Database::new_fallback().expect("database"),
    )));
    let image_root = tempfile::tempdir().expect("image root");
    let trusted_root = tempfile::tempdir().expect("trusted root");
    let service = Arc::new(TaskQueueService::new(
        repository.clone(),
        image_root.path().to_path_buf(),
        trusted_root.path().to_path_buf(),
    ));
    let gateway = Arc::new(FakeGateway::new(readiness));
    let dispatcher = TaskQueueDispatcher::new(service, gateway.clone());
    Fixture {
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
