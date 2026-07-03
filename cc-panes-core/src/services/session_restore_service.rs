use crate::models::workspace_snapshot::WorkspaceSnapshotSummary;
use crate::models::{SavedSession, WorkspaceSnapshot, WorkspaceSnapshotEntry};
use crate::repository::{Database, SessionRestoreRepository};
use crate::utils::AppPaths;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::sync::Arc;
use tracing::{error, info, warn};

/// 终端会话恢复服务
///
/// 管理终端会话的元数据持久化和输出文件存储，
/// 支持应用关闭后重启恢复终端状态。
pub struct SessionRestoreService {
    repo: SessionRestoreRepository,
    app_paths: Arc<AppPaths>,
}

impl SessionRestoreService {
    pub fn new(db: Arc<Database>, app_paths: Arc<AppPaths>) -> Self {
        Self {
            repo: SessionRestoreRepository::new(db),
            app_paths,
        }
    }

    /// 保存会话元数据到数据库，并同步写入用户级 workspace snapshot 文件。
    pub fn save_sessions(&self, sessions: &[SavedSession]) -> Result<(), String> {
        info!(
            count = sessions.len(),
            "Saving terminal sessions for restore"
        );
        self.repo.save_sessions(sessions)?;
        self.save_workspace_snapshots(sessions)?;
        Ok(())
    }

    /// 加载会话元数据，同时检查输出文件是否存在
    pub fn load_sessions(&self) -> Result<Vec<SavedSession>, String> {
        let mut sessions = self.repo.load_sessions()?;
        for s in &mut sessions {
            s.has_output = self.app_paths.session_output_path(&s.session_id).exists();
        }
        info!(
            count = sessions.len(),
            "Loaded terminal sessions for restore"
        );
        Ok(sessions)
    }

    /// 清空所有会话元数据
    pub fn clear_sessions(&self) -> Result<(), String> {
        self.repo.clear_sessions()
    }

    pub fn list_workspace_snapshots(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceSnapshotSummary>, String> {
        validate_snapshot_component("workspaceId", workspace_id)?;
        let dir = self.app_paths.workspace_snapshots_dir(workspace_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let entries = std::fs::read_dir(&dir).map_err(|e| {
            error!(path = %dir.display(), err = %e, "Failed to read workspace snapshots dir");
            format!("Failed to read workspace snapshots dir: {}", e)
        })?;

        let mut snapshots = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path().join("snapshot.json");
            if !path.is_file() {
                continue;
            }
            match read_workspace_snapshot_file(&path) {
                Ok(snapshot) => snapshots.push(WorkspaceSnapshotSummary::from(&snapshot)),
                Err(error) => {
                    warn!(path = %path.display(), error = %error, "Skipping invalid workspace snapshot")
                }
            }
        }
        snapshots.sort_by_cached_key(|snapshot| std::cmp::Reverse(snapshot.saved_at.clone()));
        Ok(snapshots)
    }

    pub fn get_workspace_snapshot(
        &self,
        workspace_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<WorkspaceSnapshot>, String> {
        validate_snapshot_component("workspaceId", workspace_id)?;
        validate_snapshot_component("snapshotId", snapshot_id)?;
        let path = self
            .app_paths
            .workspace_snapshot_path(workspace_id, snapshot_id);
        if !path.is_file() {
            return Ok(None);
        }
        read_workspace_snapshot_file(&path).map(Some)
    }

    pub fn delete_workspace_snapshot(
        &self,
        workspace_id: &str,
        snapshot_id: &str,
    ) -> Result<bool, String> {
        validate_snapshot_component("workspaceId", workspace_id)?;
        validate_snapshot_component("snapshotId", snapshot_id)?;
        let path = self
            .app_paths
            .workspace_snapshot_path(workspace_id, snapshot_id);
        if !path.exists() {
            return Ok(false);
        }
        std::fs::remove_file(&path).map_err(|e| {
            error!(path = %path.display(), err = %e, "Failed to delete workspace snapshot");
            format!("Failed to delete workspace snapshot: {}", e)
        })?;
        Ok(true)
    }

    fn save_workspace_snapshots(&self, sessions: &[SavedSession]) -> Result<(), String> {
        let mut groups: BTreeMap<(String, String), Vec<&SavedSession>> = BTreeMap::new();
        for session in sessions {
            let workspace_id = workspace_identity(session);
            let workspace_snapshot_id = session
                .workspace_snapshot_id
                .clone()
                .unwrap_or_else(|| workspace_id.clone());
            groups
                .entry((workspace_id, workspace_snapshot_id))
                .or_default()
                .push(session);
        }

        for ((workspace_id, workspace_snapshot_id), group) in groups {
            let Some(first) = group.first() else {
                continue;
            };
            let saved_at = group
                .iter()
                .map(|session| session.saved_at.as_str())
                .max()
                .unwrap_or(first.saved_at.as_str())
                .to_string();
            let created_at = group
                .iter()
                .map(|session| session.created_at.as_str())
                .min()
                .unwrap_or(first.created_at.as_str())
                .to_string();
            let title = first
                .workspace_name
                .clone()
                .or_else(|| first.custom_title.clone())
                .unwrap_or_else(|| "Workspace Snapshot".to_string());
            let workspace_name = first.workspace_name.clone();
            let workspace_path = first.workspace_path.clone();
            let entries = group
                .into_iter()
                .map(|session| WorkspaceSnapshotEntry {
                    pty_session_id: session.session_id.clone(),
                    tab_id: session.tab_id.clone(),
                    pane_id: session.pane_id.clone(),
                    project_path: session.project_path.clone(),
                    provider_id: session.provider_id.clone(),
                    provider_selection: session.provider_selection.clone(),
                    launch_profile_id: session.launch_profile_id.clone(),
                    agent_tool: session.cli_tool.clone(),
                    runtime_kind: session.runtime_kind.clone(),
                    agent_resume_id: session.resume_id.clone(),
                    custom_title: session.custom_title.clone(),
                    created_at: session.created_at.clone(),
                    saved_at: session.saved_at.clone(),
                })
                .collect();

            let workspace_snapshot = WorkspaceSnapshot {
                id: workspace_snapshot_id.clone(),
                workspace_id: workspace_id.clone(),
                workspace_name,
                workspace_path,
                title,
                created_at,
                saved_at,
                entries,
            };
            self.write_workspace_snapshot(&workspace_snapshot)?;
        }

        Ok(())
    }

    fn write_workspace_snapshot(&self, session: &WorkspaceSnapshot) -> Result<(), String> {
        let path = self
            .app_paths
            .workspace_snapshot_path(&session.workspace_id, &session.id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                error!(path = %parent.display(), err = %e, "Failed to create workspace snapshot dir");
                format!("Failed to create workspace snapshot dir: {}", e)
            })?;
        }
        let content = serde_json::to_string_pretty(session)
            .map_err(|e| format!("Failed to serialize workspace snapshot: {}", e))?;
        std::fs::write(&path, content).map_err(|e| {
            error!(path = %path.display(), err = %e, "Failed to write workspace snapshot");
            format!("Failed to write workspace snapshot: {}", e)
        })?;
        Ok(())
    }

