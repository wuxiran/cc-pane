use anyhow::{Context, Result};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tracing::{info, warn};

use crate::constants::history::{BUILTIN_IGNORE_PATTERNS, CHECKOUT_SILENCE_SECS, DEBOUNCE_MS};
use crate::models::{
    DiffResult, FileVersion, HistoryConfig, HistoryLabel, RecentChange, WorktreeRecentChange,
};
use crate::repository::HistoryFileRepository;
use crate::utils::{normalize_project_path, paths_equivalent};

type WatcherMap = Arc<Mutex<HashMap<PathBuf, RecommendedWatcher>>>;
type RepoMap = Arc<Mutex<HashMap<PathBuf, Arc<HistoryFileRepository>>>>;
type HistoryEventBatch = Vec<HistoryEvent>;
type HistoryEventSender = SyncSender<HistoryEventBatch>;

const HISTORY_EVENT_BUFFER_CAPACITY: usize = 30_000;
const DEBOUNCE_BATCH_PATH_LIMIT: usize = 128;

fn equivalent_path_key<T>(map: &HashMap<PathBuf, T>, path: &Path) -> Option<PathBuf> {
    map.keys().find(|key| paths_equivalent(key, path)).cloned()
}

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

#[derive(Default)]
struct DebounceBatch {
    events: Vec<HistoryEvent>,
    file_paths: HashSet<PathBuf>,
    overflowed: bool,
}

impl DebounceBatch {
    /// 返回 true 表示本次追加首次触发上限，调用方应记录一次 warn。
    fn push(&mut self, mut events: HistoryEventBatch) -> bool {
        if self.overflowed {
            return false;
        }

        for event in &events {
            let file_path = match event {
                HistoryEvent::FileChanged { file_path, .. }
                | HistoryEvent::FileRemoved { file_path, .. } => file_path,
                HistoryEvent::BranchSwitched { .. } => continue,
            };
            self.file_paths.insert(file_path.clone());
            if self.file_paths.len() > DEBOUNCE_BATCH_PATH_LIMIT {
                self.events.clear();
                self.file_paths.clear();
                self.overflowed = true;
                return true;
            }
        }

        self.events.append(&mut events);
        false
    }

    fn into_events(self) -> Option<Vec<HistoryEvent>> {
        (!self.overflowed).then_some(self.events)
    }
}

/// 非阻塞地整批入队。返回 true 表示本次超限需要记录首次 warn。
fn enqueue_history_batch(
    tx: &HistoryEventSender,
    batch: HistoryEventBatch,
    overflow_warned: &AtomicBool,
) -> bool {
    if batch.is_empty() {
        return false;
    }

    match tx.try_send(batch) {
        Ok(()) => false,
        Err(TrySendError::Full(_)) => !overflow_warned.swap(true, Ordering::Relaxed),
        Err(TrySendError::Disconnected(_)) => {
            warn!("history event channel disconnected; dropping event batch");
            false
        }
    }
}

pub struct HistoryService {
    watchers: WatcherMap,
    repos: RepoMap,
    /// 事件发送端（单写者模型）
    event_tx: HistoryEventSender,
    /// 通道首次溢出后不再重复告警，避免洪峰期间刷日志
    event_overflow_warned: Arc<AtomicBool>,
    /// 分支缓存：project_path -> 当前分支名
    branch_cache: Arc<Mutex<HashMap<PathBuf, String>>>,
    /// 静默窗口：project_path -> 静默截止时间
    silence_until: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl Default for HistoryService {
    fn default() -> Self {
        Self::new()
    }
}

impl HistoryService {
    pub fn new() -> Self {
        let repos: RepoMap = Arc::new(Mutex::new(HashMap::new()));
        let debounce_state: Arc<Mutex<HashMap<PathBuf, Instant>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let (tx, rx) =
            std::sync::mpsc::sync_channel::<HistoryEventBatch>(HISTORY_EVENT_BUFFER_CAPACITY);

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
            event_overflow_warned: Arc::new(AtomicBool::new(false)),
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
            Some(
                content
                    .trim_start_matches("ref: refs/heads/")
                    .trim()
                    .to_string(),
            )
        } else {
            Some("HEAD".to_string()) // detached HEAD
        }
    }

