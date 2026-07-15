use crate::models::{UsageScanState, UsageStatsDelta, UsageStatsRow, UsageTotals};
use crate::repository::Database;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use std::sync::Arc;
use tracing::error;

/// PTY 实时累加字符数的 source_path 固定 sentinel。
/// 与 jsonl 绝对路径区分，保证 UNIQUE(date, cli, workspace, source_path) 不冲突。
pub const PTY_INPUT_SOURCE: &str = "_pty";

pub struct UsageStatsRepository {
    db: Arc<Database>,
}

impl UsageStatsRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 写入/覆盖单个 jsonl 文件在某日期的聚合（幂等）。
    /// 重复扫描同一份文件直接覆盖该 (date, cli, ws, path) 行，不会累加 → 重启/重扫安全。
    pub fn upsert_jsonl_stats(
        &self,
        source_path: &str,
        delta: &UsageStatsDelta,
    ) -> Result<(), String> {
        // jsonl 路径下 char_count 恒为 0，is_empty 等价于 "token 全 0"
        if delta.is_empty() {
            return Ok(());
        }

        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_stats (
                date, cli_tool, workspace_name, source_path,
                char_count, token_input, token_output,
                token_cache_read, token_cache_creation, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(date, cli_tool, workspace_name, source_path) DO UPDATE SET
                token_input = excluded.token_input,
                token_output = excluded.token_output,
                token_cache_read = excluded.token_cache_read,
                token_cache_creation = excluded.token_cache_creation,
                updated_at = excluded.updated_at",
            params![
                delta.date,
                delta.cli_tool,
                delta.workspace_name,
                source_path,
                delta.token_input as i64,
                delta.token_output as i64,
                delta.token_cache_read as i64,
                delta.token_cache_creation as i64,
                now,
            ],
        )
        .map_err(|e| {
            error!(table = "usage_stats", source = source_path, err = %e, "SQL upsert_jsonl_stats failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 批量覆盖某 jsonl 文件的多个日期聚合。
    pub fn upsert_jsonl_stats_batch(
        &self,
        source_path: &str,
        deltas: &[UsageStatsDelta],
    ) -> Result<(), String> {
        for delta in deltas {
            self.upsert_jsonl_stats(source_path, delta)?;
        }
        Ok(())
    }

    /// 删除某 jsonl 文件所有日期的累计行（重扫前先清空再写，保证与文件当前状态一致）。
    pub fn delete_jsonl_stats(&self, source_path: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM usage_stats WHERE source_path = ?1",
            params![source_path],
        )
        .map_err(|e| {
            error!(table = "usage_stats", source = source_path, err = %e, "SQL delete_jsonl_stats failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// PTY 字符输入累加（30s flush 调用）。source_path 固定 `_pty`，
    /// char_count 用 += 增量累加；token 字段 0（PTY 不贡献 token）。
    pub fn upsert_pty_input(&self, delta: &UsageStatsDelta) -> Result<(), String> {
        if delta.char_count == 0 {
            return Ok(());
        }

        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_stats (
                date, cli_tool, workspace_name, source_path,
                char_count, token_input, token_output,
                token_cache_read, token_cache_creation, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, 0, ?6)
             ON CONFLICT(date, cli_tool, workspace_name, source_path) DO UPDATE SET
                char_count = char_count + excluded.char_count,
                updated_at = excluded.updated_at",
            params![
                delta.date,
                delta.cli_tool,
                delta.workspace_name,
                PTY_INPUT_SOURCE,
                delta.char_count as i64,
                now,
            ],
        )
        .map_err(|e| {
            error!(table = "usage_stats", source = PTY_INPUT_SOURCE, err = %e, "SQL upsert_pty_input failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 批量 PTY 输入累加。
    pub fn upsert_pty_inputs(&self, deltas: &[UsageStatsDelta]) -> Result<(), String> {
        for delta in deltas {
            self.upsert_pty_input(delta)?;
        }
        Ok(())
    }

    pub fn query_rows(
        &self,
        start_date: &str,
        workspace_filter: Option<&str>,
    ) -> Result<Vec<UsageStatsRow>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut rows = Vec::new();

        if let Some(workspace) = workspace_filter {
            let mut stmt = conn
                .prepare(
                    "SELECT date, cli_tool,
                        SUM(char_count),
                        SUM(token_input),
                        SUM(token_output),
                        SUM(token_cache_read),
                        SUM(token_cache_creation)
                     FROM usage_stats
                     WHERE date >= ?1 AND workspace_name = ?2
                     GROUP BY date, cli_tool
                     ORDER BY date ASC",
                )
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map(params![start_date, workspace], row_to_usage_stats_row)
                .map_err(|e| e.to_string())?;
            for row in mapped {
                rows.push(row.map_err(|e| e.to_string())?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT date, cli_tool,
                        SUM(char_count),
                        SUM(token_input),
                        SUM(token_output),
                        SUM(token_cache_read),
                        SUM(token_cache_creation)
                     FROM usage_stats
                     WHERE date >= ?1
                     GROUP BY date, cli_tool
                     ORDER BY date ASC",
                )
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map(params![start_date], row_to_usage_stats_row)
                .map_err(|e| e.to_string())?;
            for row in mapped {
                rows.push(row.map_err(|e| e.to_string())?);
            }
        }

        Ok(rows)
    }

    pub fn list_workspaces(&self) -> Result<Vec<String>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT workspace_name
                 FROM usage_stats
                 ORDER BY CASE WHEN workspace_name = '_global' THEN 0 ELSE 1 END, workspace_name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_scan_state(&self, jsonl_path: &str) -> Result<Option<UsageScanState>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT jsonl_path, last_byte_offset, last_mtime_ms, scanned_at
             FROM usage_scan_state
             WHERE jsonl_path = ?1",
            params![jsonl_path],
            |row| {
                let offset: i64 = row.get(1)?;
                Ok(UsageScanState {
                    jsonl_path: row.get(0)?,
                    last_byte_offset: offset.max(0) as u64,
                    last_mtime_ms: row.get(2)?,
                    scanned_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 清空全部扫描状态：统计算法变更时强制下一轮全量重扫，
    /// usage_stats 行随重扫被 REPLACE 重算（幂等设计兜底，无需数据迁移）。
    pub fn clear_all_scan_states(&self) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM usage_scan_state", [])
            .map_err(|e| {
                error!(table = "usage_scan_state", err = %e, "SQL clear_all_scan_states failed");
                e.to_string()
            })?;
        Ok(())
    }

    pub fn upsert_scan_state(
        &self,
        jsonl_path: &str,
        last_byte_offset: u64,
        last_mtime_ms: i64,
    ) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let scanned_at = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_scan_state (
                jsonl_path, last_byte_offset, last_mtime_ms, scanned_at
             )
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(jsonl_path) DO UPDATE SET
                last_byte_offset = excluded.last_byte_offset,
                last_mtime_ms = excluded.last_mtime_ms,
                scanned_at = excluded.scanned_at",
            params![
                jsonl_path,
                last_byte_offset as i64,
                last_mtime_ms,
                scanned_at,
            ],
        )
        .map_err(|e| {
            error!(table = "usage_scan_state", path = %jsonl_path, err = %e, "SQL upsert_scan_state failed");
            e.to_string()
        })?;
        Ok(())
    }
}

fn row_to_usage_stats_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageStatsRow> {
    Ok(UsageStatsRow {
        date: row.get(0)?,
        cli_tool: row.get(1)?,
        totals: UsageTotals {
            char_count: i64_to_u64(row.get(2)?),
            token_input: i64_to_u64(row.get(3)?),
            token_output: i64_to_u64(row.get(4)?),
            token_cache_read: i64_to_u64(row.get(5)?),
            token_cache_creation: i64_to_u64(row.get(6)?),
        },
    })
}

fn i64_to_u64(value: i64) -> u64 {
    value.max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> UsageStatsRepository {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        UsageStatsRepository::new(db)
    }

    fn token_delta(token_input: u64) -> UsageStatsDelta {
        UsageStatsDelta {
            date: "2026-05-23".to_string(),
            cli_tool: "codex".to_string(),
            workspace_name: "main".to_string(),
            char_count: 0,
            token_input,
            token_output: 0,
            token_cache_read: 0,
            token_cache_creation: 0,
        }
    }

    #[test]
    fn upsert_jsonl_stats_is_idempotent_for_same_path() {
        let repo = repo();
        // 第一次扫描某文件
        repo.upsert_jsonl_stats("/path/a.jsonl", &token_delta(100))
            .expect("first upsert");
        // 第二次扫描相同文件（内容更新到 250）— 应覆盖不累加
        repo.upsert_jsonl_stats("/path/a.jsonl", &token_delta(250))
            .expect("second upsert");

        let rows = repo
            .query_rows("2026-05-01", Some("main"))
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].totals.token_input, 250,
            "second upsert should REPLACE, not accumulate"
        );
    }

    #[test]
    fn upsert_jsonl_stats_different_paths_sum_via_query() {
        let repo = repo();
        repo.upsert_jsonl_stats("/path/a.jsonl", &token_delta(100))
            .expect("upsert a");
        repo.upsert_jsonl_stats("/path/b.jsonl", &token_delta(50))
            .expect("upsert b");

        let rows = repo
            .query_rows("2026-05-01", Some("main"))
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].totals.token_input, 150,
            "GROUP BY should SUM across source_path"
        );
    }

    #[test]
    fn upsert_pty_input_accumulates() {
        let repo = repo();
        let mut delta = UsageStatsDelta {
            date: "2026-05-23".to_string(),
            cli_tool: "claude".to_string(),
            workspace_name: "main".to_string(),
            char_count: 100,
            token_input: 0,
            token_output: 0,
            token_cache_read: 0,
            token_cache_creation: 0,
        };
        repo.upsert_pty_input(&delta).expect("first pty input");
        delta.char_count = 75;
        repo.upsert_pty_input(&delta).expect("second pty input");

        let rows = repo
            .query_rows("2026-05-01", Some("main"))
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].totals.char_count, 175,
            "pty input should ADD, not REPLACE"
        );
    }

    #[test]
    fn jsonl_and_pty_coexist_in_same_date_workspace() {
        let repo = repo();
        // jsonl 贡献 token
        repo.upsert_jsonl_stats(
            "/path/x.jsonl",
            &UsageStatsDelta {
                date: "2026-05-23".to_string(),
                cli_tool: "claude".to_string(),
                workspace_name: "main".to_string(),
                char_count: 0,
                token_input: 500,
                token_output: 200,
                token_cache_read: 0,
                token_cache_creation: 0,
            },
        )
        .expect("jsonl upsert");
        // PTY 贡献 char
        repo.upsert_pty_input(&UsageStatsDelta {
            date: "2026-05-23".to_string(),
            cli_tool: "claude".to_string(),
            workspace_name: "main".to_string(),
            char_count: 42,
            token_input: 0,
            token_output: 0,
            token_cache_read: 0,
            token_cache_creation: 0,
        })
        .expect("pty upsert");

        let rows = repo
            .query_rows("2026-05-01", Some("main"))
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].totals.token_input, 500);
        assert_eq!(rows[0].totals.token_output, 200);
        assert_eq!(rows[0].totals.char_count, 42);
    }
}
