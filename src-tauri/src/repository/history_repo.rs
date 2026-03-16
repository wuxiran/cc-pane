use crate::repository::Database;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::error;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    pub id: i64,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub launched_at: String,
    pub claude_session_id: Option<String>,
    pub last_prompt: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub launch_cwd: Option<String>,
    pub provider_id: Option<String>,
}

pub struct HistoryRepository {
    db: Arc<Database>,
}

impl HistoryRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 添加启动记录，返回新记录的 ID
    #[allow(clippy::too_many_arguments)]
    pub fn add(&self, project_id: &str, project_name: &str, project_path: &str, workspace_name: Option<&str>, workspace_path: Option<&str>, launch_cwd: Option<&str>, provider_id: Option<&str>) -> Result<i64, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO launch_history (project_id, project_name, project_path, launched_at, workspace_name, workspace_path, launch_cwd, provider_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![project_id, project_name, project_path, &now, workspace_name, workspace_path, launch_cwd, provider_id],
        )
        .map_err(|e| {
            error!(table = "launch_history", project_id = %project_id, err = %e, "SQL insert failed");
            e.to_string()
        })?;

        Ok(conn.last_insert_rowid())
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, project_id, project_name, project_path, launched_at, claude_session_id, last_prompt, workspace_name, workspace_path, launch_cwd, provider_id FROM launch_history ORDER BY launched_at DESC LIMIT ?1")
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL prepare failed");
                e.to_string()
            })?;

        let records = stmt
            .query_map([limit], |row| {
                Ok(LaunchRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    project_name: row.get(2)?,
                    project_path: row.get(3)?,
                    launched_at: row.get(4)?,
                    claude_session_id: row.get(5)?,
                    last_prompt: row.get(6)?,
                    workspace_name: row.get(7)?,
                    workspace_path: row.get(8)?,
                    launch_cwd: row.get(9)?,
                    provider_id: row.get(10)?,
                })
            })
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL query_map failed");
                e.to_string()
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 按项目路径获取启动记录（SQL 层过滤，路径大小写不敏感 + 正反斜杠统一比较）
    pub fn list_by_project(&self, project_path: &str, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        // 在 SQL 中用 REPLACE + LOWER 做路径规范化比较
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, project_name, project_path, launched_at, claude_session_id, last_prompt, workspace_name, workspace_path, launch_cwd, provider_id \
                 FROM launch_history \
                 WHERE LOWER(REPLACE(project_path, '\\', '/')) = LOWER(REPLACE(?1, '\\', '/')) \
                 ORDER BY launched_at DESC LIMIT ?2"
            )
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL prepare (list_by_project) failed");
                e.to_string()
            })?;

        let records = stmt
            .query_map(rusqlite::params![project_path, limit], |row| {
                Ok(LaunchRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    project_name: row.get(2)?,
                    project_path: row.get(3)?,
                    launched_at: row.get(4)?,
                    claude_session_id: row.get(5)?,
                    last_prompt: row.get(6)?,
                    workspace_name: row.get(7)?,
                    workspace_path: row.get(8)?,
                    launch_cwd: row.get(9)?,
                    provider_id: row.get(10)?,
                })
            })
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL query_map (list_by_project) failed");
                e.to_string()
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 更新启动记录的 Claude Session ID
    pub fn update_session_id(&self, id: i64, claude_session_id: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE launch_history SET claude_session_id = ?1 WHERE id = ?2",
            rusqlite::params![claude_session_id, id],
        )
        .map_err(|e| {
            error!(table = "launch_history", id = %id, err = %e, "SQL update_session_id failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 更新启动记录的最后 Prompt
    pub fn update_last_prompt(&self, id: i64, last_prompt: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE launch_history SET last_prompt = ?1 WHERE id = ?2",
            rusqlite::params![last_prompt, id],
        )
        .map_err(|e| {
            error!(table = "launch_history", id = %id, err = %e, "SQL update_last_prompt failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 更新已有会话记录的时间戳，返回记录 ID（不存在则返回 None）
    pub fn touch_by_session_id(&self, claude_session_id: &str) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE launch_history SET launched_at = ?1 WHERE claude_session_id = ?2",
            rusqlite::params![&now, claude_session_id],
        ).map_err(|e| {
            error!(table = "launch_history", err = %e, "SQL touch_by_session_id update failed");
            e.to_string()
        })?;
        if affected == 0 {
            return Ok(None);
        }
        let id: i64 = conn.query_row(
            "SELECT id FROM launch_history WHERE claude_session_id = ?1 ORDER BY launched_at DESC LIMIT 1",
            rusqlite::params![claude_session_id],
            |row| row.get(0),
        ).map_err(|e| {
            error!(table = "launch_history", err = %e, "SQL touch_by_session_id query failed");
            e.to_string()
        })?;
        Ok(Some(id))
    }

    /// 删除单条启动记录
    pub fn delete_by_id(&self, id: i64) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM launch_history WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| {
                error!(table = "launch_history", id = %id, err = %e, "SQL delete_by_id failed");
                e.to_string()
            })?;
        Ok(())
    }

    /// 清空历史记录
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM launch_history", [])
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL clear failed");
                e.to_string()
            })?;
        Ok(())
    }
}
