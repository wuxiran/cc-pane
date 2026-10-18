use cc_panes_core::models::task_queue::TaskQueueItemDraft;
use cc_panes_core::repository::{Database, TaskQueueRepository};
use cc_panes_core::services::{
    TaskQueueService, TASK_QUEUE_IMAGE_RETENTION, TASK_QUEUE_IMAGE_STORAGE_MAX_BYTES,
};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn service() -> (TaskQueueService, tempfile::TempDir, tempfile::TempDir) {
    let image_root = tempfile::tempdir().expect("image root");
    let trusted_root = tempfile::tempdir().expect("trusted root");
    let repository = Arc::new(TaskQueueRepository::new(Arc::new(
        Database::new_fallback().expect("database"),
    )));
    let service = TaskQueueService::new(
        repository,
        image_root.path().to_path_buf(),
        trusted_root.path().to_path_buf(),
    );
    (service, image_root, trusted_root)
}

#[test]
fn prompt_composition_preserves_image_order_and_single_separator() {
    assert_eq!(
        TaskQueueService::compose_prompt(&["a.png".into(), "b.webp".into()], "  compare  "),
        "a.png b.webp\ncompare"
    );
    assert_eq!(TaskQueueService::compose_prompt(&[], " task "), "task");
    assert_eq!(
        TaskQueueService::compose_prompt(&["a.png".into()], ""),
        "a.png"
    );
}

#[test]
fn staging_accepts_only_trusted_supported_regular_images() {
    let (service, _image_root, trusted_root) = service();
    let png = trusted_root.path().join("clipboard.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nimage").expect("png");
    let staged = service.stage_image("pty/1", &png, 10, 20).expect("stage");
    assert_eq!(staged.width, 10);
    assert_eq!(staged.height, 20);
    assert!(!staged.image_ref.contains('/') && !staged.image_ref.contains('\\'));

    let draft = TaskQueueItemDraft::new("compare", vec![staged.image_ref]).unwrap();
    let snapshot = service.add_item("pty/1", &draft, 1).expect("add");
    assert_eq!(snapshot.items[0].image_refs.len(), 1);

    let outside = tempfile::NamedTempFile::new().expect("outside");
    std::fs::write(outside.path(), b"\x89PNG\r\n\x1a\nimage").expect("outside image");
    assert_eq!(
        service
            .stage_image("pty/1", outside.path(), 1, 1)
            .unwrap_err()
            .code(),
        Some("IMAGE_REF_INVALID")
    );
}

#[test]
fn forged_refs_and_unsupported_formats_are_rejected() {
    let (service, _image_root, trusted_root) = service();
    let text = trusted_root.path().join("not-image.png");
    std::fs::write(&text, b"plain text").expect("text");
    assert_eq!(
        service.stage_image("pty", &text, 1, 1).unwrap_err().code(),
        Some("IMAGE_REF_INVALID")
    );
    let forged = TaskQueueItemDraft::new("task", vec!["../../secret.png".into()]).unwrap();
    assert_eq!(
        service.add_item("pty", &forged, 1).unwrap_err().code(),
        Some("IMAGE_REF_INVALID")
    );
}

