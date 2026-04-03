use crate::models::task_binding::*;
use crate::repository::Database;
use rusqlite::params;
use std::sync::Arc;
use tracing::{error, warn};

/// TaskBinding 数据访问层
pub struct TaskBindingRepository {
    db: Arc<Database>,
}

impl TaskBindingRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// 插入新 TaskBinding
    pub fn insert(&self, binding: &TaskBinding) -> Result<(), String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO task_bindings (id, title, prompt, session_id, todo_id, project_path, workspace_name, cli_tool, status, progress, completion_summary, exit_code, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                binding.id,
                binding.title,
                binding.prompt,
                binding.session_id,
                binding.todo_id,
                binding.project_path,
                binding.workspace_name,
                binding.cli_tool,
                binding.status.as_str(),
                binding.progress,
                binding.completion_summary,
                binding.exit_code,
                binding.sort_order,
                binding.created_at,
                binding.updated_at,
            ],
        )
        .map_err(|e| {
            error!(table = "task_bindings", id = %binding.id, err = %e, "SQL insert failed");
            e.to_string()
        })?;
        Ok(())
    }

    /// 获取单个 TaskBinding
    pub fn get(&self, id: &str) -> Result<Option<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, title, prompt, session_id, todo_id, project_path, workspace_name, cli_tool, status, progress, completion_summary, exit_code, sort_order, created_at, updated_at
             FROM task_bindings WHERE id = ?1",
            params![id],
            |row| Ok(Self::row_to_binding(row)),
        );

        match result {
            Ok(binding_result) => Ok(Some(binding_result.map_err(|e| e.to_string())?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 根据 session_id 查找 TaskBinding
    pub fn find_by_session_id(&self, session_id: &str) -> Result<Option<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, title, prompt, session_id, todo_id, project_path, workspace_name, cli_tool, status, progress, completion_summary, exit_code, sort_order, created_at, updated_at
             FROM task_bindings WHERE session_id = ?1",
            params![session_id],
            |row| Ok(Self::row_to_binding(row)),
        );

        match result {
            Ok(binding_result) => Ok(Some(binding_result.map_err(|e| e.to_string())?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// 更新 TaskBinding
    pub fn update(&self, id: &str, req: &UpdateTaskBindingRequest) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        macro_rules! add_field {
            ($field:expr, $val:expr) => {
                if let Some(ref v) = $val {
                    sets.push(format!("{} = ?{}", $field, idx));
                    values.push(Box::new(v.clone()));
                    idx += 1;
                }
            };
        }

        add_field!("title", req.title);
        add_field!("prompt", req.prompt);
        add_field!("session_id", req.session_id);
        add_field!("progress", req.progress);
        add_field!("completion_summary", req.completion_summary);
        add_field!("exit_code", req.exit_code);
        add_field!("sort_order", req.sort_order);

        if let Some(ref status) = req.status {
            sets.push(format!("status = ?{}", idx));
            values.push(Box::new(status.as_str().to_string()));
            idx += 1;
        }

        if sets.is_empty() {
            return Ok(false);
        }

        // 始终更新 updated_at
        let now = chrono::Utc::now().to_rfc3339();
        sets.push(format!("updated_at = ?{}", idx));
        values.push(Box::new(now));
        idx += 1;

        let sql = format!(
            "UPDATE task_bindings SET {} WHERE id = ?{}",
            sets.join(", "),
            idx
        );
        values.push(Box::new(id.to_string()));

        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let affected = conn.execute(&sql, params.as_slice()).map_err(|e| {
            error!(table = "task_bindings", id = %id, err = %e, "SQL update failed");
            e.to_string()
        })?;

        Ok(affected > 0)
    }

    /// 删除 TaskBinding
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let affected = conn
            .execute("DELETE FROM task_bindings WHERE id = ?1", params![id])
            .map_err(|e| {
                error!(table = "task_bindings", id = %id, err = %e, "SQL delete failed");
                e.to_string()
            })?;
        Ok(affected > 0)
    }

    /// 查询 TaskBindings
    pub fn query(&self, query: &TaskBindingQuery) -> Result<TaskBindingQueryResult, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut conditions: Vec<String> = Vec::new();
        let mut count_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref status) = query.status {
            conditions.push(format!("status = ?{}", idx));
            count_params.push(Box::new(status.as_str().to_string()));
            idx += 1;
        }
        if let Some(ref project_path) = query.project_path {
            conditions.push(format!("project_path = ?{}", idx));
            count_params.push(Box::new(project_path.clone()));
            idx += 1;
        }
        if let Some(ref workspace_name) = query.workspace_name {
            conditions.push(format!("workspace_name = ?{}", idx));
            count_params.push(Box::new(workspace_name.clone()));
            idx += 1;
        }
        if let Some(ref search) = query.search {
            conditions.push(format!("(title LIKE ?{} OR prompt LIKE ?{})", idx, idx));
            count_params.push(Box::new(format!("%{}%", search)));
            idx += 1;
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };

        // Count
        let count_sql = format!("SELECT COUNT(*) FROM task_bindings{}", where_clause);
        let count_refs: Vec<&dyn rusqlite::types::ToSql> =
            count_params.iter().map(|v| v.as_ref()).collect();
        let total: u32 = conn
            .query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))
            .map_err(|e| e.to_string())?;

        // Query
        let limit = query.limit.unwrap_or(50).min(200);
        let offset = query.offset.unwrap_or(0);

        let data_sql = format!(
            "SELECT id, title, prompt, session_id, todo_id, project_path, workspace_name, cli_tool, status, progress, completion_summary, exit_code, sort_order, created_at, updated_at
             FROM task_bindings{} ORDER BY sort_order ASC, created_at DESC LIMIT ?{} OFFSET ?{}",
            where_clause, idx, idx + 1
        );

        let mut data_params = count_params;
        data_params.push(Box::new(limit));
        data_params.push(Box::new(offset));

        let data_refs: Vec<&dyn rusqlite::types::ToSql> =
            data_params.iter().map(|v| v.as_ref()).collect();

        let mut stmt = conn.prepare(&data_sql).map_err(|e| e.to_string())?;
        let items = stmt
            .query_map(data_refs.as_slice(), |row| Ok(Self::row_to_binding(row)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| {
                r.map_err(|e| warn!("task_bindings query_map error: {}", e))
                    .ok()
            })
            .filter_map(|r| {
                r.map_err(|e| warn!("task_bindings row parse error: {}", e))
                    .ok()
            })
            .collect::<Vec<_>>();

        Ok(TaskBindingQueryResult {
            has_more: (offset + limit) < total,
            items,
            total,
        })
    }

    fn row_to_binding(row: &rusqlite::Row) -> Result<TaskBinding, String> {
        let status_str: String = row.get(8).map_err(|e| e.to_string())?;
        let status: TaskBindingStatus = status_str.parse().unwrap_or(TaskBindingStatus::Pending);

        Ok(TaskBinding {
            id: row.get(0).map_err(|e| e.to_string())?,
            title: row.get(1).map_err(|e| e.to_string())?,
            prompt: row.get(2).map_err(|e| e.to_string())?,
            session_id: row.get(3).map_err(|e| e.to_string())?,
            todo_id: row.get(4).map_err(|e| e.to_string())?,
            project_path: row.get(5).map_err(|e| e.to_string())?,
            workspace_name: row.get(6).map_err(|e| e.to_string())?,
            cli_tool: row.get(7).map_err(|e| e.to_string())?,
            status,
            progress: row.get(9).map_err(|e| e.to_string())?,
            completion_summary: row.get(10).map_err(|e| e.to_string())?,
            exit_code: row.get(11).map_err(|e| e.to_string())?,
            sort_order: row.get(12).map_err(|e| e.to_string())?,
            created_at: row.get(13).map_err(|e| e.to_string())?,
            updated_at: row.get(14).map_err(|e| e.to_string())?,
        })
    }
}
