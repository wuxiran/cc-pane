use crate::repository::Database;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchRecord {
    pub id: i64,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub launched_at: String,
}

pub struct HistoryRepository {
    db: Arc<Database>,
}

impl HistoryRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 添加启动记录
    pub fn add(&self, project_id: &str, project_name: &str, project_path: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO launch_history (project_id, project_name, project_path, launched_at) VALUES (?1, ?2, ?3, ?4)",
            [project_id, project_name, project_path, &now],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, project_id, project_name, project_path, launched_at FROM launch_history ORDER BY launched_at DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;

        let records = stmt
            .query_map([limit], |row| {
                Ok(LaunchRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    project_name: row.get(2)?,
                    project_path: row.get(3)?,
                    launched_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(records)
    }

    /// 清空历史记录
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM launch_history", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