    /// 单写者事件循环：从队列中取事件，debounce 后处理
    /// 采用 "trailing edge" debounce：收集 DEBOUNCE_MS 窗口内的事件后统一处理
    fn event_loop(
        rx: Receiver<HistoryEventBatch>,
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
            let mut batch = DebounceBatch::default();
            if batch.push(first) {
                warn!(
                    limit = DEBOUNCE_BATCH_PATH_LIMIT,
                    "history debounce batch exceeded path limit; dropping entire batch"
                );
            }
            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(events) => {
                        if batch.push(events) {
                            warn!(
                                limit = DEBOUNCE_BATCH_PATH_LIMIT,
                                "history debounce batch exceeded path limit; dropping entire batch"
                            );
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            let Some(batch) = batch.into_events() else {
                continue;
            };

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
                if let HistoryEvent::BranchSwitched {
                    project_path,
                    old_branch,
                    new_branch,
                } = event
                {
                    // 设置静默窗口
                    silence_until.insert(
                        project_path.clone(),
                        Instant::now() + Duration::from_secs(CHECKOUT_SILENCE_SECS),
                    );
                    // 创建 BranchSwitched 自动标签
                    Self::create_branch_switch_label(
                        &repos,
                        &project_path,
                        &old_branch,
                        &new_branch,
                    );
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
                            warn!("Error processing file change: {}", e);
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
                            warn!("Error processing file removal: {}", e);
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

        let Some(relative_path) = Self::relative_to_project(file_path, project_path) else {
            warn!(
                project_path = %project_path.display(),
                file_path = %file_path.display(),
                "history: file change path is outside project"
            );
            return Ok(());
        };
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

            if let Err(e) = repo.save_version(
                &relative_str,
                &content,
                false,
                branch,
                config.history.min_save_interval_secs,
            ) {
                // 编辑历史快照落库失败不能静默——否则用户以为有恢复点实际没有
                warn!("history: save_version failed for {relative_str}: {e}");
            }
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
        let Some(relative_path) = Self::relative_to_project(file_path, project_path) else {
            warn!(
                project_path = %project_path.display(),
                file_path = %file_path.display(),
                "history: removed file path is outside project"
            );
            return Ok(());
        };
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
                if let Err(e) = repo.save_version(&relative_str, &content, true, branch, 0) {
                    warn!("history: delete-tombstone save failed for {relative_str}: {e}");
                }
            }
        }

        Ok(())
    }

    /// 获取或创建项目的仓库实例
    fn get_or_create_repo(&self, project_path: &Path) -> Result<Arc<HistoryFileRepository>> {
        let project_path = normalize_project_path(project_path);
        let mut repos = self.repos.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = equivalent_path_key(&repos, &project_path) {
            let repo = repos.get(&key).expect("equivalent repo key must exist");
            return Ok(repo.clone());
        }

        let repo = Arc::new(HistoryFileRepository::open(&project_path)?);
        repos.insert(project_path, repo.clone());
        Ok(repo)
    }

    fn relative_to_project(file_path: &Path, project_path: &Path) -> Option<PathBuf> {
        let file_path = normalize_project_path(file_path);
        let project_path = normalize_project_path(project_path);

        if let Ok(relative) = file_path.strip_prefix(&project_path) {
            return Some(relative.to_path_buf());
        }

        let file = file_path.to_string_lossy().replace('\\', "/");
        let project = project_path.to_string_lossy().replace('\\', "/");
        if !Self::is_absolute_drive_path(&file) || !Self::is_absolute_drive_path(&project) {
            return None;
        }

        let file_components: Vec<&str> = file.split('/').filter(|part| !part.is_empty()).collect();
        let project_components: Vec<&str> =
            project.split('/').filter(|part| !part.is_empty()).collect();
        if project_components.len() > file_components.len()
            || file_components
                .iter()
                .chain(project_components.iter())
                .any(|part| *part == "." || *part == "..")
            || !project_components
                .iter()
                .zip(&file_components)
                .all(|(project, file)| project.eq_ignore_ascii_case(file))
        {
            return None;
        }

        Some(PathBuf::from(
            file_components[project_components.len()..].join("/"),
        ))
    }

    fn is_absolute_drive_path(path: &str) -> bool {
        let bytes = path.as_bytes();
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    }

    /// 初始化项目历史记录
    pub fn init_project_history(&self, project_path: &Path) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        repo.init_history_dir()?;
        Ok(())
    }

