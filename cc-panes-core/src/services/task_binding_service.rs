use crate::models::task_binding::*;
use crate::repository::TaskBindingRepository;
use crate::utils::error::{AppError, AppResult};
use std::sync::Arc;
use tracing::debug;

/// TaskBinding 业务逻辑层
pub struct TaskBindingService {
    repo: Arc<TaskBindingRepository>,
}

impl TaskBindingService {
    pub fn new(repo: Arc<TaskBindingRepository>) -> Self {
        Self { repo }
    }

    /// 创建 TaskBinding
    pub fn create(&self, req: CreateTaskBindingRequest) -> AppResult<TaskBinding> {
        debug!("svc::create_task_binding");
        let title = req.title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::from("TaskBinding title cannot be empty"));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let binding = TaskBinding {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            prompt: req.prompt,
            session_id: req.session_id,
            todo_id: req.todo_id,
            project_path: req.project_path,
            workspace_name: req.workspace_name,
            cli_tool: req.cli_tool.unwrap_or_else(|| "claude".to_string()),
            status: TaskBindingStatus::Pending,
            progress: 0,
            completion_summary: None,
            exit_code: None,
            sort_order: 0,
            created_at: now.clone(),
            updated_at: now,
        };

        self.repo.insert(&binding)?;
        Ok(binding)
    }

    /// 获取 TaskBinding
    pub fn get(&self, id: &str) -> AppResult<Option<TaskBinding>> {
        Ok(self.repo.get(id)?)
    }

    /// 根据 session_id 查找
    pub fn find_by_session_id(&self, session_id: &str) -> AppResult<Option<TaskBinding>> {
        Ok(self.repo.find_by_session_id(session_id)?)
    }

    /// 更新 TaskBinding
    pub fn update(&self, id: &str, req: UpdateTaskBindingRequest) -> AppResult<TaskBinding> {
        debug!("svc::update_task_binding");
        if let Some(ref title) = req.title {
            if title.trim().is_empty() {
                return Err(AppError::from("TaskBinding title cannot be empty"));
            }
        }

        // 验证 progress 范围
        if let Some(progress) = req.progress {
            if !(0..=100).contains(&progress) {
                return Err(AppError::from("Progress must be between 0 and 100"));
            }
        }

        self.repo.update(id, &req)?;
        self.repo
            .get(id)?
            .ok_or_else(|| AppError::from(format!("TaskBinding '{}' not found", id)))
    }

    /// 删除 TaskBinding
    pub fn delete(&self, id: &str) -> AppResult<bool> {
        Ok(self.repo.delete(id)?)
    }

    /// 查询 TaskBindings
    pub fn query(&self, query: TaskBindingQuery) -> AppResult<TaskBindingQueryResult> {
        Ok(self.repo.query(&query)?)
    }
}
