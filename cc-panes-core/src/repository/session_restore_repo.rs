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

    /// 按 session_id UPSERT 保存会话。
    ///
    /// **不再 `DELETE FROM terminal_sessions`**（docs/61 阶段 1）：这张表是跨实例共享的，
    /// 而每个实例只知道自己布局里的会话。全表覆盖导致两个实例各自 60 秒周期保存时
    /// 轮流清空对方的行，这张表也就没法充当归属权威源。
    ///
    /// 代价是死会话的行会留存。清理**不在这里做**——daemon 活会话列表是 SQLite 事务外的
    /// 外部快照，在此处删除消不掉 TOCTOU；按评审意见，剪枝要等阶段 3 拿到
    /// daemon generation 一致的完整快照后再做。
    ///
    /// `created_at` 在更新时保留原值：它是会话的出生时间，不是本次保存时间。
    pub fn save_sessions(&self, sessions: &[SavedSession]) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(
                "INSERT INTO terminal_sessions (
                    session_id, workspace_session_id, workspace_snapshot_id, tab_id, pane_id, project_path,
                    workspace_name, workspace_path, provider_id, provider_selection, launch_profile_id, cli_tool,
                    runtime_kind, resume_id, ssh_config, custom_title,
                    created_at, saved_at,
                    terminal_pane_id, layout_id, wsl_config, machine_name
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                ON CONFLICT(session_id) DO UPDATE SET
                    workspace_session_id = excluded.workspace_session_id,
                    workspace_snapshot_id = excluded.workspace_snapshot_id,
                    tab_id = excluded.tab_id,
                    pane_id = excluded.pane_id,
                    project_path = excluded.project_path,
                    workspace_name = excluded.workspace_name,
                    workspace_path = excluded.workspace_path,
                    provider_id = excluded.provider_id,
                    provider_selection = excluded.provider_selection,
                    launch_profile_id = excluded.launch_profile_id,
                    cli_tool = excluded.cli_tool,
                    runtime_kind = excluded.runtime_kind,
                    resume_id = excluded.resume_id,
                    ssh_config = excluded.ssh_config,
                    custom_title = excluded.custom_title,
                    saved_at = excluded.saved_at,
                    terminal_pane_id = excluded.terminal_pane_id,
                    layout_id = excluded.layout_id,
                    wsl_config = excluded.wsl_config,
                    machine_name = excluded.machine_name",
            )
            .map_err(|e| format!("Failed to prepare insert: {}", e))?;

        for s in sessions {
            stmt.execute(rusqlite::params![
                s.session_id,
                s.workspace_snapshot_id,
                s.workspace_snapshot_id,
                s.tab_id,
                s.pane_id,
                s.project_path,
                s.workspace_name,
                s.workspace_path,
                s.provider_id,
                s.provider_selection,
                s.launch_profile_id,
                s.cli_tool,
                s.runtime_kind,
                s.resume_id,
                s.ssh_config,
                s.custom_title,
                s.created_at,
                s.saved_at,
                s.terminal_pane_id,
                s.layout_id,
                s.wsl_config,
                s.machine_name,
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
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT session_id, tab_id, pane_id, project_path,
                        COALESCE(workspace_snapshot_id, workspace_session_id) AS workspace_snapshot_id,
                        workspace_name, workspace_path, provider_id, provider_selection, launch_profile_id, cli_tool,
                        runtime_kind, COALESCE(resume_id, claude_session_id) AS resume_id,
                        ssh_config, custom_title,
                        created_at, saved_at,
                        terminal_pane_id, layout_id, wsl_config, machine_name
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
                    workspace_snapshot_id: row.get(4)?,
                    workspace_name: row.get(5)?,
                    workspace_path: row.get(6)?,
                    provider_id: row.get(7)?,
                    provider_selection: row.get(8)?,
                    launch_profile_id: row.get(9)?,
                    cli_tool: row.get(10)?,
                    runtime_kind: row.get(11)?,
                    resume_id: row.get(12)?,
                    ssh_config: row.get(13)?,
                    custom_title: row.get(14)?,
                    created_at: row.get(15)?,
                    saved_at: row.get(16)?,
                    terminal_pane_id: row.get(17)?,
                    layout_id: row.get(18)?,
                    wsl_config: row.get(19)?,
                    machine_name: row.get(20)?,
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
        let conn = self.db.connection().map_err(|e| e.to_string())?;
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
                workspace_snapshot_id: None,
                session_id: "s1".into(),
                tab_id: "t1".into(),
                pane_id: "p1".into(),
                terminal_pane_id: None,
                layout_id: None,
                wsl_config: None,
                machine_name: None,
                project_path: "/home/user/project".into(),
                workspace_name: Some("ws1".into()),
                workspace_path: None,
                provider_id: None,
                provider_selection: Some("none".into()),
                launch_profile_id: Some("profile-1".into()),
                cli_tool: "claude".into(),
                runtime_kind: Some("local".into()),
                resume_id: Some("r1".into()),
                ssh_config: None,
                custom_title: None,
                created_at: "2025-01-01T00:00:00Z".into(),
                saved_at: "2025-01-01T00:01:00Z".into(),
                has_output: false,
            },
            SavedSession {
                workspace_snapshot_id: None,
                session_id: "s2".into(),
                tab_id: "t2".into(),
                pane_id: "p1".into(),
                terminal_pane_id: None,
                layout_id: None,
                wsl_config: None,
                machine_name: None,
                project_path: "/home/user/project2".into(),
                workspace_name: None,
                workspace_path: None,
                provider_id: None,
                provider_selection: None,
                launch_profile_id: None,
                cli_tool: "none".into(),
                runtime_kind: Some("local".into()),
                resume_id: None,
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
        assert_eq!(loaded[0].launch_profile_id, Some("profile-1".into()));
        assert_eq!(loaded[0].provider_selection, Some("none".into()));
        assert_eq!(loaded[1].custom_title, Some("My Shell".into()));
    }

    #[test]
    fn test_save_replaces_previous() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let session = SavedSession {
            workspace_snapshot_id: None,
            session_id: "s1".into(),
            tab_id: "t1".into(),
            pane_id: "p1".into(),
            terminal_pane_id: None,
            layout_id: None,
            wsl_config: None,
            machine_name: None,
            project_path: "/p".into(),
            workspace_name: None,
            workspace_path: None,
            provider_id: None,
            provider_selection: None,
            launch_profile_id: None,
            cli_tool: "none".into(),
            runtime_kind: Some("local".into()),
            resume_id: None,
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

    /// docs/61 阶段 1：save_sessions 不得清掉别的实例写的行。
    /// 旧实现是 `DELETE FROM terminal_sessions` 后全量重插，两个实例各自 60 秒
    /// 周期保存会轮流把对方的归属记录抹掉。
    #[test]
    fn save_sessions_keeps_rows_owned_by_other_instances() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let mut other_instance = sample_session("other-pty");
        other_instance.tab_id = "tab-other".into();
        repo.save_sessions(&[other_instance])
            .expect("instance A save");

        // 实例 B 只知道自己的会话，保存时不得波及 A 的行
        repo.save_sessions(&[sample_session("mine-pty")])
            .expect("instance B save");

        let loaded = repo.load_sessions().expect("should load");
        let ids: Vec<_> = loaded.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(loaded.len(), 2, "另一个实例的行被清掉了: {:?}", ids);
        assert!(ids.contains(&"other-pty"));
        assert!(ids.contains(&"mine-pty"));
    }

    /// created_at 是会话出生时间，不是本次保存时间；UPSERT 不得覆盖它。
    #[test]
    fn save_sessions_preserves_created_at_on_update() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        repo.save_sessions(&[sample_session("s1")])
            .expect("first save");

        let mut later = sample_session("s1");
        later.created_at = "2099-01-01T00:00:00Z".into();
        later.saved_at = "2099-01-01T00:05:00Z".into();
        repo.save_sessions(&[later]).expect("second save");

        let loaded = repo.load_sessions().expect("should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].created_at, "2025-01-01T00:00:00Z");
        assert_eq!(loaded[0].saved_at, "2099-01-01T00:05:00Z");
    }

    fn sample_session(session_id: &str) -> SavedSession {
        SavedSession {
            workspace_snapshot_id: None,
            session_id: session_id.into(),
            tab_id: "t1".into(),
            pane_id: "p1".into(),
            terminal_pane_id: Some("leaf-1".into()),
            layout_id: Some("layout-1".into()),
            wsl_config: None,
            machine_name: None,
            project_path: "/p".into(),
            workspace_name: None,
            workspace_path: None,
            provider_id: None,
            provider_selection: None,
            launch_profile_id: None,
            cli_tool: "none".into(),
            runtime_kind: Some("local".into()),
            resume_id: None,
            ssh_config: None,
            custom_title: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            saved_at: "2025-01-01T00:01:00Z".into(),
            has_output: false,
        }
    }

    #[test]
    fn test_clear_sessions() {
        let db = Arc::new(Database::new_in_memory().expect("should create db"));
        let repo = SessionRestoreRepository::new(db);

        let session = SavedSession {
            workspace_snapshot_id: None,
            session_id: "s1".into(),
            tab_id: "t1".into(),
            pane_id: "p1".into(),
            terminal_pane_id: None,
            layout_id: None,
            wsl_config: None,
            machine_name: None,
            project_path: "/p".into(),
            workspace_name: None,
            workspace_path: None,
            provider_id: None,
            provider_selection: None,
            launch_profile_id: None,
            cli_tool: "none".into(),
            runtime_kind: Some("local".into()),
            resume_id: None,
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
