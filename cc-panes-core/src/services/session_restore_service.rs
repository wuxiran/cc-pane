use crate::models::session_restore::SavedSession;
use crate::repository::{Database, SessionRestoreRepository};
use crate::utils::AppPaths;
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

    /// 保存会话元数据到数据库
    pub fn save_sessions(&self, sessions: &[SavedSession]) -> Result<(), String> {
        info!(
            count = sessions.len(),
            "Saving terminal sessions for restore"
        );
        self.repo.save_sessions(sessions)
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
