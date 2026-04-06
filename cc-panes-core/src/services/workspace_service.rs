use crate::constants::events as EV;
use crate::events::EventEmitter;
use crate::models::{
    ProjectMigrationPlan, ProjectMigrationRequest, ProjectMigrationResult,
    ProjectMigrationRollbackResult, ScannedRepo, ScannedWorktree, SshConnectionInfo, Workspace,
    WorkspaceMigrationItem, WorkspaceMigrationPlan, WorkspaceMigrationRequest,
    WorkspaceMigrationResult, WorkspaceMigrationRollbackResult, WorkspaceMigrationStatus,
    WorkspaceMigrationTargetKind, WorkspaceProject, WorkspaceWslConfig,
};
use crate::utils::{output_with_timeout, GIT_LOCAL_TIMEOUT};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{error, info, warn};

const MIGRATION_EXCLUDED_NAMES: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "__pycache__",
];

const MIGRATION_PROJECTS_CSV_RELATIVE_PATH: &str = ".ccpanes/projects.csv";

#[derive(Debug, Default, Clone, Copy)]
struct CopyStats {
    files: u64,
    bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMigrationSnapshot {
    workspace: Workspace,
    plan: WorkspaceMigrationPlan,
    created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMigrationSnapshot {
    workspace: Workspace,
    plan: ProjectMigrationPlan,
    created_at: String,
}

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
            wsl_remote_path: None,
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

    /// 预览工作空间迁移计划
    pub fn preview_workspace_migration(
        &self,
        request: &WorkspaceMigrationRequest,
    ) -> Result<WorkspaceMigrationPlan, String> {
        self.build_migration_plan(request).map(|(_, plan)| plan)
    }

    /// 执行工作空间迁移
    pub fn execute_workspace_migration(
        &self,
        request: &WorkspaceMigrationRequest,
    ) -> Result<WorkspaceMigrationResult, String> {
        let (workspace, plan) = self.build_migration_plan(request)?;
        let source_root = PathBuf::from(&plan.source_root);
        let target_root = self.resolve_physical_target_root(&plan)?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        self.write_migration_snapshot(&workspace, &plan, &snapshot_id)?;

        self.ensure_directory_exists(&target_root)?;
        let mut stats = self.copy_workspace_shell(&workspace, &source_root, &target_root)?;

        for item in &plan.items {
            let destination = self.resolve_item_target_path(&plan, item)?;
            self.ensure_directory_exists(&destination)?;
            let item_stats =
                self.copy_directory_recursive(Path::new(&item.source_path), &destination)?;
            stats.files += item_stats.files;
            stats.bytes += item_stats.bytes;
        }

        let target_workspace = self.build_target_workspace_view(&workspace, &plan);
        self.ensure_workspace_files_at_path(&target_workspace, &target_root)?;
        self.verify_workspace_metadata(&source_root, &target_root)?;
        for item in &plan.items {
            self.verify_directory_copy(
                Path::new(&item.source_path),
                &self.resolve_item_target_path(&plan, item)?,
            )?;
        }

        let updated_workspace = self.build_workspace_after_migration(&workspace, &plan);
        let result_warnings = plan.warnings.clone();

        self.write_workspace_json(&workspace.name, &updated_workspace)?;
        self.sync_projects_csv(&updated_workspace);

        Ok(WorkspaceMigrationResult {
            status: WorkspaceMigrationStatus::Succeeded,
            snapshot_id,
            workspace: updated_workspace,
            plan,
            copied_files: stats.files,
            copied_bytes: stats.bytes,
            warnings: result_warnings,
        })
    }

    /// 回滚工作空间迁移，仅恢复 workspace.json 与工作空间元数据文件
    pub fn rollback_workspace_migration(
        &self,
        workspace_name: &str,
        snapshot_id: &str,
    ) -> Result<WorkspaceMigrationRollbackResult, String> {
        let snapshot = self.read_migration_snapshot(workspace_name, snapshot_id)?;
        self.write_workspace_json(workspace_name, &snapshot.workspace)?;
        self.sync_projects_csv(&snapshot.workspace);
        Ok(WorkspaceMigrationRollbackResult {
            snapshot_id: snapshot_id.to_string(),
            workspace: snapshot.workspace,
        })
    }

    // ============ 私有方法 ============

    pub fn preview_project_migration(
        &self,
        request: &ProjectMigrationRequest,
    ) -> Result<ProjectMigrationPlan, String> {
        self.build_project_migration_plan(request)
            .map(|(_, plan)| plan)
    }

    pub fn execute_project_migration(
        &self,
        request: &ProjectMigrationRequest,
    ) -> Result<ProjectMigrationResult, String> {
        let (workspace, plan) = self.build_project_migration_plan(request)?;
        let source_root = PathBuf::from(&plan.source_path);
        let target_root = self.resolve_target_root_path(
            plan.target_kind,
            &plan.target_root,
            plan.target_distro.as_deref(),
        )?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        self.write_project_migration_snapshot(&workspace, &plan, &snapshot_id)?;

        self.ensure_directory_exists(&target_root)?;
        let stats = self.copy_directory_recursive(&source_root, &target_root)?;
        self.verify_directory_copy(&source_root, &target_root)?;

        let updated_workspace =
            self.build_workspace_after_project_migration(&workspace, &plan, &target_root);
        self.write_workspace_json(&workspace.name, &updated_workspace)?;
        self.sync_projects_csv(&updated_workspace);

        Ok(ProjectMigrationResult {
            status: WorkspaceMigrationStatus::Succeeded,
            snapshot_id,
            workspace: updated_workspace,
            plan: plan.clone(),
            copied_files: stats.files,
            copied_bytes: stats.bytes,
            warnings: plan.warnings.clone(),
        })
    }

    pub fn rollback_project_migration(
        &self,
        workspace_name: &str,
        snapshot_id: &str,
    ) -> Result<ProjectMigrationRollbackResult, String> {
        let snapshot = self.read_project_migration_snapshot(workspace_name, snapshot_id)?;
        self.write_workspace_json(workspace_name, &snapshot.workspace)?;
        self.sync_projects_csv(&snapshot.workspace);
        Ok(ProjectMigrationRollbackResult {
            snapshot_id: snapshot_id.to_string(),
            workspace: snapshot.workspace,
        })
    }

    fn build_migration_plan(
        &self,
        request: &WorkspaceMigrationRequest,
    ) -> Result<(Workspace, WorkspaceMigrationPlan), String> {
        let workspace = self.get_workspace(&request.workspace_name)?;
        let source_root = workspace.path.clone().ok_or_else(|| {
            format!(
                "Workspace '{}' requires a local path before migration",
                workspace.name
            )
        })?;
        let source_root_path = PathBuf::from(&source_root);
        if !source_root_path.is_dir() {
            return Err(format!(
                "Workspace root does not exist or is not a directory: {}",
                source_root
            ));
        }

        let target_root = request.target_root.trim();
        if target_root.is_empty() {
            return Err("Migration target root cannot be empty".to_string());
        }

        if matches!(request.target_kind, WorkspaceMigrationTargetKind::Ssh) {
            return Err("SSH migration is not supported yet".to_string());
        }

        let resolved_target_root = match request.target_kind {
            WorkspaceMigrationTargetKind::Local => {
                PathBuf::from(target_root).to_string_lossy().to_string()
            }
            WorkspaceMigrationTargetKind::Wsl => Self::normalize_wsl_root(target_root)?,
            WorkspaceMigrationTargetKind::Ssh => unreachable!(),
        };

        let resolved_target_distro = self.resolve_target_distro(request)?;
        let physical_target_root = self.resolve_target_root_path(
            request.target_kind,
            &resolved_target_root,
            resolved_target_distro.as_deref(),
        )?;
        self.ensure_migration_target_available(
            &source_root_path,
            request.target_kind,
            &physical_target_root,
        )?;

        let external_names = Self::build_external_name_map(&workspace.projects, &source_root);
        let mut warnings = Vec::new();
        let mut items = Vec::new();

        for project in &workspace.projects {
            if project.ssh.is_some() {
                warnings.push(format!(
                    "Skipped SSH project '{}' during migration preview",
                    project.alias.as_deref().unwrap_or(&project.path)
                ));
                continue;
            }

            let source_path = PathBuf::from(&project.path);
            if !source_path.is_dir() {
                return Err(format!(
                    "Project path does not exist or is not a directory: {}",
                    project.path
                ));
            }

            let relative_path = Self::relative_path_from_workspace(&project.path, &source_root);
            let (logical_relative_path, external) = match relative_path {
                Some(relative) => (relative, false),
                None => {
                    let folder_name =
                        external_names.get(&project.id).cloned().ok_or_else(|| {
                            format!("Failed to resolve external path for '{}'", project.path)
                        })?;
                    (format!("externals/{}", folder_name), true)
                }
            };

            let destination_path = Self::join_logical_path(
                request.target_kind,
                &resolved_target_root,
                &logical_relative_path,
            );
            items.push(WorkspaceMigrationItem {
                project_id: project.id.clone(),
                project_name: Self::display_project_name(project),
                source_path: project.path.clone(),
                destination_path,
                relative_path: Some(logical_relative_path),
                external,
            });
        }

        let plan = WorkspaceMigrationPlan {
            workspace_name: workspace.name.clone(),
            source_root,
            root_destination: resolved_target_root.clone(),
            target_kind: request.target_kind,
            target_root: resolved_target_root,
            target_distro: resolved_target_distro,
            items,
            warnings,
        };

        Ok((workspace, plan))
    }

    fn build_project_migration_plan(
        &self,
        request: &ProjectMigrationRequest,
    ) -> Result<(Workspace, ProjectMigrationPlan), String> {
        let workspace = self.get_workspace(&request.workspace_name)?;
        let project = workspace
            .projects
            .iter()
            .find(|item| item.id == request.project_id)
            .ok_or_else(|| {
                format!(
                    "Project '{}' does not exist in workspace '{}'",
                    request.project_id, request.workspace_name
                )
            })?;

        if project.ssh.is_some() {
            return Err("SSH projects are not supported for migration".to_string());
        }

        let source_root_path = PathBuf::from(&project.path);
        if !source_root_path.is_dir() {
            return Err(format!(
                "Project path does not exist or is not a directory: {}",
                project.path
            ));
        }

        let target_root = request.target_root.trim();
        if target_root.is_empty() {
            return Err("Migration target root cannot be empty".to_string());
        }

        if matches!(request.target_kind, WorkspaceMigrationTargetKind::Ssh) {
            return Err("SSH migration is not supported yet".to_string());
        }

        let resolved_target_root = match request.target_kind {
            WorkspaceMigrationTargetKind::Local => {
                PathBuf::from(target_root).to_string_lossy().to_string()
            }
            WorkspaceMigrationTargetKind::Wsl => Self::normalize_wsl_root(target_root)?,
            WorkspaceMigrationTargetKind::Ssh => unreachable!(),
        };

        let resolved_target_distro = self.resolve_target_distro_for_kind(
            request.target_kind,
            request.target_distro.as_deref(),
        )?;
        let physical_target_root = self.resolve_target_root_path(
            request.target_kind,
            &resolved_target_root,
            resolved_target_distro.as_deref(),
        )?;
        self.ensure_migration_target_available(
            &source_root_path,
            request.target_kind,
            &physical_target_root,
        )?;

        let plan = ProjectMigrationPlan {
            workspace_name: workspace.name.clone(),
            project_id: project.id.clone(),
            project_name: Self::display_project_name(project),
            source_path: project.path.clone(),
            destination_path: resolved_target_root.clone(),
            target_kind: request.target_kind,
            target_root: resolved_target_root,
            target_distro: resolved_target_distro,
            warnings: Vec::new(),
        };

        Ok((workspace, plan))
    }

    fn resolve_target_distro(
        &self,
        request: &WorkspaceMigrationRequest,
    ) -> Result<Option<String>, String> {
        self.resolve_target_distro_for_kind(request.target_kind, request.target_distro.as_deref())
    }

    fn resolve_target_distro_for_kind(
        &self,
        target_kind: WorkspaceMigrationTargetKind,
        requested_distro: Option<&str>,
    ) -> Result<Option<String>, String> {
        #[cfg(not(target_os = "windows"))]
        let _ = requested_distro;


        match target_kind {
            WorkspaceMigrationTargetKind::Local => Ok(None),
            WorkspaceMigrationTargetKind::Wsl => {
                #[cfg(target_os = "windows")]
                {
                    let requested = requested_distro
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    if requested.is_some() {
                        return Ok(requested);
                    }
                    crate::services::wsl_discovery_service::resolve_default_distro()
                        .map_err(|error| {
                            format!("Failed to resolve WSL default distro: {}", error)
                        })?
                        .ok_or_else(|| "No default WSL distro found".to_string())
                        .map(Some)
                }

                #[cfg(not(target_os = "windows"))]
                {
                    Err("WSL migration is only supported on Windows".to_string())
                }
            }
            WorkspaceMigrationTargetKind::Ssh => Ok(None),
        }
    }

    fn resolve_physical_target_root(
        &self,
        plan: &WorkspaceMigrationPlan,
    ) -> Result<PathBuf, String> {
        self.resolve_target_root_path(
            plan.target_kind,
            &plan.target_root,
            plan.target_distro.as_deref(),
        )
    }

    fn resolve_target_root_path(
        &self,
        target_kind: WorkspaceMigrationTargetKind,
        target_root: &str,
        target_distro: Option<&str>,
    ) -> Result<PathBuf, String> {
        match target_kind {
            WorkspaceMigrationTargetKind::Local => Ok(PathBuf::from(target_root)),
            WorkspaceMigrationTargetKind::Wsl => {
                #[cfg(target_os = "windows")]
                {
                    let distro = target_distro
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "WSL migration requires a distro".to_string())?;
                    Ok(Self::wsl_remote_to_windows_path(distro, target_root))
                }

                #[cfg(not(target_os = "windows"))]
                {
                    let _ = target_distro;
                    Err("WSL migration is only supported on Windows".to_string())
                }
            }
            WorkspaceMigrationTargetKind::Ssh => {
                Err("SSH migration is not supported yet".to_string())
            }
        }
    }

