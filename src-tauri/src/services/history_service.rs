use anyhow::{Context, Result};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::{
    DiffResult, FileVersion, HistoryConfig, HistoryLabel, RecentChange, WorktreeRecentChange,
};
use crate::repository::HistoryFileRepository;

type WatcherMap = Arc<Mutex<HashMap<PathBuf, RecommendedWatcher>>>;
type RepoMap = Arc<Mutex<HashMap<PathBuf, Arc<HistoryFileRepository>>>>;

/// 文件事件消息（单写者模型）
enum HistoryEvent {
    FileChanged {
        project_path: PathBuf,
        file_path: PathBuf,
        branch: String,
    },
    FileRemoved {
        project_path: PathBuf,
        file_path: PathBuf,
        branch: String,
    },
    BranchSwitched {
        project_path: PathBuf,
        old_branch: String,
        new_branch: String,
    },
}

pub struct HistoryService {
    watchers: WatcherMap,
    repos: RepoMap,
    /// 事件发送端（单写者模型）
    event_tx: std::sync::mpsc::Sender<HistoryEvent>,
    /// 分支缓存：project_path -> 当前分支名
    branch_cache: Arc<Mutex<HashMap<PathBuf, String>>>,
    /// 静默窗口：project_path -> 静默截止时间
    silence_until: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

const DEBOUNCE_MS: u64 = 500;
/// 分支切换后的静默窗口（秒），抑制 checkout 产生的文件事件
const CHECKOUT_SILENCE_SECS: u64 = 3;

impl HistoryService {
    pub fn new() -> Self {
        let repos: RepoMap = Arc::new(Mutex::new(HashMap::new()));
        let debounce_state: Arc<Mutex<HashMap<PathBuf, Instant>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let (tx, rx) = std::sync::mpsc::channel::<HistoryEvent>();

        // 启动单写者后台线程
        let repos_clone = repos.clone();
        let debounce_clone = debounce_state.clone();
        std::thread::spawn(move || {
            Self::event_loop(rx, repos_clone, debounce_clone);
        });

        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            repos,
            event_tx: tx,
            branch_cache: Arc::new(Mutex::new(HashMap::new())),
            silence_until: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 读取当前分支名（直接读 .git/HEAD 文件，~0.01ms）
    /// 支持普通仓库和 worktree 两种 .git 格式
    fn read_current_branch(project_path: &Path) -> Option<String> {
        let git_path = project_path.join(".git");
        let head_path = if git_path.is_file() {
            // Worktree: .git 是文件，内容 = "gitdir: /path/to/.git/worktrees/<name>"
            let content = fs::read_to_string(&git_path).ok()?;
            let gitdir = content.trim_start_matches("gitdir:").trim();
            let gitdir_path = if Path::new(gitdir).is_absolute() {
                PathBuf::from(gitdir)
            } else {
                project_path.join(gitdir)
            };
            gitdir_path.join("HEAD")
        } else if git_path.is_dir() {
            git_path.join("HEAD")
        } else {
            return None;
        };
        let content = fs::read_to_string(&head_path).ok()?;
        if content.starts_with("ref: refs/heads/") {
            Some(content.trim_start_matches("ref: refs/heads/").trim().to_string())
        } else {
            Some("HEAD".to_string()) // detached HEAD
        }
    }

    /// 单写者事件循环：从队列中取事件，debounce 后处理
    /// 采用 "trailing edge" debounce：收集 DEBOUNCE_MS 窗口内的事件后统一处理
    fn event_loop(
        rx: std::sync::mpsc::Receiver<HistoryEvent>,
        repos: RepoMap,
        debounce_state: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    ) {
        // 事件循环本地的静默窗口表
        let mut silence_until: HashMap<PathBuf, Instant> = HashMap::new();

        loop {
            // 等待第一个事件
            let first = match rx.recv() {
                Ok(e) => e,
                Err(_) => return, // channel 关闭
            };

            // 收集 DEBOUNCE_MS 窗口内的所有事件（trailing edge debounce）
            let mut batch = vec![first];
            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(e) => batch.push(e),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            // 分离 BranchSwitched 事件（优先处理）和文件事件
            let mut branch_events: Vec<HistoryEvent> = Vec::new();
            let mut file_events: Vec<HistoryEvent> = Vec::new();
            for event in batch {
                match &event {
                    HistoryEvent::BranchSwitched { .. } => branch_events.push(event),
                    _ => file_events.push(event),
                }
            }

            // 先处理 BranchSwitched 事件
            for event in branch_events {
                if let HistoryEvent::BranchSwitched { project_path, old_branch, new_branch } = event {
                    // 设置静默窗口
                    silence_until.insert(
                        project_path.clone(),
                        Instant::now() + Duration::from_secs(CHECKOUT_SILENCE_SECS),
                    );
                    // 创建 BranchSwitched 自动标签
                    Self::create_branch_switch_label(&repos, &project_path, &old_branch, &new_branch);
                }
            }

            // 去重文件事件：同一文件路径只保留最后一个事件
            let mut deduped: HashMap<PathBuf, HistoryEvent> = HashMap::new();
            for event in file_events {
                let key = match &event {
                    HistoryEvent::FileChanged { file_path, .. } => file_path.clone(),
                    HistoryEvent::FileRemoved { file_path, .. } => file_path.clone(),
                    _ => continue,
                };
                deduped.insert(key, event);
            }

            // 清理旧的 debounce 状态（防止内存泄漏）
            {
                let mut state = debounce_state.lock().unwrap_or_else(|e| e.into_inner());
                let cutoff = Instant::now() - Duration::from_secs(60);
                state.retain(|_, t| *t > cutoff);
            }

            // 清理过期的静默窗口
            let now = Instant::now();
            silence_until.retain(|_, t| *t > now);

            for (_file_path, event) in deduped {
                match event {
                    HistoryEvent::FileChanged {
                        project_path,
                        file_path,
                        branch,
                    } => {
                        // 检查是否在静默窗口内
                        if let Some(until) = silence_until.get(&project_path) {
                            if Instant::now() < *until {
                                continue; // 跳过 checkout 噪声事件
                            }
                        }
                        if let Err(e) =
                            Self::process_file_changed(&repos, &project_path, &file_path, &branch)
                        {
                            eprintln!("Error processing file change: {}", e);
                        }
                    }
                    HistoryEvent::FileRemoved {
                        project_path,
                        file_path,
                        branch,
                    } => {
                        // 检查是否在静默窗口内
                        if let Some(until) = silence_until.get(&project_path) {
                            if Instant::now() < *until {
                                continue;
                            }
                        }
                        if let Err(e) =
                            Self::process_file_removed(&repos, &project_path, &file_path, &branch)
                        {
                            eprintln!("Error processing file removal: {}", e);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// 创建 BranchSwitched 自动标签
    fn create_branch_switch_label(
        repos: &RepoMap,
        project_path: &Path,
        old_branch: &str,
        new_branch: &str,
    ) {
        let repo = {
            let repos = repos.lock().unwrap_or_else(|e| e.into_inner());
            match repos.get(project_path) {
                Some(r) => r.clone(),
                None => return,
            }
        };

        let label = HistoryLabel {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("Branch Switch: {} \u{2192} {}", old_branch, new_branch),
            label_type: "auto".to_string(),
            source: "branch_switch".to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            file_snapshots: Vec::new(), // 仅作为时间锚点
            branch: new_branch.to_string(),
        };
        let _ = repo.put_label(&label);
    }

    /// 处理文件变更
    fn process_file_changed(
        repos: &RepoMap,
        project_path: &Path,
        file_path: &Path,
        branch: &str,
    ) -> Result<()> {
        if file_path.is_dir() {
            return Ok(());
        }

        let relative_path = file_path
            .strip_prefix(project_path)
            .context("Failed to get relative path")?;
        let relative_str = relative_path.to_string_lossy().replace('\\', "/");

        let repo = {
            let repos = repos.lock().unwrap_or_else(|e| e.into_inner());
            match repos.get(project_path) {
                Some(r) => r.clone(),
                None => return Ok(()),
            }
        };

        let config = repo.read_config()?;
        if !config.history.enabled {
            return Ok(());
        }
        if Self::should_ignore(&relative_str, &config.history.ignore_patterns) {
            return Ok(());
        }

        // 检查文件是否在项目目录内（符号链接保护）
        if let Ok(canonical) = file_path.canonicalize() {
            if let Ok(proj_canonical) = project_path.canonicalize() {
                if !canonical.starts_with(&proj_canonical) {
                    return Ok(());
                }
            }
        }

        // 先检查文件大小（避免超大文件整读入内存）
        if let Ok(meta) = fs::metadata(file_path) {
            if meta.len() > config.history.max_file_size {
                return Ok(());
            }
        }

        if let Ok(content) = fs::read(file_path) {
            // 二进制文件检测
            if HistoryFileRepository::is_binary(&content) {
                return Ok(());
            }

            let _ = repo.save_version(&relative_str, &content, false, branch);
        }

        Ok(())
    }

    /// 处理文件删除
    fn process_file_removed(
        repos: &RepoMap,
        project_path: &Path,
        file_path: &Path,
        branch: &str,
    ) -> Result<()> {
        let relative_path = file_path
            .strip_prefix(project_path)
            .context("Failed to get relative path")?;
        let relative_str = relative_path.to_string_lossy().replace('\\', "/");

        let repo = {
            let repos = repos.lock().unwrap_or_else(|e| e.into_inner());
            match repos.get(project_path) {
                Some(r) => r.clone(),
                None => return Ok(()),
            }
        };

        let config = repo.read_config()?;
        if !config.history.enabled {
            return Ok(());
        }
        if Self::should_ignore(&relative_str, &config.history.ignore_patterns) {
            return Ok(());
        }

        // 获取最新版本内容，保存一个 is_deleted=true 的快照
        let versions = repo.list_versions(&relative_str)?;
        if let Some(last_ver) = versions.last() {
            if let Ok(content) = repo.get_version_content(&relative_str, &last_ver.id) {
                let _ = repo.save_version(&relative_str, &content, true, branch);
            }
        }

        Ok(())
    }

    /// 获取或创建项目的仓库实例
    fn get_or_create_repo(&self, project_path: &Path) -> Result<Arc<HistoryFileRepository>> {
        let mut repos = self.repos.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(repo) = repos.get(project_path) {
            return Ok(repo.clone());
        }

        let repo = Arc::new(HistoryFileRepository::open(project_path)?);
        repos.insert(project_path.to_path_buf(), repo.clone());
        Ok(repo)
    }

    /// 初始化项目历史记录
    pub fn init_project_history(&self, project_path: &Path) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.init_history_dir()?;
        self.start_watching(project_path)?;
        Ok(())
    }

    /// 获取配置
    pub fn get_config(&self, project_path: &Path) -> Result<HistoryConfig> {
        let repo = self.get_or_create_repo(project_path)?;
        let config = repo.read_config()?;
        Ok(config.history)
    }

    /// 更新配置
    pub fn update_config(
        &self,
        project_path: &Path,
        history_config: HistoryConfig,
    ) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        let mut config = repo.read_config()?;
        config.history = history_config;
        repo.save_config(&config)
    }

    /// 启动文件监控
    pub fn start_watching(&self, project_path: &Path) -> Result<()> {
        let project_path = project_path.to_path_buf();

        // 确保 repo 已创建
        self.get_or_create_repo(&project_path)?;

        // 初始化分支缓存
        if let Some(branch) = Self::read_current_branch(&project_path) {
            let mut cache = self.branch_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(project_path.clone(), branch);
        }

        let project_path_clone = project_path.clone();
        let tx = self.event_tx.clone();
        let branch_cache = self.branch_cache.clone();
        let silence_until = self.silence_until.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    Self::dispatch_event(&project_path_clone, event, &tx, &branch_cache, &silence_until);
                }
            },
            Config::default(),
        )
        .context("Failed to create file watcher")?;

        watcher
            .watch(&project_path, RecursiveMode::Recursive)
            .context("Failed to start watching")?;

        let mut watchers = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        watchers.insert(project_path, watcher);

        Ok(())
    }

    /// 停止文件监控
    pub fn stop_watching(&self, project_path: &Path) -> Result<()> {
        let mut watchers = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        watchers.remove(project_path);
        Ok(())
    }

    /// 分发文件事件到队列，检测分支切换
    fn dispatch_event(
        project_path: &Path,
        event: Event,
        tx: &std::sync::mpsc::Sender<HistoryEvent>,
        branch_cache: &Arc<Mutex<HashMap<PathBuf, String>>>,
        silence_until: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    ) {
        use notify::EventKind;

        // 读取当前分支并检测是否切换
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();
        {
            let mut cache = branch_cache.lock().unwrap_or_else(|e| e.into_inner());
            let cached = cache.get(project_path).cloned().unwrap_or_default();
            if !cached.is_empty() && cached != current_branch {
                // 分支切换！发送 BranchSwitched 事件
                let _ = tx.send(HistoryEvent::BranchSwitched {
                    project_path: project_path.to_path_buf(),
                    old_branch: cached,
                    new_branch: current_branch.clone(),
                });
                cache.insert(project_path.to_path_buf(), current_branch.clone());

                // 设置静默窗口
                let mut silence = silence_until.lock().unwrap_or_else(|e| e.into_inner());
                silence.insert(
                    project_path.to_path_buf(),
                    Instant::now() + Duration::from_secs(CHECKOUT_SILENCE_SECS),
                );
                return; // 分支切换事件已发送，不再处理文件事件
            }
            if cached.is_empty() {
                cache.insert(project_path.to_path_buf(), current_branch.clone());
            }
        }

        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {
                for path in event.paths {
                    let _ = tx.send(HistoryEvent::FileChanged {
                        project_path: project_path.to_path_buf(),
                        file_path: path,
                        branch: current_branch.clone(),
                    });
                }
            }
            EventKind::Remove(_) => {
                for path in event.paths {
                    let _ = tx.send(HistoryEvent::FileRemoved {
                        project_path: project_path.to_path_buf(),
                        file_path: path,
                        branch: current_branch.clone(),
                    });
                }
            }
            _ => {}
        }
    }

    /// 检查文件是否应该忽略
    fn should_ignore(path: &str, patterns: &[String]) -> bool {
        for pattern in patterns {
            if Self::matches_pattern(path, pattern) {
                return true;
            }
        }
        false
    }

    /// 简单的 glob 模式匹配
    fn matches_pattern(path: &str, pattern: &str) -> bool {
        if pattern.ends_with("/**") {
            let prefix = &pattern[..pattern.len() - 3];
            // 精确匹配目录前缀，避免 "target2/foo" 误匹配 "target/**"
            return path == prefix || path.starts_with(&format!("{}/", prefix));
        }
        if pattern.starts_with("*.") {
            let ext = &pattern[1..];
            return path.ends_with(ext);
        }
        path == pattern || path.starts_with(&format!("{}/", pattern))
    }

    /// 列出文件版本
    pub fn list_versions(
        &self,
        project_path: &Path,
        file_path: &str,
    ) -> Result<Vec<FileVersion>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.list_versions(file_path)
    }

