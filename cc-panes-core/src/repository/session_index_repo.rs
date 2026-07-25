use crate::models::{SessionIndexEntry, SessionIndexQuery, SessionIndexScope, SessionScanState};
use crate::repository::Database;
use chrono::Utc;
use rusqlite::{params, params_from_iter, types::Value, OptionalExtension};
use std::sync::Arc;

const SESSION_COLUMNS: &str = "
    session_id, cli_tool, file_path, cwd, project_path_norm, project_name,
    workspace_name, first_prompt, last_summary, message_count, mtime_ms,
    size, source, wsl_distro, updated_at";
const ALGO_VERSION_KEY: &str = "_algo_version";

pub struct SessionIndexRepository {
    db: Arc<Database>,
}

impl SessionIndexRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn upsert_session(&self, entry: &SessionIndexEntry) -> Result<(), String> {
        let conn = self.db.connection().map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO session_index (
                session_id, cli_tool, file_path, cwd, project_path_norm, project_name,
                workspace_name, first_prompt, last_summary, message_count, mtime_ms,
                size, source, wsl_distro, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
             ) ON CONFLICT(session_id) DO UPDATE SET
                cli_tool = excluded.cli_tool,
                file_path = excluded.file_path,
                cwd = excluded.cwd,
                project_path_norm = excluded.project_path_norm,
                project_name = excluded.project_name,
                workspace_name = excluded.workspace_name,
                first_prompt = excluded.first_prompt,
                last_summary = excluded.last_summary,
                message_count = excluded.message_count,
                mtime_ms = excluded.mtime_ms,
                size = excluded.size,
                source = excluded.source,
                wsl_distro = excluded.wsl_distro,
                updated_at = excluded.updated_at",
            params![
                entry.session_id,
                entry.cli_tool,
                entry.file_path,
                entry.cwd,
                entry.project_path_norm,
                entry.project_name,
                entry.workspace_name,
                entry.first_prompt,
                entry.last_summary,
                entry.message_count as i64,
                entry.mtime_ms,
                entry.size as i64,
                entry.source,
                entry.wsl_distro,
                entry.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_sessions_indexed(
        &self,
        query: &SessionIndexQuery,
    ) -> Result<Vec<SessionIndexEntry>, String> {
        let mut sql = format!("SELECT {SESSION_COLUMNS} FROM session_index WHERE 1 = 1");
        let mut values = Vec::<Value>::new();
        match &query.scope {
            SessionIndexScope::All => {}
            SessionIndexScope::Workspace(name) => {
                sql.push_str(" AND workspace_name = ?");
                values.push(name.trim().to_string().into());
            }
            SessionIndexScope::Project(path) => {
                sql.push_str(" AND project_path_norm = ?");
                values.push(path.trim().to_string().into());
            }
        }
        if let Some(search) = query
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sql.push_str(" AND (first_prompt LIKE ? OR last_summary LIKE ? OR session_id LIKE ?)");
            let pattern = format!("%{search}%");
            values.extend([
                pattern.clone().into(),
                pattern.clone().into(),
                pattern.into(),
            ]);
        }
        if let Some(cli) = query
            .cli_filter
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sql.push_str(" AND cli_tool = ?");
            values.push(cli.to_string().into());
        }
        sql.push_str(" ORDER BY mtime_ms DESC LIMIT ? OFFSET ?");
        values.push((query.limit.clamp(1, 500) as i64).into());
        values.push((query.offset as i64).into());

