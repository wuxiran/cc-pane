use crate::models::{PortClaim, RunnerInstance, RunnerInstanceStatus, RunnerProfile};
use crate::repository::Database;
use rusqlite::params;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tracing::error;

/// Runner Registry 数据访问层
pub struct RunnerRepository {
    db: Arc<Database>,
}

impl RunnerRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ============ RunnerProfile ============

    /// 新建或更新启动配置（按 (project_path, name) UNIQUE，提供 id 则按 id 更新）
    pub fn upsert_profile(&self, profile: &RunnerProfile) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let env_json = serde_json::to_string(&profile.env).map_err(|e| e.to_string())?;
        let ports_json =
            serde_json::to_string(&profile.expected_ports).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO runner_profiles
                (id, project_path, workspace_name, name, command, cwd, runtime_kind,
                 wsl_distro, ssh_machine_id, env_json, expected_ports_json, tool_hint,
                 last_started_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
                project_path = excluded.project_path,
                workspace_name = excluded.workspace_name,
                name = excluded.name,
                command = excluded.command,
                cwd = excluded.cwd,
                runtime_kind = excluded.runtime_kind,
                wsl_distro = excluded.wsl_distro,
                ssh_machine_id = excluded.ssh_machine_id,
                env_json = excluded.env_json,
                expected_ports_json = excluded.expected_ports_json,
                tool_hint = excluded.tool_hint,
                last_started_at = excluded.last_started_at,
                updated_at = excluded.updated_at",
            params![
                profile.id,
                profile.project_path,
                profile.workspace_name,
                profile.name,
                profile.command,
                profile.cwd,
                profile.runtime_kind,
                profile.wsl_distro,
                profile.ssh_machine_id,
                env_json,
                ports_json,
                profile.tool_hint,
                profile.last_started_at,
                profile.created_at,
                profile.updated_at,
            ],
        )
        .map_err(|e| {
            error!(table = "runner_profiles", err = %e, "upsert failed");
            e.to_string()
        })?;
        Ok(())
    }

    pub fn get_profile(&self, id: &str) -> Result<Option<RunnerProfile>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, project_path, workspace_name, name, command, cwd, runtime_kind,
                    wsl_distro, ssh_machine_id, env_json, expected_ports_json, tool_hint,
                    last_started_at, created_at, updated_at
             FROM runner_profiles WHERE id = ?1",
            params![id],
            Self::map_profile_row,
        );
        match result {
            Ok(profile) => Ok(Some(profile)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "runner_profiles", err = %e, "get failed");
                Err(e.to_string())
            }
        }
    }

    pub fn list_profiles_by_project(
        &self,
        project_path: &str,
    ) -> Result<Vec<RunnerProfile>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, workspace_name, name, command, cwd, runtime_kind,
                        wsl_distro, ssh_machine_id, env_json, expected_ports_json, tool_hint,
                        last_started_at, created_at, updated_at
                 FROM runner_profiles
                 WHERE project_path = ?1
                 ORDER BY COALESCE(last_started_at, created_at) DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_path], Self::map_profile_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 按 workspace_name 列出该工作空间下所有 profile（供 list_workspace_port_reservations 用）
    pub fn list_profiles_by_workspace(
        &self,
        workspace_name: &str,
    ) -> Result<Vec<RunnerProfile>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, project_path, workspace_name, name, command, cwd, runtime_kind,
                        wsl_distro, ssh_machine_id, env_json, expected_ports_json, tool_hint,
                        last_started_at, created_at, updated_at
                 FROM runner_profiles
                 WHERE workspace_name = ?1
                 ORDER BY project_path, name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_name], Self::map_profile_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM runner_profiles WHERE id = ?1", params![id])
            .map_err(|e| {
                error!(table = "runner_profiles", err = %e, "delete failed");
                e.to_string()
            })?;
        Ok(())
    }

    pub fn touch_profile_last_started(&self, id: &str, when: &str) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE runner_profiles SET last_started_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![when, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============ RunnerInstance ============

    pub fn record_instance_start(&self, instance: &RunnerInstance) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let metadata = instance
            .metadata
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        conn.execute(
            "INSERT INTO runner_instances
                (id, profile_id, project_path, workspace_name, session_id, root_pid,
                 runtime_kind, command, cwd, started_at, status, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                instance.id,
                instance.profile_id,
                instance.project_path,
                instance.workspace_name,
                instance.session_id,
                instance.root_pid,
                instance.runtime_kind,
                instance.command,
                instance.cwd,
                instance.started_at,
                instance.status.as_str(),
                metadata,
            ],
        )
        .map_err(|e| {
            error!(table = "runner_instances", err = %e, "record_start failed");
            e.to_string()
        })?;
        Ok(())
    }

    pub fn mark_instance_exited(
        &self,
        id: &str,
        exited_at: &str,
        exit_code: Option<i32>,
        status: RunnerInstanceStatus,
    ) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE runner_instances
             SET exited_at = ?1, exit_code = ?2, status = ?3
             WHERE id = ?4",
            params![exited_at, exit_code, status.as_str(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_instance(&self, id: &str) -> Result<Option<RunnerInstance>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, profile_id, project_path, workspace_name, session_id, root_pid,
                    runtime_kind, command, cwd, started_at, exited_at, exit_code, status, metadata
             FROM runner_instances WHERE id = ?1",
            params![id],
            Self::map_instance_row,
        );
        match result {
            Ok(inst) => Ok(Some(inst)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn list_active_instances(
        &self,
        project_path: Option<&str>,
    ) -> Result<Vec<RunnerInstance>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let (sql, want_filter) = if project_path.is_some() {
            (
                "SELECT id, profile_id, project_path, workspace_name, session_id, root_pid,
                        runtime_kind, command, cwd, started_at, exited_at, exit_code, status, metadata
                 FROM runner_instances
                 WHERE status = 'running' AND project_path = ?1
                 ORDER BY started_at DESC",
                true,
            )
        } else {
            (
                "SELECT id, profile_id, project_path, workspace_name, session_id, root_pid,
                        runtime_kind, command, cwd, started_at, exited_at, exit_code, status, metadata
                 FROM runner_instances
                 WHERE status = 'running'
                 ORDER BY started_at DESC",
                false,
            )
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = if want_filter {
            stmt.query_map(params![project_path.unwrap()], Self::map_instance_row)
        } else {
            stmt.query_map([], Self::map_instance_row)
        }
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        Ok(rows)
    }

    /// 按 profile_id 列出仍在 running 的 instances（最新启动优先）
    pub fn list_active_by_profile(&self, profile_id: &str) -> Result<Vec<RunnerInstance>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, project_path, workspace_name, session_id, root_pid,
                        runtime_kind, command, cwd, started_at, exited_at, exit_code, status, metadata
                 FROM runner_instances
                 WHERE status = 'running' AND profile_id = ?1
                 ORDER BY started_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![profile_id], Self::map_instance_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn find_active_instance_by_pid(&self, pid: u32) -> Result<Option<RunnerInstance>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, profile_id, project_path, workspace_name, session_id, root_pid,
                    runtime_kind, command, cwd, started_at, exited_at, exit_code, status, metadata
             FROM runner_instances
             WHERE status = 'running' AND root_pid = ?1
             LIMIT 1",
            params![pid],
            Self::map_instance_row,
        );
        match result {
            Ok(inst) => Ok(Some(inst)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // ============ PortClaim ============

    /// 用新一批 claims 替换某 instance 当前的端口快照（先删后插）
    pub fn replace_port_claims_for_instance(
        &self,
        instance_id: &str,
        claims: &[PortClaim],
    ) -> Result<(), String> {
        let mut conn = self.db.connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM port_claims WHERE instance_id = ?1",
            params![instance_id],
        )
        .map_err(|e| e.to_string())?;
        for c in claims {
            tx.execute(
                "INSERT OR IGNORE INTO port_claims
                    (instance_id, pid, port, protocol, listen_addr, detected_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    instance_id,
                    c.pid,
                    c.port,
                    c.protocol,
                    c.listen_addr,
                    c.detected_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_claims_by_port(&self, port: u16) -> Result<Vec<PortClaim>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, instance_id, pid, port, protocol, listen_addr, detected_at
                 FROM port_claims WHERE port = ?1 ORDER BY detected_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![port], Self::map_claim_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn list_claims_by_instance(&self, instance_id: &str) -> Result<Vec<PortClaim>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, instance_id, pid, port, protocol, listen_addr, detected_at
                 FROM port_claims WHERE instance_id = ?1 ORDER BY port ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![instance_id], Self::map_claim_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ============ Row mapping helpers ============

    fn map_profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunnerProfile> {
        let env_json: Option<String> = row.get(9)?;
        let ports_json: Option<String> = row.get(10)?;
        let env: HashMap<String, String> = env_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let expected_ports: Vec<u16> = ports_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        Ok(RunnerProfile {
            id: row.get(0)?,
            project_path: row.get(1)?,
            workspace_name: row.get(2)?,
            name: row.get(3)?,
            command: row.get(4)?,
            cwd: row.get(5)?,
            runtime_kind: row.get(6)?,
            wsl_distro: row.get(7)?,
            ssh_machine_id: row.get(8)?,
            env,
            expected_ports,
            tool_hint: row.get(11)?,
            last_started_at: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    }

    fn map_instance_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunnerInstance> {
        let status_str: String = row.get(12)?;
        let metadata_str: Option<String> = row.get(13)?;
        let status =
            RunnerInstanceStatus::from_str(&status_str).unwrap_or(RunnerInstanceStatus::Running);
        let metadata = metadata_str
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        Ok(RunnerInstance {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            project_path: row.get(2)?,
            workspace_name: row.get(3)?,
            session_id: row.get(4)?,
            root_pid: row.get::<_, i64>(5)? as u32,
            runtime_kind: row.get(6)?,
            command: row.get(7)?,
            cwd: row.get(8)?,
            started_at: row.get(9)?,
            exited_at: row.get(10)?,
            exit_code: row.get(11)?,
            status,
            metadata,
        })
    }

    fn map_claim_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PortClaim> {
        Ok(PortClaim {
            id: row.get(0)?,
            instance_id: row.get(1)?,
            pid: row.get::<_, i64>(2)? as u32,
            port: row.get::<_, i64>(3)? as u16,
            protocol: row.get(4)?,
            listen_addr: row.get(5)?,
            detected_at: row.get(6)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{RunnerInstance, RunnerInstanceStatus, RunnerProfile};
    use std::collections::HashMap;

    fn db() -> Arc<Database> {
        Arc::new(Database::new_in_memory().expect("in-memory db"))
    }

    fn profile_fixture(id: &str, project: &str, name: &str) -> RunnerProfile {
        RunnerProfile {
            id: id.to_string(),
            project_path: project.to_string(),
            workspace_name: Some("ws".to_string()),
            name: name.to_string(),
            command: "npm run dev".to_string(),
            cwd: project.to_string(),
            runtime_kind: "local".to_string(),
            wsl_distro: None,
            ssh_machine_id: None,
            env: HashMap::from([("NODE_ENV".to_string(), "development".to_string())]),
            expected_ports: vec![5173, 5174],
            tool_hint: Some("npm".to_string()),
            last_started_at: None,
            created_at: "2026-05-24T00:00:00Z".to_string(),
            updated_at: "2026-05-24T00:00:00Z".to_string(),
        }
    }

    fn instance_fixture(id: &str, project: &str, pid: u32) -> RunnerInstance {
        RunnerInstance {
            id: id.to_string(),
            profile_id: None,
            project_path: project.to_string(),
            workspace_name: Some("ws".to_string()),
            session_id: Some("sess-1".to_string()),
            root_pid: pid,
            runtime_kind: "local".to_string(),
            command: "cargo run".to_string(),
            cwd: project.to_string(),
            started_at: "2026-05-24T00:00:00Z".to_string(),
            exited_at: None,
            exit_code: None,
            status: RunnerInstanceStatus::Running,
            metadata: None,
        }
    }

    #[test]
    fn upsert_and_get_profile() {
        let repo = RunnerRepository::new(db());
        let p = profile_fixture("p1", "/proj", "frontend dev");
        repo.upsert_profile(&p).unwrap();
        let got = repo.get_profile("p1").unwrap().unwrap();
        assert_eq!(got.name, "frontend dev");
        assert_eq!(got.expected_ports, vec![5173, 5174]);
        assert_eq!(got.env.get("NODE_ENV").unwrap(), "development");
    }

    #[test]
    fn upsert_updates_existing() {
        let repo = RunnerRepository::new(db());
        let mut p = profile_fixture("p1", "/proj", "frontend dev");
        repo.upsert_profile(&p).unwrap();
        p.command = "npm start".to_string();
        p.updated_at = "2026-05-25T00:00:00Z".to_string();
        repo.upsert_profile(&p).unwrap();
        let got = repo.get_profile("p1").unwrap().unwrap();
        assert_eq!(got.command, "npm start");
        assert_eq!(got.updated_at, "2026-05-25T00:00:00Z");
    }

    #[test]
    fn list_profiles_orders_by_last_started() {
        let repo = RunnerRepository::new(db());
        let mut a = profile_fixture("a", "/proj", "older");
        a.last_started_at = Some("2026-05-20T00:00:00Z".to_string());
        let mut b = profile_fixture("b", "/proj", "newer");
        b.last_started_at = Some("2026-05-23T00:00:00Z".to_string());
        repo.upsert_profile(&a).unwrap();
        repo.upsert_profile(&b).unwrap();
        let list = repo.list_profiles_by_project("/proj").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "b");
        assert_eq!(list[1].id, "a");
    }

    #[test]
    fn delete_profile_works() {
        let repo = RunnerRepository::new(db());
        let p = profile_fixture("p1", "/proj", "frontend dev");
        repo.upsert_profile(&p).unwrap();
        repo.delete_profile("p1").unwrap();
        assert!(repo.get_profile("p1").unwrap().is_none());
    }

    #[test]
    fn unique_project_name_constraint() {
        let repo = RunnerRepository::new(db());
        let a = profile_fixture("a", "/proj", "same");
        let b = profile_fixture("b", "/proj", "same");
        repo.upsert_profile(&a).unwrap();
        assert!(
            repo.upsert_profile(&b).is_err(),
            "UNIQUE constraint should reject duplicate (project, name)"
        );
    }

    #[test]
    fn record_and_mark_instance() {
        let repo = RunnerRepository::new(db());
        let inst = instance_fixture("i1", "/proj", 1234);
        repo.record_instance_start(&inst).unwrap();
        let got = repo.get_instance("i1").unwrap().unwrap();
        assert_eq!(got.root_pid, 1234);
        assert_eq!(got.status, RunnerInstanceStatus::Running);

        repo.mark_instance_exited(
            "i1",
            "2026-05-24T01:00:00Z",
            Some(0),
            RunnerInstanceStatus::Exited,
        )
        .unwrap();
        let got = repo.get_instance("i1").unwrap().unwrap();
        assert_eq!(got.status, RunnerInstanceStatus::Exited);
        assert_eq!(got.exit_code, Some(0));
        assert_eq!(got.exited_at.as_deref(), Some("2026-05-24T01:00:00Z"));
    }

    #[test]
    fn list_active_filters_running() {
        let repo = RunnerRepository::new(db());
        repo.record_instance_start(&instance_fixture("i1", "/a", 1))
            .unwrap();
        repo.record_instance_start(&instance_fixture("i2", "/b", 2))
            .unwrap();
        repo.mark_instance_exited(
            "i1",
            "2026-05-24T01:00:00Z",
            Some(0),
            RunnerInstanceStatus::Exited,
        )
        .unwrap();

        let active_all = repo.list_active_instances(None).unwrap();
        assert_eq!(active_all.len(), 1);
        assert_eq!(active_all[0].id, "i2");

        let active_proj_b = repo.list_active_instances(Some("/b")).unwrap();
        assert_eq!(active_proj_b.len(), 1);
        let active_proj_a = repo.list_active_instances(Some("/a")).unwrap();
        assert!(active_proj_a.is_empty());
    }

    #[test]
    fn port_claims_replace_and_cascade() {
        let repo = RunnerRepository::new(db());
        repo.record_instance_start(&instance_fixture("i1", "/proj", 1234))
            .unwrap();

        let claims = vec![
            PortClaim {
                id: 0,
                instance_id: Some("i1".to_string()),
                pid: 1234,
                port: 5173,
                protocol: "tcp".to_string(),
                listen_addr: Some("0.0.0.0".to_string()),
                detected_at: "2026-05-24T00:00:00Z".to_string(),
            },
            PortClaim {
                id: 0,
                instance_id: Some("i1".to_string()),
                pid: 1234,
                port: 5174,
                protocol: "tcp".to_string(),
                listen_addr: Some("127.0.0.1".to_string()),
                detected_at: "2026-05-24T00:00:00Z".to_string(),
            },
        ];
        repo.replace_port_claims_for_instance("i1", &claims)
            .unwrap();
        let got = repo.list_claims_by_instance("i1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].port, 5173);
        assert_eq!(got[1].port, 5174);

        let by_port = repo.list_claims_by_port(5173).unwrap();
        assert_eq!(by_port.len(), 1);
        assert_eq!(by_port[0].pid, 1234);

        // Cascade delete: delete instance, claims should disappear (need FK pragma)
        // SQLite's ON DELETE CASCADE requires `PRAGMA foreign_keys = ON`
        // Not enabled in this codebase—test should not assume cascade.
        // We only test explicit replace_port_claims_for_instance(empty)
        repo.replace_port_claims_for_instance("i1", &[]).unwrap();
        assert!(repo.list_claims_by_instance("i1").unwrap().is_empty());
    }

    #[test]
    fn replace_claims_idempotent_on_same_pid_port_protocol() {
        let repo = RunnerRepository::new(db());
        repo.record_instance_start(&instance_fixture("i1", "/proj", 1234))
            .unwrap();
        let claim = PortClaim {
            id: 0,
            instance_id: Some("i1".to_string()),
            pid: 1234,
            port: 5173,
            protocol: "tcp".to_string(),
            listen_addr: Some("0.0.0.0".to_string()),
            detected_at: "2026-05-24T00:00:00Z".to_string(),
        };
        repo.replace_port_claims_for_instance("i1", &[claim.clone()])
            .unwrap();
        repo.replace_port_claims_for_instance("i1", &[claim])
            .unwrap();
        assert_eq!(repo.list_claims_by_instance("i1").unwrap().len(), 1);
    }

    #[test]
    fn touch_profile_last_started() {
        let repo = RunnerRepository::new(db());
        let p = profile_fixture("p1", "/proj", "frontend dev");
        repo.upsert_profile(&p).unwrap();
        repo.touch_profile_last_started("p1", "2026-05-25T10:00:00Z")
            .unwrap();
        let got = repo.get_profile("p1").unwrap().unwrap();
        assert_eq!(got.last_started_at.as_deref(), Some("2026-05-25T10:00:00Z"));
        assert_eq!(got.updated_at, "2026-05-25T10:00:00Z");
    }

    #[test]
    fn list_active_by_profile_returns_only_running_for_profile() {
        let repo = RunnerRepository::new(db());
        let mut profile_a = profile_fixture("profile-a", "/proj-a", "dev-a");
        profile_a.workspace_name = Some("ws-a".to_string());
        let mut profile_b = profile_fixture("profile-b", "/proj-b", "dev-b");
        profile_b.workspace_name = Some("ws-a".to_string());
        repo.upsert_profile(&profile_a).unwrap();
        repo.upsert_profile(&profile_b).unwrap();

        let mut running_a = instance_fixture("inst-running-a", "/proj-a", 1001);
        running_a.profile_id = Some("profile-a".to_string());
        running_a.session_id = Some("session-running-a".to_string());
        let mut exited_a = instance_fixture("inst-exited-a", "/proj-a", 1002);
        exited_a.profile_id = Some("profile-a".to_string());
        exited_a.session_id = Some("session-exited-a".to_string());
        let mut running_b = instance_fixture("inst-running-b", "/proj-b", 1003);
        running_b.profile_id = Some("profile-b".to_string());
        running_b.session_id = Some("session-running-b".to_string());

        repo.record_instance_start(&running_a).unwrap();
        repo.record_instance_start(&exited_a).unwrap();
        repo.record_instance_start(&running_b).unwrap();
        repo.mark_instance_exited(
            "inst-exited-a",
            "2026-05-24T01:00:00Z",
            Some(0),
            RunnerInstanceStatus::Exited,
        )
        .unwrap();

        let active = repo.list_active_by_profile("profile-a").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "inst-running-a");
    }

    #[test]
    fn list_profiles_by_workspace_returns_matching_profiles() {
        let repo = RunnerRepository::new(db());
        let mut profile_a = profile_fixture("profile-a", "/proj-a", "dev-a");
        profile_a.workspace_name = Some("ws-a".to_string());
        profile_a.expected_ports = vec![1420, 5173];
        let mut profile_b = profile_fixture("profile-b", "/proj-b", "dev-b");
        profile_b.workspace_name = Some("ws-a".to_string());
        profile_b.expected_ports = vec![48080];
        let mut profile_c = profile_fixture("profile-c", "/proj-c", "dev-c");
        profile_c.workspace_name = Some("ws-b".to_string());

        repo.upsert_profile(&profile_b).unwrap();
        repo.upsert_profile(&profile_c).unwrap();
        repo.upsert_profile(&profile_a).unwrap();

        let profiles = repo.list_profiles_by_workspace("ws-a").unwrap();
        let ids = profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["profile-a", "profile-b"]);
        assert_eq!(profiles[0].expected_ports, vec![1420, 5173]);
        assert_eq!(profiles[1].expected_ports, vec![48080]);
    }
}
