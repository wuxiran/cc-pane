use crate::utils::{output_with_timeout, GIT_CHECKOUT_TIMEOUT, GIT_LOCAL_TIMEOUT};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// Worktree 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub commit: String,
    pub is_main: bool,
}

/// 判断两个路径是否指向同一位置（用于 is_main 比较）。
///
/// git worktree --porcelain 输出的是 git 规范形式（正斜杠、Windows 上盘符
/// 大小写可能与调用方不同），而 main_path 是调用方原样传入的。直接字符串
/// 相等会在 `D:/proj`(git) vs `d:\proj`(调用方) 时判不相等，导致主 worktree
/// 被误标 is_main=false。归一化分隔符后比较；Windows 路径大小写不敏感。
fn worktree_paths_equal(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();
    let (a, b) = (norm(a), norm(b));
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(&b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Worktree 服务 - 管理 Git Worktree
pub struct WorktreeService;

impl WorktreeService {
    pub fn new() -> Self {
        Self
    }

    /// 检查项目是否为 Git 仓库
    pub fn is_git_repo(&self, project_path: &str) -> bool {
        let git_dir = PathBuf::from(project_path).join(".git");
        git_dir.exists()
    }

    /// 列出所有 worktree
    pub fn list_worktrees(&self, project_path: &str) -> Result<Vec<WorktreeInfo>, String> {
        if !self.is_git_repo(project_path) {
            return Err("Not a Git repository".to_string());
        }

        let output = output_with_timeout(
            Command::new("git")
                .args(["worktree", "list", "--porcelain"])
                .current_dir(project_path),
            GIT_LOCAL_TIMEOUT,
        )
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree list failed: {}", stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        self.parse_worktree_list(&stdout, project_path)
    }

    /// 解析 worktree 列表输出
    fn parse_worktree_list(
        &self,
        output: &str,
        main_path: &str,
    ) -> Result<Vec<WorktreeInfo>, String> {
        let mut worktrees = Vec::new();
        let mut current_path = String::new();
        let mut current_commit = String::new();
        let mut current_branch = String::new();

        for line in output.lines() {
            if line.starts_with("worktree ") {
                current_path = line.strip_prefix("worktree ").unwrap_or("").to_string();
            } else if line.starts_with("HEAD ") {
                current_commit = line.strip_prefix("HEAD ").unwrap_or("").to_string();
            } else if line.starts_with("branch ") {
                current_branch = line
                    .strip_prefix("branch refs/heads/")
                    .unwrap_or(line.strip_prefix("branch ").unwrap_or(""))
                    .to_string();
            } else if line.is_empty() && !current_path.is_empty() {
                let is_main = worktree_paths_equal(&current_path, main_path);
                worktrees.push(WorktreeInfo {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    commit: current_commit.chars().take(7).collect(),
                    is_main,
                });
                current_path.clear();
                current_commit.clear();
                current_branch.clear();
            }
        }

        if !current_path.is_empty() {
            let is_main = worktree_paths_equal(&current_path, main_path);
            worktrees.push(WorktreeInfo {
                path: current_path,
                branch: current_branch,
                commit: current_commit.chars().take(7).collect(),
                is_main,
            });
        }

        Ok(worktrees)
    }

    /// 添加新的 worktree
    pub fn add_worktree(
        &self,
        project_path: &str,
        name: &str,
        branch: Option<&str>,
    ) -> Result<String, String> {
        // 验证 worktree 名称安全性
        crate::utils::validate_worktree_name(name).map_err(|e| e.to_string())?;

        if !self.is_git_repo(project_path) {
            return Err("Not a Git repository".to_string());
        }

        let project_dir = PathBuf::from(project_path);
        let parent_dir = project_dir
            .parent()
            .ok_or("Failed to get parent directory")?;

        let project_name = project_dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Failed to get project name")?;

        // 分组目录模式: {repo}-worktrees/{name}/
        let worktrees_dir = parent_dir.join(format!("{}-worktrees", project_name));
        if !worktrees_dir.exists() {
            std::fs::create_dir_all(&worktrees_dir)
                .map_err(|e| format!("Failed to create worktrees directory: {}", e))?;
        }
        let worktree_path = worktrees_dir.join(name);

        let worktree_path_str = worktree_path.to_string_lossy().to_string();

        let mut args = vec!["worktree".to_string(), "add".to_string()];

        if let Some(b) = branch {
            args.push("-b".to_string());
            args.push(b.to_string());
        }

        args.push(worktree_path_str.clone());

        let output = output_with_timeout(
            Command::new("git")
                .args(&args)
                .current_dir(project_path)
                .env("GIT_LFS_SKIP_SMUDGE", "1"),
            GIT_CHECKOUT_TIMEOUT,
        )
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to create worktree: {}", stderr));
        }

        Ok(worktree_path_str)
    }

    /// 删除 worktree
    pub fn remove_worktree(&self, project_path: &str, worktree_path: &str) -> Result<(), String> {
        if !self.is_git_repo(project_path) {
            return Err("Not a Git repository".to_string());
        }

        let output = output_with_timeout(
            Command::new("git")
                .args(["worktree", "remove", "--force", worktree_path])
                .current_dir(project_path),
            GIT_LOCAL_TIMEOUT,
        )
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to remove worktree: {}", stderr));
        }

        Ok(())
    }
}

