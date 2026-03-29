use crate::models::session_restore::SavedSession;
use crate::repository::Database;
use std::sync::Arc;
use tracing::error;

pub struct SessionRestoreRepository {
    db: Arc<Database>,
}

impl SessionRestoreRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 保存所有会话（事务：先清空再批量插入）
    pub fn save_sessions(&self, sessions: &[SavedSession]) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.message)?;

        conn.execute("DELETE FROM terminal_sessions", [])
            .map_err(|e| format!("Failed to clear terminal_sessions: {}", e))?;

        let mut stmt = conn
            .prepare(
                "INSERT INTO terminal_sessions (
                    session_id, tab_id, pane_id, project_path,
                    workspace_name, workspace_path, provider_id, cli_tool,
                    resume_id, claude_session_id, ssh_config, custom_title,
                    created_at, saved_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )
            .map_err(|e| format!("Failed to prepare insert: {}", e))?;

        for s in sessions {
            stmt.execute(rusqlite::params![
                s.session_id,
                s.tab_id,
                s.pane_id,
                s.project_path,
                s.workspace_name,
                s.workspace_path,
                s.provider_id,
                s.cli_tool,
                s.resume_id,
                s.claude_session_id,
                s.ssh_config,
                s.custom_title,
                s.created_at,
                s.saved_at,
            ])
            .map_err(|e| {
                error!(session_id = %s.session_id, err = %e, "Failed to insert session");
                format!("Failed to insert session {}: {}", s.session_id, e)
            })?;
        }

        Ok(())
    }

    /// 加载所有已保存的会话
    pub fn load_sessions(&self) -> Result<Vec<SavedSession>, String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        let mut stmt = conn
            .prepare(
                "SELECT session_id, tab_id, pane_id, project_path,
                        workspace_name, workspace_path, provider_id, cli_tool,
                        resume_id, claude_session_id, ssh_config, custom_title,
                        created_at, saved_at
                 FROM terminal_sessions",
            )
            .map_err(|e| format!("Failed to prepare load query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(SavedSession {
                    session_id: row.get(0)?,
                    tab_id: row.get(1)?,
                    pane_id: row.get(2)?,
                    project_path: row.get(3)?,
                    workspace_name: row.get(4)?,
                    workspace_path: row.get(5)?,
                    provider_id: row.get(6)?,
                    cli_tool: row.get(7)?,
                    resume_id: row.get(8)?,
                    claude_session_id: row.get(9)?,
                    ssh_config: row.get(10)?,
                    custom_title: row.get(11)?,
                    created_at: row.get(12)?,
                    saved_at: row.get(13)?,
                    has_output: false, // 由 service 层根据文件是否存在设置
                })
            })
            .map_err(|e| format!("Failed to query sessions: {}", e))?;

        let mut sessions = Vec::new();
        for row in rows {
            match row {
                Ok(s) => sessions.push(s),
                Err(e) => error!(err = %e, "Failed to read session row"),
            }
        }
        Ok(sessions)
    }

    /// 清空所有已保存的会话
    pub fn clear_sessions(&self) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.message)?;
        conn.execute("DELETE FROM terminal_sessions", [])
            .map_err(|e| format!("Failed to clear terminal_sessions: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_and_load_sessions() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let sessions = vec![
            SavedSession {
                session_id: "s1".into(),
                tab_id: "t1".into(),
                pane_id: "p1".into(),
                project_path: "/home/user/project".into(),
                workspace_name: Some("ws1".into()),
                workspace_path: None,
                provider_id: None,
                cli_tool: "claude".into(),
                resume_id: Some("r1".into()),
                claude_session_id: Some("cs1".into()),
                ssh_config: None,
                custom_title: None,
                created_at: "2025-01-01T00:00:00Z".into(),
                saved_at: "2025-01-01T00:01:00Z".into(),
                has_output: false,
            },
            SavedSession {
                session_id: "s2".into(),
                tab_id: "t2".into(),
                pane_id: "p1".into(),
                project_path: "/home/user/project2".into(),
                workspace_name: None,
                workspace_path: None,
                provider_id: None,
                cli_tool: "none".into(),
                resume_id: None,
                claude_session_id: None,
                ssh_config: None,
                custom_title: Some("My Shell".into()),
                created_at: "2025-01-01T00:00:00Z".into(),
                saved_at: "2025-01-01T00:01:00Z".into(),
                has_output: false,
            },
        ];

        repo.save_sessions(&sessions).expect("should save");
        let loaded = repo.load_sessions().expect("should load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].session_id, "s1");
        assert_eq!(loaded[0].cli_tool, "claude");
        assert_eq!(loaded[1].custom_title, Some("My Shell".into()));
    }

    #[test]
    fn test_save_replaces_previous() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let session = SavedSession {
            session_id: "s1".into(),
            tab_id: "t1".into(),
            pane_id: "p1".into(),
            project_path: "/p".into(),
            workspace_name: None,
            workspace_path: None,
            provider_id: None,
            cli_tool: "none".into(),
            resume_id: None,
            claude_session_id: None,
            ssh_config: None,
            custom_title: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            saved_at: "2025-01-01T00:01:00Z".into(),
            has_output: false,
        };

        repo.save_sessions(&[session.clone()]).expect("first save");
        repo.save_sessions(&[session]).expect("second save");
        let loaded = repo.load_sessions().expect("should load");
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn test_clear_sessions() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let session = SavedSession {
            session_id: "s1".into(),
            tab_id: "t1".into(),
            pane_id: "p1".into(),
            project_path: "/p".into(),
            workspace_name: None,
            workspace_path: None,
            provider_id: None,
            cli_tool: "none".into(),
            resume_id: None,
            claude_session_id: None,
            ssh_config: None,
            custom_title: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            saved_at: "2025-01-01T00:01:00Z".into(),
            has_output: false,
        };

        repo.save_sessions(&[session]).expect("save");
        repo.clear_sessions().expect("clear");
        let loaded = repo.load_sessions().expect("load");
        assert_eq!(loaded.len(), 0);
    }
}
