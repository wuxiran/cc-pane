use crate::models::{ScannedRepo, ScannedWorktree, Workspace, WorkspaceProject};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct WorkspaceService {
    base_dir: PathBuf,
}

impl WorkspaceService {
    pub fn new(base_dir: PathBuf) -> Self {
        // 确保目录存在
        if !base_dir.exists() {
            if let Err(e) = fs::create_dir_all(&base_dir) {
                eprintln!("警告: 无法创建 workspaces 目录 {}: {}", base_dir.display(), e);
            }
        }

        Self { base_dir }
    }

    /// 获取 workspace 目录路径
    pub fn workspace_dir(&self, name: &str) -> PathBuf {
        self.base_dir.join(name)
    }

    /// 获取 workspace.json 路径
    fn workspace_json_path(&self, name: &str) -> PathBuf {
        self.workspace_dir(name).join("workspace.json")
    }

    /// 列出所有工作空间
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, String> {
        let mut workspaces = Vec::new();

        if !self.base_dir.exists() {
            return Ok(workspaces);
        }

        let entries = fs::read_dir(&self.base_dir)
            .map_err(|e| format!("无法读取 workspaces 目录: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                let json_path = path.join("workspace.json");
                if json_path.exists() {
                    match self.read_workspace_json(&json_path) {
                        Ok(ws) => workspaces.push(ws),
                        Err(e) => eprintln!("读取 workspace.json 失败: {}", e),
                    }
                }
            }
        }

        // 按创建时间排序
        workspaces.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(workspaces)
    }

    /// 创建新工作空间
    pub fn create_workspace(&self, name: &str) -> Result<Workspace, String> {
        let ws_dir = self.workspace_dir(name);

        if ws_dir.exists() {
            return Err(format!("工作空间 '{}' 已存在", name));
        }

        // 创建目录
        fs::create_dir_all(&ws_dir)
            .map_err(|e| format!("创建工作空间目录失败: {}", e))?;

        // 创建 .ccpanes 子目录
        let ccpanes_dir = ws_dir.join(".ccpanes");
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("创建 .ccpanes 目录失败: {}", e))?;

        // 创建 workspace.json
        let workspace = Workspace::new(name.to_string());
        self.write_workspace_json(name, &workspace)?;

