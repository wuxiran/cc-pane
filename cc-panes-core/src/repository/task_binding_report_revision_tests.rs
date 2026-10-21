#[test]
fn report_revision_ignores_ui_edits_and_identical_result_updates() {
    let repo = repo();
    repo.insert(&binding("worker", TaskBindingRole::Worker))
        .unwrap();
    let result = UpdateTaskBindingRequest {
        status: Some(TaskBindingStatus::Completed),
        completion_summary: Some("result".into()),
        exit_code: Some(0),
        ..Default::default()
    };
    repo.update("worker", &result).unwrap();
    let completed = repo.get("worker").unwrap().unwrap();
    assert_eq!(completed.report_revision, 1);
    repo.update(
        "worker",
        &UpdateTaskBindingRequest {
            title: Some("rename".into()),
            progress: Some(90),
            sort_order: Some(2),
            metadata: Some(
                serde_json::json!({"reportDropped":true,"ui":{"retryBindingId":"child"}}),
            ),
            ..Default::default()
        },
    )
    .unwrap();
    repo.update("worker", &result).unwrap();
    let after = repo.get("worker").unwrap().unwrap();
    assert_eq!(after.report_revision, completed.report_revision);
    assert_eq!(after.title, "rename");
    assert_eq!(after.progress, 90);
}

#[test]
fn report_revision_tracks_real_status_session_result_changes_and_attempt_resets() {
    let repo = repo();
    repo.insert(&binding("worker", TaskBindingRole::Worker))
        .unwrap();
    let changes = [
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Running),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            status: Some(TaskBindingStatus::Completed),
            completion_summary: Some("result".into()),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            completion_summary: Some("corrected result".into()),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            exit_code: Some(1),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            session_id: Some("replacement-pty".into()),
            ..Default::default()
        },
    ];
    for (index, change) in changes.iter().enumerate() {
        repo.update("worker", change).unwrap();
        assert_eq!(
            repo.get("worker").unwrap().unwrap().report_revision,
            index as i64 + 1
        );
    }
    for expected in [6, 7] {
        repo.update_with_result_reset("worker", &UpdateTaskBindingRequest::default(), true)
            .unwrap();
        let reset = repo.get("worker").unwrap().unwrap();
        assert_eq!(reset.report_revision, expected);
        assert!(reset.completion_summary.is_none());
        assert!(reset.exit_code.is_none());
    }
}

#[test]
fn report_revision_roundtrips_and_missing_json_field_remains_compatible() {
    let repo = repo();
    let mut original = binding("worker", TaskBindingRole::Worker);
    original.report_revision = 9;
    repo.insert(&original).unwrap();
    assert_eq!(repo.get("worker").unwrap().unwrap().report_revision, 9);
    let mut legacy = serde_json::to_value(original).unwrap();
    legacy.as_object_mut().unwrap().remove("reportRevision");
    let decoded: TaskBinding = serde_json::from_value(legacy).unwrap();
    assert_eq!(decoded.report_revision, 0);
}