impl Default for WorktreeService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- worktree_paths_equal ----------

    #[test]
    fn paths_equal_normalizes_separators() {
        assert!(worktree_paths_equal("D:/proj/app", "D:\\proj\\app"));
    }

    #[test]
    fn paths_equal_ignores_trailing_slash() {
        assert!(worktree_paths_equal("D:/proj/app/", "D:/proj/app"));
    }

    #[cfg(windows)]
    #[test]
    fn paths_equal_case_insensitive_on_windows() {
        assert!(worktree_paths_equal("d:/Proj/App", "D:/proj/app"));
    }

    #[cfg(not(windows))]
    #[test]
    fn paths_equal_case_sensitive_on_unix() {
        assert!(!worktree_paths_equal("/proj/App", "/proj/app"));
    }

    #[test]
    fn paths_equal_rejects_different_paths() {
        assert!(!worktree_paths_equal("D:/proj/a", "D:/proj/b"));
    }

    // ---------- parse_worktree_list ----------

    #[test]
    fn parse_multiple_worktrees_with_main_flag() {
        let output = "worktree D:/proj/app\n\
                      HEAD 1234567890abcdef\n\
                      branch refs/heads/main\n\
                      \n\
                      worktree D:/proj/app-worktrees/feat\n\
                      HEAD abcdef1234567890\n\
                      branch refs/heads/feature-x\n\
                      \n";
        let svc = WorktreeService::new();
        let list = svc
            .parse_worktree_list(output, "D:\\proj\\app")
            .expect("parse should succeed");

        assert_eq!(list.len(), 2);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch, "main");
        assert_eq!(list[0].commit, "1234567");
        assert!(!list[1].is_main);
        assert_eq!(list[1].branch, "feature-x");
        assert_eq!(list[1].path, "D:/proj/app-worktrees/feat");
    }

    #[test]
    fn parse_strips_refs_heads_prefix() {
        let output = "worktree /repo\nHEAD aaaaaaaabbbbbbbb\nbranch refs/heads/fix/bug-1\n\n";
        let svc = WorktreeService::new();
        let list = svc.parse_worktree_list(output, "/repo").unwrap();
        assert_eq!(list[0].branch, "fix/bug-1");
    }

    #[test]
    fn parse_detached_head_has_empty_branch() {
        let output = "worktree /repo/wt\nHEAD 9999999888888888\ndetached\n\n";
        let svc = WorktreeService::new();
        let list = svc.parse_worktree_list(output, "/repo").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].branch, "");
        assert!(!list[0].is_main);
    }

    #[test]
    fn parse_last_entry_without_trailing_blank_line() {
        let output = "worktree /repo\nHEAD 1234567890abcdef\nbranch refs/heads/main";
        let svc = WorktreeService::new();
        let list = svc.parse_worktree_list(output, "/repo").unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].is_main);
        assert_eq!(list[0].commit, "1234567");
    }

    #[test]
    fn parse_empty_output_returns_empty_list() {
        let svc = WorktreeService::new();
        let list = svc.parse_worktree_list("", "/repo").unwrap();
        assert!(list.is_empty());
    }

    // ---------- is_git_repo / 输入校验 ----------

    #[test]
    fn is_git_repo_false_for_plain_dir() {
        let dir = tempfile::tempdir().unwrap();
        let svc = WorktreeService::new();
        assert!(!svc.is_git_repo(dir.path().to_str().unwrap()));
    }

    #[test]
    fn is_git_repo_true_when_dot_git_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let svc = WorktreeService::new();
        assert!(svc.is_git_repo(dir.path().to_str().unwrap()));
    }

    #[test]
    fn list_worktrees_rejects_non_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let svc = WorktreeService::new();
        let err = svc
            .list_worktrees(dir.path().to_str().unwrap())
            .unwrap_err();
        assert_eq!(err, "Not a Git repository");
    }

    #[test]
    fn add_worktree_rejects_traversal_name_before_touching_fs() {
        // 名称校验在 is_git_repo 检查之前，非法名称应直接被拒
        let dir = tempfile::tempdir().unwrap();
        let svc = WorktreeService::new();
        for bad in ["../escape", "a/b", "a\\b", "", "   "] {
            assert!(
                svc.add_worktree(dir.path().to_str().unwrap(), bad, None)
                    .is_err(),
                "name {:?} should be rejected",
                bad
            );
        }
    }

    #[test]
    fn add_worktree_rejects_non_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let svc = WorktreeService::new();
        let err = svc
            .add_worktree(dir.path().to_str().unwrap(), "wt1", None)
            .unwrap_err();
        assert_eq!(err, "Not a Git repository");
    }

    #[test]
    fn remove_worktree_rejects_non_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let svc = WorktreeService::new();
        let err = svc
            .remove_worktree(dir.path().to_str().unwrap(), "whatever")
            .unwrap_err();
        assert_eq!(err, "Not a Git repository");
    }

    // ---------- 真实 git 集成 ----------

    /// 在临时目录初始化一个带一次提交的 git 仓库，返回 (tempdir, repo_path)。
    fn init_git_repo() -> Option<(tempfile::TempDir, String)> {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let repo_str = repo.to_string_lossy().to_string();

        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .ok()
                .filter(|o| o.status.success())
        };

        run(&["init", "-b", "main"])?;
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        run(&["add", "."])?;
        run(&[
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "init",
        ])?;
        Some((dir, repo_str))
    }

    #[test]
    fn add_list_remove_worktree_roundtrip() {
        let Some((_guard, repo)) = init_git_repo() else {
            eprintln!("git unavailable, skipping integration test");
            return;
        };
        let svc = WorktreeService::new();

        // 初始只有主 worktree
        let list = svc.list_worktrees(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch, "main");

        // 新建 worktree（-b 新分支），落在 {repo}-worktrees/{name}/
        let wt_path = svc.add_worktree(&repo, "feat1", Some("feat-1")).unwrap();
        assert!(wt_path.replace('\\', "/").contains("repo-worktrees/feat1"));
        assert!(PathBuf::from(&wt_path).exists());

        let list = svc.list_worktrees(&repo).unwrap();
        assert_eq!(list.len(), 2);
        let main_count = list.iter().filter(|w| w.is_main).count();
        assert_eq!(main_count, 1, "exactly one worktree should be main");
        let feat = list.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(feat.branch, "feat-1");
        assert_eq!(feat.commit.len(), 7);

        // 删除后回到 1 个
        svc.remove_worktree(&repo, &wt_path).unwrap();
        let list = svc.list_worktrees(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert!(!PathBuf::from(&wt_path).exists());
    }

    #[test]
    fn add_worktree_without_branch_uses_name_as_branch() {
        let Some((_guard, repo)) = init_git_repo() else {
            eprintln!("git unavailable, skipping integration test");
            return;
        };
        let svc = WorktreeService::new();

        // 不传 branch 时 git 会以目录名自动建分支
        let wt_path = svc.add_worktree(&repo, "auto-branch", None).unwrap();
        let list = svc.list_worktrees(&repo).unwrap();
        let wt = list.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(wt.branch, "auto-branch");

        svc.remove_worktree(&repo, &wt_path).unwrap();
    }

    #[test]
    fn add_worktree_duplicate_branch_fails() {
        let Some((_guard, repo)) = init_git_repo() else {
            eprintln!("git unavailable, skipping integration test");
            return;
        };
        let svc = WorktreeService::new();

        svc.add_worktree(&repo, "wt-a", Some("dup")).unwrap();
        let err = svc.add_worktree(&repo, "wt-b", Some("dup")).unwrap_err();
        assert!(
            err.contains("Failed to create worktree"),
            "unexpected error: {}",
            err
        );
    }
}
