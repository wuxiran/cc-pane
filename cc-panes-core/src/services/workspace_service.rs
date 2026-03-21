use crate::constants::events as EV;
use crate::events::EventEmitter;
use crate::models::{ScannedRepo, ScannedWorktree, SshConnectionInfo, Workspace, WorkspaceProject};
use crate::utils::{output_with_timeout, GIT_LOCAL_TIMEOUT};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, warn};

pub struct WorkspaceService {
    base_dir: PathBuf,
    /// 保存 watcher 引用，防止被 drop
    _watcher: Mutex<Option<RecommendedWatcher>>,
    /// debounce 线程停止标志
    watcher_stop: Arc<AtomicBool>,
}

impl WorkspaceService {
    pub fn new(base_dir: PathBuf) -> Self {
        // 确保目录存在
        if !base_dir.exists() {
            if let Err(e) = fs::create_dir_all(&base_dir) {
                warn!(
                    "Failed to create workspaces directory {}: {}",
                    base_dir.display(),
                    e
                );
            }
        }

        Self {
            base_dir,
            _watcher: Mutex::new(None),
            watcher_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动文件系统监控，检测 workspace.json 变化后通知前端刷新
    ///
    /// 使用 dirty flag + debounce 线程模式：notify 回调仅设标记，
    /// 独立线程每 500ms 检查标记并 emit，避免在 notify 内部线程直接调用 IPC。
    pub fn start_watcher(&self, emitter: Arc<dyn EventEmitter>) {
        let dirty = Arc::new(AtomicBool::new(false));
        let dirty_clone = dirty.clone();

        // Watcher 回调：仅设标记，不直接 emit
        let watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    if event
                        .paths
                        .iter()
                        .any(|p| p.file_name() == Some(std::ffi::OsStr::new("workspace.json")))
                    {
                        dirty_clone.store(true, Ordering::Relaxed);
                    }
                }
            },
            Config::default(),
        );

        match watcher {
            Ok(mut w) => {
                if let Err(e) = w.watch(&self.base_dir, RecursiveMode::Recursive) {
                    error!(
                        "[workspace-watcher] Failed to watch {}: {}",
                        self.base_dir.display(),
                        e
                    );
                    return;
                }
                info!("[workspace-watcher] Watching {}", self.base_dir.display());
                let mut guard = self._watcher.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some(w);
            }
            Err(e) => {
                error!("[workspace-watcher] Failed to create watcher: {}", e);
                return;
            }
        }

