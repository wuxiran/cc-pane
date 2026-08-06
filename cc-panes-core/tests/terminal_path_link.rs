use cc_panes_core::services::{resolve_terminal_path_link, TerminalLinkContext, TerminalPathKind};

fn context(root: &std::path::Path, runtime_kind: &str) -> TerminalLinkContext {
    TerminalLinkContext {
        project_path: root.to_string_lossy().to_string(),
        runtime_kind: runtime_kind.to_string(),
    }
}

fn assert_error_code(
    result: cc_panes_core::utils::AppResult<impl std::fmt::Debug>,
    expected: &str,
) {
    let error = result.expect_err("expected terminal path resolution to fail");
    assert_eq!(error.code(), Some(expected), "unexpected error: {error}");
}

#[test]
fn terminal_path_link_resolves_project_files_and_directories() {
    let root = tempfile::tempdir().expect("project root");
    let docs = root.path().join("docs");
    let file = docs.join("report.md");
    std::fs::create_dir_all(&docs).expect("docs dir");
    std::fs::write(&file, "report").expect("report file");
    let ctx = context(root.path(), "local");

    let relative = resolve_terminal_path_link(&ctx, "docs/report.md").expect("relative file");
    assert_eq!(relative.kind, TerminalPathKind::File);
    assert_eq!(
        std::path::PathBuf::from(relative.canonical_path),
        dunce::canonicalize(&file).expect("canonical file")
    );

    let absolute =
        resolve_terminal_path_link(&ctx, &file.to_string_lossy()).expect("absolute file");
    assert_eq!(absolute.kind, TerminalPathKind::File);

    let directory = resolve_terminal_path_link(&ctx, "docs").expect("directory");
    assert_eq!(directory.kind, TerminalPathKind::Directory);
}

#[test]
fn terminal_path_link_rejects_absolute_and_parent_escapes() {
    let parent = tempfile::tempdir().expect("parent");
    let root = parent.path().join("project");
    let outside = parent.path().join("outside.md");
    std::fs::create_dir_all(&root).expect("project root");
    std::fs::write(&outside, "outside").expect("outside file");
    let ctx = context(&root, "local");

    assert_error_code(
        resolve_terminal_path_link(&ctx, &outside.to_string_lossy()),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    assert_error_code(
        resolve_terminal_path_link(&ctx, "../outside.md"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
}

#[test]
fn terminal_path_link_rejects_missing_ssh_and_malformed_inputs() {
    let root = tempfile::tempdir().expect("project root");
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), "missing.md"),
        "TERMINAL_PATH_UNAVAILABLE",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "ssh"), "src/main.rs"),
        "TERMINAL_PATH_REMOTE_UNSUPPORTED",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), "javascript:alert(1)"),
        "TERMINAL_PATH_INVALID",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), "bad\0path"),
        "TERMINAL_PATH_INVALID",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), "src/\u{202e}secret.rs"),
        "TERMINAL_PATH_INVALID",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), "src/\u{061c}secret.rs"),
        "TERMINAL_PATH_INVALID",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "unknown"), "src/main.rs"),
        "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
    );
    assert_error_code(
        resolve_terminal_path_link(&context(root.path(), "local"), &"a".repeat(8 * 1024 + 1)),
        "TERMINAL_PATH_INVALID",
    );
    assert_error_code(
        resolve_terminal_path_link(
            &TerminalLinkContext {
                project_path: root
                    .path()
                    .join("missing-root")
                    .to_string_lossy()
                    .to_string(),
                runtime_kind: "local".to_string(),
            },
            "src/main.rs",
        ),
        "TERMINAL_PATH_CONTEXT_UNAVAILABLE",
    );
}

#[test]
fn terminal_path_link_resolves_wsl_relative_paths_from_the_host_root() {
    let root = tempfile::tempdir().expect("project root");
    let file = root.path().join("src").join("main.rs");
    std::fs::create_dir_all(file.parent().expect("src parent")).expect("src dir");
    std::fs::write(&file, "fn main() {}").expect("source file");

    let resolved = resolve_terminal_path_link(&context(root.path(), "wsl"), "src/main.rs")
        .expect("host-resolvable WSL relative path");

    assert_eq!(resolved.kind, TerminalPathKind::File);
    assert_eq!(resolved.runtime_kind, "wsl");
}

#[cfg(unix)]
#[test]
fn terminal_path_link_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let parent = tempfile::tempdir().expect("parent");
    let root = parent.path().join("project");
    let outside = parent.path().join("outside.md");
    std::fs::create_dir_all(&root).expect("project root");
    std::fs::write(&outside, "outside").expect("outside file");
    symlink(&outside, root.join("linked.md")).expect("symlink");

    assert_error_code(
        resolve_terminal_path_link(&context(&root, "local"), "linked.md"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );

    let outside_dir = parent.path().join("outside-dir");
    std::fs::create_dir_all(&outside_dir).expect("outside dir");
    symlink(&outside_dir, root.join("linked-dir")).expect("directory symlink");
    assert_error_code(
        resolve_terminal_path_link(&context(&root, "local"), "linked-dir"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
}

/// 回归：绝对路径输入可能是与规范形不同的拼写（8.3 短名、大小写变体——
/// GitHub runner 的 TEMP 就是 `RUNNER~1` 短名）。包含性判定必须在
/// canonicalize 之后做，原始字符串对比会把项目内文件误判为出界。
#[cfg(windows)]
#[test]
fn terminal_path_link_accepts_absolute_spelling_variants() {
    let root = tempfile::tempdir().expect("project root");
    let file = root.path().join("docs").join("report.md");
    std::fs::create_dir_all(file.parent().unwrap()).expect("docs dir");
    std::fs::write(&file, "report").expect("report file");

    // 大小写变体：Windows 文件系统不区分大小写，canonicalize 会还原真实拼写
    let upper = file.to_string_lossy().to_uppercase();
    let resolved = resolve_terminal_path_link(&context(root.path(), "local"), &upper)
        .expect("case-variant absolute path resolves");
    assert_eq!(resolved.kind, TerminalPathKind::File);
}
