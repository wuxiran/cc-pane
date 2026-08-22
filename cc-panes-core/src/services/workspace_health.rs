//! 工作空间项目路径健康检查。
//!
//! worktree 被删除后，workspace.json 里的项目记录不会自动回收（`remove_worktree` 只跑 git，
//! `remove_project` 只删记录，两侧没有联动）。本模块提供批量存在性判定，供 UI 标记失效项目
//! 并让用户确认后批量清理。
//!
//! 判定结果是三态而非布尔：WSL 发行版未运行时无法区分「路径真没了」与「暂时看不到」，
//! 把这种情况判成 Missing 会诱导用户误删仍然有效的注册。

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::models::WorkspaceProject;
use crate::utils::{canonical_project_path, repair_persisted_project_path};

/// 项目路径的存在性判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathStatusKind {
    /// 路径存在且是目录。
    Present,
    /// 路径确定不存在，可安全清理。
    Missing,
    /// 无法验证（SSH 远程项目，或 WSL 发行版未运行）。默认不清理。
    Unverifiable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathStatus {
    pub project_id: String,
    pub path: String,
    pub status: PathStatusKind,
}

/// 批量判定一组项目的路径存在性。
pub fn check_project_paths(projects: &[WorkspaceProject]) -> Vec<ProjectPathStatus> {
    projects
        .iter()
        .map(|project| ProjectPathStatus {
            project_id: project.id.clone(),
            path: project.path.clone(),
            status: classify_path(&project.path, project.ssh.is_some()),
        })
        .collect()
}

/// 判定单条路径。
///
/// 必须先过 `canonical_project_path`：注册路径可能以 `/mnt/d/...` 或
/// `\\wsl.localhost\Ubuntu\mnt\d\...` 形式存起来，直接 `Path::exists()` 会把合法的
/// Windows 路径判成 missing。
pub fn classify_path(path: &str, is_ssh: bool) -> PathStatusKind {
    if is_ssh {
        return PathStatusKind::Unverifiable;
    }
    if path.trim().is_empty() {
        return PathStatusKind::Missing;
    }

    let canonical = canonical_project_path(path);
    // 规范化后仍是 WSL UNC = 发行版内的原生 Linux 路径。先检查发行版状态，避免
    // `repair_persisted_project_path` 内部的目录探测反向唤醒已停止的 WSL 虚拟机。
    if is_wsl_unc_path(&canonical) && !wsl_vm_running() {
        return PathStatusKind::Unverifiable;
    }

    // `canonical_project_path` 是跨 Windows/WSL 的身份键，不一定是当前宿主可访问的路径：
    // 在 Linux/WSL 上 `/mnt/d/repo` 会变成 `D:\\repo`。存在性探测必须使用宿主可用
    // 的持久化路径修复结果，否则会把整个挂载盘误标成 Missing。
    let probe_path = repair_persisted_project_path(path);
    if Path::new(&probe_path).is_dir() {
        return PathStatusKind::Present;
    }

    PathStatusKind::Missing
}

fn is_wsl_unc_path(path: &str) -> bool {
    let slash = path.replace('\\', "/").to_ascii_lowercase();
    slash.starts_with("//wsl.localhost/") || slash.starts_with("//wsl$/")
}

#[cfg(not(test))]
fn wsl_vm_running() -> bool {
    crate::services::wsl_discovery_service::is_wsl_vm_running()
}

// 测试里不去探测真实 WSL 状态：让 UNC 分支恒走 Unverifiable，判定逻辑本身才可断言。
#[cfg(test)]
fn wsl_vm_running() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::WorkspaceProject;

    fn project(id: &str, path: &str) -> WorkspaceProject {
        WorkspaceProject {
            id: id.to_string(),
            path: path.to_string(),
            alias: None,
            launch_profile_id: None,
            wsl_remote_path: None,
            ssh: None,
            archived_at: None,
        }
    }

    #[test]
    fn existing_directory_is_present() {
        let dir = std::env::temp_dir();
        assert_eq!(
            classify_path(dir.to_string_lossy().as_ref(), false),
            PathStatusKind::Present
        );
    }

    #[cfg(unix)]
    #[test]
    fn mounted_drive_path_uses_host_usable_probe_when_available() {
        let candidate = Path::new("/mnt/d");
        if !candidate.is_dir() {
            eprintln!("/mnt/d unavailable, skipping mounted-drive regression");
            return;
        }

        assert_eq!(classify_path("/mnt/d", false), PathStatusKind::Present);
    }

    #[test]
    fn missing_directory_is_missing() {
        let dir = std::env::temp_dir().join("cc-panes-health-does-not-exist-9e1f");
        assert_eq!(
            classify_path(dir.to_string_lossy().as_ref(), false),
            PathStatusKind::Missing
        );
    }

    #[test]
    fn ssh_project_is_unverifiable() {
        assert_eq!(
            classify_path("/home/dev/repo", true),
            PathStatusKind::Unverifiable
        );
    }

    #[test]
    fn empty_path_is_missing() {
        assert_eq!(classify_path("   ", false), PathStatusKind::Missing);
    }

    // 核心回归：/mnt/<drive> 与 WSL UNC 挂载形式必须先规范化再探测，否则合法路径被误判。
    #[cfg(windows)]
    #[test]
    fn mounted_drive_forms_resolve_to_windows_path() {
        let temp = std::env::temp_dir().join("cc-panes-health-mount-probe");
        std::fs::create_dir_all(&temp).unwrap();
        let windows_path = temp.to_string_lossy().replace('/', "\\");
        assert_eq!(
            classify_path(&windows_path, false),
            PathStatusKind::Present,
            "windows form must be present"
        );

        let drive = windows_path.chars().next().unwrap().to_ascii_lowercase();
        let tail = windows_path[2..].replace('\\', "/");
        let mnt_form = format!("/mnt/{drive}{tail}");
        assert_eq!(
            classify_path(&mnt_form, false),
            PathStatusKind::Present,
            "/mnt form must normalize back to the same directory"
        );

        let unc_form = format!(
            "\\\\wsl.localhost\\Ubuntu\\mnt\\{drive}{}",
            &windows_path[2..]
        );
        assert_eq!(
            classify_path(&unc_form, false),
            PathStatusKind::Present,
            "WSL UNC mount form must normalize back to the same directory"
        );

        std::fs::remove_dir_all(&temp).ok();
    }

    // 发行版未运行时，原生 Linux 路径不可判定——绝不能标成 Missing 诱导用户清理。
    #[test]
    fn wsl_native_path_is_unverifiable_when_vm_down() {
        assert_eq!(
            classify_path("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", false),
            PathStatusKind::Unverifiable
        );
    }

    #[test]
    fn check_project_paths_preserves_order_and_ids() {
        let missing = std::env::temp_dir().join("cc-panes-health-absent-4a2c");
        let projects = vec![
            project("a", std::env::temp_dir().to_string_lossy().as_ref()),
            project("b", missing.to_string_lossy().as_ref()),
        ];
        let statuses = check_project_paths(&projects);
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].project_id, "a");
        assert_eq!(statuses[0].status, PathStatusKind::Present);
        assert_eq!(statuses[1].project_id, "b");
        assert_eq!(statuses[1].status, PathStatusKind::Missing);
    }

    #[test]
    fn empty_workspace_yields_empty_statuses() {
        assert!(check_project_paths(&[]).is_empty());
    }
}