    /// 保存终端输出到文件
    pub fn save_session_output(&self, session_id: &str, lines: &[String]) -> Result<(), String> {
        let dir = self.app_paths.sessions_dir();
        std::fs::create_dir_all(&dir).map_err(|e| {
            error!(path = %dir.display(), err = %e, "Failed to create sessions dir");
            format!("Failed to create sessions dir: {}", e)
        })?;

        let path = self.app_paths.session_output_path(session_id);
        let file = std::fs::File::create(&path).map_err(|e| {
            error!(path = %path.display(), err = %e, "Failed to create output file");
            format!("Failed to create output file: {}", e)
        })?;

        let mut writer = BufWriter::new(file);
        for line in lines {
            writeln!(writer, "{}", line)
                .map_err(|e| format!("Failed to write output line: {}", e))?;
        }
        writer
            .flush()
            .map_err(|e| format!("Failed to flush output: {}", e))?;

        info!(session_id, lines = lines.len(), "Saved session output");
        Ok(())
    }

    /// 加载终端输出文件
    pub fn load_session_output(&self, session_id: &str) -> Result<Option<Vec<String>>, String> {
        let path = self.app_paths.session_output_path(session_id);
        if !path.exists() {
            return Ok(None);
        }

        let file = std::fs::File::open(&path).map_err(|e| {
            error!(path = %path.display(), err = %e, "Failed to open output file");
            format!("Failed to open output file: {}", e)
        })?;

        let reader = BufReader::new(file);
        let lines: Vec<String> = reader
            .lines()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read output: {}", e))?;

        info!(session_id, lines = lines.len(), "Loaded session output");
        Ok(Some(lines))
    }

