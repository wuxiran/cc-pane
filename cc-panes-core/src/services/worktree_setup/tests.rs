use super::*;
use std::process::Command;

fn config(setup: &[&str]) -> WorktreeSetupConfig {
    WorktreeSetupConfig {
        setup: setup.iter().map(|item| item.to_string()).collect(),
        ..WorktreeSetupConfig::default()
    }
}

#[test]
fn parses_all_fields_and_ignores_unknown_keys() {
    let parsed = parse_worktree_setup_config(
        r#"{
            "$schema": "x",
            "setup": ["  npm ci ", "", "npm run build"],
            "copyFiles": [".env", "config/local.json"],
            "sparseCheckout": ["web", "src-tauri"]
        }"#,
    )
    .unwrap();
    assert_eq!(parsed.setup, vec!["npm ci", "npm run build"]);
    assert_eq!(parsed.copy_files, vec![".env", "config/local.json"]);
    assert_eq!(parsed.sparse_checkout, vec!["web", "src-tauri"]);
}

#[test]
fn missing_fields_default_to_empty() {
    let parsed = parse_worktree_setup_config("{}").unwrap();
    assert_eq!(parsed, WorktreeSetupConfig::default());
}

#[test]
fn rejects_multiline_commands_and_bad_json() {
    assert!(parse_worktree_setup_config(r#"{"setup":["npm ci\nrm -rf /"]}"#).is_err());
    assert!(parse_worktree_setup_config(r#"{"setup":"npm ci"}"#).is_err());
    assert!(parse_worktree_setup_config("not json").is_err());
}

#[test]
fn rejects_paths_outside_the_repository() {
    for bad in ["../secret", "/etc/passwd", "C:/x", "a/../../b", "-x", "."] {
        let raw = format!(r#"{{"copyFiles":["{bad}"]}}"#);
        assert!(
            parse_worktree_setup_config(&raw).is_err(),
            "{bad} should be rejected"
        );
        let raw = format!(r#"{{"sparseCheckout":["{bad}"]}}"#);
        assert!(
            parse_worktree_setup_config(&raw).is_err(),
            "{bad} should be rejected"
        );
    }
    assert!(validate_relative_path("./config/.env").is_ok());
}

#[test]
fn hash_is_stable_and_changes_with_content() {
    let a = worktree_setup_config_hash(&config(&["npm ci"]));
    assert_eq!(a, worktree_setup_config_hash(&config(&["npm ci"])));
    assert_eq!(a.len(), 64);
    assert_ne!(a, worktree_setup_config_hash(&config(&["npm install"])));
    let mut with_copy = config(&["npm ci"]);
    with_copy.copy_files.push(".env".into());
    assert_ne!(a, worktree_setup_config_hash(&with_copy));
    // 解析时的空白归一化不影响 hash
    let parsed = parse_worktree_setup_config(r#"{"setup":["  npm ci  "]}"#).unwrap();
    assert_eq!(a, worktree_setup_config_hash(&parsed));
}

#[test]
fn command_line_joins_per_platform() {
    let commands = vec!["npm ci".to_string(), "npm run build".to_string()];
    assert_eq!(
        setup_command_line(&commands, false),
        "npm ci && npm run build"
    );
    assert_eq!(setup_command_line(&commands, true), "npm ci; npm run build");
    assert_eq!(setup_command_line(&[], false), "");
}

#[test]
fn approval_is_scoped_to_project_and_hash() {
    let mut approvals = WorktreeSetupApprovals::default();
    assert!(!approvals.is_approved("/repo", "h1"));
    approvals.approve("/repo", "h1", 1);
    assert!(approvals.is_approved("/repo", "h1"));
    assert!(approvals.is_approved("/repo/", "h1"));
    assert!(!approvals.is_approved("/repo", "h2"));
    assert!(!approvals.is_approved("/other", "h1"));
    assert!(!approvals.is_approved("/repo", ""));
    // 新批准替换旧 hash：配置改过之后旧批准不再生效
    approvals.approve("/repo", "h2", 2);
    assert!(!approvals.is_approved("/repo", "h1"));
    assert!(approvals.is_approved("/repo", "h2"));
}

#[test]
fn service_persists_approvals_and_validates_hash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("approvals.json");
    let service = WorktreeSetupService::new(path.clone());
    let hash = worktree_setup_config_hash(&config(&["npm ci"]));
    assert!(service.approve("/repo", "not-a-hash").is_err());
    assert!(!service.is_approved("/repo", &hash));
    service.approve("/repo", &hash).unwrap();
    let reopened = WorktreeSetupService::new(path);
    assert!(reopened.is_approved("/repo", &hash));
}

#[test]
fn corrupt_approval_file_means_not_approved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("approvals.json");
    std::fs::write(&path, "{broken").unwrap();
    let service = WorktreeSetupService::new(path);
    assert!(!service.is_approved("/repo", "abc"));
}

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// 主树里提交 worktree.json，留一个未跟踪的 `.env`，再建一个 worktree。
fn repo_with_worktree(config_json: &str) -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
    let dir = tempfile::tempdir().unwrap();
    let repo = dunce::canonicalize(dir.path()).unwrap().join("repo");
    std::fs::create_dir_all(repo.join(".ccpanes")).unwrap();
    if !git(&repo, &["init", "-q", "-b", "main"]) {
        return None;
    }
    std::fs::write(repo.join(".ccpanes").join(WORKTREE_SETUP_FILE), config_json).unwrap();
    std::fs::write(repo.join(".gitignore"), ".env\n").unwrap();
    std::fs::write(repo.join(".env"), "SECRET=1").unwrap();
    let committed = git(&repo, &["add", "."])
        && git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
    if !committed {
        return None;
    }
    let worktree = WorktreeService::new()
        .add_worktree(repo.to_str().unwrap(), "wt", Some("wt"))
        .ok()?;
    Some((dir, repo, PathBuf::from(worktree)))
}

#[test]
fn prepare_copies_untracked_files_and_reports_approval() {
    let Some((dir, repo, worktree)) =
        repo_with_worktree(r#"{"setup":["echo hi"],"copyFiles":[".env",".env.local"]}"#)
    else {
        eprintln!("git unavailable, skipping");
        return;
    };
    let service = WorktreeSetupService::new(dir.path().join("approvals.json"));
    let plan = service
        .prepare(worktree.to_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(plan.setup, vec!["echo hi"]);
    assert_eq!(plan.copied_files, vec![".env"]);
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    assert!(!plan.always_allowed);
    assert!(paths_equivalent(&plan.project_path, &repo));
    assert_eq!(
        std::fs::read_to_string(worktree.join(".env")).unwrap(),
        "SECRET=1"
    );

    service
        .approve(&plan.project_path, &plan.config_hash)
        .unwrap();
    // 第二次 prepare：`.env` 已存在不覆盖（给出提示），批准记录生效
    let again = service
        .prepare(worktree.to_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(again.always_allowed);
    assert!(again.copied_files.is_empty());
    assert_eq!(again.warnings.len(), 1);
}

#[test]
fn prepare_rejects_the_main_worktree() {
    let Some((dir, repo, _worktree)) = repo_with_worktree(r#"{"setup":["echo hi"]}"#) else {
        eprintln!("git unavailable, skipping");
        return;
    };
    let service = WorktreeSetupService::new(dir.path().join("approvals.json"));
    assert!(service.prepare(repo.to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn copy_skips_symlinks_that_escape_the_repository() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let main = root.join("main");
    let worktree = root.join("wt");
    std::fs::create_dir_all(&main).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(root.join("outside"), "x").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), main.join("link")).unwrap();
    std::fs::create_dir_all(main.join("dir/sub")).unwrap();
    std::fs::write(main.join("dir/sub/a.txt"), "a").unwrap();
    let outcome = apply_copy_files(&main, &worktree, &["link".into(), "dir".into()]);
    assert_eq!(outcome.copied, vec!["dir"]);
    assert_eq!(outcome.warnings.len(), 1);
    assert!(!worktree.join("link").exists());
    assert!(worktree.join("dir/sub/a.txt").exists());
}
