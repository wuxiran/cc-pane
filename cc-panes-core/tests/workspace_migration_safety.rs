use cc_panes_core::models::{WorkspaceMigrationRequest, WorkspaceMigrationTargetKind};
use cc_panes_core::services::WorkspaceService;

#[cfg(unix)]
#[test]
fn preview_and_execution_reject_target_reached_through_source_symlink() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let alias = root.path().join("alias");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("keep.txt"), "unchanged").unwrap();
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    let service = WorkspaceService::new(root.path().join("registry"));
    service
        .create_workspace("safe", Some(source.to_str().unwrap()))
        .unwrap();
    let request = WorkspaceMigrationRequest {
        workspace_name: "safe".to_string(),
        target_kind: WorkspaceMigrationTargetKind::Local,
        target_root: alias.join("nested/deep").to_string_lossy().into_owned(),
        target_distro: None,
    };
    assert!(service
        .preview_workspace_migration(&request)
        .unwrap_err()
        .contains("inside"));
    assert!(service
        .execute_workspace_migration(&request)
        .unwrap_err()
        .contains("inside"));
    assert!(!source.join("nested").exists());
    assert_eq!(
        std::fs::read_to_string(source.join("keep.txt")).unwrap(),
        "unchanged"
    );
}

#[test]
fn sibling_migration_keeps_nested_project_layout() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    let project = source.join("Backend");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("main.txt"), "payload").unwrap();
    let service = WorkspaceService::new(root.path().join("registry"));
    service
        .create_workspace("safe", Some(source.to_str().unwrap()))
        .unwrap();
    service
        .add_project("safe", project.to_str().unwrap())
        .unwrap();
    let result = service
        .execute_workspace_migration(&WorkspaceMigrationRequest {
            workspace_name: "safe".to_string(),
            target_kind: WorkspaceMigrationTargetKind::Local,
            target_root: target.to_string_lossy().into_owned(),
            target_distro: None,
        })
        .unwrap();
    assert_eq!(
        result.plan.items[0].relative_path.as_deref(),
        Some("Backend")
    );
    assert_eq!(
        std::fs::read_to_string(target.join("Backend/main.txt")).unwrap(),
        "payload"
    );
    assert!(!target.join("main.txt").exists());
}

#[cfg(unix)]
#[test]
fn execution_rechecks_an_alias_changed_after_preview() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let outside = root.path().join("outside");
    let alias = root.path().join("alias");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &alias).unwrap();
    let service = WorkspaceService::new(root.path().join("registry"));
    service
        .create_workspace("safe", Some(source.to_str().unwrap()))
        .unwrap();
    let request = WorkspaceMigrationRequest {
        workspace_name: "safe".to_string(),
        target_kind: WorkspaceMigrationTargetKind::Local,
        target_root: alias.join("new").to_string_lossy().into_owned(),
        target_distro: None,
    };
    service.preview_workspace_migration(&request).unwrap();
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    assert!(service
        .execute_workspace_migration(&request)
        .unwrap_err()
        .contains("inside"));
    assert!(!source.join("new").exists());
}

#[cfg(windows)]
#[test]
fn windows_migration_preserves_suffix_when_registered_case_differs() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("Repo");
    let project = source.join("Backend");
    let target = root.path().join("target");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("main.txt"), "payload").unwrap();
    let service = WorkspaceService::new(root.path().join("registry"));
    service
        .create_workspace("safe", Some(source.to_str().unwrap()))
        .unwrap();
    service
        .add_project("safe", &project.to_string_lossy().to_ascii_lowercase())
        .unwrap();
    let result = service
        .execute_workspace_migration(&WorkspaceMigrationRequest {
            workspace_name: "safe".to_string(),
            target_kind: WorkspaceMigrationTargetKind::Local,
            target_root: target.to_string_lossy().into_owned(),
            target_distro: None,
        })
        .unwrap();
    assert_eq!(
        result.plan.items[0].relative_path.as_deref(),
        Some("backend")
    );
    assert!(target.join("backend/main.txt").is_file());
    assert!(!target.join("main.txt").exists());
}