        let conn = self.db.connection().map_err(|error| error.to_string())?;
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), map_session_entry)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get_scan_state(&self, file_path: &str) -> Result<Option<SessionScanState>, String> {
        let conn = self.db.connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT file_path, mtime_ms, size, scanned_at
             FROM session_scan_state WHERE file_path = ?1",
            [file_path],
            |row| {
                let size: i64 = row.get(2)?;
                Ok(SessionScanState {
                    file_path: row.get(0)?,
                    mtime_ms: row.get(1)?,
                    size: size.max(0) as u64,
                    scanned_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn upsert_scan_state(
        &self,
        file_path: &str,
        mtime_ms: i64,
        size: u64,
    ) -> Result<(), String> {
        let conn = self.db.connection().map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO session_scan_state (file_path, mtime_ms, size, scanned_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(file_path) DO UPDATE SET
                mtime_ms = excluded.mtime_ms,
                size = excluded.size,
                scanned_at = excluded.scanned_at",
            params![file_path, mtime_ms, size as i64, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 返回 true 表示版本未变；false 表示已清缓存、下轮必须全量重扫。
    pub fn ensure_scan_algo_version(&self, version: u64) -> Result<bool, String> {
        let current = self
            .get_scan_state(ALGO_VERSION_KEY)?
            .map(|state| state.size);
        if current == Some(version) {
            return Ok(true);
        }

        let mut conn = self.db.connection().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM session_index", [])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM session_scan_state", [])
            .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO session_scan_state (file_path, mtime_ms, size, scanned_at)
             VALUES (?1, 0, ?2, ?3)",
            params![ALGO_VERSION_KEY, version as i64, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(false)
    }
}

fn map_session_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionIndexEntry> {
    let message_count: i64 = row.get(9)?;
    let size: i64 = row.get(11)?;
    Ok(SessionIndexEntry {
        session_id: row.get(0)?,
        cli_tool: row.get(1)?,
        file_path: row.get(2)?,
        cwd: row.get(3)?,
        project_path_norm: row.get(4)?,
        project_name: row.get(5)?,
        workspace_name: row.get(6)?,
        first_prompt: row.get(7)?,
        last_summary: row.get(8)?,
        message_count: message_count.max(0) as u64,
        mtime_ms: row.get(10)?,
        size: size.max(0) as u64,
        source: row.get(12)?,
        wsl_distro: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::SessionIndexRepository;
    use crate::models::{SessionIndexEntry, SessionIndexQuery, SessionIndexScope};
    use crate::repository::Database;
    use std::sync::Arc;

    fn entry(id: &str, cli_tool: &str, project: &str, workspace: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            session_id: id.to_string(),
            cli_tool: cli_tool.to_string(),
            file_path: format!("/sessions/{id}.jsonl"),
            cwd: project.to_string(),
            project_path_norm: project.to_string(),
            project_name: project.rsplit('/').next().unwrap_or(project).to_string(),
            workspace_name: Some(workspace.to_string()),
            first_prompt: format!("first prompt for {id}"),
            last_summary: format!("last summary for {id}"),
            message_count: 4,
            mtime_ms: if id == "newer" { 20 } else { 10 },
            size: 512,
            source: "local".to_string(),
            wsl_distro: None,
            updated_at: "2026-07-25T00:00:00Z".to_string(),
        }
    }

    fn repo() -> SessionIndexRepository {
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        SessionIndexRepository::new(db)
    }

    #[test]
    fn session_index_round_trip_and_incremental_scan_state() {
        let repo = repo();
        repo.upsert_session(&entry("older", "claude", "/workspace/alpha", "main"))
            .expect("upsert session");
        repo.upsert_scan_state("/sessions/older.jsonl", 10, 512)
            .expect("scan state");

        let rows = repo
            .list_sessions_indexed(&SessionIndexQuery::default())
            .expect("list index");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "older");

        let state = repo
            .get_scan_state("/sessions/older.jsonl")
            .expect("get state")
            .expect("state exists");
        assert_eq!((state.mtime_ms, state.size), (10, 512));
    }

    #[test]
    fn session_index_query_combines_scope_search_cli_and_paging() {
        let repo = repo();
        repo.upsert_session(&entry("older", "claude", "/workspace/alpha", "main"))
            .expect("older");
        repo.upsert_session(&entry("newer", "codex", "/workspace/beta", "main"))
            .expect("newer");
        repo.upsert_session(&entry("other", "codex", "/other/gamma", "other"))
            .expect("other");

        let query = SessionIndexQuery {
            scope: SessionIndexScope::Workspace("main".to_string()),
            query: Some("summary".to_string()),
            cli_filter: Some("codex".to_string()),
            limit: 1,
            offset: 0,
        };
        let rows = repo.list_sessions_indexed(&query).expect("filtered list");
        assert_eq!(
            rows.iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            ["newer"]
        );

        let project_rows = repo
            .list_sessions_indexed(&SessionIndexQuery {
                scope: SessionIndexScope::Project("/workspace/alpha".to_string()),
                ..SessionIndexQuery::default()
            })
            .expect("project list");
        assert_eq!(project_rows[0].session_id, "older");
    }

    #[test]
    fn algorithm_version_gate_clears_scan_states_and_index() {
        let repo = repo();
        assert!(!repo.ensure_scan_algo_version(2).expect("initial version"));
        repo.upsert_session(&entry("older", "claude", "/workspace/alpha", "main"))
            .expect("upsert session");
        repo.upsert_scan_state("/sessions/older.jsonl", 10, 512)
            .expect("scan state");

        assert!(repo.ensure_scan_algo_version(2).expect("same version"));
        assert!(!repo.ensure_scan_algo_version(3).expect("new version"));
        assert!(repo
            .list_sessions_indexed(&SessionIndexQuery::default())
            .expect("list")
            .is_empty());
        assert!(repo
            .get_scan_state("/sessions/older.jsonl")
            .expect("get state")
            .is_none());
        assert!(repo.ensure_scan_algo_version(3).expect("stored version"));
    }
}
