use cc_panes_core::models::{QuickCommandDraft, QuickCommandKind, QuickCommandTarget};
use cc_panes_core::services::QuickCommandService;

fn draft(name: &str) -> QuickCommandDraft {
    QuickCommandDraft {
        name: name.to_string(),
        kind: QuickCommandKind::Terminal,
        text: "cargo test".to_string(),
        append_enter: true,
        target: QuickCommandTarget::CurrentPane,
        cli_tool: None,
    }
}

#[test]
fn quick_command_global_json_round_trip_is_atomic() {
    let root = tempfile::tempdir().expect("temp dir");
    let config_path = root.path().join("quick-commands.json");
    let service = QuickCommandService::new(config_path.clone());

    let created = service
        .create_global(draft("Run tests"))
        .expect("create global command");
    assert_eq!(service.list_global(), vec![created.clone()]);

    let mut updated = draft("Run focused tests");
    updated.text = "cargo test quick_command".to_string();
    let updated = service
        .update_global(&created.id, updated)
        .expect("update global command");

    let reloaded = QuickCommandService::new(config_path);
    assert_eq!(reloaded.list_global(), vec![updated]);
    assert!(root
        .path()
        .read_dir()
        .expect("list root")
        .all(|entry| !entry
            .expect("directory entry")
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")));
}

#[test]
fn quick_command_project_json_stays_under_ccpanes_directory() {
    let root = tempfile::tempdir().expect("temp dir");
    let project = root.path().join("project");
    std::fs::create_dir_all(&project).expect("create project");
    let service = QuickCommandService::new(root.path().join("global.json"));

    let command = service
        .create_global(draft("Project tests"))
        .expect("build command");
    service
        .save_project(&project, vec![command.clone()])
        .expect("save project commands");

    let expected_path = project.join(".ccpanes").join("quick-commands.json");
    assert!(expected_path.is_file());
    assert_eq!(
        service
            .list_project(&project)
            .expect("list project commands"),
        vec![command]
    );
}

#[cfg(unix)]
#[test]
fn quick_command_project_rejects_symlinked_ccpanes_directory() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("temp dir");
    let project = root.path().join("project");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&project).expect("create project");
    std::fs::create_dir_all(&outside).expect("create outside");
    symlink(&outside, project.join(".ccpanes")).expect("create symlink");
    let service = QuickCommandService::new(root.path().join("global.json"));

    let error = service
        .save_project(&project, Vec::new())
        .expect_err("symlinked .ccpanes must be rejected");

    assert!(error.to_string().contains("symbolic link"));
    assert!(!outside.join("quick-commands.json").exists());
}
