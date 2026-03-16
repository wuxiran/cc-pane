use crate::models::todo::*;
use crate::repository::TodoRepository;
use crate::utils::error::AppError;
use crate::utils::error::AppResult;
use crate::utils::error_codes as EC;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::debug;

/// Todo 业务逻辑层
pub struct TodoService {
    repo: Arc<TodoRepository>,
}

impl TodoService {
    pub fn new(repo: Arc<TodoRepository>) -> Self {
        Self { repo }
    }

    // ============ TodoItem 操作 ============

    /// 创建 Todo
    pub fn create_todo(&self, req: CreateTodoRequest) -> AppResult<TodoItem> {
        debug!("svc::create_todo");
        let title = req.title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::coded(EC::TODO_TITLE_EMPTY, "Title cannot be empty"));
        }

        let scope = req.scope.unwrap_or(TodoScope::Global);
        // Validate: workspace/project scope requires scope_ref
        if matches!(scope, TodoScope::Workspace | TodoScope::Project) && req.scope_ref.is_none() {
            return Err(AppError::coded(EC::TODO_SCOPE_REF_REQUIRED, "workspace/project scope requires scopeRef"));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let sort_order = self.repo.max_sort_order()? + 1;

        let todo = TodoItem {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            description: req.description,
            status: req.status.unwrap_or(TodoStatus::Todo),
            priority: req.priority.unwrap_or(TodoPriority::Medium),
            scope,
            scope_ref: req.scope_ref,
            tags: req.tags.unwrap_or_default(),
            due_date: req.due_date,
            my_day: false,
            my_day_date: None,
            reminder_at: req.reminder_at,
            recurrence: req.recurrence,
            todo_type: req.todo_type.unwrap_or_default(),
            sort_order,
            created_at: now.clone(),
            updated_at: now,
            subtasks: vec![],
        };

        self.repo.insert(&todo)?;
        Ok(todo)
    }

    /// 获取 Todo
    pub fn get_todo(&self, id: &str) -> AppResult<Option<TodoItem>> {
        Ok(self.repo.get(id)?)
    }

    /// 更新 Todo
    pub fn update_todo(&self, id: &str, req: UpdateTodoRequest) -> AppResult<TodoItem> {
        debug!("svc::update_todo");
        // Validate title is not empty (if provided)
        if let Some(ref title) = req.title {
            if title.trim().is_empty() {
                return Err(AppError::coded(EC::TODO_TITLE_EMPTY, "Title cannot be empty"));
            }
        }

        // 获取旧记录，用于判断是否需要触发重复任务
        let old_todo = self.repo.get(id)?
            .ok_or_else(|| todo_not_found(id))?;

        let updated = self.repo.update(id, &req)?;
        if !updated {
            return Err(todo_not_found(id));
        }

        // 重复任务：状态变为 done 且有 recurrence 时，自动创建下一个实例
        let is_becoming_done = req.status.as_ref() == Some(&TodoStatus::Done)
            && old_todo.status != TodoStatus::Done;
        if is_becoming_done {
            if let Some(ref recurrence) = old_todo.recurrence {
                if !recurrence.is_empty() {
                    let _ = self.create_next_recurrence(&old_todo, recurrence);
                }
            }
        }

        self.repo
            .get(id)?
            .ok_or_else(|| todo_not_found(id))
    }

    /// 根据重复规则创建下一个 Todo 实例
    fn create_next_recurrence(&self, old: &TodoItem, recurrence: &str) -> AppResult<TodoItem> {
        use chrono::{NaiveDate, Duration, Months};

        // 计算下一个 due_date
        let next_due = old.due_date.as_ref().and_then(|d| {
            // 支持 ISO 8601 日期（可能包含时间部分）
            let date_str = if d.len() >= 10 { &d[..10] } else { d };
            NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()
        }).map(|date| {
            let next = match recurrence {
                "daily" => date + Duration::days(1),
                "weekly" => date + Duration::weeks(1),
                "monthly" => date.checked_add_months(Months::new(1)).unwrap_or(date + Duration::days(30)),
                _ => date + Duration::days(1),
            };
            next.format("%Y-%m-%d").to_string()
        });

        // 计算下一个 reminder_at（保持与 due_date 相同的偏移量）
        let next_reminder = if let (Some(ref due), Some(ref reminder)) = (&old.due_date, &old.reminder_at) {
            if let (Ok(due_dt), Ok(rem_dt)) = (
                chrono::DateTime::parse_from_rfc3339(due),
                chrono::DateTime::parse_from_rfc3339(reminder),
            ) {
                let offset = rem_dt.signed_duration_since(due_dt);
                next_due.as_ref().and_then(|nd| {
                    NaiveDate::parse_from_str(nd, "%Y-%m-%d").ok().and_then(|d| {
                        d.and_hms_opt(0, 0, 0)
                            .and_then(|dt| dt.and_local_timezone(chrono::Utc).single())
                            .map(|base| (base + offset).to_rfc3339())
                    })
                })
            } else {
                None
            }
        } else {
            None
        };

        let req = CreateTodoRequest {
            title: old.title.clone(),
            description: old.description.clone(),
            status: Some(TodoStatus::Todo),
            priority: Some(old.priority.clone()),
            scope: Some(old.scope.clone()),
            scope_ref: old.scope_ref.clone(),
            tags: if old.tags.is_empty() { None } else { Some(old.tags.clone()) },
            due_date: next_due,
            reminder_at: next_reminder,
            recurrence: Some(recurrence.to_string()),
            todo_type: Some(old.todo_type.clone()),
        };

        self.create_todo(req)
    }

    /// 删除 Todo
    pub fn delete_todo(&self, id: &str) -> AppResult<()> {
        debug!("svc::delete_todo");
        let deleted = self.repo.delete(id)?;
        if !deleted {
            return Err(todo_not_found(id));
        }
        Ok(())
    }

    /// 查询 Todo 列表
    pub fn query_todos(&self, query: TodoQuery) -> AppResult<TodoQueryResult> {
        Ok(self.repo.query(&query)?)
    }

    /// 重排 Todo
    pub fn reorder_todos(&self, todo_ids: Vec<String>) -> AppResult<()> {
        Ok(self.repo.reorder(&todo_ids)?)
    }

    /// 批量更新状态
    pub fn batch_update_status(
        &self,
        ids: Vec<String>,
        status: TodoStatus,
    ) -> AppResult<u32> {
        Ok(self.repo.batch_update_status(&ids, &status)?)
    }

    /// 获取统计
    pub fn get_stats(
        &self,
        scope: Option<TodoScope>,
        scope_ref: Option<String>,
    ) -> AppResult<TodoStats> {
        Ok(self.repo.stats(scope.as_ref(), scope_ref.as_deref())?)
    }

    /// 切换"我的一天"状态
    pub fn toggle_my_day(&self, id: &str) -> AppResult<TodoItem> {
        let todo = self
            .repo
            .get(id)?
            .ok_or_else(|| todo_not_found(id))?;

        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let new_my_day = !todo.my_day || todo.my_day_date.as_deref() != Some(&today);

        let req = UpdateTodoRequest {
            my_day: Some(new_my_day),
            my_day_date: Some(if new_my_day { today } else { String::new() }),
            ..Default::default()
        };

        self.repo.update(id, &req)?;
        self.repo
            .get(id)?
            .ok_or_else(|| todo_not_found(id))
    }

    /// 获取到期提醒的 Todo
    pub fn get_due_reminders(&self) -> AppResult<Vec<TodoItem>> {
        Ok(self.repo.get_due_reminders(&chrono::Utc::now().to_rfc3339())?)
    }

    // ============ 子任务操作 ============

    /// 添加子任务
    pub fn add_subtask(&self, todo_id: &str, title: &str) -> AppResult<TodoSubtask> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::coded(EC::SUBTASK_TITLE_EMPTY, "Subtask title cannot be empty"));
        }

        // Validate parent Todo exists
        if self.repo.get(todo_id)?.is_none() {
            return Err(todo_not_found(todo_id));
        }

        let sort_order = self.repo.max_subtask_sort_order(todo_id)? + 1;

        let subtask = TodoSubtask {
            id: uuid::Uuid::new_v4().to_string(),
            todo_id: todo_id.to_string(),
            title,
            completed: false,
            sort_order,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        self.repo.insert_subtask(&subtask)?;
        Ok(subtask)
    }

    /// 更新子任务
    pub fn update_subtask(
        &self,
        id: &str,
        title: Option<String>,
        completed: Option<bool>,
    ) -> AppResult<bool> {
        Ok(self.repo.update_subtask(id, title.as_deref(), completed)?)
    }

    /// 删除子任务
    pub fn delete_subtask(&self, id: &str) -> AppResult<()> {
        let deleted = self.repo.delete_subtask(id)?;
        if !deleted {
            return Err(AppError::coded_with_params(
                EC::SUBTASK_NOT_FOUND,
                format!("Subtask {} not found", id),
                HashMap::from([("id".into(), id.into())]),
            ));
        }
        Ok(())
    }

    /// 切换子任务完成状态
    pub fn toggle_subtask(&self, id: &str) -> AppResult<bool> {
        let subtask = self
            .repo
            .get_subtask(id)?
            .ok_or_else(|| AppError::coded_with_params(
                EC::SUBTASK_NOT_FOUND,
                format!("Subtask {} not found", id),
                HashMap::from([("id".into(), id.into())]),
            ))?;

        let new_completed = !subtask.completed;
        self.repo
            .update_subtask(id, None, Some(new_completed))?;
        Ok(new_completed)
    }

    /// 重排子任务
    pub fn reorder_subtasks(&self, subtask_ids: Vec<String>) -> AppResult<()> {
        Ok(self.repo.reorder_subtasks(&subtask_ids)?)
    }
}

