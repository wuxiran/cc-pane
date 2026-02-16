//! 会话状态管理模块
//!
//! 管理 Claude Code 会话的持久化，支持会话恢复功能

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 会话状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    /// Claude 会话 ID
    pub session_id: String,
    /// 会话开始时间
    pub started_at: String,
    /// 最后活跃时间
    pub last_active: String,
    /// 会话状态: active, completed, abandoned
    pub status: SessionStatus,
}

/// 会话状态枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Completed,
    Abandoned,
}

impl SessionState {
    /// 创建新会话状态
    pub fn new(session_id: String) -> Self {
        let now = crate::utils::current_datetime();
        Self {
            session_id,
            started_at: now.clone(),
            last_active: now,
            status: SessionStatus::Active,
        }
    }

    /// 更新最后活跃时间
    pub fn touch(&mut self) {
        self.last_active = crate::utils::current_datetime();
    }

    /// 标记为已完成
    pub fn mark_completed(&mut self) {
        self.status = SessionStatus::Completed;
        self.touch();
    }
}

/// 获取会话状态文件路径
pub fn session_file_path(workspace_dir: &str) -> PathBuf {
    Path::new(workspace_dir)
        .join(".cc-panes")
        .join("session.json")
}

/// 加载会话状态
pub fn load_session(workspace_dir: &str) -> Result<Option<SessionState>> {
    let path = session_file_path(workspace_dir);
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("无法读取会话文件: {}", path.display()))?;

    let state: SessionState = serde_json::from_str(&content)
        .with_context(|| "无法解析会话文件")?;

    Ok(Some(state))
}

/// 保存会话状态
pub fn save_session(workspace_dir: &str, state: &SessionState) -> Result<()> {
    let path = session_file_path(workspace_dir);

    // 确保目录存在
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let content = serde_json::to_string_pretty(state)?;
    fs::write(&path, content)
        .with_context(|| format!("无法写入会话文件: {}", path.display()))?;

    Ok(())
}

/// 检查是否有活跃会话
pub fn has_active_session(workspace_dir: &str) -> bool {
    match load_session(workspace_dir) {
        Ok(Some(state)) => state.status == SessionStatus::Active,
        _ => false,
    }
}

/// 清除会话状态
pub fn clear_session(workspace_dir: &str) -> Result<()> {
    let path = session_file_path(workspace_dir);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_state_new() {
        let state = SessionState::new("test-id".to_string());
        assert_eq!(state.session_id, "test-id");
        assert_eq!(state.status, SessionStatus::Active);
    }

    #[test]
    fn test_session_status_serialize() {
        let state = SessionState::new("test".to_string());
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"status\":\"active\""));
    }
}
