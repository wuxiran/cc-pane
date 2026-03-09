use crate::models::todo::*;
use crate::repository::Database;
use rusqlite::params;
use std::sync::Arc;
use tracing::error;

/// Todo 数据访问层
pub struct TodoRepository {
    db: Arc<Database>,
}

impl TodoRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ============ TodoItem CRUD ============

    /// 插入新 Todo
    pub fn insert(&self, todo: &TodoItem) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let tags_json = serde_json::to_string(&todo.tags)
            .map_err(|e| format!("Failed to serialize tags: {}", e))?;

        conn.execute(
            "INSERT INTO todos (id, title, description, status, priority, scope, scope_ref, tags, due_date, my_day, my_day_date, reminder_at, recurrence, todo_type, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                todo.id,
                todo.title,
                todo.description.as_deref().unwrap_or(""),
                todo.status.as_str(),
                todo.priority.as_str(),
                todo.scope.as_str(),
                todo.scope_ref,
                tags_json,
                todo.due_date,
                todo.my_day as i32,
                todo.my_day_date,
                todo.reminder_at,
                todo.recurrence,
                todo.todo_type,
                todo.sort_order,
                todo.created_at,
                todo.updated_at,
            ],
        )
        .map_err(|e| {
            error!(table = "todos", id = %todo.id, err = %e, "SQL insert failed");
            e.to_string()
        })?;

        Ok(())
    }

    /// 获取单个 Todo（含 subtasks）
    pub fn get(&self, id: &str) -> Result<Option<TodoItem>, String> {
        // 查询 todo 主记录，连接在块结束时释放
        let todo_opt = {
            let conn = self.db.connection().map_err(|e| e.to_string())?;
            let result = conn.query_row(
                "SELECT id, title, description, status, priority, scope, scope_ref, tags, due_date, my_day, my_day_date, reminder_at, recurrence, todo_type, sort_order, created_at, updated_at
                 FROM todos WHERE id = ?1",
                params![id],
                |row| Ok(Self::row_to_todo(row)),
            );

            match result {
                Ok(todo_result) => Some(todo_result.map_err(|e| e.to_string())?),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(e.to_string()),
            }
        };

        // 连接已释放，安全地调用 list_subtasks
        match todo_opt {
            Some(mut todo) => {
                todo.subtasks = self.list_subtasks(&todo.id)?;
                Ok(Some(todo))
            }
            None => Ok(None),
        }
    }

    /// 更新 Todo（动态字段）
    pub fn update(&self, id: &str, req: &UpdateTodoRequest) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref title) = req.title {
            sets.push("title = ?");
            values.push(Box::new(title.clone()));
        }
        if let Some(ref description) = req.description {
            sets.push("description = ?");
            values.push(Box::new(description.clone()));
        }
        if let Some(ref status) = req.status {
            sets.push("status = ?");
            values.push(Box::new(status.as_str().to_string()));
        }
        if let Some(ref priority) = req.priority {
            sets.push("priority = ?");
            values.push(Box::new(priority.as_str().to_string()));
        }
        if let Some(ref scope) = req.scope {
            sets.push("scope = ?");
            values.push(Box::new(scope.as_str().to_string()));
        }
        if let Some(ref scope_ref) = req.scope_ref {
            sets.push("scope_ref = ?");
            values.push(Box::new(scope_ref.clone()));
        }
        if let Some(ref tags) = req.tags {
            sets.push("tags = ?");
            let tags_json = serde_json::to_string(tags)
                .map_err(|e| format!("Failed to serialize tags: {}", e))?;
            values.push(Box::new(tags_json));
        }
        if let Some(ref due_date) = req.due_date {
            sets.push("due_date = ?");
            values.push(Box::new(due_date.clone()));
        }
        if let Some(my_day) = req.my_day {
            sets.push("my_day = ?");
            values.push(Box::new(my_day as i32));
        }
        if let Some(ref my_day_date) = req.my_day_date {
            sets.push("my_day_date = ?");
            values.push(Box::new(my_day_date.clone()));
        }
        if let Some(ref reminder_at) = req.reminder_at {
            sets.push("reminder_at = ?");
            values.push(Box::new(reminder_at.clone()));
        }
        if let Some(ref recurrence) = req.recurrence {
            sets.push("recurrence = ?");
            values.push(Box::new(recurrence.clone()));
        }
        if let Some(ref todo_type) = req.todo_type {
            sets.push("todo_type = ?");
            values.push(Box::new(todo_type.clone()));
        }

        if sets.is_empty() {
            return Ok(false);
        }

        // 总是更新 updated_at
        sets.push("updated_at = ?");
        let now = chrono::Utc::now().to_rfc3339();
        values.push(Box::new(now));

        values.push(Box::new(id.to_string()));

        let sql = format!("UPDATE todos SET {} WHERE id = ?", sets.join(", "));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();

        let affected = conn
            .execute(&sql, params.as_slice())
            .map_err(|e| {
                error!(table = "todos", id = %id, err = %e, "SQL update failed");
                e.to_string()
            })?;

        Ok(affected > 0)
    }

    /// 删除 Todo（CASCADE 删除 subtasks）
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        // 手动删除 subtasks（兼容未启用外键约束的情况）
        conn.execute("DELETE FROM todo_subtasks WHERE todo_id = ?1", params![id])
            .map_err(|e| {
                error!(table = "todo_subtasks", todo_id = %id, err = %e, "SQL delete subtasks failed");
                e.to_string()
            })?;
        let affected = conn
            .execute("DELETE FROM todos WHERE id = ?1", params![id])
            .map_err(|e| {
                error!(table = "todos", id = %id, err = %e, "SQL delete failed");
                e.to_string()
            })?;
        Ok(affected > 0)
    }

    /// 查询 Todo 列表（动态 WHERE）
    pub fn query(&self, query: &TodoQuery) -> Result<TodoQueryResult, String> {
        // 查询主记录，连接在块结束时释放（避免与 list_subtasks 死锁）
        let (todos, total, has_more) = {
            let conn = self.db.connection().map_err(|e| e.to_string())?;

            let mut conditions = Vec::new();
            let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if let Some(ref status) = query.status {
                conditions.push("status = ?");
                values.push(Box::new(status.as_str().to_string()));
            }
            if let Some(ref priority) = query.priority {
                conditions.push("priority = ?");
                values.push(Box::new(priority.as_str().to_string()));
            }
            if let Some(ref scope) = query.scope {
                conditions.push("scope = ?");
                values.push(Box::new(scope.as_str().to_string()));
            }
            if let Some(ref scope_ref) = query.scope_ref {
                conditions.push("scope_ref = ?");
                values.push(Box::new(scope_ref.clone()));
            }
            if let Some(ref search) = query.search {
                conditions.push("(title LIKE ? OR description LIKE ?)");
                let pattern = format!("%{}%", search);
                values.push(Box::new(pattern.clone()));
                values.push(Box::new(pattern));
            }
            if let Some(ref tag) = query.tag {
                conditions.push("tags LIKE ?");
                values.push(Box::new(format!("%\"{}\"%" , tag)));
            }
            if let Some(ref todo_type) = query.todo_type {
                conditions.push("todo_type = ?");
                values.push(Box::new(todo_type.clone()));
            }
            if let Some(true) = query.my_day {
                conditions.push("my_day = 1 AND my_day_date = ?");
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                values.push(Box::new(today));
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conditions.join(" AND "))
            };

            // 排序
            let order = match query.sort_by.as_deref() {
                Some("created_at") => "created_at DESC",
                Some("updated_at") => "updated_at DESC",
                Some("priority") => "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END ASC, sort_order ASC",
                Some("due_date") => "due_date ASC NULLS LAST, sort_order ASC",
                _ => "sort_order ASC, created_at DESC",
            };

            // 获取总数
            let count_sql = format!("SELECT COUNT(*) FROM todos {}", where_clause);
            let count_params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
            let total: u32 = conn
                .query_row(&count_sql, count_params.as_slice(), |row| row.get(0))
                .map_err(|e| {
                    error!(table = "todos", err = %e, "SQL count query failed");
                    e.to_string()
                })?;

            // 分页
            let limit = query.limit.unwrap_or(50);
            let offset = query.offset.unwrap_or(0);

            let data_sql = format!(
                "SELECT id, title, description, status, priority, scope, scope_ref, tags, due_date, my_day, my_day_date, reminder_at, recurrence, todo_type, sort_order, created_at, updated_at
                 FROM todos {} ORDER BY {} LIMIT ? OFFSET ?",
                where_clause, order
            );

            values.push(Box::new(limit));
            values.push(Box::new(offset));
            let data_params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();

            let mut stmt = conn.prepare(&data_sql).map_err(|e| {
                error!(table = "todos", err = %e, "SQL prepare failed");
                e.to_string()
            })?;
            let todos: Vec<TodoItem> = stmt
                .query_map(data_params.as_slice(), |row| Ok(Self::row_to_todo(row)))
                .map_err(|e| {
                    error!(table = "todos", err = %e, "SQL query_map failed");
                    e.to_string()
                })?
                .filter_map(|r| r.ok())
                .filter_map(|r| r.ok())
                .collect();

            let has_more = (offset + limit) < total;
            (todos, total, has_more)
        };

        // 连接已释放，安全地为每个 todo 加载 subtasks
        let mut items = Vec::with_capacity(todos.len());
        for mut todo in todos {
            todo.subtasks = self.list_subtasks(&todo.id)?;
            items.push(todo);
        }

        Ok(TodoQueryResult {
            items,
            total,
            has_more,
        })
    }

    /// 重新排序 Todos
    pub fn reorder(&self, todo_ids: &[String]) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        for (i, id) in todo_ids.iter().enumerate() {
            conn.execute(
                "UPDATE todos SET sort_order = ?1 WHERE id = ?2",
                params![i as i32, id],
            )
            .map_err(|e| {
                error!(table = "todos", id = %id, err = %e, "SQL reorder failed");
                e.to_string()
            })?;
        }
        Ok(())
    }

    /// 批量更新状态
    pub fn batch_update_status(&self, ids: &[String], status: &TodoStatus) -> Result<u32, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut count: u32 = 0;
        for id in ids {
            let affected = conn
                .execute(
                    "UPDATE todos SET status = ?1, updated_at = ?2 WHERE id = ?3",
                    params![status.as_str(), now, id],
                )
                .map_err(|e| {
                    error!(table = "todos", id = %id, err = %e, "SQL batch_update_status failed");
                    e.to_string()
                })?;
            count += affected as u32;
        }
        Ok(count)
    }

    /// 获取统计信息
    pub fn stats(
        &self,
        scope: Option<&TodoScope>,
        scope_ref: Option<&str>,
    ) -> Result<TodoStats, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut conditions = Vec::new();
        let mut values: Vec<String> = Vec::new();

        if let Some(s) = scope {
            conditions.push("scope = ?");
            values.push(s.as_str().to_string());
        }
        if let Some(sr) = scope_ref {
            conditions.push("scope_ref = ?");
            values.push(sr.to_string());
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        // 总数
        let total_sql = format!("SELECT COUNT(*) FROM todos {}", where_clause);
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        let total: u32 = conn
            .query_row(&total_sql, params_ref.as_slice(), |row| row.get(0))
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL stats total query failed");
                e.to_string()
            })?;

        // 按状态统计
        let by_status_sql = format!(
            "SELECT status, COUNT(*) FROM todos {} GROUP BY status",
            where_clause
        );
        let mut by_status = std::collections::HashMap::new();
        let mut stmt = conn.prepare(&by_status_sql).map_err(|e| {
            error!(table = "todos", err = %e, "SQL stats by_status prepare failed");
            e.to_string()
        })?;
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL stats by_status query failed");
                e.to_string()
            })?;
        for row in rows.flatten() {
            by_status.insert(row.0, row.1);
        }

        // 按作用域统计
        let by_scope_sql = format!(
            "SELECT scope, COUNT(*) FROM todos {} GROUP BY scope",
            where_clause
        );
        let mut by_scope = std::collections::HashMap::new();
        let mut stmt = conn.prepare(&by_scope_sql).map_err(|e| {
            error!(table = "todos", err = %e, "SQL stats by_scope prepare failed");
            e.to_string()
        })?;
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL stats by_scope query failed");
                e.to_string()
            })?;
        for row in rows.flatten() {
            by_scope.insert(row.0, row.1);
        }

        // 按优先级统计
        let by_priority_sql = format!(
            "SELECT priority, COUNT(*) FROM todos {} GROUP BY priority",
            where_clause
        );
        let mut by_priority = std::collections::HashMap::new();
        let mut stmt = conn.prepare(&by_priority_sql).map_err(|e| {
            error!(table = "todos", err = %e, "SQL stats by_priority prepare failed");
            e.to_string()
        })?;
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL stats by_priority query failed");
                e.to_string()
            })?;
        for row in rows.flatten() {
            by_priority.insert(row.0, row.1);
        }

        // 过期数量
        let now = chrono::Utc::now().to_rfc3339();
        let overdue: u32 = if conditions.is_empty() {
            conn.query_row(
                "SELECT COUNT(*) FROM todos WHERE due_date IS NOT NULL AND due_date < ?1 AND status != 'done'",
                params![now],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL stats overdue query failed");
                e.to_string()
            })?
        } else {
            let mut overdue_conds = conditions.clone();
            overdue_conds.push("due_date IS NOT NULL");
            overdue_conds.push("due_date < ?");
            overdue_conds.push("status != 'done'");
            let overdue_where = format!("WHERE {}", overdue_conds.join(" AND "));
            let overdue_sql = format!("SELECT COUNT(*) FROM todos {}", overdue_where);
            let mut overdue_vals = values.clone();
            overdue_vals.push(now);
            let overdue_params: Vec<&dyn rusqlite::types::ToSql> = overdue_vals.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
            conn.query_row(&overdue_sql, overdue_params.as_slice(), |row| row.get(0))
                .map_err(|e| {
                    error!(table = "todos", err = %e, "SQL stats overdue filtered query failed");
                    e.to_string()
                })?
        };

        Ok(TodoStats {
            total,
            by_status,
            by_scope,
            by_priority,
            overdue,
        })
    }

    /// 获取最大 sort_order
    pub fn max_sort_order(&self) -> Result<i32, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let max: Option<i32> = conn
            .query_row(
                "SELECT MAX(sort_order) FROM todos",
                [],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL max_sort_order query failed");
                e.to_string()
            })?;
        Ok(max.unwrap_or(0))
    }

    /// 获取到期提醒的 Todo 列表（reminder_at <= now AND status != 'done'）
    pub fn get_due_reminders(&self, now: &str) -> Result<Vec<TodoItem>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, description, status, priority, scope, scope_ref, tags, due_date, my_day, my_day_date, reminder_at, recurrence, todo_type, sort_order, created_at, updated_at
                 FROM todos WHERE reminder_at IS NOT NULL AND reminder_at <= ?1 AND status != 'done'",
            )
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL get_due_reminders prepare failed");
                e.to_string()
            })?;

        let todos: Vec<TodoItem> = stmt
            .query_map(params![now], |row| Ok(Self::row_to_todo(row)))
            .map_err(|e| {
                error!(table = "todos", err = %e, "SQL get_due_reminders query failed");
                e.to_string()
            })?
            .filter_map(|r| r.ok())
            .filter_map(|r| r.ok())
            .collect();

        Ok(todos)
    }

    // ============ Subtask CRUD ============

    /// 插入子任务
    pub fn insert_subtask(&self, subtask: &TodoSubtask) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO todo_subtasks (id, todo_id, title, completed, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                subtask.id,
                subtask.todo_id,
                subtask.title,
                subtask.completed as i32,
                subtask.sort_order,
                subtask.created_at,
            ],
        )
        .map_err(|e| {
            error!(table = "todo_subtasks", id = %subtask.id, err = %e, "SQL insert_subtask failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 更新子任务
    pub fn update_subtask(
        &self,
        id: &str,
        title: Option<&str>,
        completed: Option<bool>,
    ) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(t) = title {
            sets.push("title = ?");
            values.push(Box::new(t.to_string()));
        }
        if let Some(c) = completed {
            sets.push("completed = ?");
            values.push(Box::new(c as i32));
        }

        if sets.is_empty() {
            return Ok(false);
        }

        values.push(Box::new(id.to_string()));
        let sql = format!("UPDATE todo_subtasks SET {} WHERE id = ?", sets.join(", "));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();

        let affected = conn
            .execute(&sql, params.as_slice())
            .map_err(|e| {
                error!(table = "todo_subtasks", id = %id, err = %e, "SQL update_subtask failed");
                e.to_string()
            })?;
        Ok(affected > 0)
    }

    /// 删除子任务
    pub fn delete_subtask(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute("DELETE FROM todo_subtasks WHERE id = ?1", params![id])
            .map_err(|e| {
                error!(table = "todo_subtasks", id = %id, err = %e, "SQL delete_subtask failed");
                e.to_string()
            })?;
        Ok(affected > 0)
    }

    /// 列出某 Todo 的所有子任务
    pub fn list_subtasks(&self, todo_id: &str) -> Result<Vec<TodoSubtask>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, todo_id, title, completed, sort_order, created_at
                 FROM todo_subtasks WHERE todo_id = ?1 ORDER BY sort_order ASC",
            )
            .map_err(|e| {
                error!(table = "todo_subtasks", todo_id = %todo_id, err = %e, "SQL list_subtasks prepare failed");
                e.to_string()
            })?;

        let subtasks = stmt
            .query_map(params![todo_id], |row| {
                Ok(TodoSubtask {
                    id: row.get(0)?,
                    todo_id: row.get(1)?,
                    title: row.get(2)?,
                    completed: row.get::<_, i32>(3)? != 0,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| {
                error!(table = "todo_subtasks", todo_id = %todo_id, err = %e, "SQL list_subtasks query failed");
                e.to_string()
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(subtasks)
    }

    /// 获取子任务的最大 sort_order
    pub fn max_subtask_sort_order(&self, todo_id: &str) -> Result<i32, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let max: Option<i32> = conn
            .query_row(
                "SELECT MAX(sort_order) FROM todo_subtasks WHERE todo_id = ?1",
                params![todo_id],
                |row| row.get(0),
            )
            .map_err(|e| {
                error!(table = "todo_subtasks", todo_id = %todo_id, err = %e, "SQL max_subtask_sort_order query failed");
                e.to_string()
            })?;
        Ok(max.unwrap_or(0))
    }

    /// 重排子任务
    pub fn reorder_subtasks(&self, subtask_ids: &[String]) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        for (i, id) in subtask_ids.iter().enumerate() {
            conn.execute(
                "UPDATE todo_subtasks SET sort_order = ?1 WHERE id = ?2",
                params![i as i32, id],
            )
            .map_err(|e| {
                error!(table = "todo_subtasks", id = %id, err = %e, "SQL reorder_subtasks failed");
                e.to_string()
            })?;
        }
        Ok(())
    }

    /// 获取子任务（含 completed 状态）
    pub fn get_subtask(&self, id: &str) -> Result<Option<TodoSubtask>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, todo_id, title, completed, sort_order, created_at FROM todo_subtasks WHERE id = ?1",
            params![id],
            |row| {
                Ok(TodoSubtask {
                    id: row.get(0)?,
                    todo_id: row.get(1)?,
                    title: row.get(2)?,
                    completed: row.get::<_, i32>(3)? != 0,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        );

        match result {
            Ok(subtask) => Ok(Some(subtask)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                error!(table = "todo_subtasks", id = %id, err = %e, "SQL get_subtask query failed");
                Err(e.to_string())
            }
        }
    }

    // ============ 内部辅助 ============

    fn row_to_todo(row: &rusqlite::Row) -> Result<TodoItem, String> {
        let status_str: String = row.get(3).map_err(|e| e.to_string())?;
        let priority_str: String = row.get(4).map_err(|e| e.to_string())?;
        let scope_str: String = row.get(5).map_err(|e| e.to_string())?;
        let tags_str: String = row.get(7).map_err(|e| e.to_string())?;

        let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();

        Ok(TodoItem {
            id: row.get(0).map_err(|e| e.to_string())?,
            title: row.get(1).map_err(|e| e.to_string())?,
            description: row.get::<_, Option<String>>(2).map_err(|e| e.to_string())?,
            status: status_str.parse::<TodoStatus>()?,
            priority: priority_str.parse::<TodoPriority>()?,
            scope: scope_str.parse::<TodoScope>()?,
            scope_ref: row.get(6).map_err(|e| e.to_string())?,
            tags,
            due_date: row.get(8).map_err(|e| e.to_string())?,
            my_day: row.get::<_, i32>(9).map_err(|e| e.to_string())? != 0,
            my_day_date: row.get(10).map_err(|e| e.to_string())?,
            reminder_at: row.get(11).map_err(|e| e.to_string())?,
            recurrence: row.get(12).map_err(|e| e.to_string())?,
            todo_type: row.get::<_, Option<String>>(13).map_err(|e| e.to_string())?.unwrap_or_default(),
            sort_order: row.get(14).map_err(|e| e.to_string())?,
            created_at: row.get(15).map_err(|e| e.to_string())?,
            updated_at: row.get(16).map_err(|e| e.to_string())?,
            subtasks: vec![], // 由调用者填充
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> TodoRepository {
        let db = Arc::new(Database::new_in_memory().expect("创建内存数据库失败"));
        TodoRepository::new(db)
    }

    fn make_todo(title: &str) -> TodoItem {
        TodoItem {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            description: Some("desc".to_string()),
            status: TodoStatus::Todo,
            priority: TodoPriority::Medium,
            scope: TodoScope::Global,
            scope_ref: None,
            tags: vec!["test".to_string()],
            due_date: None,
            my_day: false,
            my_day_date: None,
            reminder_at: None,
            recurrence: None,
            todo_type: String::new(),
            sort_order: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            subtasks: vec![],
        }
    }

    #[test]
    fn test_insert_and_get() {
        let repo = setup();
        let todo = make_todo("测试任务");
        repo.insert(&todo).unwrap();

        let found = repo.get(&todo.id).unwrap().unwrap();
        assert_eq!(found.title, "测试任务");
        assert_eq!(found.tags, vec!["test"]);
        assert_eq!(found.status, TodoStatus::Todo);
    }

    #[test]
    fn test_update() {
        let repo = setup();
        let todo = make_todo("原标题");
        repo.insert(&todo).unwrap();

        let req = UpdateTodoRequest {
            title: Some("新标题".to_string()),
            status: Some(TodoStatus::InProgress),
            ..Default::default()
        };
        let updated = repo.update(&todo.id, &req).unwrap();
        assert!(updated);

        let found = repo.get(&todo.id).unwrap().unwrap();
        assert_eq!(found.title, "新标题");
        assert_eq!(found.status, TodoStatus::InProgress);
    }

    #[test]
    fn test_delete() {
        let repo = setup();
        let todo = make_todo("将被删除");
        repo.insert(&todo).unwrap();

        let deleted = repo.delete(&todo.id).unwrap();
        assert!(deleted);

        let found = repo.get(&todo.id).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn test_query_basic() {
        let repo = setup();
        for i in 0..5 {
            let mut todo = make_todo(&format!("任务 {}", i));
            todo.sort_order = i;
            repo.insert(&todo).unwrap();
        }

        let result = repo.query(&TodoQuery::default()).unwrap();
        assert_eq!(result.total, 5);
        assert_eq!(result.items.len(), 5);
        assert!(!result.has_more);
    }

    #[test]
    fn test_query_with_filter() {
        let repo = setup();
        let mut t1 = make_todo("高优先级");
        t1.priority = TodoPriority::High;
        repo.insert(&t1).unwrap();

        let mut t2 = make_todo("低优先级");
        t2.priority = TodoPriority::Low;
        repo.insert(&t2).unwrap();

        let result = repo
            .query(&TodoQuery {
                priority: Some(TodoPriority::High),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].title, "高优先级");
    }

    #[test]
    fn test_query_with_search() {
        let repo = setup();
        let t1 = make_todo("修复登录 Bug");
        repo.insert(&t1).unwrap();
        let t2 = make_todo("添加新功能");
        repo.insert(&t2).unwrap();

        let result = repo
            .query(&TodoQuery {
                search: Some("登录".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].title, "修复登录 Bug");
    }

    #[test]
    fn test_query_pagination() {
        let repo = setup();
        for i in 0..10 {
            let mut todo = make_todo(&format!("任务 {}", i));
            todo.sort_order = i;
            repo.insert(&todo).unwrap();
        }

        let result = repo
            .query(&TodoQuery {
                limit: Some(3),
                offset: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.total, 10);
        assert_eq!(result.items.len(), 3);
        assert!(result.has_more);
    }

    #[test]
    fn test_reorder() {
        let repo = setup();
        let t1 = make_todo("A");
        let t2 = make_todo("B");
        let t3 = make_todo("C");
        repo.insert(&t1).unwrap();
        repo.insert(&t2).unwrap();
        repo.insert(&t3).unwrap();

        repo.reorder(&[t3.id.clone(), t1.id.clone(), t2.id.clone()])
            .unwrap();

        let result = repo.query(&TodoQuery::default()).unwrap();
        assert_eq!(result.items[0].title, "C");
        assert_eq!(result.items[1].title, "A");
        assert_eq!(result.items[2].title, "B");
    }

    #[test]
    fn test_batch_update_status() {
        let repo = setup();
        let t1 = make_todo("任务1");
        let t2 = make_todo("任务2");
        repo.insert(&t1).unwrap();
        repo.insert(&t2).unwrap();

        let count = repo
            .batch_update_status(&[t1.id.clone(), t2.id.clone()], &TodoStatus::Done)
            .unwrap();
        assert_eq!(count, 2);

        let found1 = repo.get(&t1.id).unwrap().unwrap();
        assert_eq!(found1.status, TodoStatus::Done);
    }

    #[test]
    fn test_subtask_crud() {
        let repo = setup();
        let todo = make_todo("父任务");
        repo.insert(&todo).unwrap();

        let subtask = TodoSubtask {
            id: uuid::Uuid::new_v4().to_string(),
            todo_id: todo.id.clone(),
            title: "子任务1".to_string(),
            completed: false,
            sort_order: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        repo.insert_subtask(&subtask).unwrap();

        let subtasks = repo.list_subtasks(&todo.id).unwrap();
        assert_eq!(subtasks.len(), 1);
        assert_eq!(subtasks[0].title, "子任务1");
        assert!(!subtasks[0].completed);

        // 更新
        repo.update_subtask(&subtask.id, None, Some(true)).unwrap();
        let subtasks = repo.list_subtasks(&todo.id).unwrap();
        assert!(subtasks[0].completed);

        // 删除
        repo.delete_subtask(&subtask.id).unwrap();
        let subtasks = repo.list_subtasks(&todo.id).unwrap();
        assert!(subtasks.is_empty());
    }

    #[test]
    fn test_get_with_subtasks() {
        let repo = setup();
        let todo = make_todo("有子任务的");
        repo.insert(&todo).unwrap();

        for i in 0..3 {
            let subtask = TodoSubtask {
                id: uuid::Uuid::new_v4().to_string(),
                todo_id: todo.id.clone(),
                title: format!("子任务 {}", i),
                completed: false,
                sort_order: i,
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            repo.insert_subtask(&subtask).unwrap();
        }

        let found = repo.get(&todo.id).unwrap().unwrap();
        assert_eq!(found.subtasks.len(), 3);
    }

    #[test]
    fn test_stats() {
        let repo = setup();
        let mut t1 = make_todo("A");
        t1.status = TodoStatus::Todo;
        t1.priority = TodoPriority::High;
        repo.insert(&t1).unwrap();

        let mut t2 = make_todo("B");
        t2.status = TodoStatus::Done;
        t2.priority = TodoPriority::Low;
        repo.insert(&t2).unwrap();

        let stats = repo.stats(None, None).unwrap();
        assert_eq!(stats.total, 2);
        assert_eq!(*stats.by_status.get("todo").unwrap_or(&0), 1);
        assert_eq!(*stats.by_status.get("done").unwrap_or(&0), 1);
    }

    #[test]
    fn test_delete_cascades_subtasks() {
        let repo = setup();
        let todo = make_todo("将被级联删除");
        repo.insert(&todo).unwrap();

        let subtask = TodoSubtask {
            id: uuid::Uuid::new_v4().to_string(),
            todo_id: todo.id.clone(),
            title: "子任务".to_string(),
            completed: false,
            sort_order: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        repo.insert_subtask(&subtask).unwrap();

        repo.delete(&todo.id).unwrap();
        let subtasks = repo.list_subtasks(&todo.id).unwrap();
        assert!(subtasks.is_empty());
    }

    #[test]
    fn test_max_sort_order() {
        let repo = setup();
        assert_eq!(repo.max_sort_order().unwrap(), 0);

        let mut t1 = make_todo("A");
        t1.sort_order = 5;
        repo.insert(&t1).unwrap();

        let mut t2 = make_todo("B");
        t2.sort_order = 10;
        repo.insert(&t2).unwrap();

        assert_eq!(repo.max_sort_order().unwrap(), 10);
    }
}