/// 构造 TODO_NOT_FOUND 错误（高频使用，提取为辅助函数）
fn todo_not_found(id: &str) -> AppError {
    AppError::coded_with_params(
        EC::TODO_NOT_FOUND,
        format!("Todo {} not found", id),
        HashMap::from([("id".into(), id.into())]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Database;

    fn setup() -> TodoService {
        let db = Arc::new(Database::new_in_memory().expect("创建内存数据库失败"));
        let repo = Arc::new(TodoRepository::new(db));
        TodoService::new(repo)
    }

    #[test]
    fn test_create_todo_basic() {
        let service = setup();
        let req = CreateTodoRequest {
            title: "测试任务".to_string(),
            ..Default::default()
        };
        let todo = service.create_todo(req).unwrap();
        assert_eq!(todo.title, "测试任务");
        assert_eq!(todo.status, TodoStatus::Todo);
        assert_eq!(todo.priority, TodoPriority::Medium);
        assert_eq!(todo.scope, TodoScope::Global);
    }

    #[test]
    fn test_create_todo_empty_title_fails() {
        let service = setup();
        let req = CreateTodoRequest {
            title: "  ".to_string(),
            ..Default::default()
        };
        let err = service.create_todo(req).unwrap_err();
        assert_eq!(err.code.as_deref(), Some(EC::TODO_TITLE_EMPTY));
    }

    #[test]
    fn test_create_todo_workspace_without_ref_fails() {
        let service = setup();
        let req = CreateTodoRequest {
            title: "任务".to_string(),
            scope: Some(TodoScope::Workspace),
            scope_ref: None,
            ..Default::default()
        };
        let err = service.create_todo(req).unwrap_err();
        assert_eq!(err.code.as_deref(), Some(EC::TODO_SCOPE_REF_REQUIRED));
    }

    #[test]
    fn test_update_todo() {
        let service = setup();
        let todo = service
            .create_todo(CreateTodoRequest {
                title: "原标题".to_string(),
                ..Default::default()
            })
            .unwrap();

        let updated = service
            .update_todo(
                &todo.id,
                UpdateTodoRequest {
                    title: Some("新标题".to_string()),
                    status: Some(TodoStatus::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.status, TodoStatus::InProgress);
    }

    #[test]
    fn test_delete_todo() {
        let service = setup();
        let todo = service
            .create_todo(CreateTodoRequest {
                title: "将删除".to_string(),
                ..Default::default()
            })
            .unwrap();

        service.delete_todo(&todo.id).unwrap();
        assert!(service.get_todo(&todo.id).unwrap().is_none());
    }

    #[test]
    fn test_query_todos() {
        let service = setup();
        for i in 0..5 {
            service
                .create_todo(CreateTodoRequest {
                    title: format!("任务 {}", i),
                    ..Default::default()
                })
                .unwrap();
        }

        let result = service.query_todos(TodoQuery::default()).unwrap();
        assert_eq!(result.total, 5);
    }

    #[test]
    fn test_subtask_lifecycle() {
        let service = setup();
        let todo = service
            .create_todo(CreateTodoRequest {
                title: "父任务".to_string(),
                ..Default::default()
            })
            .unwrap();

        // 添加
        let sub = service.add_subtask(&todo.id, "子任务1").unwrap();
        assert_eq!(sub.title, "子任务1");
        assert!(!sub.completed);

        // 切换
        let toggled = service.toggle_subtask(&sub.id).unwrap();
        assert!(toggled);

        // 再次切换
        let toggled = service.toggle_subtask(&sub.id).unwrap();
        assert!(!toggled);

        // 删除
        service.delete_subtask(&sub.id).unwrap();
    }

    #[test]
    fn test_add_subtask_to_nonexistent_todo_fails() {
        let service = setup();
        let err = service.add_subtask("nonexistent", "子任务").unwrap_err();
        assert_eq!(err.code.as_deref(), Some(EC::TODO_NOT_FOUND));
    }

    #[test]
    fn test_batch_update_status() {
        let service = setup();
        let t1 = service
            .create_todo(CreateTodoRequest {
                title: "A".to_string(),
                ..Default::default()
            })
            .unwrap();
        let t2 = service
            .create_todo(CreateTodoRequest {
                title: "B".to_string(),
                ..Default::default()
            })
            .unwrap();

        let count = service
            .batch_update_status(vec![t1.id.clone(), t2.id.clone()], TodoStatus::Done)
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_get_stats() {
        let service = setup();
        service
            .create_todo(CreateTodoRequest {
                title: "A".to_string(),
                priority: Some(TodoPriority::High),
                ..Default::default()
            })
            .unwrap();
        service
            .create_todo(CreateTodoRequest {
                title: "B".to_string(),
                priority: Some(TodoPriority::Low),
                ..Default::default()
            })
            .unwrap();

        let stats = service.get_stats(None, None).unwrap();
        assert_eq!(stats.total, 2);
    }

    #[test]
    fn test_sort_order_auto_increment() {
        let service = setup();
        let t1 = service
            .create_todo(CreateTodoRequest {
                title: "First".to_string(),
                ..Default::default()
            })
            .unwrap();
        let t2 = service
            .create_todo(CreateTodoRequest {
                title: "Second".to_string(),
                ..Default::default()
            })
            .unwrap();
        assert!(t2.sort_order > t1.sort_order);
    }
}
