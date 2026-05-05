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
