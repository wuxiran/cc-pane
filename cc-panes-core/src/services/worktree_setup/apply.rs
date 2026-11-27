//! 不执行命令的那两步：sparse-checkout 与拷贝未跟踪文件。两者都不需要批准，
//! 但都只在仓库内动手：源必须在主树内、目标必须落在新 worktree 内，符号链接一律跳过。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::utils::{output_with_timeout, GIT_CHECKOUT_TIMEOUT};

/// 已通过 `validate_relative_path` 的 cone 目录列表。
pub fn apply_sparse_checkout(worktree_root: &Path, patterns: &[String]) -> Result<(), String> {
    let mut args = vec![
        "sparse-checkout".to_string(),
        "set".to_string(),
        "--cone".to_string(),
    ];
    args.extend(patterns.iter().map(|pattern| pattern.replace('\\', "/")));
    let output = output_with_timeout(
        Command::new("git")
            .args(&args)
            .current_dir(worktree_root)
            .env("GIT_LFS_SKIP_SMUDGE", "1"),
        GIT_CHECKOUT_TIMEOUT,
    )
    .map_err(|error| format!("sparseCheckout: failed to run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "sparseCheckout failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CopyOutcome {
    pub copied: Vec<String>,
    pub warnings: Vec<String>,
}

/// 逐项从主树拷到新 worktree。不覆盖已存在的目标；缺源只提示不报错。
pub fn apply_copy_files(main_root: &Path, worktree_root: &Path, entries: &[String]) -> CopyOutcome {
    let mut outcome = CopyOutcome::default();
    let (Ok(main_canonical), Ok(worktree_canonical)) = (
        dunce::canonicalize(main_root),
        dunce::canonicalize(worktree_root),
    ) else {
        outcome
            .warnings
            .push("copyFiles: repository roots are not accessible".into());
        return outcome;
    };
    for entry in entries {
        if let Err(error) = super::validate_relative_path(entry) {
            outcome
                .warnings
                .push(format!("copyFiles '{entry}': {error}"));
            continue;
        }
        match copy_entry(&main_canonical, &worktree_canonical, entry) {
            Ok(true) => outcome.copied.push(entry.clone()),
            Ok(false) => {}
            Err(error) => outcome
                .warnings
                .push(format!("copyFiles '{entry}': {error}")),
        }
    }
    outcome
}

/// Ok(true) = 拷了；Ok(false) = 源不存在（静默跳过，常见于可选的 `.env.local`）。
fn copy_entry(main_root: &Path, worktree_root: &Path, entry: &str) -> Result<bool, String> {
    let relative = PathBuf::from(entry.replace('\\', "/"));
    let source = main_root.join(&relative);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(false),
    };
    if metadata.file_type().is_symlink() {
        return Err("symlinks are not copied".into());
    }
    let source_canonical = dunce::canonicalize(&source).map_err(|error| error.to_string())?;
    if !source_canonical.starts_with(main_root) {
        return Err("source escapes the main worktree".into());
    }
    let target = worktree_root.join(&relative);
    if fs::symlink_metadata(&target).is_ok() {
        return Err("already exists in the new worktree".into());
    }
    let parent = target.parent().ok_or("invalid target")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent_canonical = dunce::canonicalize(parent).map_err(|error| error.to_string())?;
    if !parent_canonical.starts_with(worktree_root) {
        return Err("target escapes the new worktree".into());
    }
    if metadata.is_dir() {
        copy_dir(&source_canonical, &target)?;
    } else {
        fs::copy(&source_canonical, &target).map_err(|error| error.to_string())?;
    }
    Ok(true)
}

/// 递归拷目录：跳过符号链接，不覆盖已存在的文件。
fn copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if file_type.is_symlink() || fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        if file_type.is_dir() {
            copy_dir(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
