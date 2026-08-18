use cc_panes_core::models::task_queue::{
    QueueItemState, TaskQueueItemDraft, TaskQueueReason, TaskQueueSnapshot, TaskQueueState,
};

#[test]
fn task_queue_models_use_camel_case_and_defaults() {
    let draft = TaskQueueItemDraft::new("  do the work  ", vec![]).expect("valid draft");
    assert_eq!(draft.text, "do the work");

    let snapshot = TaskQueueSnapshot::new("pty-1");
    let json = serde_json::to_value(&snapshot).expect("serialize snapshot");
    assert_eq!(json["sessionId"], "pty-1");
    assert_eq!(json["state"], "running");
    assert_eq!(json["reason"], serde_json::Value::Null);
    assert_eq!(
        serde_json::to_value(TaskQueueState::ConfirmingIdle).unwrap(),
        "confirmingIdle"
    );
    assert_eq!(
        serde_json::to_value(TaskQueueReason::GlobalDisabled).unwrap(),
        "globalDisabled"
    );
    assert_eq!(
        serde_json::to_value(QueueItemState::DeliveryUnknown).unwrap(),
        "deliveryUnknown"
    );
}

#[test]
fn task_queue_draft_rejects_empty_and_oversized_text() {
    assert!(TaskQueueItemDraft::new("  ", vec![]).is_err());
    assert!(TaskQueueItemDraft::new("x".repeat(65_537), vec![]).is_err());
    assert!(TaskQueueItemDraft::new("", vec!["img-1".into()]).is_ok());
}
