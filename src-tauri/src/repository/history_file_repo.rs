use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::models::{
    DiffChangeType, DiffHunk, DiffLine, DiffResult, DiffStats, FileVersion, HistoryConfig,
    HistoryLabel, InlineChange, LabelFileSnapshot, ProjectConfig, RecentChange, VersionsMetadata,
};

const CCPANES_DIR: &str = ".ccpanes";
const HISTORY_DIR: &str = "history";
const CONTENT_DIR: &str = "blobs";
const CONFIG_FILE: &str = "config.toml";
const DB_FILE: &str = "history.db";
const MAX_DIFF_LINES: usize = 10000;
const CONTEXT_LINES: usize = 3;

pub struct HistoryFileRepository {
    db: Mutex<Connection>,
    project_path: PathBuf,
}

impl HistoryFileRepository {
    /// 创建新的仓库实例（每个项目一个 SQLite 数据库）
    pub fn open(project_path: &Path) -> Result<Self> {
        let ccpanes = project_path.join(CCPANES_DIR);
        let history = ccpanes.join(HISTORY_DIR);
        let blobs = history.join(CONTENT_DIR);
        fs::create_dir_all(&blobs).context("Failed to create blobs directory")?;

        let db_path = history.join(DB_FILE);
        let conn = Connection::open(&db_path).context("Failed to open history database")?;

        // 启用 WAL 模式
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        Self::init_tables(&conn)?;
        Self::migrate_add_branch(&conn)?;

        // 迁移旧版 versions.json 数据
        let repo = Self {
            db: Mutex::new(conn),
            project_path: project_path.to_path_buf(),
        };
        repo.migrate_from_json()?;

        Ok(repo)
    }

    fn init_tables(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS file_versions (
                id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                hash TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (file_path, id)
            );
            CREATE INDEX IF NOT EXISTS idx_versions_path ON file_versions(file_path);
            CREATE INDEX IF NOT EXISTS idx_versions_created ON file_versions(created_at);
            CREATE INDEX IF NOT EXISTS idx_versions_hash ON file_versions(hash);

            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                label_type TEXT NOT NULL,
                source TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_labels_timestamp ON labels(timestamp);

            CREATE TABLE IF NOT EXISTS label_snapshots (
                label_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                version_id TEXT NOT NULL,
                PRIMARY KEY (label_id, file_path),
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_label_snapshots_file_version
                ON label_snapshots(file_path, version_id);",
        )
        .context("Failed to initialize history tables")?;
        Ok(())
    }

