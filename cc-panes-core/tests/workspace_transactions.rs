use cc_panes_core::services::WorkspaceService;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

#[test]
fn concurrent_updates_keep_every_success_and_readable_json() {
    let root = tempfile::tempdir().unwrap();
    let service = WorkspaceService::new(root.path().to_path_buf());
    service.create_workspace("race", None).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let tasks: Vec<_> = (0..8)
        .map(|index| {
            // Independent instances exercise the actual file lock, not a shared mutex.
            let service = WorkspaceService::new(root.path().to_path_buf());
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for item in 0..8 {
                    service.add_project("race", &format!("/fixture/{index}/{item}"))?;
                    service.get_workspace("race")?;
                }
                Ok::<_, String>(())
            })
        })
        .collect();
    for task in tasks {
        task.join().unwrap().unwrap();
    }
    assert_eq!(service.get_workspace("race").unwrap().projects.len(), 64);
}

#[test]
fn workspace_transactions_across_processes() {
    const CHILD_ROOT: &str = "CCPANES_WORKSPACE_TRANSACTION_TEST_ROOT";
    if let Ok(root) = std::env::var(CHILD_ROOT) {
        let root = Path::new(&root);
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.join("start").exists() {
            assert!(
                Instant::now() < deadline,
                "parent never released start barrier"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let service = WorkspaceService::new(root.to_path_buf());
        for index in 0..8 {
            service
                .add_project("race", &format!("/fixture/{}/{index}", std::process::id()))
                .unwrap();
        }
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let service = WorkspaceService::new(root.path().to_path_buf());
    service.create_workspace("race", None).unwrap();
    let mut children: Vec<_> = (0..4)
        .map(|_| {
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "workspace_transactions_across_processes"])
                .env(CHILD_ROOT, root.path())
                .spawn()
                .unwrap()
        })
        .collect();
    std::fs::write(root.path().join("start"), "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    for child in &mut children {
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("workspace subprocess timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    assert_eq!(service.get_workspace("race").unwrap().projects.len(), 32);
}

#[test]
fn failed_transaction_keeps_previous_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let service = WorkspaceService::new(root.path().to_path_buf());
    service.create_workspace("safe", None).unwrap();
    service.add_project("safe", "/fixture/original").unwrap();
    let result: Result<(), String> = service.update_workspace_with("safe", |workspace| {
        workspace.projects.clear();
        Err("validation failed".to_string())
    });
    assert!(result.is_err());
    assert_eq!(service.get_workspace("safe").unwrap().projects.len(), 1);
    service
        .update_workspace_alias("safe", Some("still writable"))
        .unwrap();
    assert_eq!(
        service.get_workspace("safe").unwrap().alias.as_deref(),
        Some("still writable")
    );
}

#[test]
fn stale_form_snapshot_cannot_erase_a_concurrent_project_addition() {
    let root = tempfile::tempdir().unwrap();
    let service = WorkspaceService::new(root.path().to_path_buf());
    let mut form = service.create_workspace("safe", None).unwrap();
    assert!(form.revision.is_some());
    service.add_project("safe", "/fixture/concurrent").unwrap();
    form.alias = Some("stale form".to_string());
    let error = service.save_workspace_snapshot("safe", &form).unwrap_err();
    assert!(error.starts_with("WORKSPACE_CHANGED:"));
    let current = service.get_workspace("safe").unwrap();
    assert_eq!(current.projects.len(), 1);
    assert_eq!(current.alias, None);
}

#[test]
fn successful_snapshot_save_returns_revision_for_the_next_edit() {
    let root = tempfile::tempdir().unwrap();
    let service = WorkspaceService::new(root.path().to_path_buf());
    let mut form = service.create_workspace("safe", None).unwrap();
    let original_revision = form.revision.clone();
    form.alias = Some("first".to_string());
    let mut saved = service.save_workspace_snapshot("safe", &form).unwrap();
    assert_ne!(saved.revision, original_revision);
    saved.alias = Some("second".to_string());
    let saved = service.save_workspace_snapshot("safe", &saved).unwrap();
    assert_eq!(saved.alias.as_deref(), Some("second"));
    let disk = std::fs::read_to_string(root.path().join("safe/workspace.json")).unwrap();
    assert!(
        !disk.contains("\"revision\""),
        "revision belongs to the transport snapshot"
    );
}