#[test]
fn staged_ref_rejects_content_that_no_longer_matches_its_extension() {
    let (service, image_root, trusted_root) = service();
    let png = trusted_root.path().join("clipboard.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nimage").expect("png");
    let staged = service.stage_image("pty", &png, 1, 1).unwrap();
    let staged_path = std::fs::read_dir(image_root.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join(&staged.image_ref);
    std::fs::write(staged_path, b"RIFF0000WEBPpayload").unwrap();
    let draft = TaskQueueItemDraft::new("task", vec![staged.image_ref]).unwrap();
    assert_eq!(
        service.add_item("pty", &draft, 1).unwrap_err().code(),
        Some("IMAGE_REF_INVALID")
    );
}

fn stage_png(service: &TaskQueueService, source_root: &std::path::Path, session: &str) -> String {
    let png = source_root.join("clipboard.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nimage").unwrap();
    service.stage_image(session, &png, 1, 1).unwrap().image_ref
}

#[test]
fn completed_image_lease_survives_service_restart_and_expires_after_retention() {
    let (service, image_root, trusted_root) = service();
    let image_ref = stage_png(&service, trusted_root.path(), "pty");
    let path = service.resolve_image_ref("pty", &image_ref).unwrap();
    let draft = TaskQueueItemDraft::new("describe", vec![image_ref]).unwrap();
    service.add_item("pty", &draft, 1).unwrap();
    // A long-queued image must get a fresh retention period when it is finally submitted.
    let submitted_at = SystemTime::now();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(submitted_at - TASK_QUEUE_IMAGE_RETENTION * 2)
        .unwrap();
    let generation = service.repository().runtime().unwrap().dispatch_generation;
    let claim = service
        .repository()
        .claim_next("pty", generation, 2)
        .unwrap()
        .unwrap();
    service.effective_prompt("pty", &claim.item).unwrap();
    service
        .complete_claim("pty", &claim.item.id, &claim.token, 3)
        .unwrap();
    let restored = TaskQueueService::new(
        service.repository().clone(),
        image_root.path().to_owned(),
        trusted_root.path().to_owned(),
    );
    assert_eq!(
        restored
            .prune_unreferenced_images_at(submitted_at + Duration::from_secs(60))
            .unwrap(),
        0
    );
    assert!(
        path.exists(),
        "the CLI can still open the submitted file after app restart"
    );
    assert_eq!(
        restored
            .prune_unreferenced_images_at(
                submitted_at + TASK_QUEUE_IMAGE_RETENTION + Duration::from_secs(10)
            )
            .unwrap(),
        1
    );
    assert!(!path.exists());
    assert_eq!(restored.prune_unreferenced_images().unwrap(), 0);
}

#[test]
fn shared_queue_references_survive_cancellation_expiry_and_session_exit() {
    let (service, _image_root, trusted_root) = service();
    let image_ref = stage_png(&service, trusted_root.path(), "pty");
    let path = service.resolve_image_ref("pty", &image_ref).unwrap();
    let draft = TaskQueueItemDraft::new("describe", vec![image_ref]).unwrap();
    let first = service.add_item("pty", &draft, 1).unwrap().items[0]
        .id
        .clone();
    service.add_item("pty", &draft, 2).unwrap();
    service.delete_item("pty", &first, 3).unwrap();
    assert_eq!(service.release_session_images("pty").unwrap(), 0);
    assert_eq!(
        service
            .prune_unreferenced_images_at(SystemTime::now() + TASK_QUEUE_IMAGE_RETENTION * 2)
            .unwrap(),
        0
    );
    assert!(path.exists());
    service.clear_queue("pty", 4).unwrap();
    // Clear does not prove an uncertain submission was never consumed.
    assert!(path.exists());
    assert_eq!(service.release_session_images("pty").unwrap(), 1);
    assert!(!path.exists());
}

#[test]
fn session_exit_releases_completed_images_but_preserves_other_sessions() {
    let (service, _image_root, trusted_root) = service();
    let first = stage_png(&service, trusted_root.path(), "first");
    let second = stage_png(&service, trusted_root.path(), "second");
    let second_path = service.resolve_image_ref("second", &second).unwrap();
    assert_eq!(service.release_session_images("first").unwrap(), 1);
    assert!(service.resolve_image_ref("first", &first).is_err());
    assert!(second_path.exists());
    assert_eq!(service.release_session_images("first").unwrap(), 0);
}

#[test]
fn storage_limit_rejects_new_images_without_evicting_recent_files() {
    let (service, _image_root, trusted_root) = service();
    let image_ref = stage_png(&service, trusted_root.path(), "pty");
    let path = service.resolve_image_ref("pty", &image_ref).unwrap();
    // Sparse allocation exercises the quota without writing a GiB of test data.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(TASK_QUEUE_IMAGE_STORAGE_MAX_BYTES)
        .unwrap();
    let source = trusted_root.path().join("clipboard.png");
    let error = service.stage_image("another", &source, 1, 1).unwrap_err();
    assert_eq!(error.code(), Some("IMAGE_STAGE_FAILED"));
    assert!(error.message().contains("storage is full"));
    assert!(
        path.exists(),
        "the quota must not evict a potentially active attachment"
    );
}

#[test]
fn lease_refresh_does_not_modify_existing_linked_file_content() {
    let (service, _image_root, trusted_root) = service();
    let image_ref = stage_png(&service, trusted_root.path(), "pty");
    let path = service.resolve_image_ref("pty", &image_ref).unwrap();
    let protected = trusted_root.path().join("other-data");
    std::fs::write(&protected, b"keep this unchanged").unwrap();
    let lease = std::path::PathBuf::from(format!("{}.lease", path.display()));
    std::fs::hard_link(&protected, &lease).unwrap();
    let item = service
        .add_item(
            "pty",
            &TaskQueueItemDraft::new("describe", vec![image_ref]).unwrap(),
            1,
        )
        .unwrap()
        .items
        .remove(0);
    service.effective_prompt("pty", &item).unwrap();
    assert_eq!(std::fs::read(protected).unwrap(), b"keep this unchanged");
    assert_eq!(std::fs::read(lease).unwrap(), b"retained");
}
