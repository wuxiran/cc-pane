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

    /// 添加启动记录
    pub fn add(&self, project_id: &str, project_name: &str, project_path: &str) -> Result<(), String> {
        self.repo.add(project_id, project_name, project_path)
    }

    /// 获取最近的启动记录
    pub fn list(&self, limit: usize) -> Result<Vec<LaunchRecord>, String> {
        self.repo.list(limit)
    }

    /// 清空启动记录
    pub fn clear(&self) -> Result<(), String> {
        self.repo.clear()
    }
}
