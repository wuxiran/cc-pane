use cc_panes_core::models::task_queue::TaskQueueItemDraft;
use cc_panes_core::repository::{Database, TaskQueueRepository};
use cc_panes_core::services::TaskQueueService;
use std::sync::Arc;

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
