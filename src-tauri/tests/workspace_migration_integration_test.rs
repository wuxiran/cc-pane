use cc_panes_lib::models::{ProjectMigrationRequest, WorkspaceMigrationRequest};
use cc_panes_lib::services::WorkspaceService;
use std::fs;
use std::path::{Path, PathBuf};

fn create_dir(path: &Path) {
    fs::create_dir_all(path).expect("failed to create directory");
}

fn write_file(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create parent directory");
    }
    fs::write(path, content).expect("failed to write file");
}

fn setup() -> (
    tempfile::TempDir,
    WorkspaceService,
    PathBuf,
    PathBuf,
    PathBuf,
) {
    let temp = tempfile::tempdir().expect("failed to create tempdir");
    let workspaces_dir = temp.path().join("workspaces");
    let workspace_root = temp.path().join("workspace-root");
    let external_root = temp.path().join("outside-lib");
    let target_root = temp.path().join("migrated-root");

    create_dir(&workspace_root.join("app/src"));
    create_dir(&workspace_root.join("app/.git"));
    create_dir(&workspace_root.join("app/node_modules/pkg"));
    create_dir(&workspace_root.join(".ccpanes"));
    create_dir(&external_root.join("src"));

    write_file(&workspace_root.join("CLAUDE.md"), "# Workspace");
    write_file(
        &workspace_root.join("app/src/index.ts"),
        "console.log('app');",
    );
    write_file(
        &workspace_root.join("app/.git/HEAD"),
        "ref: refs/heads/main\n",
    );
    write_file(
        &workspace_root.join("app/node_modules/pkg/skip.txt"),
        "ignored",
    );
    write_file(
        &workspace_root.join(".ccpanes/projects.csv"),
        "path,alias,branch,status\n",
    );
    write_file(
        &external_root.join("src/lib.ts"),
        "export const lib = true;\n",
    );

    let service = WorkspaceService::new(workspaces_dir);
    let workspace = service
        .create_workspace(
            "migration-test",
            Some(workspace_root.to_string_lossy().as_ref()),
        )
        .expect("failed to create workspace");
    service
        .add_project(
            &workspace.name,
            workspace_root.join("app").to_string_lossy().as_ref(),
        )
        .expect("failed to add internal project");
    service
        .add_project(&workspace.name, external_root.to_string_lossy().as_ref())
        .expect("failed to add external project");

    (temp, service, workspace_root, external_root, target_root)
}

fn get_project_id_by_path(
    service: &WorkspaceService,
    workspace_name: &str,
    project_path: &Path,
) -> String {
    service
        .get_workspace(workspace_name)
        .expect("workspace should exist")
        .projects
        .into_iter()
        .find(|project| project.path == project_path.to_string_lossy())
        .map(|project| project.id)
        .expect("project should exist")
}

#[test]
fn preview_workspace_migration_builds_internal_and_external_paths() {
    let (_temp, service, workspace_root, _external_root, target_root) = setup();

    let plan = service
        .preview_workspace_migration(&WorkspaceMigrationRequest {
            workspace_name: "migration-test".into(),
            target_kind: cc_panes_lib::models::WorkspaceMigrationTargetKind::Local,
            target_root: target_root.to_string_lossy().to_string(),
            target_distro: None,
        })
        .expect("preview should succeed");

    assert_eq!(plan.workspace_name, "migration-test");
    assert_eq!(plan.source_root, workspace_root.to_string_lossy());
    assert_eq!(plan.items.len(), 2);
    assert!(plan
        .items
        .iter()
        .any(|item| item.destination_path.ends_with("migrated-root\\app")
            || item.destination_path.ends_with("migrated-root/app")));
    assert!(plan.items.iter().any(|item| item.external));
}

