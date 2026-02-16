use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};

/// Worktree 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub commit: String,
    pub is_main: bool,
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
            return Err("不是 Git 仓库".to_string());
        }

        let output = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(project_path)
            .output()
            .map_err(|e| format!("执行 git 命令失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree list 失败: {}", stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        self.parse_worktree_list(&stdout, project_path)
    }

    /// 解析 worktree 列表输出
    fn parse_worktree_list(&self, output: &str, main_path: &str) -> Result<Vec<WorktreeInfo>, String> {
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
                current_branch = line.strip_prefix("branch refs/heads/")
                    .unwrap_or(line.strip_prefix("branch ").unwrap_or(""))
                    .to_string();
            } else if line.is_empty() && !current_path.is_empty() {
                let is_main = current_path == main_path;
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
            let is_main = current_path == main_path;
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
        if !self.is_git_repo(project_path) {
            return Err("不是 Git 仓库".to_string());
        }

        let project_dir = PathBuf::from(project_path);
        let parent_dir = project_dir.parent()
            .ok_or("无法获取父目录")?;

        let project_name = project_dir.file_name()
            .and_then(|n| n.to_str())
            .ok_or("无法获取项目名称")?;

        // 分组目录模式: {repo}-worktrees/{name}/
        let worktrees_dir = parent_dir.join(format!("{}-worktrees", project_name));
        if !worktrees_dir.exists() {
            std::fs::create_dir_all(&worktrees_dir)
                .map_err(|e| format!("创建 worktrees 目录失败: {}", e))?;
        }
        let worktree_path = worktrees_dir.join(name);

        let worktree_path_str = worktree_path.to_string_lossy().to_string();

        let mut args = vec![
            "worktree".to_string(),
            "add".to_string(),
            worktree_path_str.clone(),
        ];

        if let Some(b) = branch {
            args.push("-b".to_string());
            args.push(b.to_string());
        }

        let output = Command::new("git")
            .args(&args)
            .current_dir(project_path)
            .output()
            .map_err(|e| format!("执行 git 命令失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("创建 worktree 失败: {}", stderr));
        }

        Ok(worktree_path_str)
    }

    /// 删除 worktree
    pub fn remove_worktree(
        &self,
        project_path: &str,
        worktree_path: &str,
    ) -> Result<(), String> {
        if !self.is_git_repo(project_path) {
            return Err("不是 Git 仓库".to_string());
        }

        let output = Command::new("git")
            .args(["worktree", "remove", worktree_path])
            .current_dir(project_path)
            .output()
            .map_err(|e| format!("执行 git 命令失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("删除 worktree 失败: {}", stderr));
        }

        Ok(())
    }
}

impl Default for WorktreeService {
    fn default() -> Self {
        Self::new()
    }
}