    /// 获取配置
    pub fn get_config(&self, project_path: &Path) -> Result<HistoryConfig> {
        let repo = self.get_or_create_repo(project_path)?;
        let config = repo.read_config()?;
        Ok(config.history)
    }

    /// 更新配置
    pub fn update_config(&self, project_path: &Path, history_config: HistoryConfig) -> Result<()> {
        let repo = self.get_or_create_repo(project_path)?;
        let mut config = repo.read_config()?;
        config.history = history_config;
        repo.save_config(&config)
    }

    /// 启动文件监控
    pub fn start_watching(&self, project_path: &Path) -> Result<()> {
        let project_path = normalize_project_path(project_path);

        // 确保 repo 已创建
        self.get_or_create_repo(&project_path)?;
        let project_path = {
            let repos = self.repos.lock().unwrap_or_else(|e| e.into_inner());
            equivalent_path_key(&repos, &project_path).unwrap_or(project_path)
        };

        // double-check 必须在 watcher 锁内完成，否则并发启动仍会各自创建内核 watcher。
        let mut watchers = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if equivalent_path_key(&watchers, &project_path).is_some() {
            return Ok(());
        }

        // 初始化分支缓存
        if let Some(branch) = Self::read_current_branch(&project_path) {
            let mut cache = self.branch_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(project_path.clone(), branch);
        }

        let project_path_clone = project_path.clone();
        let tx = self.event_tx.clone();
        let event_overflow_warned = self.event_overflow_warned.clone();
        let branch_cache = self.branch_cache.clone();
        let silence_until = self.silence_until.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                Self::handle_notify_result(
                    &project_path_clone,
                    res,
                    &tx,
                    &branch_cache,
                    &silence_until,
                    &event_overflow_warned,
                );
            },
            Config::default(),
        )
        .context("Failed to create file watcher")?;

        watcher
            .watch(&project_path, RecursiveMode::Recursive)
            .context("Failed to start watching")?;

        watchers.insert(project_path, watcher);

        Ok(())
    }

    /// 停止文件监控
    pub fn stop_watching(&self, project_path: &Path) -> Result<()> {
        let project_path = normalize_project_path(project_path);
        let mut watchers = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = equivalent_path_key(&watchers, &project_path) {
            watchers.remove(&key);
        }
        drop(watchers);
        let mut branch_cache = self.branch_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = equivalent_path_key(&branch_cache, &project_path) {
            branch_cache.remove(&key);
        }
        drop(branch_cache);
        let mut silence_until = self.silence_until.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(key) = equivalent_path_key(&silence_until, &project_path) {
            silence_until.remove(&key);
        }
        Ok(())
    }

    pub fn is_watching(&self, project_path: &Path) -> bool {
        let project_path = normalize_project_path(project_path);
        self.watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .any(|key| paths_equivalent(key, &project_path))
    }

    pub fn watcher_count(&self) -> usize {
        self.watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// 停止所有文件监控（应用退出时调用）
    pub fn stop_all_watching(&self) {
        let mut watchers = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        let count = watchers.len();
        watchers.clear();
        if count > 0 {
            info!("[cleanup] stopped {} file watchers", count);
        }
    }

    /// 分发文件事件到队列，检测分支切换
    fn handle_notify_result(
        project_path: &Path,
        result: Result<Event, notify::Error>,
        tx: &HistoryEventSender,
        branch_cache: &Arc<Mutex<HashMap<PathBuf, String>>>,
        silence_until: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
        overflow_warned: &AtomicBool,
    ) {
        match result {
            Ok(event) if event.need_rescan() => {
                warn!(
                    project = %project_path.display(),
                    "history watcher requested rescan; ignoring event"
                );
            }
            Ok(event) => Self::dispatch_event(
                project_path,
                event,
                tx,
                branch_cache,
                silence_until,
                overflow_warned,
            ),
            Err(error) => {
                warn!(
                    project = %project_path.display(),
                    error = %error,
                    "history watcher error; ignoring event"
                );
            }
        }
    }

    fn dispatch_event(
        project_path: &Path,
        event: Event,
        tx: &HistoryEventSender,
        branch_cache: &Arc<Mutex<HashMap<PathBuf, String>>>,
        silence_until: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
        overflow_warned: &AtomicBool,
    ) {
        use notify::EventKind;

        // 读取当前分支并检测是否切换。
        // read 失败返回空串——git 在很多操作中非原子重写 .git/HEAD，瞬时读不到
        // 时若把空串当成"切到空分支"，会伪造一次 BranchSwitched 并开静默窗口
        // 丢掉真实编辑。空串表示"未知"，此时跳过切换检测，保留缓存分支。
        let current_branch = Self::read_current_branch(project_path).unwrap_or_default();
        if !current_branch.is_empty() {
            let mut cache = branch_cache.lock().unwrap_or_else(|e| e.into_inner());
            let cached = cache.get(project_path).cloned().unwrap_or_default();
            if !cached.is_empty() && cached != current_branch {
                // 分支切换！发送 BranchSwitched 事件
                if enqueue_history_batch(
                    tx,
                    vec![HistoryEvent::BranchSwitched {
                        project_path: project_path.to_path_buf(),
                        old_branch: cached,
                        new_branch: current_branch.clone(),
                    }],
                    overflow_warned,
                ) {
                    warn!(
                        capacity = HISTORY_EVENT_BUFFER_CAPACITY,
                        "history event channel full; dropping entire event batch"
                    );
                }
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

        let mut event = event;
        event
            .paths
            .retain(|path| !Self::is_builtin_ignored_event_path(project_path, path));
        if event.paths.is_empty() {
            return;
        }

        let events = match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => event
                .paths
                .into_iter()
                .map(|path| HistoryEvent::FileChanged {
                    project_path: project_path.to_path_buf(),
                    file_path: path,
                    branch: current_branch.clone(),
                })
                .collect(),
            EventKind::Remove(_) => event
                .paths
                .into_iter()
                .map(|path| HistoryEvent::FileRemoved {
                    project_path: project_path.to_path_buf(),
                    file_path: path,
                    branch: current_branch.clone(),
                })
                .collect(),
            _ => return,
        };

        if enqueue_history_batch(tx, events, overflow_warned) {
            warn!(
                capacity = HISTORY_EVENT_BUFFER_CAPACITY,
                "history event channel full; dropping entire event batch"
            );
        }
    }

    /// 检查文件是否应该忽略
    fn should_ignore(path: &str, patterns: &[String]) -> bool {
        BUILTIN_IGNORE_PATTERNS
            .iter()
            .any(|pattern| Self::matches_pattern(path, pattern))
            || patterns
                .iter()
                .any(|pattern| Self::matches_pattern(path, pattern))
    }

    fn is_builtin_ignored_event_path(project_path: &Path, file_path: &Path) -> bool {
        let Some(relative) = Self::relative_to_project(file_path, project_path) else {
            return false;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let Some(first) = relative.split('/').next() else {
            return false;
        };

        BUILTIN_IGNORE_PATTERNS.iter().any(|pattern| {
            pattern
                .strip_suffix("/**")
                .is_some_and(|directory| directory == first)
        })
    }

    /// 简单的 glob 模式匹配
    fn matches_pattern(path: &str, pattern: &str) -> bool {
        if let Some(prefix) = pattern.strip_suffix("/**") {
            if !prefix.contains('/') {
                return path.split('/').any(|component| component == prefix);
            }
            // 含路径的目录模式保持根锚定，避免扩大已有自定义规则的范围。
            return path == prefix || path.starts_with(&format!("{prefix}/"));
        }
        if let Some(ext) = pattern.strip_prefix("*.") {
            // 按扩展名边界匹配：`*.js` 只匹配 `.js` 结尾，不能连带 `.mjs`/`.cjs`；
            // `*.log` 不能误伤 `changelog`/`catalog`。
            return path.ends_with(&format!(".{ext}"));
        }
        if !pattern.contains('/') {
            return path.split('/').any(|component| component == pattern);
        }
        path == pattern || path.starts_with(&format!("{pattern}/"))
    }

    /// 列出文件版本
    pub fn list_versions(&self, project_path: &Path, file_path: &str) -> Result<Vec<FileVersion>> {
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
                let full_path =
                    project_path.join(snap.file_path.replace('/', std::path::MAIN_SEPARATOR_STR));
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
    pub fn get_file_branches(&self, project_path: &Path, file_path: &str) -> Result<Vec<String>> {
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
        let project_path = normalize_project_path(project_path);
        let mut all_changes: Vec<WorktreeRecentChange> = Vec::new();

        // 1. 判断当前项目是主仓库还是 worktree
        let git_path = project_path.join(".git");
        let is_main = git_path.is_dir(); // .git 是目录 = 主仓库，是文件 = worktree

        // 当前项目自身的变更
        let current_branch = Self::read_current_branch(&project_path).unwrap_or_default();
        let repo = self.get_or_create_repo(&project_path)?;
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
                let gitdir_path = normalize_project_path(gitdir_path);
                // 从 .git/worktrees/<name> 回到 .git/worktrees/
                if let Some(worktrees_parent) = gitdir_path.parent() {
                    // 新增：发现主仓库并聚合其变更
                    // worktrees_parent = .git/worktrees/
                    if let Some(git_dir) = worktrees_parent.parent() {
                        // git_dir = .git/
                        if let Some(main_repo_dir) = git_dir.parent() {
                            let main_repo_dir = normalize_project_path(main_repo_dir);
                            // main_repo_dir = 主仓库根目录
                            if !paths_equivalent(&main_repo_dir, &project_path) {
                                if let Ok(main_repo) =
                                    HistoryFileRepository::open_readonly(&main_repo_dir)
                                {
                                    let main_branch = Self::read_current_branch(&main_repo_dir)
                                        .unwrap_or_default();
                                    if let Ok(main_changes) = main_repo.get_recent_changes(limit) {
                                        for change in main_changes {
                                            all_changes.push(WorktreeRecentChange {
                                                worktree_path: main_repo_dir
                                                    .to_string_lossy()
                                                    .to_string(),
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
            all_changes
                .sort_by_cached_key(|change| std::cmp::Reverse(change.change.timestamp.clone()));
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
                    let work_dir = normalize_project_path(work_dir);

                    // 跳过当前项目自身
                    if paths_equivalent(&work_dir, &project_path) {
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
        all_changes.sort_by_cached_key(|change| std::cmp::Reverse(change.change.timestamp.clone()));
        all_changes.truncate(limit);
        Ok(all_changes)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        enqueue_history_batch, equivalent_path_key, DebounceBatch, HistoryEvent, HistoryService,
        DEBOUNCE_BATCH_PATH_LIMIT,
    };
    use notify::{event::Flag, Event, EventKind};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    fn file_changed(path: impl Into<PathBuf>) -> HistoryEvent {
        HistoryEvent::FileChanged {
            project_path: PathBuf::from("/project"),
            file_path: path.into(),
            branch: "main".to_string(),
        }
    }

    #[test]
    fn bounded_event_channel_drops_overflowing_batch_and_warns_once() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let overflow_warned = AtomicBool::new(false);

        assert!(!enqueue_history_batch(
            &tx,
            vec![file_changed("first.rs")],
            &overflow_warned,
        ));
        assert!(enqueue_history_batch(
            &tx,
            vec![file_changed("second.rs"), file_changed("third.rs")],
            &overflow_warned,
        ));
        assert!(!enqueue_history_batch(
            &tx,
            vec![file_changed("fourth.rs")],
            &overflow_warned,
        ));

        let queued = rx.try_recv().unwrap();
        assert_eq!(queued.len(), 1);
        assert!(rx.try_recv().is_err());
        assert!(overflow_warned.load(Ordering::Relaxed));
    }

    #[test]
    fn debounce_batch_drops_every_event_after_path_limit_is_exceeded() {
        let mut batch = DebounceBatch::default();
        let at_limit = (0..DEBOUNCE_BATCH_PATH_LIMIT)
            .map(|index| file_changed(format!("file-{index}.rs")))
            .collect();

        assert!(!batch.push(at_limit));
        assert!(batch.push(vec![file_changed("overflow.rs")]));
        assert!(!batch.push(vec![file_changed("ignored-after-overflow.rs")]));
        assert!(batch.into_events().is_none());
    }

    #[test]
    fn notify_rescan_and_error_events_are_warned_and_ignored() {
        let project_path = PathBuf::from("/project");
        let (tx, rx) = std::sync::mpsc::sync_channel(2);
        let branch_cache = Arc::new(Mutex::new(HashMap::new()));
        let silence_until = Arc::new(Mutex::new(HashMap::new()));
        let overflow_warned = AtomicBool::new(false);
        let rescan = Event::new(EventKind::Other).set_flag(Flag::Rescan);

        HistoryService::handle_notify_result(
            &project_path,
            Ok(rescan),
            &tx,
            &branch_cache,
            &silence_until,
            &overflow_warned,
        );
        HistoryService::handle_notify_result(
            &project_path,
            Err(notify::Error::generic("watcher overflow")),
            &tx,
            &branch_cache,
            &silence_until,
            &overflow_warned,
        );

        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn init_project_history_does_not_start_watcher() {
        let dir = tempdir().unwrap();
        let service = HistoryService::new();

        service.init_project_history(dir.path()).unwrap();

        assert_eq!(service.watcher_count(), 0);
    }

    #[test]
    fn map_keys_use_platform_aware_path_equivalence() {
        let map = HashMap::from([(PathBuf::from(r"D:\Code\Project"), ())]);

        assert_eq!(
            equivalent_path_key(&map, std::path::Path::new("d:/code/project/")),
            Some(PathBuf::from(r"D:\Code\Project"))
        );
        assert_eq!(
            equivalent_path_key(&map, std::path::Path::new(r"D:\Code\Other")),
            None
        );
    }

    #[test]
    fn start_watching_is_idempotent_for_normalized_path() {
        let dir = tempdir().unwrap();
        let service = HistoryService::new();
        let with_trailing_separator = format!("{}/", dir.path().display());

        service.start_watching(dir.path()).unwrap();
        service
            .start_watching(std::path::Path::new(&with_trailing_separator))
            .unwrap();

        assert_eq!(service.watcher_count(), 1);
        assert!(service.is_watching(dir.path()));
    }

    #[test]
    fn relative_to_project_folds_drive_components_safely() {
        assert_eq!(
            HistoryService::relative_to_project(
                std::path::Path::new(r"\\?\d:\Code\Project\src\main.rs"),
                std::path::Path::new(r"D:\code\project"),
            ),
            Some(std::path::PathBuf::from("src/main.rs"))
        );
        assert_eq!(
            HistoryService::relative_to_project(
                std::path::Path::new(r"D:\code\project-copy\src\main.rs"),
                std::path::Path::new(r"D:\code\project"),
            ),
            None
        );
    }

    #[test]
    fn relative_to_project_does_not_fold_unc_or_unix_case() {
        assert_eq!(
            HistoryService::relative_to_project(
                std::path::Path::new(r"\\server\share\Project\src\main.rs"),
                std::path::Path::new(r"\\server\share\project"),
            ),
            None
        );
        assert_eq!(
            HistoryService::relative_to_project(
                std::path::Path::new("/home/User/project/src/main.rs"),
                std::path::Path::new("/home/user/project"),
            ),
            None
        );
    }

    #[test]
    fn ext_pattern_matches_only_extension_boundary() {
        // `*.js` 精确匹配 .js，不连带 .mjs / .cjs
        assert!(HistoryService::matches_pattern("a/foo.js", "*.js"));
        assert!(!HistoryService::matches_pattern("a/foo.mjs", "*.js"));
        assert!(!HistoryService::matches_pattern("a/foo.cjs", "*.js"));
        // `*.log` 不误伤 changelog / catalog
        assert!(HistoryService::matches_pattern("build.log", "*.log"));
        assert!(!HistoryService::matches_pattern("CHANGELOG", "*.log"));
        assert!(!HistoryService::matches_pattern("docs/catalog", "*.log"));
    }

    #[test]
    fn dir_and_exact_patterns_still_work() {
        assert!(HistoryService::matches_pattern("target/x", "target/**"));
        assert!(HistoryService::matches_pattern(
            "crates/app/target/x",
            "target/**"
        ));
        assert!(!HistoryService::matches_pattern("target2/x", "target/**"));
        assert!(!HistoryService::matches_pattern(
            "crates/app/target2/x",
            "target/**"
        ));
        assert!(HistoryService::matches_pattern(
            "packages/app/node_modules/pkg/index.js",
            "node_modules"
        ));
        assert!(HistoryService::matches_pattern(
            "src/gen/output.rs",
            "src/gen/**"
        ));
        assert!(!HistoryService::matches_pattern(
            "nested/src/gen/output.rs",
            "src/gen/**"
        ));
        assert!(HistoryService::matches_pattern(".env", ".env"));
    }

    #[test]
    fn builtin_patterns_extend_legacy_project_config() {
        let legacy_patterns = vec!["node_modules/**".to_string(), "target/**".to_string()];

        assert!(HistoryService::should_ignore(
            "packages/app/.next/cache/data",
            &legacy_patterns
        ));
        assert!(HistoryService::should_ignore(
            "src/__pycache__/module.pyc",
            &legacy_patterns
        ));
        assert!(!HistoryService::should_ignore(
            "src/not__pycache__/module.py",
            &legacy_patterns
        ));
    }

    #[test]
    fn dispatch_prefilter_rejects_root_builtin_directory_only() {
        let project = std::path::Path::new("/workspace/project");

        assert!(HistoryService::is_builtin_ignored_event_path(
            project,
            std::path::Path::new("/workspace/project/node_modules/pkg/index.js")
        ));
        assert!(!HistoryService::is_builtin_ignored_event_path(
            project,
            std::path::Path::new("/workspace/project/src/node_modules/pkg/index.js")
        ));
        assert!(!HistoryService::is_builtin_ignored_event_path(
            project,
            std::path::Path::new("/workspace/project/node_modules-copy/index.js")
        ));
    }
}
