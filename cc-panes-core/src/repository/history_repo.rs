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
    pub pty_session_id: Option<String>,
    pub resume_session_id: Option<String>,
    pub cli_tool: String,
    pub runtime_kind: String,
    pub wsl_distro: Option<String>,
    pub last_prompt: Option<String>,
    pub workspace_name: Option<String>,
    pub workspace_path: Option<String>,
    pub launch_cwd: Option<String>,
    pub provider_id: Option<String>,
    pub provider_selection: Option<String>,
    pub launch_profile_id: Option<String>,
    pub workspace_snapshot_id: Option<String>,
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
    pub fn add(
        &self,
        project_id: &str,
        project_name: &str,
        project_path: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        workspace_name: Option<&str>,
        workspace_path: Option<&str>,
        launch_cwd: Option<&str>,
        provider_id: Option<&str>,
        provider_selection: Option<&str>,
        launch_profile_id: Option<&str>,
        workspace_snapshot_id: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO launch_history (
                project_id, project_name, project_path, launched_at,
                cli_tool, runtime_kind, wsl_distro, workspace_name, workspace_path, launch_cwd, provider_id, provider_selection, launch_profile_id, workspace_session_id, workspace_snapshot_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            rusqlite::params![
                project_id,
                project_name,
                project_path,
                &now,
                cli_tool,
                runtime_kind,
                wsl_distro,
                workspace_name,
                workspace_path,
                launch_cwd,
                provider_id,
                provider_selection,
                launch_profile_id,
                workspace_snapshot_id,
                workspace_snapshot_id
            ],
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
            .prepare(
                "SELECT
                    id,
                    project_id,
                    project_name,
                    project_path,
                    launched_at,
                    pty_session_id,
                    COALESCE(resume_session_id, claude_session_id) AS resume_session_id,
                    COALESCE(cli_tool, 'none') AS cli_tool,
                    COALESCE(runtime_kind, 'local') AS runtime_kind,
                    wsl_distro,
                    last_prompt,
                    workspace_name,
                    workspace_path,
                    launch_cwd,
                    provider_id,
                    provider_selection,
                    launch_profile_id,
                    COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id
                 FROM launch_history
                 ORDER BY launched_at DESC
                 LIMIT ?1",
            )
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
                    pty_session_id: row.get(5)?,
                    resume_session_id: row.get(6)?,
                    cli_tool: row.get(7)?,
                    runtime_kind: row.get(8)?,
                    wsl_distro: row.get(9)?,
                    last_prompt: row.get(10)?,
                    workspace_name: row.get(11)?,
                    workspace_path: row.get(12)?,
                    launch_cwd: row.get(13)?,
                    provider_id: row.get(14)?,
                    provider_selection: row.get(15)?,
                    launch_profile_id: row.get(16)?,
                    workspace_snapshot_id: row.get(17)?,
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
    pub fn list_by_project(
        &self,
        project_path: &str,
        limit: usize,
    ) -> Result<Vec<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        // 在 SQL 中用 REPLACE + LOWER 做路径规范化比较
        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    project_id,
                    project_name,
                    project_path,
                    launched_at,
                    pty_session_id,
                    COALESCE(resume_session_id, claude_session_id) AS resume_session_id,
                    COALESCE(cli_tool, 'none') AS cli_tool,
                    COALESCE(runtime_kind, 'local') AS runtime_kind,
                    wsl_distro,
                    last_prompt,
                    workspace_name,
                    workspace_path,
                    launch_cwd,
                    provider_id, \
                    provider_selection, \
                    launch_profile_id, \
                    COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id \
                 FROM launch_history \
                 WHERE LOWER(REPLACE(project_path, '\\', '/')) = LOWER(REPLACE(?1, '\\', '/')) \
                 ORDER BY launched_at DESC LIMIT ?2",
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
                    pty_session_id: row.get(5)?,
                    resume_session_id: row.get(6)?,
                    cli_tool: row.get(7)?,
                    runtime_kind: row.get(8)?,
                    wsl_distro: row.get(9)?,
                    last_prompt: row.get(10)?,
                    workspace_name: row.get(11)?,
                    workspace_path: row.get(12)?,
                    launch_cwd: row.get(13)?,
                    provider_id: row.get(14)?,
                    provider_selection: row.get(15)?,
                    launch_profile_id: row.get(16)?,
                    workspace_snapshot_id: row.get(17)?,
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
    pub fn update_session_id(&self, id: i64, resume_session_id: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE launch_history SET resume_session_id = ?1 WHERE id = ?2",
            rusqlite::params![resume_session_id, id],
        )
        .map_err(|e| {
            error!(table = "launch_history", id = %id, err = %e, "SQL update_session_id failed");
            e.to_string()
        })?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_session_started(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        resume_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        launch_cwd: Option<&str>,
    ) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE launch_history
                 SET pty_session_id = ?1,
                     resume_session_id = ?2,
                     cli_tool = ?3,
                     runtime_kind = ?4,
                     wsl_distro = COALESCE(?5, wsl_distro),
                     launch_cwd = COALESCE(?6, launch_cwd)
                 WHERE project_id = ?7",
                rusqlite::params![
                    pty_session_id,
                    resume_session_id,
                    cli_tool,
                    runtime_kind,
                    wsl_distro,
                    launch_cwd,
                    launch_id
                ],
            )
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL update_session_started failed");
                e.to_string()
            })?;

        if affected == 0 {
            return Ok(None);
        }

        let id = conn
            .query_row(
                "SELECT id FROM launch_history WHERE project_id = ?1 ORDER BY launched_at DESC LIMIT 1",
                rusqlite::params![launch_id],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL query session_started record failed");
                e.to_string()
            })?;

        Ok(Some(id))
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

    pub fn update_last_prompt_by_pty_session_id(
        &self,
        pty_session_id: &str,
        last_prompt: &str,
    ) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE launch_history SET last_prompt = ?1 WHERE pty_session_id = ?2",
                rusqlite::params![last_prompt, pty_session_id],
            )
            .map_err(|e| {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL update_last_prompt_by_pty_session_id failed");
                e.to_string()
            })?;
        if affected == 0 {
            return Ok(None);
        }
        let id = conn
            .query_row(
                "SELECT id FROM launch_history WHERE pty_session_id = ?1 ORDER BY launched_at DESC LIMIT 1",
                rusqlite::params![pty_session_id],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL query updated prompt record failed");
                e.to_string()
            })?;
        Ok(Some(id))
    }

    pub fn find_by_pty_session_id(
        &self,
        pty_session_id: &str,
    ) -> Result<Option<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    project_id,
                    project_name,
                    project_path,
                    launched_at,
                    pty_session_id,
                    COALESCE(resume_session_id, claude_session_id) AS resume_session_id,
                    COALESCE(cli_tool, 'none') AS cli_tool,
                    COALESCE(runtime_kind, 'local') AS runtime_kind,
                    wsl_distro,
                    last_prompt,
                    workspace_name,
                    workspace_path,
                    launch_cwd,
                    provider_id,
                    provider_selection,
                    launch_profile_id,
                    COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id
                 FROM launch_history
                 WHERE pty_session_id = ?1
                 ORDER BY launched_at DESC
                 LIMIT 1",
            )
            .map_err(|e| {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL prepare find_by_pty_session_id failed");
                e.to_string()
            })?;

        let result = stmt.query_row(rusqlite::params![pty_session_id], |row| {
            Ok(LaunchRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                project_path: row.get(3)?,
                launched_at: row.get(4)?,
                pty_session_id: row.get(5)?,
                resume_session_id: row.get(6)?,
                cli_tool: row.get(7)?,
                runtime_kind: row.get(8)?,
                wsl_distro: row.get(9)?,
                last_prompt: row.get(10)?,
                workspace_name: row.get(11)?,
                workspace_path: row.get(12)?,
                launch_cwd: row.get(13)?,
                provider_id: row.get(14)?,
                provider_selection: row.get(15)?,
                launch_profile_id: row.get(16)?,
                workspace_snapshot_id: row.get(17)?,
            })
        });

        match result {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL find_by_pty_session_id failed");
                Err(e.to_string())
            }
        }
    }

    pub fn find_by_launch_id(&self, launch_id: &str) -> Result<Option<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    project_id,
                    project_name,
                    project_path,
                    launched_at,
                    pty_session_id,
                    COALESCE(resume_session_id, claude_session_id) AS resume_session_id,
                    COALESCE(cli_tool, 'none') AS cli_tool,
                    COALESCE(runtime_kind, 'local') AS runtime_kind,
                    wsl_distro,
                    last_prompt,
                    workspace_name,
                    workspace_path,
                    launch_cwd,
                    provider_id,
                    provider_selection,
                    launch_profile_id,
                    COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id
                 FROM launch_history
                 WHERE project_id = ?1
                 ORDER BY launched_at DESC
                 LIMIT 1",
            )
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL prepare find_by_launch_id failed");
                e.to_string()
            })?;

        let result = stmt.query_row(rusqlite::params![launch_id], |row| {
            Ok(LaunchRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                project_path: row.get(3)?,
                launched_at: row.get(4)?,
                pty_session_id: row.get(5)?,
                resume_session_id: row.get(6)?,
                cli_tool: row.get(7)?,
                runtime_kind: row.get(8)?,
                wsl_distro: row.get(9)?,
                last_prompt: row.get(10)?,
                workspace_name: row.get(11)?,
                workspace_path: row.get(12)?,
                launch_cwd: row.get(13)?,
                provider_id: row.get(14)?,
                provider_selection: row.get(15)?,
                launch_profile_id: row.get(16)?,
                workspace_snapshot_id: row.get(17)?,
            })
        });

        match result {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL find_by_launch_id failed");
                Err(e.to_string())
            }
        }
    }

    /// 更新已有会话记录的时间戳，返回记录 ID（不存在则返回 None）
    pub fn touch_by_session_id(&self, resume_session_id: &str) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        let affected = conn
            .execute(
                "UPDATE launch_history SET launched_at = ?1 WHERE resume_session_id = ?2",
                rusqlite::params![&now, resume_session_id],
            )
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL touch_by_session_id update failed");
                e.to_string()
            })?;
        if affected == 0 {
            return Ok(None);
        }
        let id: i64 = conn.query_row(
            "SELECT id FROM launch_history WHERE resume_session_id = ?1 ORDER BY launched_at DESC LIMIT 1",
            rusqlite::params![resume_session_id],
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
        conn.execute(
            "DELETE FROM launch_history WHERE id = ?1",
            rusqlite::params![id],
        )
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
