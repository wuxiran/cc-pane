use cc_panes_core::services::{
    resolve_terminal_path_link, resolve_terminal_path_link_for_desktop, TerminalLinkContext,
    TerminalPathKind,
};

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
fn desktop_terminal_path_link_confirms_explicit_external_directories_only() {
    let parent = tempfile::tempdir().expect("parent");
    let root = parent.path().join("project");
    let outside_dir = parent.path().join("outside-dir");
    let outside_file = parent.path().join("outside.md");
    std::fs::create_dir_all(&root).expect("project root");
    std::fs::create_dir_all(&outside_dir).expect("outside directory");
    std::fs::write(&outside_file, "outside").expect("outside file");
    let ctx = context(&root, "local");

    let resolved = resolve_terminal_path_link_for_desktop(&ctx, &outside_dir.to_string_lossy())
        .expect("desktop should resolve an explicit external directory for confirmation");
    assert_eq!(resolved.kind, TerminalPathKind::Directory);
    assert_eq!(
        std::path::PathBuf::from(resolved.canonical_path),
        dunce::canonicalize(&outside_dir).expect("canonical outside directory")
    );

    assert_error_code(
        resolve_terminal_path_link(&ctx, &outside_dir.to_string_lossy()),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    assert_error_code(
        resolve_terminal_path_link_for_desktop(&ctx, "../outside-dir"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    assert_error_code(
        resolve_terminal_path_link_for_desktop(&ctx, &outside_file.to_string_lossy()),
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
    assert_error_code(
        resolve_terminal_path_link_for_desktop(
            &context(&root, "local"),
            &root.join("linked-dir").to_string_lossy(),
        ),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );

    // 别名绕过钉子：`..` 迂回别名与穿过 symlink 的下级目录。raw 文本与 canonical
    // root 做包含比较时，这两类都会被误判成「外部路径」从而降级成确认放行。
    let detour = parent.path().join("detour");
    std::fs::create_dir_all(&detour).expect("detour dir");
    assert_error_code(
        resolve_terminal_path_link_for_desktop(
            &context(&root, "local"),
            &detour.join("../project/linked-dir").to_string_lossy(),
        ),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    std::fs::create_dir_all(outside_dir.join("sub")).expect("outside sub dir");
    assert_error_code(
        resolve_terminal_path_link_for_desktop(
            &context(&root, "local"),
            &root.join("linked-dir/sub").to_string_lossy(),
        ),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
}

/// Windows 侧的逃逸面：junction（目录联结）。
///
/// Unix 的 symlink 逃逸已有对照用例，但 Windows 上建符号链接要开发者模式/提权，
/// 实际能落地的重定向是 **junction**——`mklink /J` 无需任何特权，任何跑得起
/// CC-Panes 的用户都能建。项目内一个 junction 指到项目外，点终端里的链接就能
/// 把工作区外的目录当成项目内容打开。防线在 canonicalize 之后的 path_is_within
/// 复核（junction 会被解引用），这条把它钉住。
#[cfg(windows)]
#[test]
fn terminal_path_link_rejects_junction_escape() {
    let parent = tempfile::tempdir().expect("parent");
    let root = parent.path().join("project");
    let outside_dir = parent.path().join("outside-dir");
    std::fs::create_dir_all(&root).expect("project root");
    std::fs::create_dir_all(&outside_dir).expect("outside dir");
    std::fs::write(outside_dir.join("secret.md"), "secret").expect("secret file");

    let link = root.join("linked-dir");
    // mklink 是 cmd 内建命令，必须经 `cmd /c`；/J 建 junction，无需提权。
    let status = std::process::Command::new("cmd")
        .args([
            "/c",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &outside_dir.to_string_lossy(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run mklink");
    assert!(status.success(), "mklink /J 应无需提权即可建 junction");

    assert_error_code(
        resolve_terminal_path_link(&context(&root, "local"), "linked-dir"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    // 穿过 junction 的下级路径同样必须被拦——只挡链接本身等于没挡。
    assert_error_code(
        resolve_terminal_path_link(&context(&root, "local"), "linked-dir/secret.md"),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    assert_error_code(
        resolve_terminal_path_link_for_desktop(&context(&root, "local"), &link.to_string_lossy()),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );

    // 别名绕过钉子（与 unix symlink 用例同款）：`..` 迂回别名与穿过 junction 的
    // 下级目录都必须硬拒，不得降级成外部目录确认。
    let detour = parent.path().join("detour");
    std::fs::create_dir_all(&detour).expect("detour dir");
    assert_error_code(
        resolve_terminal_path_link_for_desktop(
            &context(&root, "local"),
            &detour.join("..\\project\\linked-dir").to_string_lossy(),
        ),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
    std::fs::create_dir_all(outside_dir.join("sub")).expect("outside sub dir");
    assert_error_code(
        resolve_terminal_path_link_for_desktop(
            &context(&root, "local"),
            &root.join("linked-dir\\sub").to_string_lossy(),
        ),
        "TERMINAL_PATH_OUTSIDE_ROOT",
    );
}

/// 意图锁（钉住**故意**行为，非缺陷）：UNC / 设备命名空间绝对路径输入按
/// TERMINAL_PATH_INVALID 在语法层拒收，而不是 OUTSIDE_ROOT。
///
/// `has_invalid_windows_syntax` 在语法层砍掉 `\\.\` / `\\` 与非盘符形式的 `\\?\`
/// 前缀，早于任何 canonicalize 与包含性判定。代价是 WSL 项目的
/// `\\wsl.localhost\...` 绝对路径也进不来（相对路径仍可用，见上面的 wsl 用例）。
/// 这是权衡后的取舍：设备命名空间与 UNC 的等价形式太多，逐一规范化容易漏。
///
/// 0.12.1 复核记录：`\\?\C:\...` verbatim **盘符**形式已按本注释的要求放开——
/// 它的规范化是完整的（strip `\\?\` → canonicalize → 包含性复核，ADS 冒号仍拒），
/// 语法合法后由包含性判定接管，项目外报 OUTSIDE_ROOT（见下）。其余三类维持语法层拒收；
/// 再要放开任何一类，同样必须先补足等价形式的规范化，让本用例变红时来复核。
#[cfg(windows)]
#[test]
fn terminal_path_link_rejects_unc_absolute_input_by_syntax() {
    let root = tempfile::tempdir().expect("project root");
    let ctx = context(root.path(), "local");

    for raw in [
        r"\\wsl.localhost\Ubuntu\home\dev\repo\src\main.rs",
        r"\\server\share\file.md",
        r"\\.\PhysicalDrive0",
    ] {
        assert_error_code(
            resolve_terminal_path_link(&ctx, raw),
            "TERMINAL_PATH_INVALID",
        );
    }

    // verbatim 盘符形式语法合法，但项目外的目标要被包含性判定拦下。
    assert_error_code(
        resolve_terminal_path_link(&ctx, r"\\?\C:\Windows\System32\drivers\etc\hosts"),
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
