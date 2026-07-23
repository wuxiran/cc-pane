use crate::repository::Database;
use crate::utils::simplify_opt_path_str;
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
    /// resume id 的来源：issued / osc-title / backfill / rescue / manual（NULL = 旧数据）
    pub resume_source: Option<String>,
}

/// launch_history 查询列清单（与 [`map_launch_record`] 严格对应，新增列必须两处同步）
const LAUNCH_RECORD_COLUMNS: &str = "
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
    COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id,
    resume_source";

fn map_launch_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<LaunchRecord> {
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
        resume_source: row.get(18)?,
    })
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
        // 入库防线：即使上游漏网也不落 `\\?\` 脏数据（docs/35-unc-path-contamination.md）
        let workspace_path = simplify_opt_path_str(workspace_path);
        let launch_cwd = simplify_opt_path_str(launch_cwd);

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

    /// 添加启动记录并立刻填上 `pty_session_id`。
    ///
    /// 用于 MCP `launch_task` 这种"由后端在 in-process 创建 PTY 后立即落 history"
    /// 的场景：先有 pty_session_id，再有 hook 上报的 resume_session_id。和
    /// [`Self::add`] 相比唯一区别是写入时就把 pty_session_id 设上，避免后续
    /// `find_by_launch_id` 在 hook 未到达前返回 `pty_session_id = NULL`。
    #[allow(clippy::too_many_arguments)]
    pub fn add_with_pty_session(
        &self,
        project_id: &str,
        project_name: &str,
        project_path: &str,
        pty_session_id: &str,
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
        // 入库防线：同 `add`
        let workspace_path = simplify_opt_path_str(workspace_path);
        let launch_cwd = simplify_opt_path_str(launch_cwd);

        conn.execute(
            "INSERT INTO launch_history (
                project_id, project_name, project_path, launched_at,
                pty_session_id,
                cli_tool, runtime_kind, wsl_distro, workspace_name, workspace_path, launch_cwd, provider_id, provider_selection, launch_profile_id, workspace_session_id, workspace_snapshot_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            rusqlite::params![
                project_id,
                project_name,
                project_path,
                &now,
                pty_session_id,
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
            error!(table = "launch_history", project_id = %project_id, err = %e, "SQL insert (with pty_session_id) failed");
            e.to_string()
        })?;

        Ok(conn.last_insert_rowid())
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {LAUNCH_RECORD_COLUMNS}
                 FROM launch_history
                 ORDER BY launched_at DESC
                 LIMIT ?1"
            ))
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL prepare failed");
                e.to_string()
            })?;

        let records = stmt
            .query_map([limit], map_launch_record)
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
            .prepare(&format!(
                "SELECT {LAUNCH_RECORD_COLUMNS}
                 FROM launch_history
                 WHERE LOWER(REPLACE(project_path, '\\', '/')) = LOWER(REPLACE(?1, '\\', '/'))
                 ORDER BY launched_at DESC LIMIT ?2"
            ))
            .map_err(|e| {
                error!(table = "launch_history", err = %e, "SQL prepare (list_by_project) failed");
                e.to_string()
            })?;

        let records = stmt
            .query_map(rusqlite::params![project_path, limit], map_launch_record)
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

    /// 标记 resume id 的来源（issued / osc-title / backfill / rescue / manual）
    pub fn update_resume_source(&self, id: i64, source: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE launch_history SET resume_source = ?1 WHERE id = ?2",
            rusqlite::params![source, id],
        )
        .map_err(|e| {
            error!(table = "launch_history", id = %id, err = %e, "SQL update_resume_source failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 按 pty_session_id 写入 resume id 及其来源（OSC 标题捕获等确定性通道使用）。
    /// 返回命中的记录 id；无匹配记录返回 None。
    pub fn update_resume_session_with_source_by_pty(
        &self,
        pty_session_id: &str,
        resume_session_id: &str,
        source: &str,
    ) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE launch_history
                 SET resume_session_id = ?1, resume_source = ?2
                 WHERE id = (
                     SELECT id FROM launch_history
                     WHERE pty_session_id = ?3
                     ORDER BY launched_at DESC LIMIT 1
                 )",
                rusqlite::params![resume_session_id, source, pty_session_id],
            )
            .map_err(|e| {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL update_resume_session_with_source_by_pty failed");
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
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL query updated resume record failed");
                e.to_string()
            })?;
        Ok(Some(id))
    }

    /// 将创建完成的 PTY 精确归属到对应 launch 记录。CLI 必须匹配，避免并发启动或
    /// 错误事件把 Codex PTY 绑定到 Claude 记录。
    pub fn bind_pty_session(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        cli_tool: &str,
    ) -> Result<Option<i64>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute(
                "UPDATE launch_history
                 SET pty_session_id = ?1
                 WHERE id = (
                     SELECT id FROM launch_history
                     WHERE project_id = ?2 AND cli_tool = ?3
                       AND (pty_session_id IS NULL OR pty_session_id = ?1)
                     ORDER BY launched_at DESC LIMIT 1
                 )",
                rusqlite::params![pty_session_id, launch_id, cli_tool],
            )
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, pty_session_id = %pty_session_id, cli_tool = %cli_tool, err = %e, "SQL bind_pty_session failed");
                e.to_string()
            })?;
        if affected == 0 {
            return Ok(None);
        }
        let id = conn
            .query_row(
                "SELECT id FROM launch_history
                 WHERE project_id = ?1 AND pty_session_id = ?2 AND cli_tool = ?3
                 ORDER BY launched_at DESC LIMIT 1",
                rusqlite::params![launch_id, pty_session_id, cli_tool],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, pty_session_id = %pty_session_id, err = %e, "SQL query bound PTY record failed");
                e.to_string()
            })?;
        Ok(Some(id))
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
        // 入库防线：hook 上报的 cwd 曾是 `\\?\` 污染的主要来源
        let launch_cwd = simplify_opt_path_str(launch_cwd);
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

    /// 回填会话启动信息（upsert）：先按 project_id UPDATE（同 update_session_started）；
    /// 若无匹配记录（GUI 经 TabBar 新建等路径从未 INSERT 过 launch_history），则 INSERT
    /// 一条带 pty + resume 的完整记录，使这类会话也能在 reload 时 `codex resume`。
    /// 与 update_session_started 不同：本方法保证落库（返回命中或新建的记录 id）。
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_session_started(
        &self,
        launch_id: &str,
        pty_session_id: &str,
        resume_session_id: &str,
        cli_tool: &str,
        runtime_kind: &str,
        wsl_distro: Option<&str>,
        launch_cwd: Option<&str>,
        project_path: &str,
        project_name: &str,
        workspace_path: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        // 入库防线：UPDATE 与下方 INSERT 分支共用规范化后的值
        let launch_cwd = simplify_opt_path_str(launch_cwd);
        let workspace_path = simplify_opt_path_str(workspace_path);
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
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL upsert_session_started UPDATE failed");
                e.to_string()
            })?;

        if affected > 0 {
            let id = conn
                .query_row(
                    "SELECT id FROM launch_history WHERE project_id = ?1 ORDER BY launched_at DESC LIMIT 1",
                    rusqlite::params![launch_id],
                    |row| row.get(0),
                )
                .map_err(|e| {
                    error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL upsert_session_started query id failed");
                    e.to_string()
                })?;
            return Ok(id);
        }

        // 无匹配记录：该会话从未写过 launch_history（GUI TabBar 新建等路径）。
        // INSERT 一条带 pty + resume 的记录，让 reload 能恢复。
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO launch_history (
                project_id, project_name, project_path, launched_at,
                pty_session_id, resume_session_id, cli_tool, runtime_kind, wsl_distro, workspace_path, launch_cwd
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                launch_id,
                project_name,
                project_path,
                &now,
                pty_session_id,
                resume_session_id,
                cli_tool,
                runtime_kind,
                wsl_distro,
                workspace_path,
                launch_cwd
            ],
        )
        .map_err(|e| {
            error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL upsert_session_started INSERT failed");
            e.to_string()
        })?;

        Ok(conn.last_insert_rowid())
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
            .prepare(&format!(
                "SELECT {LAUNCH_RECORD_COLUMNS}
                 FROM launch_history
                 WHERE pty_session_id = ?1
                 ORDER BY launched_at DESC
                 LIMIT 1"
            ))
            .map_err(|e| {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL prepare find_by_pty_session_id failed");
                e.to_string()
            })?;

        let result = stmt.query_row(rusqlite::params![pty_session_id], map_launch_record);

        match result {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "launch_history", pty_session_id = %pty_session_id, err = %e, "SQL find_by_pty_session_id failed");
                Err(e.to_string())
            }
        }
    }

    pub fn find_by_resume_session_id(
        &self,
        resume_session_id: &str,
    ) -> Result<Option<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {LAUNCH_RECORD_COLUMNS}
                 FROM launch_history
                 WHERE resume_session_id = ?1 OR claude_session_id = ?1
                 ORDER BY launched_at DESC
                 LIMIT 1"
            ))
            .map_err(|e| {
                error!(table = "launch_history", resume_session_id = %resume_session_id, err = %e, "SQL prepare find_by_resume_session_id failed");
                e.to_string()
            })?;

        let result = stmt.query_row(rusqlite::params![resume_session_id], map_launch_record);

        match result {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "launch_history", resume_session_id = %resume_session_id, err = %e, "SQL find_by_resume_session_id failed");
                Err(e.to_string())
            }
        }
    }

    pub fn find_by_launch_id(&self, launch_id: &str) -> Result<Option<LaunchRecord>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {LAUNCH_RECORD_COLUMNS}
                 FROM launch_history
                 WHERE project_id = ?1
                 ORDER BY launched_at DESC
                 LIMIT 1"
            ))
            .map_err(|e| {
                error!(table = "launch_history", launch_id = %launch_id, err = %e, "SQL prepare find_by_launch_id failed");
                e.to_string()
            })?;

        let result = stmt.query_row(rusqlite::params![launch_id], map_launch_record);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> HistoryRepository {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        HistoryRepository::new(db)
    }

    #[test]
    fn add_with_pty_session_round_trip_via_find_by_launch_id() {
        // Critical regression test: covers the MCP `launch_task` path that
        // synchronously inserts a row keyed by `project_id = child_launch_id`
        // with `pty_session_id` already filled. A grandchild call must then
        // be able to look up its caller via `find_by_launch_id` and pull the
        // pty_session_id back out for `parent_session_id` propagation.
        let r = repo();
        let launch_id = "orch-child-1";
        let pty_session = "pty-session-abc";

        let id = r
            .add_with_pty_session(
                launch_id,
                "my-project",
                "/tmp/my-project",
                pty_session,
                "claude",
                "local",
                None,
                None,
                None,
                Some("/tmp/my-project"),
                None,
                None,
                None,
                None,
            )
            .expect("insert");
        assert!(id > 0);

        let found = r
            .find_by_launch_id(launch_id)
            .expect("find ok")
            .expect("row exists");

        assert_eq!(found.project_id, launch_id);
        assert_eq!(found.pty_session_id.as_deref(), Some(pty_session));
        assert_eq!(found.cli_tool, "claude");
        assert_eq!(found.runtime_kind, "local");
        // resume_session_id is filled later by `update_session_started`.
        assert!(found.resume_session_id.is_none());
    }

    #[test]
    fn add_with_pty_session_then_update_session_started_fills_resume_id() {
        // After hook callback arrives, update_session_started must still
        // succeed against the pre-inserted row (otherwise the cli-hook path
        // would no-op and downstream listings would miss the resume id).
        let r = repo();
        let launch_id = "orch-child-2";
        let pty_session = "pty-xyz";

        r.add_with_pty_session(
            launch_id,
            "proj",
            "/tmp/proj",
            pty_session,
            "claude",
            "local",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("insert");

        let row_id = r
            .update_session_started(
                launch_id,
                pty_session,
                "resume-uuid",
                "claude",
                "local",
                None,
                None,
            )
            .expect("update ok")
            .expect("row matched");
        assert!(row_id > 0);

        let found = r
            .find_by_launch_id(launch_id)
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.pty_session_id.as_deref(), Some(pty_session));
        assert_eq!(found.resume_session_id.as_deref(), Some("resume-uuid"));
    }

    #[test]
    fn upsert_session_started_inserts_when_no_record_exists() {
        // GUI 经 TabBar 新建 WSL Codex 的路径：从未 INSERT 过 launch_history。
        // upsert 必须创建一条带 pty + resume 的记录，否则 reload 永远无法 codex resume。
        let r = repo();
        let launch_id = "gui-codex-1";

        let id = r
            .upsert_session_started(
                launch_id,
                "pty-gui-1",
                "019e893b-resume",
                "codex",
                "wsl",
                Some("Ubuntu"),
                Some("/mnt/i/emergency-enterprise-project"), // launch_cwd
                "/mnt/i/emergency-enterprise-project",       // project_path
                "emergency-enterprise-project",              // project_name
                None,                                        // workspace_path
            )
            .expect("upsert insert");
        assert!(id > 0);

        let found = r
            .find_by_launch_id(launch_id)
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.project_id, launch_id);
        assert_eq!(found.project_name, "emergency-enterprise-project");
        assert_eq!(found.pty_session_id.as_deref(), Some("pty-gui-1"));
        assert_eq!(found.resume_session_id.as_deref(), Some("019e893b-resume"));
        assert_eq!(found.cli_tool, "codex");
        assert_eq!(found.runtime_kind, "wsl");
    }

    #[test]
    fn upsert_session_started_updates_existing_without_duplicating() {
        // 已有记录（handleOpenTerminal / MCP 路径已 add）：upsert 走 UPDATE 分支，不新增行。
        let r = repo();
        let launch_id = "existing-1";

        r.add_with_pty_session(
            launch_id,
            "proj",
            "/tmp/proj",
            "old-pty",
            "codex",
            "wsl",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("seed insert");

        let id = r
            .upsert_session_started(
                launch_id,
                "new-pty",
                "resume-xyz",
                "codex",
                "wsl",
                None,
                None,
                "/tmp/proj",
                "proj",
                None,
            )
            .expect("upsert update");
        assert!(id > 0);

        let matching: Vec<_> = r
            .list(100)
            .expect("list")
            .into_iter()
            .filter(|rec| rec.project_id == launch_id)
            .collect();
        assert_eq!(
            matching.len(),
            1,
            "upsert must not duplicate an existing record"
        );
        assert_eq!(matching[0].pty_session_id.as_deref(), Some("new-pty"));
        assert_eq!(matching[0].resume_session_id.as_deref(), Some("resume-xyz"));
    }

    #[test]
    fn update_resume_session_with_source_by_pty_round_trip() {
        // OSC 标题捕获路径：按 pty_session_id 写入 resume id + 来源，
        // 且 list/find 各查询的 mapper 必须把 resume_source 带回来。
        let r = repo();
        let launch_id = "osc-capture-1";
        let pty_session = "pty-osc-1";

        r.add_with_pty_session(
            launch_id,
            "proj",
            "/tmp/proj",
            pty_session,
            "codex",
            "local",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("seed insert");

        // 无匹配 pty 时返回 None，不误写
        assert_eq!(
            r.update_resume_session_with_source_by_pty("no-such-pty", "id-x", "osc-title")
                .expect("update ok"),
            None
        );

        let id = r
            .update_resume_session_with_source_by_pty(
                pty_session,
                "019eb252-b6bf-79f2-abfb-ff801aaaaaaa",
                "osc-title",
            )
            .expect("update ok")
            .expect("row matched");
        assert!(id > 0);

        let found = r
            .find_by_pty_session_id(pty_session)
            .expect("find ok")
            .expect("row exists");
        assert_eq!(
            found.resume_session_id.as_deref(),
            Some("019eb252-b6bf-79f2-abfb-ff801aaaaaaa")
        );
        assert_eq!(found.resume_source.as_deref(), Some("osc-title"));

        // 标题轮换（trust 重建线程）：再次写入应覆盖为最新 id
        r.update_resume_session_with_source_by_pty(
            pty_session,
            "019eb252-ffff-79f2-abfb-ff801bbbbbbb",
            "osc-title",
        )
        .expect("update ok")
        .expect("row matched");
        let found = r
            .find_by_pty_session_id(pty_session)
            .expect("find ok")
            .expect("row exists");
        assert_eq!(
            found.resume_session_id.as_deref(),
            Some("019eb252-ffff-79f2-abfb-ff801bbbbbbb")
        );
    }

    #[test]
    fn update_resume_source_marks_existing_record() {
        let r = repo();
        let id = r
            .add_with_pty_session(
                "issued-1",
                "proj",
                "/tmp/proj",
                "pty-1",
                "claude",
                "local",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("insert");

        r.update_session_id(id, "11111111-2222-3333-4444-555555555555")
            .expect("set resume id");
        r.update_resume_source(id, "issued").expect("set source");

        let found = r
            .find_by_launch_id("issued-1")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.resume_source.as_deref(), Some("issued"));
    }

    // ---- `\\?\` UNC 污染防线（docs/35-unc-path-contamination.md）----

    /// 入库防线：`add` 写入的 launch_cwd / workspace_path 读出必须干净。
    #[cfg(windows)]
    #[test]
    fn add_strips_verbatim_prefix_from_paths() {
        let r = repo();
        r.add(
            "launch-unc-1",
            "proj",
            r"C:\proj",
            "claude",
            "local",
            None,
            Some("ws"),
            Some(r"\\?\C:\Users\me\.cc-panes-dev\workspaces\default"),
            Some(r"\\?\C:\proj"),
            None,
            None,
            None,
            None,
        )
        .expect("insert");

        let found = r
            .find_by_launch_id("launch-unc-1")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.launch_cwd.as_deref(), Some(r"C:\proj"));
        assert_eq!(
            found.workspace_path.as_deref(),
            Some(r"C:\Users\me\.cc-panes-dev\workspaces\default")
        );
    }

    /// 根因路径：hook 上报的 UNC cwd 经 update_session_started 落库后必须干净。
    #[cfg(windows)]
    #[test]
    fn update_session_started_strips_verbatim_prefix_from_launch_cwd() {
        let r = repo();
        r.add(
            "launch-unc-2",
            "proj",
            r"C:\proj",
            "claude",
            "local",
            None,
            None,
            None,
            Some(r"C:\proj"),
            None,
            None,
            None,
            None,
        )
        .expect("insert");

        r.update_session_started(
            "launch-unc-2",
            "pty-1",
            "resume-1",
            "claude",
            "local",
            None,
            Some(r"\\?\C:\proj"),
        )
        .expect("update ok")
        .expect("row matched");

        let found = r
            .find_by_launch_id("launch-unc-2")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.launch_cwd.as_deref(), Some(r"C:\proj"));
    }

    /// upsert 的 INSERT 分支（GUI TabBar 新建路径）同样要过防线。
    #[cfg(windows)]
    #[test]
    fn upsert_session_started_strips_verbatim_prefix_on_insert() {
        let r = repo();
        r.upsert_session_started(
            "launch-unc-3",
            "pty-2",
            "resume-2",
            "claude",
            "local",
            None,
            Some(r"\\?\C:\proj"),
            r"C:\proj",
            "proj",
            Some(r"\\?\C:\ws"),
        )
        .expect("upsert insert");

        let found = r
            .find_by_launch_id("launch-unc-3")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.launch_cwd.as_deref(), Some(r"C:\proj"));
        assert_eq!(found.workspace_path.as_deref(), Some(r"C:\ws"));
    }

    /// 非 Windows 平台必须是 no-op：Unix 下 `\` 是合法文件名字符，不得改写。
    #[cfg(not(windows))]
    #[test]
    fn paths_are_untouched_on_unix() {
        let r = repo();
        let weird = r"/tmp/\\?\literal";
        r.add(
            "launch-unix-1",
            "proj",
            "/tmp/proj",
            "claude",
            "local",
            None,
            None,
            Some(weird),
            Some(weird),
            None,
            None,
            None,
            None,
        )
        .expect("insert");

        let found = r
            .find_by_launch_id("launch-unix-1")
            .expect("find ok")
            .expect("row exists");
        assert_eq!(found.launch_cwd.as_deref(), Some(weird));
        assert_eq!(found.workspace_path.as_deref(), Some(weird));
    }
}