    /// 获取版本内容
    pub fn get_version_content(
        &self,
        project_path: &Path,
        file_path: &str,
        version_id: &str,
    ) -> Result<Vec<u8>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.get_version_content(file_path, version_id)
    }

    /// 恢复文件到指定版本（恢复前自动打标签）
    pub fn restore_version(
        &self,
        project_path: &Path,
        file_path: &str,
        version_id: &str,
    ) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;

        // 恢复前自动打 "Before Restore" 标签
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();
        let snapshots = repo.get_all_latest_snapshots()?;
        if !snapshots.is_empty() {
            let label = HistoryLabel {
                id: uuid::Uuid::new_v4().to_string(),
                name: format!("Before Restore: {}", file_path),
                label_type: "auto".to_string(),
                source: "restore".to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                file_snapshots: snapshots,
                branch: current_branch,
            };
            let _ = repo.put_label(&label);
        }

        let content = repo.get_version_content(file_path, version_id)?;
        let full_path = project_path.join(file_path.replace('/', std::path::MAIN_SEPARATOR_STR));

        // 确保父目录存在（恢复已删除文件时需要）
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).context("Failed to create parent directory")?;
        }

        fs::write(&full_path, &content).context("Failed to restore file")?;
        Ok(())
    }

    /// 清理旧版本
    pub fn cleanup(&self, project_path: &Path) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        let config = repo.read_config()?;
        repo.cleanup_old_versions(&config.history)?;
        repo.cleanup_by_total_size(config.history.max_total_size)?;
        Ok(())
    }

    // ============ Diff ============

    /// 获取版本与当前文件的 diff
    pub fn get_version_diff(
        &self,
        project_path: &Path,
        file_path: &str,
        version_id: &str,
    ) -> Result<DiffResult> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.get_version_diff(file_path, version_id)
    }

    /// 获取两个版本之间的 diff
    pub fn get_versions_diff(
        &self,
        project_path: &Path,
        file_path: &str,
        old_version_id: &str,
        new_version_id: &str,
    ) -> Result<DiffResult> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.get_versions_diff(file_path, old_version_id, new_version_id)
    }

    // ============ 标签 ============

    /// 创建标签
    pub fn put_label(&self, project_path: &Path, label: &HistoryLabel) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.put_label(label)
    }

    /// 列出标签
    pub fn list_labels(&self, project_path: &Path) -> Result<Vec<HistoryLabel>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.list_labels()
    }

    /// 删除标签
    pub fn delete_label(&self, project_path: &Path, label_id: &str) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.delete_label(label_id)
    }

    /// 恢复到标签（Session 级回滚）
    pub fn restore_to_label(&self, project_path: &Path, label_id: &str) -> Result<Vec<String>> {
        let repo = self.get_or_create_repo(project_path)?;

        // 恢复前自动打 "Before Rollback" 标签
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();
        let current_snapshots = repo.get_all_latest_snapshots()?;
        if !current_snapshots.is_empty() {
            let before_label = HistoryLabel {
                id: uuid::Uuid::new_v4().to_string(),
                name: "Before Rollback".to_string(),
                label_type: "auto".to_string(),
                source: "restore".to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                file_snapshots: current_snapshots,
                branch: current_branch,
            };
            repo.put_label(&before_label)?;
        }

        // 获取目标标签
        let labels = repo.list_labels()?;
        let target_label = labels
            .into_iter()
            .find(|l| l.id == label_id)
            .context("Label not found")?;

        let mut restored_files = Vec::new();
        for snap in &target_label.file_snapshots {
            if let Ok(content) = repo.get_version_content(&snap.file_path, &snap.version_id) {
                let full_path = project_path
                    .join(snap.file_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                if let Some(parent) = full_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::write(&full_path, &content).is_ok() {
                    restored_files.push(snap.file_path.clone());
                }
            }
        }

        Ok(restored_files)
    }

    /// 创建自动标签（快捷方法）
    pub fn create_auto_label(
        &self,
        project_path: &Path,
        name: &str,
        source: &str,
    ) -> Result<String> {
        let repo = self.get_or_create_repo(project_path)?;
        let snapshots = repo.get_all_latest_snapshots()?;
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();

        let label_id = uuid::Uuid::new_v4().to_string();
        let label = HistoryLabel {
            id: label_id.clone(),
            name: name.to_string(),
            label_type: "auto".to_string(),
            source: source.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            file_snapshots: snapshots,
            branch: current_branch,
        };
        repo.put_label(&label)?;
        Ok(label_id)
    }

    // ============ 目录级查询 ============

    pub fn list_directory_changes(
        &self,
        project_path: &Path,
        dir_path: &str,
        since: Option<&str>,
    ) -> Result<Vec<FileVersion>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.list_directory_changes(dir_path, since)
    }

    pub fn get_recent_changes(
        &self,
        project_path: &Path,
        limit: usize,
    ) -> Result<Vec<RecentChange>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.get_recent_changes(limit)
    }

    // ============ 删除文件 ============

    pub fn list_deleted_files(&self, project_path: &Path) -> Result<Vec<FileVersion>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.list_deleted_files()
    }

    // ============ 压缩 ============

    pub fn compress_blobs(&self, project_path: &Path) -> Result<usize> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.compress_blobs()
    }

    // ============ 分支感知查询 ============

    /// 获取当前分支名
    pub fn get_current_branch(&self, project_path: &Path) -> Result<String> {
        Ok(Self::read_current_branch(project_path).unwrap_or_default())
    }

    /// 获取文件有版本的所有分支列表
    pub fn get_file_branches(
        &self,
        project_path: &Path,
        file_path: &str,
    ) -> Result<Vec<String>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.get_file_branches(file_path)
    }

    /// 按分支列出文件版本
    pub fn list_versions_by_branch(
        &self,
        project_path: &Path,
        file_path: &str,
        branch: &str,
    ) -> Result<Vec<FileVersion>> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.list_versions_by_branch(file_path, branch)
    }

    // ============ 跨 Worktree 聚合 ============

    /// 聚合所有 worktree 的最近变更
    pub fn list_worktree_recent_changes(
        &self,
        project_path: &Path,
        limit: usize,
    ) -> Result<Vec<WorktreeRecentChange>> {
        let mut all_changes: Vec<WorktreeRecentChange> = Vec::new();

        // 1. 判断当前项目是主仓库还是 worktree
        let git_path = project_path.join(".git");
        let is_main = git_path.is_dir(); // .git 是目录 = 主仓库，是文件 = worktree

        // 当前项目自身的变更
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();
        let repo = self.get_or_create_repo(project_path)?;
        let changes = repo.get_recent_changes(limit)?;
        for change in changes {
            all_changes.push(WorktreeRecentChange {
                worktree_path: project_path.to_string_lossy().to_string(),
                worktree_branch: current_branch.clone(),
                is_main,
                change,
            });
        }

        // 2. 发现其他 worktree
        let worktrees_dir = if git_path.is_dir() {
            // 普通仓库：.git/worktrees/
            git_path.join("worktrees")
        } else if git_path.is_file() {
            // 当前已经是 worktree，找到主仓库的 worktrees 目录
            if let Ok(content) = fs::read_to_string(&git_path) {
                let gitdir = content.trim_start_matches("gitdir:").trim();
                let gitdir_path = if Path::new(gitdir).is_absolute() {
                    PathBuf::from(gitdir)
                } else {
                    project_path.join(gitdir)
                };
                // 从 .git/worktrees/<name> 回到 .git/worktrees/
                if let Some(worktrees_parent) = gitdir_path.parent() {
                    // 新增：发现主仓库并聚合其变更
                    // worktrees_parent = .git/worktrees/
                    if let Some(git_dir) = worktrees_parent.parent() {
                        // git_dir = .git/
                        if let Some(main_repo_dir) = git_dir.parent() {
                            // main_repo_dir = 主仓库根目录
                            if main_repo_dir != project_path {
                                if let Ok(main_repo) = HistoryFileRepository::open_readonly(main_repo_dir) {
                                    let main_branch = Self::read_current_branch(main_repo_dir).unwrap_or_default();
                                    if let Ok(main_changes) = main_repo.get_recent_changes(limit) {
                                        for change in main_changes {
                                            all_changes.push(WorktreeRecentChange {
                                                worktree_path: main_repo_dir.to_string_lossy().to_string(),
                                                worktree_branch: main_branch.clone(),
                                                is_main: true,
                                                change,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    worktrees_parent.to_path_buf()
                } else {
                    return Ok(all_changes);
                }
            } else {
                return Ok(all_changes);
            }
        } else {
            return Ok(all_changes);
        };

        if !worktrees_dir.exists() {
            // 排序后截断
            all_changes.sort_by(|a, b| b.change.timestamp.cmp(&a.change.timestamp));
            all_changes.truncate(limit);
            return Ok(all_changes);
        }

        // 遍历 worktrees 目录中的每个 worktree
        if let Ok(entries) = fs::read_dir(&worktrees_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let wt_dir = entry.path();
                if !wt_dir.is_dir() {
                    continue;
                }

                // 读取 worktree 的 gitdir 文件找到工作目录路径
                let gitdir_file = wt_dir.join("gitdir");
                if let Ok(gitdir_content) = fs::read_to_string(&gitdir_file) {
                    let work_dir_str = gitdir_content.trim();
                    // gitdir 文件内容指向 worktree 中的 .git 文件所在位置
                    let work_dir = PathBuf::from(work_dir_str);
                    let work_dir = if work_dir.ends_with(".git") {
                        work_dir.parent().unwrap_or(&work_dir).to_path_buf()
                    } else {
                        work_dir
                    };

                    // 跳过当前项目自身
                    if work_dir == project_path {
                        continue;
                    }

                    // 尝试只读打开该 worktree 的历史数据库
                    if let Ok(wt_repo) = HistoryFileRepository::open_readonly(&work_dir) {
                        let wt_branch = Self::read_current_branch(&work_dir).unwrap_or_default();
                        if let Ok(wt_changes) = wt_repo.get_recent_changes(limit) {
                            for change in wt_changes {
                                all_changes.push(WorktreeRecentChange {
                                    worktree_path: work_dir.to_string_lossy().to_string(),
                                    worktree_branch: wt_branch.clone(),
                                    is_main: false,
                                    change,
                                });
                            }
                        }
                    }
                }
            }
        }

        // 按时间倒序排序，截断到 limit
        all_changes.sort_by(|a, b| b.change.timestamp.cmp(&a.change.timestamp));
        all_changes.truncate(limit);
        Ok(all_changes)
    }
}