#[test]
fn execute_workspace_migration_copies_files_and_rolls_back() {
    let (_temp, service, workspace_root, external_root, target_root) = setup();

    let result = service
        .execute_workspace_migration(&WorkspaceMigrationRequest {
            workspace_name: "migration-test".into(),
            target_kind: cc_panes_lib::models::WorkspaceMigrationTargetKind::Local,
            target_root: target_root.to_string_lossy().to_string(),
            target_distro: None,
        })
        .expect("migration should succeed");

    let target_workspace_file = target_root.join("CLAUDE.md");
    let target_internal_file = target_root.join("app").join("src").join("index.ts");
    let target_external_file = target_root
        .join("externals")
        .join("outside-lib")
        .join("src")
        .join("lib.ts");
    let skipped_file = target_root
        .join("app")
        .join("node_modules")
        .join("pkg")
        .join("skip.txt");

    assert!(target_workspace_file.exists());
    assert!(target_internal_file.exists());
    assert!(target_external_file.exists());
    assert!(!skipped_file.exists());

    let migrated_workspace = service
        .get_workspace("migration-test")
        .expect("workspace should load after migration");
    assert_eq!(
        migrated_workspace.path,
        Some(target_root.to_string_lossy().to_string())
    );
    let expected_internal_path = target_root.join("app").to_string_lossy().to_string();
    let expected_external_path = target_root
        .join("externals")
        .join("outside-lib")
        .to_string_lossy()
        .to_string();

    assert!(migrated_workspace
        .projects
        .iter()
        .any(|project| project.path == expected_internal_path));
    let migrated_paths: Vec<String> = migrated_workspace
        .projects
        .iter()
        .map(|project| project.path.clone())
        .collect();
    assert!(
        migrated_workspace
            .projects
            .iter()
            .any(|project| { project.path == expected_external_path }),
        "unexpected migrated project paths: {:?}",
        migrated_paths
    );

    let rollback = service
        .rollback_workspace_migration("migration-test", &result.snapshot_id)
        .expect("rollback should succeed");
    assert_eq!(
        rollback.workspace.path,
        Some(workspace_root.to_string_lossy().to_string())
    );
    assert!(rollback
        .workspace
        .projects
        .iter()
        .any(|project| project.path == workspace_root.join("app").to_string_lossy()));
    assert!(rollback
        .workspace
        .projects
        .iter()
        .any(|project| project.path == external_root.to_string_lossy()));
}

#[test]
fn preview_workspace_migration_rejects_non_empty_target() {
    let (_temp, service, _workspace_root, _external_root, target_root) = setup();
    create_dir(&target_root);
    write_file(&target_root.join("existing.txt"), "occupied");

    let error = service
        .preview_workspace_migration(&WorkspaceMigrationRequest {
            workspace_name: "migration-test".into(),
            target_kind: cc_panes_lib::models::WorkspaceMigrationTargetKind::Local,
            target_root: target_root.to_string_lossy().to_string(),
            target_distro: None,
        })
        .expect_err("preview should reject non-empty target");

    assert!(error.contains("must be empty"));
}

#[test]
fn execute_project_migration_copies_files_and_rolls_back_metadata() {
    let (_temp, service, workspace_root, external_root, target_root) = setup();
    let project_path = workspace_root.join("app");
    let project_id = get_project_id_by_path(&service, "migration-test", &project_path);

    let result = service
        .execute_project_migration(&ProjectMigrationRequest {
            workspace_name: "migration-test".into(),
            project_id: project_id.clone(),
            target_kind: cc_panes_lib::models::WorkspaceMigrationTargetKind::Local,
            target_root: target_root.to_string_lossy().to_string(),
            target_distro: None,
        })
        .expect("project migration should succeed");

    let migrated_file = target_root.join("src").join("index.ts");
    let skipped_file = target_root
        .join("node_modules")
        .join("pkg")
        .join("skip.txt");
    assert!(migrated_file.exists());
    assert!(!skipped_file.exists());

    let migrated_workspace = service
        .get_workspace("migration-test")
        .expect("workspace should load after project migration");
    let migrated_project = migrated_workspace
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .expect("migrated project should exist");
    let untouched_external = migrated_workspace
        .projects
        .iter()
        .find(|project| project.path == external_root.to_string_lossy())
        .expect("external project should remain untouched");

    assert_eq!(migrated_project.path, target_root.to_string_lossy());
    assert!(migrated_project.wsl_remote_path.is_none());
    assert_eq!(
        migrated_workspace.path,
        Some(workspace_root.to_string_lossy().to_string())
    );
    assert_eq!(untouched_external.path, external_root.to_string_lossy());

    let rollback = service
        .rollback_project_migration("migration-test", &result.snapshot_id)
        .expect("project migration rollback should succeed");
    let rolled_back_project = rollback
        .workspace
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .expect("rolled back project should exist");

    assert_eq!(rolled_back_project.path, project_path.to_string_lossy());
    assert!(rolled_back_project.wsl_remote_path.is_none());
    assert!(migrated_file.exists());
}

#[test]
fn preview_project_migration_rejects_non_empty_target() {
    let (_temp, service, workspace_root, _external_root, target_root) = setup();
    let project_id =
        get_project_id_by_path(&service, "migration-test", &workspace_root.join("app"));
    create_dir(&target_root);
    write_file(&target_root.join("existing.txt"), "occupied");

    let error = service
        .preview_project_migration(&ProjectMigrationRequest {
            workspace_name: "migration-test".into(),
            project_id,
            target_kind: cc_panes_lib::models::WorkspaceMigrationTargetKind::Local,
            target_root: target_root.to_string_lossy().to_string(),
            target_distro: None,
        })
        .expect_err("project migration preview should reject non-empty target");

    assert!(error.contains("must be empty"));
}
