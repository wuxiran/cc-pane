//! MCP 工具调用计数（docs/89 §5 前置埋点）。
//!
//! 隐私红线：只计数不记内容（粒度 = 工具名 → 次数 + 最后调用时间），
//! 数据只落本机 data.db，本模块零网络调用、禁止任何自动上传链路。

use crate::repository::Database;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use std::sync::Arc;
use tracing::error;

pub struct McpToolCallStatsRepository {
    db: Arc<Database>,
}

impl McpToolCallStatsRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 单次调用计数：UPSERT 递增 call_count 并刷新 last_called_at。
    /// 调用方按 fire-and-forget 使用，失败不得影响工具调用本身。
    pub fn record_call(&self, tool_name: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO mcp_tool_call_stats (tool_name, call_count, last_called_at)
             VALUES (?1, 1, ?2)
             ON CONFLICT(tool_name) DO UPDATE SET
                call_count = call_count + 1,
                last_called_at = excluded.last_called_at",
            params![tool_name, now],
        )
        .map_err(|e| {
            error!(table = "mcp_tool_call_stats", tool = tool_name, err = %e, "SQL record_call failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 读取单个工具的 (call_count, last_called_at)。当前仅测试与后续查看批次使用。
    pub fn get(&self, tool_name: &str) -> Result<Option<(i64, String)>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT call_count, last_called_at
             FROM mcp_tool_call_stats
             WHERE tool_name = ?1",
            params![tool_name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Arc<Database>, McpToolCallStatsRepository) {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        let repo = McpToolCallStatsRepository::new(db.clone());
        (db, repo)
    }

    #[test]
    fn record_call_inserts_then_increments() {
        let (_db, repo) = setup();
        repo.record_call("launch_task").expect("first call");
        repo.record_call("launch_task").expect("second call");
        repo.record_call("list_sessions").expect("other tool");

        let (count, _) = repo.get("launch_task").expect("query").expect("row exists");
        assert_eq!(count, 2, "UPSERT should increment, not replace");

        let (other_count, _) = repo
            .get("list_sessions")
            .expect("query")
            .expect("row exists");
        assert_eq!(other_count, 1, "counters are per tool_name");
    }

    #[test]
    fn record_call_refreshes_last_called_at() {
        let (db, repo) = setup();
        repo.record_call("wait_for_session").expect("first call");

        // 回拨时间戳后再计一次，验证 last_called_at 确实被刷新
        let stale = "2000-01-01T00:00:00+00:00";
        db.connection()
            .expect("conn")
            .execute(
                "UPDATE mcp_tool_call_stats SET last_called_at = ?1 WHERE tool_name = ?2",
                params![stale, "wait_for_session"],
            )
            .expect("backdate");

        repo.record_call("wait_for_session").expect("second call");
        let (count, last_called_at) = repo
            .get("wait_for_session")
            .expect("query")
            .expect("row exists");
        assert_eq!(count, 2);
        assert_ne!(
            last_called_at, stale,
            "last_called_at should be refreshed on every call"
        );
    }

    #[test]
    fn get_unknown_tool_returns_none() {
        let (_db, repo) = setup();
        assert!(repo.get("never_called").expect("query").is_none());
    }
}