        Ok(workspace)
    }

    /// 获取工作空间
    pub fn get_workspace(&self, name: &str) -> Result<Workspace, String> {
        let json_path = self.workspace_json_path(name);

        if !json_path.exists() {
            return Err(format!("工作空间 '{}' 不存在", name));
        }

        self.read_workspace_json(&json_path)
    }

    /// 重命名工作空间
    pub fn rename_workspace(&self, old_name: &str, new_name: &str) -> Result<(), String> {
        let old_dir = self.workspace_dir(old_name);
        let new_dir = self.workspace_dir(new_name);

        if !old_dir.exists() {
            return Err(format!("工作空间 '{}' 不存在", old_name));
        }

        if new_dir.exists() {
            return Err(format!("工作空间 '{}' 已存在", new_name));
        }

        // 重命名目录
        fs::rename(&old_dir, &new_dir)
            .map_err(|e| format!("重命名目录失败: {}", e))?;

        // 更新 workspace.json 中的 name
        let mut workspace = self.get_workspace(new_name)?;
        workspace.name = new_name.to_string();
        self.write_workspace_json(new_name, &workspace)?;

        Ok(())
    }

    /// 删除工作空间
    pub fn delete_workspace(&self, name: &str) -> Result<(), String> {
        let ws_dir = self.workspace_dir(name);

        if !ws_dir.exists() {
            return Err(format!("工作空间 '{}' 不存在", name));
        }

        fs::remove_dir_all(&ws_dir)
            .map_err(|e| format!("删除工作空间失败: {}", e))?;

        Ok(())
    }

    /// 添加项目到工作空间
    pub fn add_project(&self, workspace_name: &str, path: &str) -> Result<WorkspaceProject, String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        // 检查路径是否已存在
        if workspace.projects.iter().any(|p| p.path == path) {
            return Err(format!("项目路径 '{}' 已存在于工作空间中", path));
        }

        let project = WorkspaceProject::new(path.to_string());
        workspace.projects.push(project.clone());
        self.write_workspace_json(workspace_name, &workspace)?;

        Ok(project)
    }

    /// 从工作空间移除项目
    pub fn remove_project(&self, workspace_name: &str, project_id: &str) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        let original_len = workspace.projects.len();
        workspace.projects.retain(|p| p.id != project_id);

        if workspace.projects.len() == original_len {
            return Err(format!("项目 '{}' 不存在", project_id));
        }

        self.write_workspace_json(workspace_name, &workspace)?;
        Ok(())
    }

    /// 更新项目别名
    pub fn update_project_alias(
        &self,
        workspace_name: &str,
        project_id: &str,
        alias: Option<&str>,
    ) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        let project = workspace
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("项目 '{}' 不存在", project_id))?;

        project.alias = alias.map(|s| s.to_string());
        self.write_workspace_json(workspace_name, &workspace)?;

        Ok(())
    }

    /// 更新工作空间别名
    pub fn update_workspace_alias(
        &self,
        workspace_name: &str,
        alias: Option<&str>,
    ) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;
        workspace.alias = alias.map(|s| s.to_string());
        self.write_workspace_json(workspace_name, &workspace)?;
        Ok(())
    }

    /// 更新工作空间关联的 Provider
    pub fn update_workspace_provider(
        &self,
        workspace_name: &str,
        provider_id: Option<&str>,
    ) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;
        workspace.provider_id = provider_id.map(|s| s.to_string());
        self.write_workspace_json(workspace_name, &workspace)?;
        Ok(())
    }

    // ============ 私有方法 ============

    fn read_workspace_json(&self, path: &PathBuf) -> Result<Workspace, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("读取文件失败: {}", e))?;

        serde_json::from_str(&content)
            .map_err(|e| format!("解析 JSON 失败: {}", e))
    }

    fn write_workspace_json(&self, name: &str, workspace: &Workspace) -> Result<(), String> {
        let json_path = self.workspace_json_path(name);
        let content = serde_json::to_string_pretty(workspace)
            .map_err(|e| format!("序列化 JSON 失败: {}", e))?;

        fs::write(&json_path, content)
            .map_err(|e| format!("写入文件失败: {}", e))?;

        Ok(())
    }

    // ============ 目录扫描 ============

    /// 扫描指定目录，发现 Git 仓库及其 worktree，按主仓库分组返回
    pub fn scan_directory(root: &Path) -> Result<Vec<ScannedRepo>, String> {
        if !root.is_dir() {
            return Err(format!("路径不存在或不是目录: {}", root.display()));
        }

        let entries = fs::read_dir(root)
            .map_err(|e| format!("无法读取目录: {}", e))?;

        // 收集所有子目录的 git 信息
        // key = 主仓库路径, value = ScannedRepo
        let mut repo_map: HashMap<String, ScannedRepo> = HashMap::new();

        for entry in entries.filter_map(|e| e.ok()) {
            let sub_dir = entry.path();
            if !sub_dir.is_dir() {
                continue;
            }

            let git_path = sub_dir.join(".git");
            if !git_path.exists() {
                continue;
            }

            if git_path.is_dir() {
                // 普通 Git 仓库
                let main_path = sub_dir.to_string_lossy().to_string();
                let main_branch = Self::read_branch_from_dir(&sub_dir);

                // 获取该仓库的 worktree 列表
                let worktrees = Self::get_worktrees_for_repo(&sub_dir);

                let entry = repo_map.entry(main_path.clone()).or_insert_with(|| ScannedRepo {
                    main_path,
                    main_branch,
                    worktrees: Vec::new(),
                });
                // 合并 worktree（避免重复）
                for wt in worktrees {
                    if !entry.worktrees.iter().any(|w| w.path == wt.path) {
                        entry.worktrees.push(wt);
                    }
                }
            } else if git_path.is_file() {
                // Worktree：.git 是文件，找到主仓库
                if let Some((main_repo_path, wt_branch)) = Self::resolve_worktree_main(&sub_dir) {
                    let wt_path = sub_dir.to_string_lossy().to_string();
                    let main_branch = Self::read_branch_from_dir(&PathBuf::from(&main_repo_path));

                    let entry = repo_map.entry(main_repo_path.clone()).or_insert_with(|| ScannedRepo {
                        main_path: main_repo_path,
                        main_branch,
                        worktrees: Vec::new(),
                    });
                    if !entry.worktrees.iter().any(|w| w.path == wt_path) {
                        entry.worktrees.push(ScannedWorktree {
                            path: wt_path,
                            branch: wt_branch,
                        });
                    }
                }
            }
        }

        let mut result: Vec<ScannedRepo> = repo_map.into_values().collect();
        result.sort_by(|a, b| a.main_path.cmp(&b.main_path));
        Ok(result)
    }

    /// 读取目录的当前分支名
    fn read_branch_from_dir(dir: &Path) -> String {
        let git_path = dir.join(".git");
        let head_path = if git_path.is_file() {
            // Worktree
            if let Ok(content) = fs::read_to_string(&git_path) {
                let gitdir = content.trim_start_matches("gitdir:").trim();
                let gitdir_path = if Path::new(gitdir).is_absolute() {
                    PathBuf::from(gitdir)
                } else {
                    dir.join(gitdir)
                };
                gitdir_path.join("HEAD")
            } else {
                return String::new();
            }
        } else if git_path.is_dir() {
            git_path.join("HEAD")
        } else {
            return String::new();
        };

        if let Ok(content) = fs::read_to_string(&head_path) {
            if content.starts_with("ref: refs/heads/") {
                content.trim_start_matches("ref: refs/heads/").trim().to_string()
            } else {
                "HEAD".to_string()
            }
        } else {
            String::new()
        }
    }

    /// 使用 git worktree list --porcelain 获取仓库的所有 worktree
    fn get_worktrees_for_repo(repo_path: &Path) -> Vec<ScannedWorktree> {
        let output = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(repo_path)
            .output();

        let output = match output {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let repo_path_str = repo_path.to_string_lossy().to_string();
        let mut worktrees = Vec::new();
        let mut current_path = String::new();
        let mut current_branch = String::new();

        for line in stdout.lines() {
            if line.starts_with("worktree ") {
                current_path = line.strip_prefix("worktree ").unwrap_or("").to_string();
            } else if line.starts_with("branch ") {
                current_branch = line
                    .strip_prefix("branch refs/heads/")
                    .unwrap_or(line.strip_prefix("branch ").unwrap_or(""))
                    .to_string();
            } else if line.is_empty() && !current_path.is_empty() {
                // 跳过主仓库自身
                if current_path != repo_path_str {
                    worktrees.push(ScannedWorktree {
                        path: current_path.clone(),
                        branch: current_branch.clone(),
                    });
                }
                current_path.clear();
                current_branch.clear();
            }
        }

        // 处理最后一条（porcelain 输出末尾可能没有空行）
        if !current_path.is_empty() && current_path != repo_path_str {
            worktrees.push(ScannedWorktree {
                path: current_path,
                branch: current_branch,
            });
        }

        worktrees
    }

    /// 从 worktree 的 .git 文件解析出主仓库路径和当前分支
    fn resolve_worktree_main(wt_dir: &Path) -> Option<(String, String)> {
        let git_file = wt_dir.join(".git");
        let content = fs::read_to_string(&git_file).ok()?;
        let gitdir = content.trim_start_matches("gitdir:").trim();
        let gitdir_path = if Path::new(gitdir).is_absolute() {
            PathBuf::from(gitdir)
        } else {
            wt_dir.join(gitdir)
        };

        // gitdir_path = .git/worktrees/<name>
        // 向上两层得到 .git/，再取 parent 得到主仓库根目录
        let worktrees_dir = gitdir_path.parent()?; // .git/worktrees/
        let git_dir = worktrees_dir.parent()?;      // .git/
        let main_repo = git_dir.parent()?;           // 主仓库根目录

        let branch = Self::read_branch_from_dir(wt_dir);
        Some((main_repo.to_string_lossy().to_string(), branch))
    }
}
