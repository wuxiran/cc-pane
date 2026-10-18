use super::HistoryFileRepository;
use crate::models::HistoryConfig;
use anyhow::Result;
use rusqlite::{params, Connection};
use std::fs;

impl HistoryFileRepository {
    /// 清理旧版本
    pub fn cleanup_old_versions(&self, config: &HistoryConfig) -> Result<()> {
        let _files = self.lock_files();
        let cutoff = chrono::Utc::now() - chrono::Duration::days(config.max_age_days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        {
            let mut connection = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let db = connection.transaction()?;

            // 获取所有文件路径
            let file_paths: Vec<String> = {
                let mut stmt = db.prepare("SELECT DISTINCT file_path FROM file_versions")?;
                let result = stmt
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
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
            expire_invalid_labels(&db)?;
            db.commit()?;
        }

        // 清理孤儿 blob 文件（不再被任何版本引用）
        self.cleanup_orphan_blobs()?;

        Ok(())
    }

    /// LRU 清理：按 max_total_size 限制
    pub fn cleanup_by_total_size(&self, max_total_size: u64) -> Result<()> {
        let _files = self.lock_files();
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
            let mut connection = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let db = connection.transaction()?;
            let rows: Vec<(String, String, String, i64)> = {
                let mut stmt = db.prepare(
                    "SELECT id, file_path, hash, size FROM file_versions ORDER BY id ASC",
                )?;
                let result = stmt
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                result
            };

            let mut freed: u64 = 0;
            let need_to_free = total_size - max_total_size;

            for (id, fp, hash, _size) in &rows {
                if freed >= need_to_free {
                    break;
                }
                db.execute(
                    "DELETE FROM file_versions WHERE file_path = ?1 AND id = ?2",
                    params![fp, id],
                )?;
                // 删除后检查该 blob 是否已无版本引用；只有归零那一刻磁盘 blob
                // 才真正可回收，此时才计入释放量。
                //
                // 不能按 hash「首次遇到才计数」：共享 blob（文件回退到旧内容会
                // 产生重复 hash）在首个副本被删时 ref_count 仍 > 0 计 0，且该
                // hash 被标记为已计数，导致最后一个副本删除、ref_count 归零时
                // 反而被跳过——freed 对所有共享 blob 永远停在 0，删除循环停不
                // 下来，最坏把全部历史版本删光。
                let ref_count: i64 = db.query_row(
                    "SELECT COUNT(*) FROM file_versions WHERE hash = ?1",
                    params![hash],
                    |row| row.get(0),
                )?;
                if ref_count == 0 {
                    let blob_size = self
                        .blob_path(hash)
                        .metadata()
                        .map(|m| m.len())
                        .unwrap_or(0);
                    freed += blob_size;
                }
            }
            expire_invalid_labels(&db)?;
            db.commit()?;
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
            let result = stmt
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
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
}

/// Retention applies to labels too: expire the whole label when any of its
/// versions expires, never leave a seemingly complete but partial snapshot.
fn expire_invalid_labels(db: &Connection) -> Result<()> {
    db.execute_batch(
        "DELETE FROM labels WHERE id IN (
        SELECT ls.label_id FROM label_snapshots ls WHERE NOT EXISTS (
            SELECT 1 FROM file_versions v
            WHERE v.file_path = ls.file_path AND v.id = ls.version_id
        )
    );
    DELETE FROM label_snapshots WHERE NOT EXISTS (
        SELECT 1 FROM labels WHERE labels.id = label_snapshots.label_id
    );",
    )?;
    Ok(())
}
