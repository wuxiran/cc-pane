use crate::repository::{HistoryRepository, LaunchRecord};
use std::sync::Arc;

/// 启动历史 Service - 封装对 HistoryRepository 的操作
pub struct LaunchHistoryService {
    repo: Arc<HistoryRepository>,
}

impl LaunchHistoryService {
    pub fn new(repo: Arc<HistoryRepository>) -> Self {
        Self { repo }
    }

    /// 添加启动记录，返回记录 ID
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &self,
        project_id: &str,
        project_name: &str,
        project_path: &str,
        workspace_name: Option<&str>,
        workspace_path: Option<&str>,
        launch_cwd: Option<&str>,
        provider_id: Option<&str>,
    ) -> Result<i64, String> {
        self.repo.add(
            project_id,
            project_name,
            project_path,
            workspace_name,
            workspace_path,
            launch_cwd,
            provider_id,
        )
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        self.repo.list(limit)
    }

    /// 按项目路径获取启动记录（SQL 层路径规范化过滤）
    pub fn list_by_project(
        &self,
        project_path: &str,
        limit: usize,
    ) -> Result<Vec<LaunchRecord>, String> {
        self.repo.list_by_project(project_path, limit)
    }

    /// 更新 Claude Session ID
    pub fn update_session_id(&self, id: i64, claude_session_id: &str) -> Result<(), String> {
        self.repo.update_session_id(id, claude_session_id)
    }

    /// 更新最后 Prompt
    pub fn update_last_prompt(&self, id: i64, last_prompt: &str) -> Result<(), String> {
        self.repo.update_last_prompt(id, last_prompt)
    }

    /// 更新已有会话记录的时间戳，返回记录 ID（不存在则返回 None）
    pub fn touch_by_session_id(&self, claude_session_id: &str) -> Result<Option<i64>, String> {
        self.repo.touch_by_session_id(claude_session_id)
    }

    /// 删除单条启动记录
    pub fn delete(&self, id: i64) -> Result<(), String> {
        self.repo.delete_by_id(id)
    }

    /// 清空启动记录
    pub fn clear(&self) -> Result<(), String> {
        self.repo.clear()
    }
}
