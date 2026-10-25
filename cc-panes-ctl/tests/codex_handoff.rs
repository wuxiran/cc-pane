use std::process::Command;

#[test]
fn desktop_dry_run_is_a_draft_without_starting_codex_or_needing_a_daemon() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace # & 中文");
    std::fs::create_dir(&cwd).unwrap();
    let file = root.path().join("task.txt");
    let prompt = "Review `literal` and $(never-run)\nDo not edit files. # ? & 中文";
    std::fs::write(&file, prompt).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_cc-panes-ctl"))
        .env("PATH", "")
        .args(["--json", "codex", "handoff", "--dry-run", "--cwd"])
        .arg(&cwd)
        .arg("--prompt-file")
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["target"], "codex-desktop");
    assert_eq!(result["status"], "draft_prepared");
    assert_eq!(result["submitted"], false);
    assert_eq!(result["openRequested"], false);
    let url = url::Url::parse(result["url"].as_str().unwrap()).unwrap();
    assert_eq!(url.host_str(), Some("new"));
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "prompt")
            .unwrap()
            .1,
        prompt
    );
}

#[test]
fn invalid_desktop_task_is_rejected_before_opening_an_app() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_cc-panes-ctl"))
        .args(["--json", "codex", "handoff", "--prompt", " ", "--cwd"])
        .arg(root.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
}