        // Debounce 线程：每 500ms 检查标记，在此线程中 emit
        let dirty_poll = dirty.clone();
        let stop_flag = self.watcher_stop.clone();
        stop_flag.store(false, Ordering::Relaxed); // 重置，支持 restart
        std::thread::spawn(move || {
            while !stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                if dirty_poll.swap(false, Ordering::Relaxed) {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = emitter.emit(EV::WORKSPACES_CHANGED, serde_json::Value::Null);
                    }));
                }
            }
            info!("[workspace-watcher] Debounce thread stopped");
        });
    }

    /// 停止文件系统监控
    pub fn stop_watcher(&self) {
        self.watcher_stop.store(true, Ordering::Relaxed);
        let mut guard = self._watcher.lock().unwrap_or_else(|e| e.into_inner());
        if guard.take().is_some() {
            info!("[workspace-watcher] Stopped");
        }
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
            .map_err(|e| format!("Failed to read workspaces directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                let json_path = path.join("workspace.json");
                if json_path.exists() {
                    match self.read_workspace_json(&json_path) {
                        Ok(ws) => workspaces.push(ws),
                        Err(e) => warn!("Failed to read workspace.json: {}", e),
                    }
                }
            }
        }

        // 排序：pinned 优先 → sort_order 升序 → 创建时间升序
        workspaces.sort_by(|a, b| {
            // pinned 在前
            b.pinned
                .cmp(&a.pinned)
                // sort_order 升序（None 排在最后）
                .then_with(|| match (a.sort_order, b.sort_order) {
                    (Some(sa), Some(sb)) => sa.cmp(&sb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                })
                // 最后按创建时间
                .then_with(|| a.created_at.cmp(&b.created_at))
        });
        Ok(workspaces)
    }

    /// 创建新工作空间
    pub fn create_workspace(&self, name: &str, path: Option<&str>) -> Result<Workspace, String> {
        let ws_dir = self.workspace_dir(name);

        if ws_dir.exists() {
            return Err(format!("Workspace '{}' already exists", name));
        }

        // 创建目录
        fs::create_dir_all(&ws_dir)
            .map_err(|e| format!("Failed to create workspace directory: {}", e))?;

        // 创建 .ccpanes 子目录
        let ccpanes_dir = ws_dir.join(".ccpanes");
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create .ccpanes directory: {}", e))?;

        // 创建 workspace.json
        let workspace = Workspace::new(name.to_string(), path.map(|s| s.to_string()));
        self.write_workspace_json(name, &workspace)?;

        // 若指定了 path，在工作空间路径下生成引导文件
        if path.is_some() {
            self.init_workspace_files(&workspace)?;
        }

        Ok(workspace)
    }

    /// 获取工作空间
    pub fn get_workspace(&self, name: &str) -> Result<Workspace, String> {
        let json_path = self.workspace_json_path(name);

        if !json_path.exists() {
            return Err(format!("Workspace '{}' does not exist", name));
        }

        self.read_workspace_json(&json_path)
    }

    /// 重命名工作空间
    pub fn rename_workspace(&self, old_name: &str, new_name: &str) -> Result<(), String> {
        let old_dir = self.workspace_dir(old_name);
        let new_dir = self.workspace_dir(new_name);

        if !old_dir.exists() {
            return Err(format!("Workspace '{}' does not exist", old_name));
        }

        if new_dir.exists() {
            return Err(format!(
                "WORKSPACE_NAME_DUPLICATE: Workspace '{}' already exists",
                new_name
            ));
        }

        // 重命名目录
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("Failed to rename directory: {}", e))?;

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
            return Err(format!("Workspace '{}' does not exist", name));
        }

        fs::remove_dir_all(&ws_dir).map_err(|e| format!("Failed to delete workspace: {}", e))?;

        Ok(())
    }

    /// 归一化项目路径用于比较：统一分隔符为 /、去除尾部斜杠、Windows 上转小写
    fn normalize_project_path(p: &str) -> String {
        let normalized = p.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            normalized.to_lowercase()
        } else {
            normalized
        }
    }

    /// 添加项目到工作空间
    pub fn add_project(
        &self,
        workspace_name: &str,
        path: &str,
    ) -> Result<WorkspaceProject, String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        // 检查路径是否已存在（归一化比较：统一分隔符、去尾部斜杠、Windows 忽略大小写）
        let norm_input = Self::normalize_project_path(path);
        if workspace
            .projects
            .iter()
            .any(|p| Self::normalize_project_path(&p.path) == norm_input)
        {
            return Err(format!(
                "PROJECT_ALREADY_EXISTS: Project path '{}' already exists in workspace",
                path
            ));
        }

        let project = WorkspaceProject::new(path.to_string());
        workspace.projects.push(project.clone());
        self.write_workspace_json(workspace_name, &workspace)?;

        // 同步 projects.csv
        self.sync_projects_csv(&workspace);

        Ok(project)
    }

    /// 添加 SSH 远程项目到工作空间
    ///
    /// 与 `add_project` 不同，SSH 项目：
    /// - path 为 `ssh://[user@]host[:port]/remote_path` 格式的显示路径
    /// - 携带 `SshConnectionInfo` 结构
    /// - 不初始化 Local History
    /// - 不同步 projects.csv（远程路径无法本地 git 操作）
    pub fn add_ssh_project(
        &self,
        workspace_name: &str,
        ssh_info: SshConnectionInfo,
    ) -> Result<WorkspaceProject, String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        // 构建显示路径：ssh://[user@]host[:port]/remote_path
        let user_part = match &ssh_info.user {
            Some(u) => format!("{}@", u),
            None => String::new(),
        };
        let port_part = if ssh_info.port != 22 {
            format!(":{}", ssh_info.port)
        } else {
            String::new()
        };
        let display_path = format!(
            "ssh://{}{}{}{}",
            user_part, ssh_info.host, port_part, ssh_info.remote_path
        );

        // 去重检查（基于 display_path）
        let norm_input = Self::normalize_project_path(&display_path);
        if workspace
            .projects
            .iter()
            .any(|p| Self::normalize_project_path(&p.path) == norm_input)
        {
            return Err(format!(
                "PROJECT_ALREADY_EXISTS: SSH project '{}' already exists in workspace",
                display_path
            ));
        }

        // 创建 WorkspaceProject，path 为 display_path，ssh 字段填充连接信息
        let project = WorkspaceProject {
            id: uuid::Uuid::new_v4().to_string(),
            path: display_path,
            alias: None,
            ssh: Some(ssh_info),
        };

        workspace.projects.push(project.clone());
        self.write_workspace_json(workspace_name, &workspace)?;

        // 注意：不初始化 Local History，不同步 projects.csv

        Ok(project)
    }

    /// 从工作空间移除项目
    pub fn remove_project(&self, workspace_name: &str, project_id: &str) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;

        let original_len = workspace.projects.len();
        workspace.projects.retain(|p| p.id != project_id);

        if workspace.projects.len() == original_len {
            return Err(format!("Project '{}' does not exist", project_id));
        }

        self.write_workspace_json(workspace_name, &workspace)?;

        // 同步 projects.csv
        self.sync_projects_csv(&workspace);

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
            .ok_or_else(|| format!("Project '{}' does not exist", project_id))?;

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

    /// 更新工作空间根目录路径
    pub fn update_workspace_path(
        &self,
        workspace_name: &str,
        path: Option<&str>,
    ) -> Result<(), String> {
        let mut workspace = self.get_workspace(workspace_name)?;
        workspace.path = path.map(|s| s.to_string());
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

    /// 更新工作空间 pinned 状态
    pub fn update_workspace_pinned(&self, name: &str, pinned: bool) -> Result<(), String> {
        let mut ws = self.get_workspace(name)?;
        ws.pinned = pinned;
        self.write_workspace_json(name, &ws)?;
        Ok(())
    }

    /// 更新工作空间 hidden 状态
    pub fn update_workspace_hidden(&self, name: &str, hidden: bool) -> Result<(), String> {
        let mut ws = self.get_workspace(name)?;
        ws.hidden = hidden;
        self.write_workspace_json(name, &ws)?;
        Ok(())
    }

    /// 重排工作空间顺序
    pub fn reorder_workspaces(&self, ordered_names: Vec<String>) -> Result<(), String> {
        if ordered_names.is_empty() {
            return Err("Ordered names cannot be empty".to_string());
        }
        // 检查重复
        let mut seen = std::collections::HashSet::new();
        for name in &ordered_names {
            if !seen.insert(name) {
                return Err(format!("Duplicate workspace name: {}", name));
            }
        }
        // 验证所有名称都存在
        for name in &ordered_names {
            self.get_workspace(name)?;
        }
        // 更新每个 workspace 的 sort_order
        for (i, name) in ordered_names.iter().enumerate() {
            let mut ws = self.get_workspace(name)?;
            ws.sort_order = Some(i as i32);
            self.write_workspace_json(name, &ws)?;
        }
        Ok(())
    }

    // ============ 私有方法 ============

    fn read_workspace_json(&self, path: &PathBuf) -> Result<Workspace, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

        serde_json::from_str(&content).map_err(|e| format!("Failed to parse JSON: {}", e))
    }

    pub fn write_workspace_json(&self, name: &str, workspace: &Workspace) -> Result<(), String> {
        let json_path = self.workspace_json_path(name);
        let content = serde_json::to_string_pretty(workspace)
            .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

        fs::write(&json_path, content).map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(())
    }

    /// 在工作空间 path 下生成引导文件（CLAUDE.md + .ccpanes/projects.csv）
    fn init_workspace_files(&self, ws: &Workspace) -> Result<(), String> {
        let ws_path = match &ws.path {
            Some(p) => PathBuf::from(p),
            None => return Ok(()),
        };

        // 创建 .ccpanes/ 目录
        let ccpanes_dir = ws_path.join(".ccpanes");
        fs::create_dir_all(&ccpanes_dir).map_err(|e| {
            format!(
                "Failed to create .ccpanes directory in workspace path: {}",
                e
            )
        })?;

        // 生成 CLAUDE.md（仅当不存在时）
        let claude_md_path = ws_path.join("CLAUDE.md");
        if !claude_md_path.exists() {
            let content = format!(
                "# {}\n\n> CC-Panes 管理的工作空间\n\n## 子项目\n\n项目列表见 `.ccpanes/projects.csv`。\n",
                ws.name
            );
            fs::write(&claude_md_path, content)
                .map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;
        }

        // 生成初始 projects.csv
        self.sync_projects_csv(ws);

        Ok(())
    }

    /// 同步 projects.csv 到工作空间 path 下的 .ccpanes/ 目录
    fn sync_projects_csv(&self, ws: &Workspace) {
        let ws_path = match &ws.path {
            Some(p) => PathBuf::from(p),
            None => return,
        };

        let ccpanes_dir = ws_path.join(".ccpanes");
        if fs::create_dir_all(&ccpanes_dir).is_err() {
            return;
        }

        let csv_path = ccpanes_dir.join("projects.csv");
        let mut lines = Vec::with_capacity(ws.projects.len() + 1);
        lines.push("path,alias,branch,status".to_string());

        for project in &ws.projects {
            let alias = project.alias.as_deref().unwrap_or("");
            let branch = Self::get_git_branch_for_csv(&project.path);
            let status = Self::get_git_status_for_csv(&project.path);
            // CSV 转义：如果字段包含逗号或引号，用双引号包裹
            let escaped_path = Self::csv_escape(&project.path);
            let escaped_alias = Self::csv_escape(alias);
            lines.push(format!(
                "{},{},{},{}",
                escaped_path, escaped_alias, branch, status
            ));
        }

        let content = lines.join("\n") + "\n";
        let _ = fs::write(&csv_path, content);
    }

    /// 获取 git 当前分支名（用于 CSV）
    fn get_git_branch_for_csv(path: &str) -> String {
        let output = output_with_timeout(
            Command::new("git")
                .args(["branch", "--show-current"])
                .current_dir(path),
            GIT_LOCAL_TIMEOUT,
        );
        match output {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            _ => String::new(),
        }
    }

    /// 获取 git 工作区状态（用于 CSV）
    fn get_git_status_for_csv(path: &str) -> &'static str {
        let output = output_with_timeout(
            Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(path),
            GIT_LOCAL_TIMEOUT,
        );
        match output {
            Ok(o) if o.status.success() => {
                if String::from_utf8_lossy(&o.stdout).trim().is_empty() {
                    "clean"
                } else {
                    "dirty"
                }
            }
            _ => "unknown",
        }
    }

    /// CSV 字段转义
    fn csv_escape(field: &str) -> String {
        if field.contains(',') || field.contains('"') || field.contains('\n') {
            format!("\"{}\"", field.replace('"', "\"\""))
        } else {
            field.to_string()
        }
    }

    // ============ 目录扫描 ============

    /// 扫描指定目录，发现 Git 仓库及其 worktree，按主仓库分组返回
    pub fn scan_directory(root: &Path) -> Result<Vec<ScannedRepo>, String> {
        if !root.is_dir() {
            return Err(format!(
                "Path does not exist or is not a directory: {}",
                root.display()
            ));
        }

        let entries = fs::read_dir(root).map_err(|e| format!("Failed to read directory: {}", e))?;

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

                let entry = repo_map
                    .entry(main_path.clone())
                    .or_insert_with(|| ScannedRepo {
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

                    let entry =
                        repo_map
                            .entry(main_repo_path.clone())
                            .or_insert_with(|| ScannedRepo {
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
                content
                    .trim_start_matches("ref: refs/heads/")
                    .trim()
                    .to_string()
            } else {
                "HEAD".to_string()
            }
        } else {
            String::new()
        }
    }

    /// 使用 git worktree list --porcelain 获取仓库的所有 worktree
    fn get_worktrees_for_repo(repo_path: &Path) -> Vec<ScannedWorktree> {
        let output = output_with_timeout(
            Command::new("git")
                .args(["worktree", "list", "--porcelain"])
                .current_dir(repo_path),
            GIT_LOCAL_TIMEOUT,
        );

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
        let git_dir = worktrees_dir.parent()?; // .git/
        let main_repo = git_dir.parent()?; // 主仓库根目录

        let branch = Self::read_branch_from_dir(wt_dir);
        Some((main_repo.to_string_lossy().to_string(), branch))
    }
}
