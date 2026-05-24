use crate::models::task_binding::*;
use crate::repository::Database;
use rusqlite::{params, OptionalExtension};
use std::sync::Arc;
use tracing::{error, warn};

const SELECT_FIELDS: &str = "\
    id, title, role, parent_id, plan_path, normalized_plan_path, prompt, session_id, resume_id, \
    pane_id, tab_id, todo_id, project_path, workspace_name, cli_tool, status, progress, \
    completion_summary, exit_code, sort_order, metadata, created_at, updated_at";

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
        let metadata = Self::metadata_to_text(&binding.metadata)?;
        conn.execute(
            "INSERT INTO task_bindings (
                id, title, role, parent_id, plan_path, normalized_plan_path, prompt, session_id,
                resume_id, pane_id, tab_id, todo_id, project_path, workspace_name, cli_tool,
                status, progress, completion_summary, exit_code, sort_order, metadata,
                created_at, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            params![
                binding.id,
                binding.title,
                binding.role.as_str(),
                binding.parent_id,
                binding.plan_path,
                binding.normalized_plan_path,
                binding.prompt,
                binding.session_id,
                binding.resume_id,
                binding.pane_id,
                binding.tab_id,
                binding.todo_id,
                binding.project_path,
                binding.workspace_name,
                binding.cli_tool,
                binding.status.as_str(),
                binding.progress,
                binding.completion_summary,
                binding.exit_code,
                binding.sort_order,
                metadata,
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
        let sql = format!("SELECT {SELECT_FIELDS} FROM task_bindings WHERE id = ?1");
        conn.query_row(&sql, params![id], Self::row_to_binding)
            .optional()
            .map_err(|e| e.to_string())
    }

    /// 根据 session_id 查找 TaskBinding
    pub fn find_by_session_id(&self, session_id: &str) -> Result<Option<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {SELECT_FIELDS}
             FROM task_bindings
             WHERE session_id = ?1
             ORDER BY updated_at DESC
             LIMIT 1"
        );
        conn.query_row(&sql, params![session_id], Self::row_to_binding)
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn find_leader_by_plan(
        &self,
        normalized_plan_path: &str,
        project_path: Option<&str>,
    ) -> Result<Option<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let sql = if project_path.is_some() {
            format!(
                "SELECT {SELECT_FIELDS}
                 FROM task_bindings
                 WHERE role = 'leader' AND normalized_plan_path = ?1 AND project_path = ?2
                 ORDER BY updated_at DESC
                 LIMIT 1"
            )
        } else {
            format!(
                "SELECT {SELECT_FIELDS}
                 FROM task_bindings
                 WHERE role = 'leader' AND normalized_plan_path = ?1
                 ORDER BY updated_at DESC
                 LIMIT 1"
            )
        };

        if let Some(project_path) = project_path {
            conn.query_row(
                &sql,
                params![normalized_plan_path, project_path],
                Self::row_to_binding,
            )
            .optional()
            .map_err(|e| e.to_string())
        } else {
            conn.query_row(&sql, params![normalized_plan_path], Self::row_to_binding)
                .optional()
                .map_err(|e| e.to_string())
        }
    }

    pub fn find_workers_of(&self, parent_id: &str) -> Result<Vec<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        let sql = format!(
            "SELECT {SELECT_FIELDS}
             FROM task_bindings
             WHERE role IN ('worker', 'child') AND parent_id = ?1
             ORDER BY sort_order ASC, created_at ASC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![parent_id], Self::row_to_binding)
            .map_err(|e| e.to_string())?;

        Ok(rows
            .filter_map(|row| {
                row.map_err(|e| warn!("task_bindings worker row parse error: {}", e))
                    .ok()
            })
            .collect())
    }

    pub fn find_worker_for_registration(
        &self,
        parent_id: &str,
        session_id: &str,
        resume_id: Option<&str>,
    ) -> Result<Option<TaskBinding>, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;
        if let Some(resume_id) = resume_id.filter(|value| !value.trim().is_empty()) {
            let sql = format!(
                "SELECT {SELECT_FIELDS}
                 FROM task_bindings
                 WHERE role IN ('worker', 'child') AND parent_id = ?1 AND resume_id = ?2
                 ORDER BY updated_at DESC
                 LIMIT 1"
            );
            let found = conn
                .query_row(&sql, params![parent_id, resume_id], Self::row_to_binding)
                .optional()
                .map_err(|e| e.to_string())?;
            if found.is_some() {
                return Ok(found);
            }
        }

        let sql = format!(
            "SELECT {SELECT_FIELDS}
             FROM task_bindings
             WHERE role IN ('worker', 'child') AND parent_id = ?1 AND session_id = ?2
             ORDER BY updated_at DESC
             LIMIT 1"
        );
        conn.query_row(&sql, params![parent_id, session_id], Self::row_to_binding)
            .optional()
            .map_err(|e| e.to_string())
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
        add_field!("parent_id", req.parent_id);
        add_field!("plan_path", req.plan_path);
        add_field!("normalized_plan_path", req.normalized_plan_path);
        add_field!("prompt", req.prompt);
        add_field!("session_id", req.session_id);
        add_field!("resume_id", req.resume_id);
        add_field!("pane_id", req.pane_id);
        add_field!("tab_id", req.tab_id);
        add_field!("progress", req.progress);
        add_field!("completion_summary", req.completion_summary);
        add_field!("exit_code", req.exit_code);
        add_field!("sort_order", req.sort_order);

        if let Some(ref role) = req.role {
            sets.push(format!("role = ?{}", idx));
            values.push(Box::new(role.as_str().to_string()));
            idx += 1;
        }

        if let Some(ref status) = req.status {
            sets.push(format!("status = ?{}", idx));
            values.push(Box::new(status.as_str().to_string()));
            idx += 1;
        }

        if req.metadata.is_some() {
            let metadata = Self::metadata_to_text(&req.metadata)?;
            sets.push(format!("metadata = ?{}", idx));
            values.push(Box::new(metadata));
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

    /// 单事务删除指定 TaskBinding 及所有后代，返回已删除 id 列表。
    pub fn delete_cascade(&self, id: &str) -> Result<Vec<String>, String> {
        // fix(H3) review: 递归级联删除必须在后端事务内完成，避免前端多请求半删除。
        let mut conn = self.db.connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let ids = {
            let mut stmt = tx
                .prepare(
                    "WITH RECURSIVE descendants(id) AS (
                        SELECT id FROM task_bindings WHERE id = ?1
                        UNION ALL
                        SELECT child.id
                        FROM task_bindings child
                        INNER JOIN descendants parent ON child.parent_id = parent.id
                     )
                     SELECT id FROM descendants",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };

        if ids.is_empty() {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(Vec::new());
        }

        let affected = tx
            .execute(
                "WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM task_bindings WHERE id = ?1
                    UNION ALL
                    SELECT child.id
                    FROM task_bindings child
                    INNER JOIN descendants parent ON child.parent_id = parent.id
                 )
                 DELETE FROM task_bindings WHERE id IN (SELECT id FROM descendants)",
                params![id],
            )
            .map_err(|e| {
                error!(table = "task_bindings", id = %id, err = %e, "SQL cascade delete failed");
                e.to_string()
            })?;
        if affected != ids.len() {
            warn!(
                id = %id,
                expected = ids.len(),
                affected,
                "task_bindings cascade delete count mismatch"
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ids)
    }

    /// 查询 TaskBindings
    pub fn query(&self, query: &TaskBindingQuery) -> Result<TaskBindingQueryResult, String> {
        let conn = self.db.connection().map_err(|e| e.to_string())?;

        let mut conditions: Vec<String> = Vec::new();
        let mut count_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        macro_rules! add_condition {
            ($field:expr, $val:expr) => {
                if let Some(ref v) = $val {
                    conditions.push(format!("{} = ?{}", $field, idx));
                    count_params.push(Box::new(v.clone()));
                    idx += 1;
                }
            };
        }

        if let Some(ref status) = query.status {
            conditions.push(format!("status = ?{}", idx));
            count_params.push(Box::new(status.as_str().to_string()));
            idx += 1;
        }
        if let Some(ref role) = query.role {
            if role == &TaskBindingRole::Worker {
                conditions.push("role IN ('worker', 'child')".to_string());
            } else {
                conditions.push(format!("role = ?{}", idx));
                count_params.push(Box::new(role.as_str().to_string()));
                idx += 1;
            }
        }
        add_condition!("parent_id", query.parent_id);
        add_condition!("plan_path", query.plan_path);
        add_condition!("normalized_plan_path", query.normalized_plan_path);
        add_condition!("resume_id", query.resume_id);
        add_condition!("pane_id", query.pane_id);
        add_condition!("session_id", query.session_id);
        add_condition!("project_path", query.project_path);
        add_condition!("workspace_name", query.workspace_name);
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
            "SELECT {SELECT_FIELDS}
             FROM task_bindings{} ORDER BY sort_order ASC, created_at DESC LIMIT ?{} OFFSET ?{}",
            where_clause,
            idx,
            idx + 1
        );

        let mut data_params = count_params;
        data_params.push(Box::new(limit));
        data_params.push(Box::new(offset));

        let data_refs: Vec<&dyn rusqlite::types::ToSql> =
            data_params.iter().map(|v| v.as_ref()).collect();

        let mut stmt = conn.prepare(&data_sql).map_err(|e| e.to_string())?;
        let items = stmt
            .query_map(data_refs.as_slice(), Self::row_to_binding)
            .map_err(|e| e.to_string())?
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

    fn row_to_binding(row: &rusqlite::Row) -> rusqlite::Result<TaskBinding> {
        let role_str: String = row.get(2)?;
        let role: TaskBindingRole = role_str.parse().unwrap_or(TaskBindingRole::Task);
        let status_str: String = row.get(15)?;
        let status: TaskBindingStatus = status_str.parse().unwrap_or(TaskBindingStatus::Pending);
        let metadata_text: Option<String> = row.get(20)?;

        Ok(TaskBinding {
            id: row.get(0)?,
            title: row.get(1)?,
            role,
            parent_id: row.get(3)?,
            plan_path: row.get(4)?,
            normalized_plan_path: row.get(5)?,
            prompt: row.get(6)?,
            session_id: row.get(7)?,
            resume_id: row.get(8)?,
            pane_id: row.get(9)?,
            tab_id: row.get(10)?,
            todo_id: row.get(11)?,
            project_path: row.get(12)?,
            workspace_name: row.get(13)?,
            cli_tool: row.get(14)?,
            status,
            progress: row.get(16)?,
            completion_summary: row.get(17)?,
            exit_code: row.get(18)?,
            sort_order: row.get(19)?,
            metadata: Self::metadata_from_text(metadata_text),
            created_at: row.get(21)?,
            updated_at: row.get(22)?,
        })
    }

    fn metadata_to_text(value: &Option<serde_json::Value>) -> Result<Option<String>, String> {
        value
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| format!("Failed to serialize TaskBinding metadata: {}", e))
    }

    fn metadata_from_text(value: Option<String>) -> Option<serde_json::Value> {
        let value = value?;
        match serde_json::from_str(&value) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                warn!(err = %error, "Failed to parse task_bindings.metadata JSON");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Database;

    fn repo() -> TaskBindingRepository {
        TaskBindingRepository::new(Arc::new(
            Database::new_in_memory().expect("should create in-memory db"),
        ))
    }

    fn binding(id: &str, role: TaskBindingRole) -> TaskBinding {
        TaskBinding {
            id: id.to_string(),
            title: format!("binding-{id}"),
            role,
            parent_id: None,
            plan_path: Some("D:/repo/.claude/plans/plan.md".into()),
            normalized_plan_path: Some("d:/repo/.claude/plans/plan.md".into()),
            prompt: Some("prompt".into()),
            session_id: Some(format!("pty-{id}")),
            resume_id: Some(format!("resume-{id}")),
            pane_id: Some(format!("pane-{id}")),
            tab_id: Some(format!("tab-{id}")),
            todo_id: None,
            project_path: "D:/repo".into(),
            workspace_name: Some("workspace".into()),
            cli_tool: "claude".into(),
            status: TaskBindingStatus::Pending,
            progress: 0,
            completion_summary: None,
            exit_code: None,
            sort_order: 0,
            metadata: Some(serde_json::json!({ "planHash": "hash" })),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn test_round_trip_with_plan_fields() {
        let repo = repo();
        let binding = binding("leader", TaskBindingRole::Leader);

        repo.insert(&binding).expect("insert");
        let loaded = repo
            .get("leader")
            .expect("get")
            .expect("binding should exist");

        assert_eq!(loaded.role, TaskBindingRole::Leader);
        assert_eq!(
            loaded.normalized_plan_path.as_deref(),
            Some("d:/repo/.claude/plans/plan.md")
        );
        assert_eq!(loaded.resume_id.as_deref(), Some("resume-leader"));
        assert_eq!(
            loaded.metadata.as_ref().and_then(|v| v.get("planHash")),
            Some(&serde_json::json!("hash"))
        );
    }

    #[test]
    fn test_find_leader_by_plan_ignores_workers() {
        let repo = repo();
        let leader = binding("leader", TaskBindingRole::Leader);
        let mut worker = binding("worker", TaskBindingRole::Worker);
        worker.parent_id = Some("leader".into());

        repo.insert(&worker).expect("insert worker");
        repo.insert(&leader).expect("insert leader");

        let found = repo
            .find_leader_by_plan("d:/repo/.claude/plans/plan.md", Some("D:/repo"))
            .expect("find")
            .expect("leader should exist");
        assert_eq!(found.id, "leader");
    }

    #[test]
    fn test_find_workers_of_parent() {
        let repo = repo();
        let leader = binding("leader", TaskBindingRole::Leader);
        let mut worker = binding("worker", TaskBindingRole::Worker);
        worker.parent_id = Some("leader".into());

        repo.insert(&leader).expect("insert leader");
        repo.insert(&worker).expect("insert worker");

        let workers = repo.find_workers_of("leader").expect("workers");
        assert_eq!(workers.len(), 1);
        assert_eq!(workers[0].id, "worker");
    }
}