    /// 清除指定会话的输出文件
    pub fn clear_session_output(&self, session_id: &str) -> Result<(), String> {
        let path = self.app_paths.session_output_path(session_id);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| {
                warn!(path = %path.display(), err = %e, "Failed to remove output file");
                format!("Failed to remove output file: {}", e)
            })?;
        }
        Ok(())
    }

    /// 清空所有输出文件
    pub fn clear_all_outputs(&self) -> Result<(), String> {
        let dir = self.app_paths.sessions_dir();
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| {
                warn!(path = %dir.display(), err = %e, "Failed to remove sessions dir");
                format!("Failed to remove sessions dir: {}", e)
            })?;
        }
        Ok(())
    }
}

fn workspace_identity(session: &SavedSession) -> String {
    session
        .workspace_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .workspace_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("default")
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
            _ => '_',
        })
        .collect()
}

fn validate_snapshot_component(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "{} may only contain ASCII letters, numbers, '-' or '_'",
            label
        ));
    }
    Ok(())
}

fn read_workspace_snapshot_file(path: &std::path::Path) -> Result<WorkspaceSnapshot, String> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        error!(path = %path.display(), err = %e, "Failed to read workspace snapshot");
        format!("Failed to read workspace snapshot: {}", e)
    })?;
    serde_json::from_str(&content).map_err(|e| {
        error!(path = %path.display(), err = %e, "Failed to parse workspace snapshot");
        format!("Failed to parse workspace snapshot: {}", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_service() -> (SessionRestoreService, TempDir) {
        let tmp = TempDir::new().expect("tempdir");
        let app_paths = Arc::new(AppPaths::new(Some(
            tmp.path().to_string_lossy().to_string(),
        )));
        let db = Arc::new(Database::new_in_memory().expect("in-memory db"));
        (SessionRestoreService::new(db, app_paths), tmp)
    }

    fn sample_session(session_id: &str, workspace_name: Option<&str>) -> SavedSession {
        SavedSession {
            workspace_snapshot_id: None,
            session_id: session_id.to_string(),
            tab_id: format!("tab-{}", session_id),
            pane_id: format!("pane-{}", session_id),
            project_path: "D:\\proj".to_string(),
            workspace_name: workspace_name.map(|s| s.to_string()),
            workspace_path: None,
            provider_id: None,
            provider_selection: None,
            launch_profile_id: None,
            cli_tool: "claude".to_string(),
            runtime_kind: Some("local".to_string()),
            resume_id: Some(format!("resume-{}", session_id)),
            ssh_config: None,
            custom_title: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            saved_at: "2026-01-02T00:00:00Z".to_string(),
            has_output: false,
        }
    }

    // ===== 会话元数据持久化 =====

    #[test]
    fn save_and_load_sessions_roundtrip() {
        let (service, _tmp) = make_service();
        let sessions = vec![
            sample_session("s1", Some("ws")),
            sample_session("s2", Some("ws")),
        ];
        service.save_sessions(&sessions).unwrap();

        let loaded = service.load_sessions().unwrap();
        assert_eq!(loaded.len(), 2);
        let s1 = loaded.iter().find(|s| s.session_id == "s1").unwrap();
        assert_eq!(s1.cli_tool, "claude");
        assert_eq!(s1.resume_id.as_deref(), Some("resume-s1"));
        assert!(!s1.has_output, "没有输出文件时 has_output 应为 false");
    }

    #[test]
    fn load_sessions_sets_has_output_when_file_exists() {
        let (service, _tmp) = make_service();
        service
            .save_sessions(&[sample_session("s1", Some("ws"))])
            .unwrap();
        service
            .save_session_output("s1", &["line".to_string()])
            .unwrap();

        let loaded = service.load_sessions().unwrap();
        assert!(loaded[0].has_output);
    }

    #[test]
    fn clear_sessions_removes_all() {
        let (service, _tmp) = make_service();
        service
            .save_sessions(&[sample_session("s1", Some("ws"))])
            .unwrap();
        service.clear_sessions().unwrap();
        assert!(service.load_sessions().unwrap().is_empty());
    }

    // ===== 输出文件 =====

    #[test]
    fn session_output_roundtrip() {
        let (service, _tmp) = make_service();
        let lines = vec!["first".to_string(), "second".to_string()];
        service.save_session_output("out1", &lines).unwrap();

        let loaded = service.load_session_output("out1").unwrap();
        assert_eq!(loaded, Some(lines));
    }

    #[test]
    fn load_session_output_returns_none_when_missing() {
        let (service, _tmp) = make_service();
        assert_eq!(service.load_session_output("nope").unwrap(), None);
    }

    #[test]
    fn clear_session_output_removes_file_and_is_idempotent() {
        let (service, _tmp) = make_service();
        service
            .save_session_output("c1", &["x".to_string()])
            .unwrap();
        service.clear_session_output("c1").unwrap();
        assert_eq!(service.load_session_output("c1").unwrap(), None);
        // 再次清除不存在的文件不应报错
        service.clear_session_output("c1").unwrap();
    }

    #[test]
    fn clear_all_outputs_removes_sessions_dir() {
        let (service, _tmp) = make_service();
        service
            .save_session_output("a", &["1".to_string()])
            .unwrap();
        service
            .save_session_output("b", &["2".to_string()])
            .unwrap();
        service.clear_all_outputs().unwrap();
        assert_eq!(service.load_session_output("a").unwrap(), None);
        assert_eq!(service.load_session_output("b").unwrap(), None);
    }

    // ===== Workspace snapshot =====

    #[test]
    fn save_sessions_groups_into_workspace_snapshot() {
        let (service, _tmp) = make_service();
        let mut s1 = sample_session("s1", Some("myws"));
        s1.created_at = "2026-01-01T00:00:00Z".to_string();
        s1.saved_at = "2026-01-02T00:00:00Z".to_string();
        let mut s2 = sample_session("s2", Some("myws"));
        s2.created_at = "2026-01-03T00:00:00Z".to_string();
        s2.saved_at = "2026-01-04T00:00:00Z".to_string();
        service.save_sessions(&[s1, s2]).unwrap();

        let snapshots = service.list_workspace_snapshots("myws").unwrap();
        assert_eq!(snapshots.len(), 1);

        let snapshot = service
            .get_workspace_snapshot("myws", &snapshots[0].id)
            .unwrap()
            .expect("snapshot should exist");
        assert_eq!(snapshot.workspace_id, "myws");
        assert_eq!(snapshot.entries.len(), 2);
        // created_at 取最小、saved_at 取最大
        assert_eq!(snapshot.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(snapshot.saved_at, "2026-01-04T00:00:00Z");
        assert_eq!(snapshot.title, "myws");
        let entry = snapshot
            .entries
            .iter()
            .find(|e| e.pty_session_id == "s1")
            .unwrap();
        assert_eq!(entry.agent_tool, "claude");
        assert_eq!(entry.agent_resume_id.as_deref(), Some("resume-s1"));
    }

    #[test]
    fn list_workspace_snapshots_empty_when_dir_missing() {
        let (service, _tmp) = make_service();
        assert!(service
            .list_workspace_snapshots("nothing")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn get_workspace_snapshot_returns_none_when_missing() {
        let (service, _tmp) = make_service();
        assert!(service
            .get_workspace_snapshot("ws", "snap")
            .unwrap()
            .is_none());
    }

    #[test]
    fn delete_workspace_snapshot_returns_flag() {
        let (service, _tmp) = make_service();
        service
            .save_sessions(&[sample_session("s1", Some("ws1"))])
            .unwrap();
        let snapshots = service.list_workspace_snapshots("ws1").unwrap();
        assert_eq!(snapshots.len(), 1);

        assert!(service
            .delete_workspace_snapshot("ws1", &snapshots[0].id)
            .unwrap());
        assert!(!service
            .delete_workspace_snapshot("ws1", &snapshots[0].id)
            .unwrap());
        assert!(service
            .get_workspace_snapshot("ws1", &snapshots[0].id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn snapshot_apis_reject_illegal_component() {
        let (service, _tmp) = make_service();
        assert!(service.list_workspace_snapshots("").is_err());
        assert!(service.list_workspace_snapshots("bad id").is_err());
        assert!(service.get_workspace_snapshot("ws", "../x").is_err());
        assert!(service
            .delete_workspace_snapshot("ws/../x", "snap")
            .is_err());
    }

    // ===== 纯函数 =====

    #[test]
    fn workspace_identity_sanitizes_and_falls_back() {
        let mut session = sample_session("s1", Some("My WS!"));
        assert_eq!(workspace_identity(&session), "My_WS_");

        session.workspace_name = None;
        session.workspace_path = Some("D:\\ws path".to_string());
        assert_eq!(workspace_identity(&session), "D__ws_path");

        session.workspace_path = Some("   ".to_string());
        assert_eq!(workspace_identity(&session), "default");
    }

    #[test]
    fn validate_snapshot_component_rules() {
        assert!(validate_snapshot_component("id", "abc-DEF_123").is_ok());
        assert!(validate_snapshot_component("id", "").is_err());
        assert!(validate_snapshot_component("id", "  ").is_err());
        assert!(validate_snapshot_component("id", "a/b").is_err());
        assert!(validate_snapshot_component("id", "中文").is_err());
    }
}
