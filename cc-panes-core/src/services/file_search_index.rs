use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
use nucleo_matcher::{Matcher, Utf32Str};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::error;
use walkdir::WalkDir;

/// 搜索时默认过滤的目录（与 filesystem_service::SEARCH_IGNORED_DIRS 保持一致）
const SEARCH_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

/// 索引条目
#[derive(Debug, Clone)]
struct IndexEntry {
    name: String,
    rel_path: String,
    is_dir: bool,
}

/// 单个路径的索引
struct ProjectIndex {
    root: PathBuf,
    entries: Vec<IndexEntry>,
    ready: bool,
    watcher: Option<RecommendedWatcher>,
}

/// 内存文件搜索索引
pub struct FileSearchIndex {
    indices: RwLock<HashMap<PathBuf, ProjectIndex>>,
}

impl Default for FileSearchIndex {
    fn default() -> Self {
        Self {
            indices: RwLock::new(HashMap::new()),
        }
    }
}

impl FileSearchIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// 惰性构建索引：如果已存在且 ready 则跳过，否则 WalkDir 遍历一次
    pub fn ensure_index(&self, root: &Path) {
        // 快速检查：是否已有 ready 索引
        {
            let indices = self.indices.read();
            if let Some(idx) = indices.get(root) {
                if idx.ready {
                    return;
                }
            }
        }

        // 构建索引
        let entries = Self::build_entries(root);
        let mut indices = self.indices.write();
        let project_index = indices.entry(root.to_path_buf()).or_insert_with(|| {
            ProjectIndex {
                root: root.to_path_buf(),
                entries: Vec::new(),
                ready: false,
                watcher: None,
            }
        });
        project_index.entries = entries;
        project_index.ready = true;
    }

    /// WalkDir 遍历构建 entries
    fn build_entries(root: &Path) -> Vec<IndexEntry> {
        let mut entries = Vec::new();
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !SEARCH_IGNORED_DIRS.contains(&name.as_ref())
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            // 跳过根目录本身
            if entry.path() == root {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();
            entries.push(IndexEntry {
                name,
                rel_path: rel,
                is_dir: entry.file_type().is_dir(),
            });
        }
        entries
    }

    /// nucleo 模糊搜索
    ///
    /// 先克隆 entries 快照并释放读锁，再在锁外执行打分，
    /// 避免大索引搜索期间阻塞写锁（增量更新 / invalidate）。
    pub fn search(
        &self,
        root: &Path,
        query: &str,
        max_results: usize,
    ) -> Vec<SearchHit> {
        if query.is_empty() {
            return Vec::new();
        }

        // 在锁内快速克隆 entries 快照和 root，立即释放锁
        let (entries_snapshot, index_root) = {
            let indices = self.indices.read();
            match indices.get(root) {
                Some(idx) if idx.ready => (idx.entries.clone(), idx.root.clone()),
                _ => return Vec::new(),
            }
        };

        let max = if max_results == 0 { 100 } else { max_results.min(500) };

        let pattern = Atom::new(
            query,
            CaseMatching::Smart,
            Normalization::Smart,
            AtomKind::Fuzzy,
            false,
        );

        let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT);
        let mut scored: Vec<SearchHit> = Vec::new();
        let mut buf = Vec::new();

        for entry in &entries_snapshot {
            // 优先匹配文件名
            let name_haystack = Utf32Str::new(&entry.name, &mut buf);
            let name_score = pattern.score(name_haystack, &mut matcher);

            // 如果文件名没匹配上，尝试匹配相对路径（降权）
            let score = if let Some(s) = name_score {
                Some(s as u32)
            } else {
                let mut buf2 = Vec::new();
                let rel_haystack = Utf32Str::new(&entry.rel_path, &mut buf2);
                pattern.score(rel_haystack, &mut matcher).map(|s| (s as u32) / 2)
            };

            if let Some(score) = score {
                let full_path = index_root.join(&entry.rel_path);
                scored.push(SearchHit {
                    path: full_path.to_string_lossy().to_string(),
                    name: entry.name.clone(),
                    is_dir: entry.is_dir,
                    rel_path: entry.rel_path.clone(),
                    score,
                });
            }
        }

        // 按分数降序排列
        scored.sort_by(|a, b| b.score.cmp(&a.score));
        scored.truncate(max);
        scored
    }

    /// 移除指定路径的索引
    pub fn remove_index(&self, root: &Path) {
        let mut indices = self.indices.write();
        if let Some(mut idx) = indices.remove(root) {
            // 停止 watcher
            idx.watcher.take();
        }
    }

    /// 标记索引需要重建（下次 ensure_index 时重新遍历）
    pub fn invalidate(&self, root: &Path) {
        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(root) {
            idx.ready = false;
        }
    }

    // ===== 增量更新接口 =====

    /// 添加单个条目
    pub fn add_entry(&self, root: &Path, rel_path: &str, name: &str, is_dir: bool) {
        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(root) {
            if idx.ready {
                // 检查是否已存在
                if !idx.entries.iter().any(|e| e.rel_path == rel_path) {
                    idx.entries.push(IndexEntry {
                        name: name.to_string(),
                        rel_path: rel_path.to_string(),
                        is_dir,
                    });
                }
            }
        }
    }

    /// 移除单个条目
    pub fn remove_entry(&self, root: &Path, rel_path: &str) {
        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(root) {
            if idx.ready {
                idx.entries.retain(|e| e.rel_path != rel_path);
            }
        }
    }

    /// 移除指定前缀的所有条目（用于目录删除）
    pub fn remove_entries_by_prefix(&self, root: &Path, prefix: &str) {
        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(root) {
            if idx.ready {
                let prefix_with_sep = if prefix.ends_with('/') || prefix.ends_with('\\') {
                    prefix.to_string()
                } else {
                    format!("{}/", prefix.replace('\\', "/"))
                };
                let norm_prefix = prefix_with_sep.replace('\\', "/");
                idx.entries.retain(|e| {
                    let norm = e.rel_path.replace('\\', "/");
                    norm != prefix.replace('\\', "/") && !norm.starts_with(&norm_prefix)
                });
            }
        }
    }

    // ===== 文件监听 =====

    /// 启动 notify 文件监听
    pub fn start_watching(self: &Arc<Self>, root: &Path) {
        let root = root.to_path_buf();
        let index = Arc::clone(self);

        let root_clone = root.clone();
        let watcher_result = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    index.handle_fs_event(&root_clone, &event);
                }
            },
            Config::default(),
        );

        let mut watcher = match watcher_result {
            Ok(w) => w,
            Err(e) => {
                error!("[file_search_index] Failed to create watcher for {:?}: {}", root, e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            error!("[file_search_index] Failed to watch {:?}: {}", root, e);
            return;
        }

        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(&root) {
            idx.watcher = Some(watcher);
        }
    }

    /// 停止指定路径的监听
    pub fn stop_watching(&self, root: &Path) {
        let mut indices = self.indices.write();
        if let Some(idx) = indices.get_mut(root) {
            idx.watcher.take();
        }
    }

    /// 停止所有监听（应用退出时调用）
    pub fn stop_all_watching(&self) {
        let mut indices = self.indices.write();
        for idx in indices.values_mut() {
            idx.watcher.take();
        }
    }

    /// 处理文件系统事件
    fn handle_fs_event(&self, root: &Path, event: &Event) {
        for path in &event.paths {
            // 检查是否在忽略目录下
            if Self::is_in_ignored_dir(path) {
                continue;
            }

            let rel_path = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            match event.kind {
                EventKind::Create(_) => {
                    let is_dir = path.is_dir();
                    self.add_entry(root, &rel_path, &name, is_dir);
                }
                EventKind::Remove(_) => {
                    // 可能是文件或目录
                    self.remove_entry(root, &rel_path);
                    self.remove_entries_by_prefix(root, &rel_path);
                }
                EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                    // Rename 在 notify 中表现为两个事件（Remove 旧路径 + Create 新路径）
                    // 或者在某些系统上是单个 Rename 事件，此时只更新存在性
                    if path.exists() {
                        let is_dir = path.is_dir();
                        self.add_entry(root, &rel_path, &name, is_dir);
                    } else {
                        self.remove_entry(root, &rel_path);
                        self.remove_entries_by_prefix(root, &rel_path);
                    }
                }
                _ => {}
            }
        }
    }

    /// 检查路径是否在忽略目录下
    fn is_in_ignored_dir(path: &Path) -> bool {
        for component in path.components() {
            if let std::path::Component::Normal(seg) = component {
                let name = seg.to_string_lossy();
                if SEARCH_IGNORED_DIRS.contains(&name.as_ref()) {
                    return true;
                }
            }
        }
        false
    }
}

/// 搜索命中结果
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub rel_path: String,
    pub score: u32,
}