    fn ensure_migration_target_available(
        &self,
        source_root: &Path,
        target_kind: WorkspaceMigrationTargetKind,
        physical_target_root: &Path,
    ) -> Result<(), String> {
        if matches!(target_kind, WorkspaceMigrationTargetKind::Local) {
            let normalized_source = Self::normalize_filesystem_path(&source_root.to_string_lossy());
            let normalized_target =
                Self::normalize_filesystem_path(&physical_target_root.to_string_lossy());
            if normalized_source == normalized_target {
                return Err("Migration target root cannot be the same as source root".to_string());
            }
            if normalized_target.starts_with(&(normalized_source.clone() + "/")) {
                return Err(
                    "Migration target root cannot be inside the source workspace".to_string(),
                );
            }
        }

        if physical_target_root.exists() {
            let mut entries = fs::read_dir(physical_target_root)
                .map_err(|e| format!("Failed to inspect migration target: {}", e))?;
            if entries
                .next()
                .transpose()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err(format!(
                    "Migration target directory must be empty: {}",
                    physical_target_root.display()
                ));
            }
        }

        Ok(())
    }

    fn build_workspace_after_migration(
        &self,
        workspace: &Workspace,
        plan: &WorkspaceMigrationPlan,
    ) -> Workspace {
        let item_map: HashMap<&str, &WorkspaceMigrationItem> = plan
            .items
            .iter()
            .map(|item| (item.project_id.as_str(), item))
            .collect();
        let mut next_workspace = workspace.clone();

        match plan.target_kind {
            WorkspaceMigrationTargetKind::Local => {
                next_workspace.path = Some(plan.target_root.clone());
                next_workspace.default_environment =
                    crate::models::WorkspaceLaunchEnvironment::Local;
                next_workspace.wsl = next_workspace.wsl.take().map(|mut config| {
                    config.remote_path = None;
                    config
                });
                for project in &mut next_workspace.projects {
                    if let Some(item) = item_map.get(project.id.as_str()) {
                        project.path = item.destination_path.clone();
                    }
                    project.wsl_remote_path = None;
                }
            }
            WorkspaceMigrationTargetKind::Wsl => {
                next_workspace.default_environment = crate::models::WorkspaceLaunchEnvironment::Wsl;
                next_workspace.wsl = Some(WorkspaceWslConfig {
                    distro: plan.target_distro.clone(),
                    remote_path: Some(plan.target_root.clone()),
                });
                for project in &mut next_workspace.projects {
                    if let Some(item) = item_map.get(project.id.as_str()) {
                        project.wsl_remote_path = Some(item.destination_path.clone());
                    }
                }
            }
            WorkspaceMigrationTargetKind::Ssh => {}
        }

        next_workspace
    }

    fn build_workspace_after_project_migration(
        &self,
        workspace: &Workspace,
        plan: &ProjectMigrationPlan,
        physical_target_root: &Path,
    ) -> Workspace {
        let mut next_workspace = workspace.clone();

        if let Some(project) = next_workspace
            .projects
            .iter_mut()
            .find(|item| item.id == plan.project_id)
        {
            match plan.target_kind {
                WorkspaceMigrationTargetKind::Local => {
                    project.path = plan.destination_path.clone();
                    project.wsl_remote_path = None;
                }
                WorkspaceMigrationTargetKind::Wsl => {
                    project.path = physical_target_root.to_string_lossy().to_string();
                    project.wsl_remote_path = Some(plan.destination_path.clone());
                }
                WorkspaceMigrationTargetKind::Ssh => {}
            }
        }

        next_workspace
    }

    fn build_target_workspace_view(
        &self,
        workspace: &Workspace,
        plan: &WorkspaceMigrationPlan,
    ) -> Workspace {
        let item_map: HashMap<&str, &WorkspaceMigrationItem> = plan
            .items
            .iter()
            .map(|item| (item.project_id.as_str(), item))
            .collect();
        let mut target_workspace = workspace.clone();
        target_workspace.path = Some(plan.target_root.clone());

        for project in &mut target_workspace.projects {
            if let Some(item) = item_map.get(project.id.as_str()) {
                project.path = item.destination_path.clone();
            }
        }

        target_workspace
    }

    fn write_migration_snapshot(
        &self,
        workspace: &Workspace,
        plan: &WorkspaceMigrationPlan,
        snapshot_id: &str,
    ) -> Result<(), String> {
        let snapshot_dir = self.migration_snapshot_dir(&workspace.name);
        fs::create_dir_all(&snapshot_dir)
            .map_err(|e| format!("Failed to create migration snapshot directory: {}", e))?;

        let snapshot = WorkspaceMigrationSnapshot {
            workspace: workspace.clone(),
            plan: plan.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let content = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Failed to serialize migration snapshot: {}", e))?;
        fs::write(snapshot_dir.join(format!("{}.json", snapshot_id)), content)
            .map_err(|e| format!("Failed to write migration snapshot: {}", e))?;
        Ok(())
    }

    fn read_migration_snapshot(
        &self,
        workspace_name: &str,
        snapshot_id: &str,
    ) -> Result<WorkspaceMigrationSnapshot, String> {
        let path = self
            .migration_snapshot_dir(workspace_name)
            .join(format!("{}.json", snapshot_id));
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read migration snapshot: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse migration snapshot: {}", e))
    }

    fn write_project_migration_snapshot(
        &self,
        workspace: &Workspace,
        plan: &ProjectMigrationPlan,
        snapshot_id: &str,
    ) -> Result<(), String> {
        let snapshot_dir = self.project_migration_snapshot_dir(&workspace.name);
        fs::create_dir_all(&snapshot_dir).map_err(|e| {
            format!(
                "Failed to create project migration snapshot directory: {}",
                e
            )
        })?;

        let snapshot = ProjectMigrationSnapshot {
            workspace: workspace.clone(),
            plan: plan.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let content = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| format!("Failed to serialize project migration snapshot: {}", e))?;
        fs::write(snapshot_dir.join(format!("{}.json", snapshot_id)), content)
            .map_err(|e| format!("Failed to write project migration snapshot: {}", e))?;
        Ok(())
    }

    fn read_project_migration_snapshot(
        &self,
        workspace_name: &str,
        snapshot_id: &str,
    ) -> Result<ProjectMigrationSnapshot, String> {
        let path = self
            .project_migration_snapshot_dir(workspace_name)
            .join(format!("{}.json", snapshot_id));
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read project migration snapshot: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse project migration snapshot: {}", e))
    }

    fn migration_snapshot_dir(&self, workspace_name: &str) -> PathBuf {
        self.base_dir
            .parent()
            .unwrap_or(&self.base_dir)
            .join("workspace-migrations")
            .join(workspace_name)
    }

    fn project_migration_snapshot_dir(&self, workspace_name: &str) -> PathBuf {
        self.base_dir
            .parent()
            .unwrap_or(&self.base_dir)
            .join("project-migrations")
            .join(workspace_name)
    }

    fn ensure_workspace_files_at_path(
        &self,
        workspace: &Workspace,
        target_root: &Path,
    ) -> Result<(), String> {
        let ccpanes_dir = target_root.join(".ccpanes");
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create target .ccpanes directory: {}", e))?;
        self.write_projects_csv_for_root(target_root, workspace)?;

        let claude_md_path = target_root.join("CLAUDE.md");
        if !claude_md_path.exists() {
            let content = format!(
                "# {}\n\n> CC-Panes 管理的工作空间\n\n## 子项目\n项目列表见 `.ccpanes/projects.csv`。\n",
                workspace.name
            );
            fs::write(&claude_md_path, content)
                .map_err(|e| format!("Failed to write target CLAUDE.md: {}", e))?;
        }

        Ok(())
    }

    fn verify_workspace_metadata(
        &self,
        source_root: &Path,
        target_root: &Path,
    ) -> Result<(), String> {
        if !target_root.exists() {
            return Err(format!(
                "Migration verification failed because target root is missing: {}",
                target_root.display()
            ));
        }

        let source_claude = source_root.join("CLAUDE.md");
        if source_claude.exists() && !target_root.join("CLAUDE.md").exists() {
            return Err(
                "Migration verification failed because CLAUDE.md was not copied".to_string(),
            );
        }

        Ok(())
    }

    fn verify_directory_copy(&self, source: &Path, target: &Path) -> Result<(), String> {
        let source_manifest = self.build_manifest(source)?;
        let target_manifest = self.build_manifest(target)?;
        for (relative_path, source_size) in source_manifest {
            match target_manifest.get(&relative_path) {
                Some(target_size) if *target_size == source_size => {}
                _ => {
                    return Err(format!(
                        "Migration verification failed for '{}' at '{}'",
                        source.display(),
                        relative_path
                    ));
                }
            }
        }
        Ok(())
    }

    fn build_manifest(&self, root: &Path) -> Result<HashMap<String, u64>, String> {
        let mut manifest = HashMap::new();
        self.collect_manifest(root, root, &mut manifest)?;
        Ok(manifest)
    }

    fn collect_manifest(
        &self,
        base: &Path,
        current: &Path,
        manifest: &mut HashMap<String, u64>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(current)
            .map_err(|e| format!("Failed to read directory '{}': {}", current.display(), e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();
            let relative = path
                .strip_prefix(base)
                .map_err(|e| format!("Failed to calculate relative path: {}", e))?;
            let relative_string = Self::normalize_relative_path(&relative.to_string_lossy());
            if self.should_skip_migration_entry(relative) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to read metadata '{}': {}", path.display(), e))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                self.collect_manifest(base, &path, manifest)?;
            } else if metadata.is_file() {
                manifest.insert(relative_string, metadata.len());
            }
        }

        Ok(())
    }

    fn copy_directory_recursive(
        &self,
        source: &Path,
        destination: &Path,
    ) -> Result<CopyStats, String> {
        self.ensure_directory_exists(destination)?;
        let mut stats = CopyStats::default();
        self.copy_directory_recursive_inner(source, source, destination, &mut stats)?;
        Ok(stats)
    }

    fn copy_workspace_shell(
        &self,
        workspace: &Workspace,
        source_root: &Path,
        destination_root: &Path,
    ) -> Result<CopyStats, String> {
        let source_root_text = source_root.to_string_lossy().to_string();
        let skipped_project_roots: Vec<String> = workspace
            .projects
            .iter()
            .filter(|project| {
                project.ssh.is_none()
                    && Self::relative_path_from_workspace(&project.path, &source_root_text)
                        .is_some()
            })
            .map(|project| Self::normalize_compare_path(&project.path))
            .collect();

        self.ensure_directory_exists(destination_root)?;
        let mut stats = CopyStats::default();
        self.copy_directory_recursive_filtered(
            source_root,
            source_root,
            destination_root,
            &skipped_project_roots,
            &mut stats,
        )?;
        Ok(stats)
    }

    fn copy_directory_recursive_inner(
        &self,
        source_root: &Path,
        source: &Path,
        destination: &Path,
        stats: &mut CopyStats,
    ) -> Result<(), String> {
        let entries = fs::read_dir(source).map_err(|e| {
            format!(
                "Failed to read source directory '{}': {}",
                source.display(),
                e
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read source entry: {}", e))?;
            let source_path = entry.path();
            let relative = source_path
                .strip_prefix(source_root)
                .map_err(|e| format!("Failed to calculate relative path: {}", e))?;
            if self.should_skip_migration_entry(relative) {
                continue;
            }

            let metadata = fs::symlink_metadata(&source_path).map_err(|e| {
                format!("Failed to read metadata '{}': {}", source_path.display(), e)
            })?;
            let destination_path = destination.join(entry.file_name());

            if metadata.file_type().is_symlink() {
                if fs::metadata(&source_path)
                    .map(|resolved| resolved.is_file())
                    .unwrap_or(false)
                {
                    let copied = fs::copy(&source_path, &destination_path).map_err(|e| {
                        format!(
                            "Failed to copy symlinked file '{}' to '{}': {}",
                            source_path.display(),
                            destination_path.display(),
                            e
                        )
                    })?;
                    stats.files += 1;
                    stats.bytes += copied;
                }
                continue;
            }

            if metadata.is_dir() {
                self.ensure_directory_exists(&destination_path)?;
                self.copy_directory_recursive_inner(
                    source_root,
                    &source_path,
                    &destination_path,
                    stats,
                )?;
            } else if metadata.is_file() {
                let copied = fs::copy(&source_path, &destination_path).map_err(|e| {
                    format!(
                        "Failed to copy file '{}' to '{}': {}",
                        source_path.display(),
                        destination_path.display(),
                        e
                    )
                })?;
                stats.files += 1;
                stats.bytes += copied;
            }
        }

        Ok(())
    }

    fn copy_directory_recursive_filtered(
        &self,
        source_root: &Path,
        source: &Path,
        destination: &Path,
        skipped_project_roots: &[String],
        stats: &mut CopyStats,
    ) -> Result<(), String> {
        let entries = fs::read_dir(source).map_err(|e| {
            format!(
                "Failed to read source directory '{}': {}",
                source.display(),
                e
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read source entry: {}", e))?;
            let source_path = entry.path();
            let relative = source_path
                .strip_prefix(source_root)
                .map_err(|e| format!("Failed to calculate relative path: {}", e))?;
            if self.should_skip_workspace_shell_entry(relative, &source_path, skipped_project_roots)
            {
                continue;
            }

            let metadata = fs::symlink_metadata(&source_path).map_err(|e| {
                format!("Failed to read metadata '{}': {}", source_path.display(), e)
            })?;
            let destination_path = destination.join(entry.file_name());

            if metadata.file_type().is_symlink() {
                if fs::metadata(&source_path)
                    .map(|resolved| resolved.is_file())
                    .unwrap_or(false)
                {
                    let copied = fs::copy(&source_path, &destination_path).map_err(|e| {
                        format!(
                            "Failed to copy symlinked file '{}' to '{}': {}",
                            source_path.display(),
                            destination_path.display(),
                            e
                        )
                    })?;
                    stats.files += 1;
                    stats.bytes += copied;
                }
                continue;
            }

            if metadata.is_dir() {
                self.ensure_directory_exists(&destination_path)?;
                self.copy_directory_recursive_filtered(
                    source_root,
                    &source_path,
                    &destination_path,
                    skipped_project_roots,
                    stats,
                )?;
            } else if metadata.is_file() {
                let copied = fs::copy(&source_path, &destination_path).map_err(|e| {
                    format!(
                        "Failed to copy file '{}' to '{}': {}",
                        source_path.display(),
                        destination_path.display(),
                        e
                    )
                })?;
                stats.files += 1;
                stats.bytes += copied;
            }
        }

        Ok(())
    }

    fn should_skip_migration_entry(&self, relative: &Path) -> bool {
        let normalized = Self::normalize_relative_path(&relative.to_string_lossy());
        if normalized == MIGRATION_PROJECTS_CSV_RELATIVE_PATH {
            return true;
        }
        relative.components().any(|component| {
            let component = component.as_os_str().to_string_lossy();
            MIGRATION_EXCLUDED_NAMES
                .iter()
                .any(|excluded| *excluded == component)
        })
    }

    fn should_skip_workspace_shell_entry(
        &self,
        relative: &Path,
        source_path: &Path,
        skipped_project_roots: &[String],
    ) -> bool {
        if self.should_skip_migration_entry(relative) {
            return true;
        }

        let normalized_source = Self::normalize_compare_path(&source_path.to_string_lossy());
        skipped_project_roots.iter().any(|project_root| {
            normalized_source == *project_root
                || normalized_source.starts_with(&(project_root.clone() + "/"))
        })
    }

    fn ensure_directory_exists(&self, path: &Path) -> Result<(), String> {
        fs::create_dir_all(path)
            .map_err(|e| format!("Failed to create directory '{}': {}", path.display(), e))
    }

    fn resolve_item_target_path(
        &self,
        plan: &WorkspaceMigrationPlan,
        item: &WorkspaceMigrationItem,
    ) -> Result<PathBuf, String> {
        let relative_path = item
            .relative_path
            .as_deref()
            .ok_or_else(|| format!("Missing relative path for '{}'", item.project_name))?;
        Ok(Self::join_relative_path(
            &self.resolve_physical_target_root(plan)?,
            relative_path,
        ))
    }

    fn write_projects_csv_for_root(
        &self,
        root_path: &Path,
        workspace: &Workspace,
    ) -> Result<(), String> {
        let ccpanes_dir = root_path.join(".ccpanes");
        fs::create_dir_all(&ccpanes_dir)
            .map_err(|e| format!("Failed to create .ccpanes directory: {}", e))?;
        let csv_path = ccpanes_dir.join("projects.csv");
        let mut lines = Vec::with_capacity(workspace.projects.len() + 1);
        lines.push("path,alias,branch,status".to_string());

        for project in &workspace.projects {
            let alias = project.alias.as_deref().unwrap_or("");
            let branch = Self::get_git_branch_for_csv(&project.path);
            let status = Self::get_git_status_for_csv(&project.path);
            lines.push(format!(
                "{},{},{},{}",
                Self::csv_escape(&project.path),
                Self::csv_escape(alias),
                branch,
                status
            ));
        }

        let mut file = fs::File::create(&csv_path)
            .map_err(|e| format!("Failed to create projects.csv: {}", e))?;
        file.write_all(lines.join("\n").as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| format!("Failed to write projects.csv: {}", e))?;
        Ok(())
    }

    fn build_external_name_map(
        projects: &[WorkspaceProject],
        workspace_root: &str,
    ) -> HashMap<String, String> {
        let mut name_counts: HashMap<String, usize> = HashMap::new();
        for project in projects.iter().filter(|project| {
            project.ssh.is_none()
                && Self::relative_path_from_workspace(&project.path, workspace_root).is_none()
        }) {
            let basename = Self::path_basename(&project.path);
            *name_counts.entry(basename).or_default() += 1;
        }

        let mut mapping = HashMap::new();
        for project in projects.iter().filter(|project| {
            project.ssh.is_none()
                && Self::relative_path_from_workspace(&project.path, workspace_root).is_none()
        }) {
            let basename = Self::path_basename(&project.path);
            let name = if name_counts.get(&basename).copied().unwrap_or(0) > 1 {
                let short_id = project.id.chars().take(8).collect::<String>();
                format!("{}--{}", basename, short_id)
            } else {
                basename
            };
            mapping.insert(project.id.clone(), name);
        }

        mapping
    }

    fn relative_path_from_workspace(project_path: &str, workspace_root: &str) -> Option<String> {
        let display_root = Self::normalize_filesystem_path(workspace_root);
        let display_project = Self::normalize_filesystem_path(project_path);
        let compare_root = Self::normalize_compare_path(workspace_root);
        let compare_project = Self::normalize_compare_path(project_path);

        if compare_project == compare_root {
            return Some(String::new());
        }

        let prefix = compare_root + "/";
        if compare_project.starts_with(&prefix) {
            let relative = display_project
                .strip_prefix(&(display_root + "/"))
                .unwrap_or("");
            return Some(relative.to_string());
        }

        None
    }

    fn normalize_wsl_root(path: &str) -> Result<String, String> {
        if !path.starts_with('/') {
            return Err("WSL migration target must be an absolute Linux path".to_string());
        }
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            Ok("/".to_string())
        } else {
            Ok(trimmed.to_string())
        }
    }

    fn join_logical_path(
        target_kind: WorkspaceMigrationTargetKind,
        root: &str,
        relative: &str,
    ) -> String {
        if relative.is_empty() {
            return root.to_string();
        }

        match target_kind {
            WorkspaceMigrationTargetKind::Local => {
                Self::join_relative_path(Path::new(root), relative)
                    .to_string_lossy()
                    .to_string()
            }
            WorkspaceMigrationTargetKind::Wsl | WorkspaceMigrationTargetKind::Ssh => {
                format!(
                    "{}/{}",
                    root.trim_end_matches('/'),
                    relative.trim_start_matches('/')
                )
            }
        }
    }

    fn join_relative_path(root: &Path, relative: &str) -> PathBuf {
        relative
            .split('/')
            .filter(|segment| !segment.is_empty())
            .fold(root.to_path_buf(), |current, segment| current.join(segment))
    }

    fn normalize_relative_path(path: &str) -> String {
        path.replace('\\', "/").trim_start_matches("./").to_string()
    }

    fn normalize_filesystem_path(path: &str) -> String {
        path.replace('\\', "/").trim_end_matches('/').to_string()
    }

    fn normalize_compare_path(path: &str) -> String {
        let normalized = Self::normalize_filesystem_path(path);
        if cfg!(windows) {
            normalized.to_lowercase()
        } else {
            normalized
        }
    }

    fn path_basename(path: &str) -> String {
        Path::new(path)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "project".to_string())
    }

    fn display_project_name(project: &WorkspaceProject) -> String {
        project
            .alias
            .clone()
            .unwrap_or_else(|| Self::path_basename(&project.path))
    }

    #[cfg(target_os = "windows")]
    fn wsl_remote_to_windows_path(distro: &str, remote_path: &str) -> PathBuf {
        let tail = remote_path.trim_start_matches('/').replace('/', "\\");
        if tail.is_empty() {
            PathBuf::from(format!("\\\\wsl$\\{}", distro))
        } else {
            PathBuf::from(format!("\\\\wsl$\\{}\\{}", distro, tail))
        }
    }

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
        self.write_projects_csv_for_root(&ws_path, ws)?;

        Ok(())
    }

    /// 同步 projects.csv 到工作空间 path 下的 .ccpanes/ 目录
    fn sync_projects_csv(&self, ws: &Workspace) {
        let ws_path = match &ws.path {
            Some(p) => PathBuf::from(p),
            None => return,
        };
        let _ = self.write_projects_csv_for_root(&ws_path, ws);
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
