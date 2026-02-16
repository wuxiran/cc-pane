//! Git 信息获取模块

#![allow(dead_code)]

use std::path::Path;
use std::process::Command;

/// 获取指定目录的当前 git 分支名
pub fn get_branch(project_path: &str) -> Option<String> {
    let path = Path::new(project_path);
    if !path.exists() {
        return None;
    }

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();
        if !branch.is_empty() {
            return Some(branch);
        }
    }
    None
}

/// 检查目录是否是 git 仓库
pub fn is_git_repo(project_path: &str) -> bool {
    let path = Path::new(project_path);
    if !path.exists() {
        return false;
    }

    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