    /// Schema 迁移：为 file_versions 和 labels 添加 branch 列
    fn migrate_add_branch(conn: &Connection) -> Result<()> {
        // ALTER TABLE 幂等处理：捕获 "duplicate column" 错误则跳过
        let alter_stmts = [
            "ALTER TABLE file_versions ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE labels ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
        ];
        for stmt in &alter_stmts {
            match conn.execute_batch(stmt) {
                Ok(_) => {}
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate column") || msg.contains("already exists") {
                        // 列已存在，跳过
                    } else {
                        return Err(e.into());
                    }
                }
            }
        }
        // 创建索引（幂等）
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_versions_branch ON file_versions(branch);
             CREATE INDEX IF NOT EXISTS idx_labels_branch ON labels(branch);",
        )?;
        Ok(())
    }

    /// 迁移旧版 versions.json 到 SQLite
    fn migrate_from_json(&self) -> Result<()> {
        let history_dir = self.history_path();
        if !history_dir.exists() {
            return Ok(());
        }

        let entries: Vec<_> = fs::read_dir(&history_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|ft| ft.is_dir()))
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name != CONTENT_DIR && name != "." && name != ".."
            })
            .collect();

        for entry in entries {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let versions_json = entry.path().join("versions.json");
            if !versions_json.exists() {
                continue;
            }

            // 解码旧路径编码
            let file_path = match urlencoding::decode(&dir_name) {
                Ok(p) => p.to_string(),
                Err(_) => continue,
            };

            // 检查 DB 中是否已有此文件的记录
            {
                let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
                let count: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM file_versions WHERE file_path = ?1",
                        params![file_path],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if count > 0 {
                    // 已迁移，删除旧文件
                    let _ = fs::remove_file(&versions_json);
                    continue;
                }
            }

            // 读取 versions.json
            let content = match fs::read_to_string(&versions_json) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let metadata: VersionsMetadata = match serde_json::from_str(&content) {
                Ok(m) => m,
                Err(_) => continue,
            };

            // 迁移版本到 SQLite + 内容文件移到 blobs
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            for version in &metadata.versions {
                let old_version_path = entry.path().join(format!("v_{}", version.id));
                if old_version_path.exists() {
                    // 移动内容到 blobs 目录（按 hash 命名实现去重）
                    let blob_path = self.blob_path(&version.hash);
                    if !blob_path.exists() {
                        let _ = fs::rename(&old_version_path, &blob_path);
                    } else {
                        let _ = fs::remove_file(&old_version_path);
                    }
                }

                let _ = db.execute(
                    "INSERT OR IGNORE INTO file_versions (id, file_path, hash, size, created_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                    params![
                        version.id,
                        version.file_path,
                        version.hash,
                        version.size,
                        version.created_at,
                    ],
                );
            }
            drop(db);

            // 清理旧文件
            let _ = fs::remove_file(&versions_json);
            // 尝试删除旧目录（如果为空）
            let _ = fs::remove_dir(entry.path());
        }

        Ok(())
    }

    // ============ 路径辅助 ============

    fn ccpanes_path(&self) -> PathBuf {
        self.project_path.join(CCPANES_DIR)
    }

    fn history_path(&self) -> PathBuf {
        self.ccpanes_path().join(HISTORY_DIR)
    }

    fn blobs_path(&self) -> PathBuf {
        self.history_path().join(CONTENT_DIR)
    }

    fn config_path(&self) -> PathBuf {
        self.ccpanes_path().join(CONFIG_FILE)
    }

    /// 内容文件路径（按 SHA256 hash 命名，实现去重）
    fn blob_path(&self, hash: &str) -> PathBuf {
        self.blobs_path().join(hash)
    }

    // ============ 配置管理 ============

    pub fn read_config(&self) -> Result<ProjectConfig> {
        let config_path = self.config_path();
        if config_path.exists() {
            let content =
                fs::read_to_string(&config_path).context("Failed to read config file")?;
            toml::from_str(&content).context("Failed to parse config file")
        } else {
            Ok(ProjectConfig::default())
        }
    }

    pub fn save_config(&self, config: &ProjectConfig) -> Result<()> {
        let config_path = self.config_path();
        let toml_str =
            toml::to_string_pretty(config).context("Failed to serialize config")?;
        fs::write(&config_path, toml_str).context("Failed to write config file")
    }

    pub fn init_history_dir(&self) -> Result<()> {
        let blobs = self.blobs_path();
        fs::create_dir_all(&blobs).context("Failed to create blobs directory")?;

        let config_path = self.config_path();
        if !config_path.exists() {
            let config = ProjectConfig::default();
            self.save_config(&config)?;
        }
        Ok(())
    }

    // ============ 静态辅助方法（向后兼容） ============

    pub fn calculate_hash(content: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content);
        format!("{:x}", hasher.finalize())
    }

    // ============ 二进制文件检测 ============

    /// 检测内容是否为二进制文件
    /// 先检测 BOM（UTF-8/UTF-16/UTF-32），再检测 \0 字节
    pub fn is_binary(content: &[u8]) -> bool {
        if content.is_empty() {
            return false;
        }

        // 检测 BOM：有 BOM 则认为是文本
        // UTF-8 BOM: EF BB BF
        if content.len() >= 3 && content[0] == 0xEF && content[1] == 0xBB && content[2] == 0xBF {
            return false;
        }
        // UTF-16 LE BOM: FF FE
        if content.len() >= 2 && content[0] == 0xFF && content[1] == 0xFE {
            return false;
        }
        // UTF-16 BE BOM: FE FF
        if content.len() >= 2 && content[0] == 0xFE && content[1] == 0xFF {
            return false;
        }
        // UTF-32 LE BOM: FF FE 00 00
        if content.len() >= 4
            && content[0] == 0xFF
            && content[1] == 0xFE
            && content[2] == 0x00
            && content[3] == 0x00
        {
            return false;
        }
        // UTF-32 BE BOM: 00 00 FE FF
        if content.len() >= 4
            && content[0] == 0x00
            && content[1] == 0x00
            && content[2] == 0xFE
            && content[3] == 0xFF
        {
            return false;
        }

        // 检测首 8KB 中是否包含 \0 字节
        let check_len = content.len().min(8192);
        content[..check_len].contains(&0)
    }

    // ============ 版本管理 ============

    /// 保存文件版本
    pub fn save_version(
        &self,
        file_path: &str,
        content: &[u8],
        is_deleted: bool,
        branch: &str,
    ) -> Result<Option<FileVersion>> {
        let hash = Self::calculate_hash(content);

        // 检查是否与同分支的最新版本相同（去重）
        // 注意：is_deleted 标记的版本不做去重，即使内容相同也要记录
        if !is_deleted {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let latest_hash: Option<String> = db
                .query_row(
                    "SELECT hash FROM file_versions WHERE file_path = ?1 AND branch = ?2 ORDER BY id DESC LIMIT 1",
                    params![file_path, branch],
                    |row| row.get(0),
                )
                .ok();
            if let Some(ref lh) = latest_hash {
                if lh == &hash {
                    return Ok(None);
                }
            }
        }

        // 写入 blob（哈希去重：同内容不重复写入）
        let blob_path = self.blob_path(&hash);
        if !blob_path.exists() {
            fs::write(&blob_path, content).context("Failed to write blob file")?;
        }

        // 生成版本 ID（时间戳毫秒 + 4 位递增计数器，避免同毫秒主键冲突）
        use std::sync::atomic::{AtomicU32, Ordering};
        static VERSION_COUNTER: AtomicU32 = AtomicU32::new(0);
        let now = chrono::Utc::now();
        let counter = VERSION_COUNTER.fetch_add(1, Ordering::Relaxed) % 10000;
        let version_id = format!("{}{:04}", now.timestamp_millis(), counter);
        let created_at = now.to_rfc3339();

        let version = FileVersion {
            id: version_id.clone(),
            file_path: file_path.to_string(),
            hash: hash.clone(),
            size: content.len() as u64,
            created_at: created_at.clone(),
            is_deleted,
            branch: branch.to_string(),
        };

        // 写入 SQLite
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "INSERT INTO file_versions (id, file_path, hash, size, created_at, is_deleted, branch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    version_id,
                    file_path,
                    hash,
                    content.len() as i64,
                    created_at,
                    is_deleted as i32,
                    branch,
                ],
            )
            .context("Failed to insert version")?;
        }

        Ok(Some(version))
    }

    /// 列出文件的所有版本
    pub fn list_versions(&self, file_path: &str) -> Result<Vec<FileVersion>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db
            .prepare(
                "SELECT id, file_path, hash, size, created_at, is_deleted, branch
                 FROM file_versions WHERE file_path = ?1 ORDER BY id ASC",
            )
            .context("Failed to prepare list versions query")?;

        let versions = stmt
            .query_map(params![file_path], |row| {
                Ok(FileVersion {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    is_deleted: row.get::<_, i32>(5)? != 0,
                    branch: row.get(6)?,
                })
            })
            .context("Failed to query versions")?
            .filter_map(|r| r.ok())
            .collect();

        Ok(versions)
    }

    /// 列出文件在指定分支的版本
    pub fn list_versions_by_branch(&self, file_path: &str, branch: &str) -> Result<Vec<FileVersion>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db
            .prepare(
                "SELECT id, file_path, hash, size, created_at, is_deleted, branch
                 FROM file_versions WHERE file_path = ?1 AND branch = ?2 ORDER BY id ASC",
            )
            .context("Failed to prepare list versions by branch query")?;

        let versions = stmt
            .query_map(params![file_path, branch], |row| {
                Ok(FileVersion {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    is_deleted: row.get::<_, i32>(5)? != 0,
                    branch: row.get(6)?,
                })
            })
            .context("Failed to query versions by branch")?
            .filter_map(|r| r.ok())
            .collect();

        Ok(versions)
    }

    /// 获取文件有版本的所有分支列表
    pub fn get_file_branches(&self, file_path: &str) -> Result<Vec<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT DISTINCT branch FROM file_versions WHERE file_path = ?1 ORDER BY branch",
        )?;
        let branches = stmt
            .query_map(params![file_path], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(branches)
    }

    /// 获取指定版本的内容
    pub fn get_version_content(&self, file_path: &str, version_id: &str) -> Result<Vec<u8>> {
        let hash = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row(
                "SELECT hash FROM file_versions WHERE file_path = ?1 AND id = ?2",
                params![file_path, version_id],
                |row| row.get::<_, String>(0),
            )
            .context("Version not found")?
        };

        let blob_path = self.blob_path(&hash);

        // 检测是否 gzip 压缩（魔数 0x1f 0x8b）
        let raw = fs::read(&blob_path).context("Failed to read blob file")?;
        if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
            let mut decoder = flate2::read::GzDecoder::new(&raw[..]);
            let mut decompressed = Vec::new();
            decoder
                .read_to_end(&mut decompressed)
                .context("Failed to decompress blob")?;
            Ok(decompressed)
        } else {
            Ok(raw)
        }
    }

    /// 清理旧版本
    pub fn cleanup_old_versions(&self, config: &HistoryConfig) -> Result<()> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(config.max_age_days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());

            // 获取所有文件路径
            let file_paths: Vec<String> = {
                let mut stmt = db.prepare("SELECT DISTINCT file_path FROM file_versions")?;
                let result = stmt
                    .query_map([], |row| row.get(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                result
            };

            for fp in &file_paths {
                // 按时间删除过期版本
                db.execute(
                    "DELETE FROM file_versions WHERE file_path = ?1 AND created_at < ?2",
                    params![fp, cutoff_str],
                )?;

                // 按数量限制：只保留最新 N 个
                let count: i64 = db.query_row(
                    "SELECT COUNT(*) FROM file_versions WHERE file_path = ?1",
                    params![fp],
                    |row| row.get(0),
                )?;

                if count > config.max_versions_per_file as i64 {
                    let excess = count - config.max_versions_per_file as i64;
                    db.execute(
                        "DELETE FROM file_versions WHERE file_path = ?1 AND id IN (
                            SELECT id FROM file_versions WHERE file_path = ?1 ORDER BY id ASC LIMIT ?2
                        )",
                        params![fp, excess],
                    )?;
                }
            }
        }

        // 清理孤儿 blob 文件（不再被任何版本引用）
        self.cleanup_orphan_blobs()?;

        Ok(())
    }

    /// LRU 清理：按 max_total_size 限制
    pub fn cleanup_by_total_size(&self, max_total_size: u64) -> Result<()> {
        let blobs_dir = self.blobs_path();
        if !blobs_dir.exists() {
            return Ok(());
        }

        // 计算当前总大小
        let mut total_size: u64 = 0;
        for entry in fs::read_dir(&blobs_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                total_size += entry.metadata()?.len();
            }
        }

        if total_size <= max_total_size {
            return Ok(());
        }

        // 按时间删除最旧的版本，直到低于限制
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let rows: Vec<(String, String, String, i64)> = {
                let mut stmt = db.prepare(
                    "SELECT id, file_path, hash, size FROM file_versions ORDER BY id ASC",
                )?;
                let result = stmt
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();
                result
            };

            let mut freed: u64 = 0;
            let need_to_free = total_size - max_total_size;
            // 追踪已计数的 blob hash，避免共享 blob 重复计算释放量
            let mut counted_hashes = std::collections::HashSet::new();

            for (id, fp, hash, _size) in &rows {
                if freed >= need_to_free {
                    break;
                }
                db.execute(
                    "DELETE FROM file_versions WHERE file_path = ?1 AND id = ?2",
                    params![fp, id],
                )?;
                // 只在首次遇到该 hash 时计入释放量（共享 blob 不重复计数）
                if counted_hashes.insert(hash.clone()) {
                    // 检查该 blob 是否仍被其他版本引用
                    let ref_count: i64 = db.query_row(
                        "SELECT COUNT(*) FROM file_versions WHERE hash = ?1",
                        params![hash],
                        |row| row.get(0),
                    ).unwrap_or(0);
                    if ref_count == 0 {
                        let blob_size = self
                            .blob_path(hash)
                            .metadata()
                            .map(|m| m.len())
                            .unwrap_or(0);
                        freed += blob_size;
                    }
                }
            }
        }

        self.cleanup_orphan_blobs()?;
        Ok(())
    }

    /// 清理不再被引用的 blob 文件
    fn cleanup_orphan_blobs(&self) -> Result<()> {
        let blobs_dir = self.blobs_path();
        if !blobs_dir.exists() {
            return Ok(());
        }

        // 获取所有被引用的 hash
        let referenced_hashes: std::collections::HashSet<String> = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let mut stmt = db.prepare("SELECT DISTINCT hash FROM file_versions")?;
            let result = stmt.query_map([], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            result
        };

        // 删除未引用的 blob
        for entry in fs::read_dir(&blobs_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 跳过非 blob 文件（如 history.db）
            if name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm") {
                continue;
            }
            if !referenced_hashes.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }

        Ok(())
    }

    // ============ Diff 计算 ============

    /// 计算两段文本的 diff
    pub fn compute_diff(old_text: &str, new_text: &str) -> DiffResult {
        // 二进制检测
        if Self::is_binary(old_text.as_bytes()) || Self::is_binary(new_text.as_bytes()) {
            return DiffResult {
                hunks: vec![],
                stats: DiffStats::default(),
                is_binary: true,
                truncated: false,
            };
        }

        let old_lines: Vec<&str> = old_text.lines().collect();
        let new_lines: Vec<&str> = new_text.lines().collect();

        // 大文件保护
        let truncated = old_lines.len() > MAX_DIFF_LINES || new_lines.len() > MAX_DIFF_LINES;
        if truncated {
            let stats = DiffStats {
                additions: 0,
                deletions: 0,
                changes: 0,
            };
            return DiffResult {
                hunks: vec![],
                stats,
                is_binary: false,
                truncated: true,
            };
        }

        // 使用 similar crate 做行级 diff
        let diff = similar::TextDiff::from_lines(old_text, new_text);
        let mut all_changes: Vec<(similar::ChangeTag, usize, usize, String)> = Vec::new();

        let mut old_line_no = 0usize;
        let mut new_line_no = 0usize;

        for change in diff.iter_all_changes() {
            let tag = change.tag();
            let value = change.value().to_string();
            match tag {
                similar::ChangeTag::Equal => {
                    old_line_no += 1;
                    new_line_no += 1;
                    all_changes.push((tag, old_line_no, new_line_no, value));
                }
                similar::ChangeTag::Delete => {
                    old_line_no += 1;
                    all_changes.push((tag, old_line_no, 0, value));
                }
                similar::ChangeTag::Insert => {
                    new_line_no += 1;
                    all_changes.push((tag, 0, new_line_no, value));
                }
            }
        }

        // 将 changes 分成 hunks（合并相邻变更，保留上下文行）
        let mut hunks: Vec<DiffHunk> = Vec::new();
        let mut stats = DiffStats::default();

        // 找到所有非 Equal 区间
        let mut change_ranges: Vec<(usize, usize)> = Vec::new();
        let mut i = 0;
        while i < all_changes.len() {
            if all_changes[i].0 != similar::ChangeTag::Equal {
                let start = i;
                while i < all_changes.len() && all_changes[i].0 != similar::ChangeTag::Equal {
                    i += 1;
                }
                change_ranges.push((start, i));
            } else {
                i += 1;
            }
        }

        // 合并相邻的 change_ranges（间距 <= 2 * CONTEXT_LINES 的合并）
        let mut merged_ranges: Vec<(usize, usize)> = Vec::new();
        for (start, end) in change_ranges {
            if let Some(last) = merged_ranges.last_mut() {
                if start <= last.1 + 2 * CONTEXT_LINES {
                    last.1 = end;
                } else {
                    merged_ranges.push((start, end));
                }
            } else {
                merged_ranges.push((start, end));
            }
        }

        // 为每个合并后的区间生成 hunk
        for (change_start, change_end) in merged_ranges {
            let hunk_start = change_start.saturating_sub(CONTEXT_LINES);
            let hunk_end = (change_end + CONTEXT_LINES).min(all_changes.len());

            let mut lines: Vec<DiffLine> = Vec::new();

            // 找到 hunk 的起始行号
            let mut hunk_old_start = 0;
            let mut hunk_new_start = 0;
            let mut hunk_old_count = 0;
            let mut hunk_new_count = 0;

            for (idx, (tag, old_no, new_no, value)) in all_changes[hunk_start..hunk_end].iter().enumerate() {
                if idx == 0 {
                    hunk_old_start = if *old_no > 0 { *old_no } else { 1 };
                    hunk_new_start = if *new_no > 0 { *new_no } else { 1 };
                }

                let content = value.trim_end_matches('\n').to_string();

                match tag {
                    similar::ChangeTag::Equal => {
                        lines.push(DiffLine {
                            change_type: DiffChangeType::Equal,
                            content,
                            old_line_no: Some(*old_no),
                            new_line_no: Some(*new_no),
                            inline_changes: None,
                        });
                        hunk_old_count += 1;
                        hunk_new_count += 1;
                    }
                    similar::ChangeTag::Delete => {
                        stats.deletions += 1;
                        lines.push(DiffLine {
                            change_type: DiffChangeType::Delete,
                            content,
                            old_line_no: Some(*old_no),
                            new_line_no: None,
                            inline_changes: None,
                        });
                        hunk_old_count += 1;
                    }
                    similar::ChangeTag::Insert => {
                        stats.additions += 1;
                        lines.push(DiffLine {
                            change_type: DiffChangeType::Insert,
                            content,
                            old_line_no: None,
                            new_line_no: Some(*new_no),
                            inline_changes: None,
                        });
                        hunk_new_count += 1;
                    }
                }
            }

            // 字符级 diff：对相邻的 Delete/Insert 行做字符级比较
            Self::compute_inline_changes(&mut lines);

            hunks.push(DiffHunk {
                old_start: hunk_old_start,
                old_count: hunk_old_count,
                new_start: hunk_new_start,
                new_count: hunk_new_count,
                lines,
            });
        }

        stats.changes = stats.additions.min(stats.deletions);

        DiffResult {
            hunks,
            stats,
            is_binary: false,
            truncated: false,
        }
    }

    /// 对相邻的 Delete/Insert 行计算字符级 inline diff
    fn compute_inline_changes(lines: &mut [DiffLine]) {
        let mut i = 0;
        while i < lines.len() {
            // 找到一组连续的 Delete 行
            let del_start = i;
            while i < lines.len() && lines[i].change_type == DiffChangeType::Delete {
                i += 1;
            }
            let del_end = i;

            // 找到紧跟的 Insert 行
            let ins_start = i;
            while i < lines.len() && lines[i].change_type == DiffChangeType::Insert {
                i += 1;
            }
            let ins_end = i;

            let del_count = del_end - del_start;
            let ins_count = ins_end - ins_start;

            // 一一对应做字符级 diff（取较小数量）
            let pairs = del_count.min(ins_count);
            for p in 0..pairs {
                let del_idx = del_start + p;
                let ins_idx = ins_start + p;

                let old_str = &lines[del_idx].content;
                let new_str = &lines[ins_idx].content;

                let char_diff = similar::TextDiff::from_chars(old_str, new_str);

                let mut old_inlines = Vec::new();
                let mut new_inlines = Vec::new();
                let mut old_pos = 0usize;
                let mut new_pos = 0usize;

                for change in char_diff.iter_all_changes() {
                    // 使用字符数（而非字节数），与前端 JS String.slice 一致
                    let char_count = change.value().chars().count();
                    match change.tag() {
                        similar::ChangeTag::Equal => {
                            old_pos += char_count;
                            new_pos += char_count;
                        }
                        similar::ChangeTag::Delete => {
                            old_inlines.push(InlineChange {
                                start: old_pos,
                                end: old_pos + char_count,
                                change_type: DiffChangeType::Delete,
                            });
                            old_pos += char_count;
                        }
                        similar::ChangeTag::Insert => {
                            new_inlines.push(InlineChange {
                                start: new_pos,
                                end: new_pos + char_count,
                                change_type: DiffChangeType::Insert,
                            });
                            new_pos += char_count;
                        }
                    }
                }

                if !old_inlines.is_empty() {
                    lines[del_idx].inline_changes = Some(old_inlines);
                }
                if !new_inlines.is_empty() {
                    lines[ins_idx].inline_changes = Some(new_inlines);
                }
            }

            // 如果没有配对的行，跳到下一组
            if del_count == 0 && ins_count == 0 {
                i += 1;
            }
        }
    }

    /// 获取版本与当前文件的 diff
    pub fn get_version_diff(&self, file_path: &str, version_id: &str) -> Result<DiffResult> {
        let old_content = self.get_version_content(file_path, version_id)?;
        let old_text = String::from_utf8_lossy(&old_content).to_string();

        let full_path = self
            .project_path
            .join(file_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        // 用 from_utf8_lossy 处理非 UTF-8 文件，避免 read_to_string 失败变空字符串
        let new_text = match fs::read(&full_path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(_) => String::new(),
        };

        Ok(Self::compute_diff(&old_text, &new_text))
    }

    /// 获取两个版本之间的 diff
    pub fn get_versions_diff(
        &self,
        file_path: &str,
        old_version_id: &str,
        new_version_id: &str,
    ) -> Result<DiffResult> {
        let old_content = self.get_version_content(file_path, old_version_id)?;
        let old_text = String::from_utf8_lossy(&old_content).to_string();

        let new_content = self.get_version_content(file_path, new_version_id)?;
        let new_text = String::from_utf8_lossy(&new_content).to_string();

        Ok(Self::compute_diff(&old_text, &new_text))
    }

    // ============ 标签管理 ============

    /// 创建标签
    pub fn put_label(&self, label: &HistoryLabel) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "INSERT OR REPLACE INTO labels (id, name, label_type, source, timestamp, branch)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                label.id,
                label.name,
                label.label_type,
                label.source,
                label.timestamp,
                label.branch,
            ],
        )?;

        // 删除旧快照
        db.execute(
            "DELETE FROM label_snapshots WHERE label_id = ?1",
            params![label.id],
        )?;

        // 插入新快照
        for snap in &label.file_snapshots {
            db.execute(
                "INSERT INTO label_snapshots (label_id, file_path, version_id)
                 VALUES (?1, ?2, ?3)",
                params![label.id, snap.file_path, snap.version_id],
            )?;
        }

        Ok(())
    }

    /// 列出所有标签（单次 JOIN 查询，避免 N+1）
    pub fn list_labels(&self) -> Result<Vec<HistoryLabel>> {
        type LabelRow = (String, String, String, String, String, String, Option<String>, Option<String>);

        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT l.id, l.name, l.label_type, l.source, l.timestamp, l.branch,
                    ls.file_path, ls.version_id
             FROM labels l
             LEFT JOIN label_snapshots ls ON ls.label_id = l.id
             ORDER BY l.timestamp DESC, l.id",
        )?;

        let rows: Vec<LabelRow> =
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // 按 label id 分组
        let mut result: Vec<HistoryLabel> = Vec::new();
        let mut current_id = String::new();

        for (id, name, label_type, source, timestamp, branch, snap_file, snap_ver) in rows {
            if id != current_id {
                result.push(HistoryLabel {
                    id: id.clone(),
                    name,
                    label_type,
                    source,
                    timestamp,
                    file_snapshots: Vec::new(),
                    branch,
                });
                current_id = id;
            }
            if let (Some(fp), Some(vid)) = (snap_file, snap_ver) {
                if let Some(label) = result.last_mut() {
                    label.file_snapshots.push(LabelFileSnapshot {
                        file_path: fp,
                        version_id: vid,
                    });
                }
            }
        }

        Ok(result)
    }

    /// 删除标签
    pub fn delete_label(&self, label_id: &str) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "DELETE FROM label_snapshots WHERE label_id = ?1",
            params![label_id],
        )?;
        db.execute("DELETE FROM labels WHERE id = ?1", params![label_id])?;
        Ok(())
    }

    // ============ 目录级查询 ============

    /// 列出目录下所有文件的变更记录
    pub fn list_directory_changes(
        &self,
        dir_path: &str,
        since: Option<&str>,
    ) -> Result<Vec<FileVersion>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let escaped_dir = escape_like_pattern(dir_path.trim_end_matches('/'));
        let pattern = if dir_path.is_empty() {
            "%".to_string()
        } else {
            format!("{}/%", escaped_dir)
        };

        let versions = if let Some(since_time) = since {
            let mut stmt = db.prepare(
                "SELECT id, file_path, hash, size, created_at, is_deleted, branch
                 FROM file_versions
                 WHERE file_path LIKE ?1 ESCAPE '\\' AND created_at >= ?2
                 ORDER BY created_at DESC",
            )?;
            let result = stmt.query_map(params![pattern, since_time], |row| {
                Ok(FileVersion {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    is_deleted: row.get::<_, i32>(5)? != 0,
                    branch: row.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
            result
        } else {
            let mut stmt = db.prepare(
                "SELECT id, file_path, hash, size, created_at, is_deleted, branch
                 FROM file_versions
                 WHERE file_path LIKE ?1 ESCAPE '\\'
                 ORDER BY created_at DESC",
            )?;
            let result = stmt.query_map(params![pattern], |row| {
                Ok(FileVersion {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    is_deleted: row.get::<_, i32>(5)? != 0,
                    branch: row.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
            result
        };

        Ok(versions)
    }

    /// 获取最近变更（跨文件）
    pub fn get_recent_changes(&self, limit: usize) -> Result<Vec<RecentChange>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT fv.file_path, fv.id, fv.created_at, fv.size, fv.hash,
                    (SELECT l.name FROM label_snapshots ls
                     JOIN labels l ON l.id = ls.label_id
                     WHERE ls.file_path = fv.file_path AND ls.version_id = fv.id
                     LIMIT 1) as label_name,
                    fv.branch
             FROM file_versions fv
             ORDER BY fv.created_at DESC
             LIMIT ?1",
        )?;

        let changes = stmt
            .query_map(params![limit as i64], |row| {
                Ok(RecentChange {
                    file_path: row.get(0)?,
                    version_id: row.get(1)?,
                    timestamp: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    hash: row.get(4)?,
                    label_name: row.get(5)?,
                    branch: row.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(changes)
    }

    /// 获取所有已追踪文件的最新版本快照（用于标签创建）
    pub fn get_all_latest_snapshots(&self) -> Result<Vec<LabelFileSnapshot>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT file_path, id FROM file_versions
             WHERE (file_path, id) IN (
                 SELECT file_path, MAX(id) FROM file_versions GROUP BY file_path
             )",
        )?;

        let snapshots = stmt
            .query_map([], |row| {
                Ok(LabelFileSnapshot {
                    file_path: row.get(0)?,
                    version_id: row.get(1)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(snapshots)
    }

    /// 获取已删除文件列表（最新版本 is_deleted=true 的文件）
    pub fn list_deleted_files(&self) -> Result<Vec<FileVersion>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT id, file_path, hash, size, created_at, is_deleted, branch
             FROM file_versions
             WHERE is_deleted = 1
             AND (file_path, id) IN (
                 SELECT file_path, MAX(id) FROM file_versions GROUP BY file_path
             )
             ORDER BY created_at DESC",
        )?;

        let versions = stmt
            .query_map([], |row| {
                Ok(FileVersion {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, i64>(3)? as u64,
                    created_at: row.get(4)?,
                    is_deleted: row.get::<_, i32>(5)? != 0,
                    branch: row.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(versions)
    }

    // ============ 压缩存储 ============

    /// 压缩所有未压缩的 blob 文件
    pub fn compress_blobs(&self) -> Result<usize> {
        let blobs_dir = self.blobs_path();
        if !blobs_dir.exists() {
            return Ok(0);
        }

        let mut compressed_count = 0;
        for entry in fs::read_dir(&blobs_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm") {
                continue;
            }

            let path = entry.path();
            let raw = fs::read(&path)?;

            // 已经压缩的跳过
            if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
                continue;
            }

            // 小于 512 字节不压缩（压缩收益小）
            if raw.len() < 512 {
                continue;
            }

            // gzip 压缩
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&raw)?;
            let compressed = encoder.finish()?;

            // 只有压缩后确实更小才替换（写临时文件后原子 rename，避免并发读到部分内容）
            if compressed.len() < raw.len() {
                let tmp_path = path.with_extension("gz.tmp");
                fs::write(&tmp_path, &compressed)?;
                fs::rename(&tmp_path, &path)?;
                compressed_count += 1;
            }
        }

        Ok(compressed_count)
    }

    /// 以只读模式打开数据库（用于查询其他 worktree 的历史）
    pub fn open_readonly(project_path: &Path) -> Result<Self> {
        let ccpanes = project_path.join(CCPANES_DIR);
        let history = ccpanes.join(HISTORY_DIR);
        let db_path = history.join(DB_FILE);

        if !db_path.exists() {
            anyhow::bail!("History database not found at {:?}", db_path);
        }

        let conn = Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .context("Failed to open history database in readonly mode")?;

        Ok(Self {
            db: Mutex::new(conn),
            project_path: project_path.to_path_buf(),
        })
    }

}

/// 转义 SQLite LIKE 模式中的特殊字符（`\`、`%`、`_`）
/// 必须先转义 `\`，再转义 `%` 和 `_`，否则会产生二次转义。
fn escape_like_pattern(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_like_plain_string() {
        assert_eq!(escape_like_pattern("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn test_escape_like_percent() {
        assert_eq!(escape_like_pattern("100%done"), "100\\%done");
    }

    #[test]
    fn test_escape_like_underscore() {
        assert_eq!(escape_like_pattern("file_name"), "file\\_name");
    }

    #[test]
    fn test_escape_like_backslash() {
        assert_eq!(escape_like_pattern("path\\to\\file"), "path\\\\to\\\\file");
    }

    #[test]
    fn test_escape_like_all_special() {
        // 含全部三种特殊字符
        assert_eq!(
            escape_like_pattern("a\\b%c_d"),
            "a\\\\b\\%c\\_d"
        );
    }

    #[test]
    fn test_escape_like_empty() {
        assert_eq!(escape_like_pattern(""), "");
    }
}
