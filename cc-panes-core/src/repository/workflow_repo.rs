//! Persistence for staged workflows (docs/114 §3).
//!
//! Approval columns are written only by [`WorkflowRepository::approve`] and task
//! claims only by [`WorkflowRepository::claim_task`] (compare-and-set), so a
//! concurrent progress save can never erase an approval or double-claim a task.

use super::Database;
use crate::models::workflow::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::sync::Arc;

pub struct WorkflowRepository {
    db: Arc<Database>,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn parse<T: std::str::FromStr<Err = String>>(text: String) -> rusqlite::Result<T> {
    text.parse::<T>().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl WorkflowRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Insert a new workflow with all stages and tasks in one transaction.
    pub fn insert(&self, workflow: &Workflow) -> Result<(), String> {
        let conn = self.db.connection().map_err(err)?;
        let tx = conn.unchecked_transaction().map_err(err)?;
        let pools = serde_json::to_string(&workflow.pools).map_err(err)?;
        tx.execute(
            "INSERT INTO workflows (id, pools_json, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workflow.id,
                pools,
                workflow.status.as_str(),
                workflow.created_at,
                workflow.updated_at
            ],
        )
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(code, _)
                if code.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("workflow '{}' already exists", workflow.id)
            }
            other => other.to_string(),
        })?;
        for stage in &workflow.stages {
            tx.execute(
                "INSERT INTO workflow_stages (workflow_id, stage_index, stage_key, title,
                    requires_approval, status, approved_at, approved_via, error, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    workflow.id,
                    stage.index,
                    stage.key,
                    stage.title,
                    stage.requires_approval,
                    stage.status.as_str(),
                    stage.approved_at,
                    stage.approved_via,
                    stage.error,
                    workflow.updated_at
                ],
            )
            .map_err(err)?;
            for task in &stage.tasks {
                insert_task(&tx, &workflow.id, stage.index, task, &workflow.updated_at)?;
            }
        }
        tx.commit().map_err(err)
    }

    pub fn get(&self, id: &str) -> Result<Option<Workflow>, String> {
        let conn = self.db.connection().map_err(err)?;
        load(&conn, id)
    }

    /// Workflows ordered by most recent update. `active_only` keeps non-terminal ones.
    pub fn list(&self, active_only: bool, limit: u32) -> Result<Vec<Workflow>, String> {
        let conn = self.db.connection().map_err(err)?;
        let sql = if active_only {
            "SELECT id FROM workflows WHERE status IN ('running', 'waiting_approval')
             ORDER BY updated_at DESC LIMIT ?1"
        } else {
            "SELECT id FROM workflows ORDER BY updated_at DESC LIMIT ?1"
        };
        let ids: Vec<String> = conn
            .prepare(sql)
            .map_err(err)?
            .query_map(params![limit], |row| row.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let mut workflows = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(workflow) = load(&conn, &id)? {
                workflows.push(workflow);
            }
        }
        Ok(workflows)
    }

    /// Persist reducer output: statuses, errors, results and binding ids.
    /// Never touches approval columns.
    pub fn save_progress(&self, workflow: &Workflow) -> Result<(), String> {
        let conn = self.db.connection().map_err(err)?;
        let tx = conn.unchecked_transaction().map_err(err)?;
        let at = now();
        tx.execute(
            "UPDATE workflows SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![workflow.id, workflow.status.as_str(), at],
        )
        .map_err(err)?;
        for stage in &workflow.stages {
            tx.execute(
                "UPDATE workflow_stages SET status = ?3, error = ?4, updated_at = ?5
                 WHERE workflow_id = ?1 AND stage_index = ?2",
                params![
                    workflow.id,
                    stage.index,
                    stage.status.as_str(),
                    stage.error,
                    at
                ],
            )
            .map_err(err)?;
            for task in &stage.tasks {
                let result = task
                    .result
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(err)?;
                tx.execute(
                    "UPDATE workflow_tasks SET status = ?4, binding_id = ?5, result_json = ?6,
                        error = ?7, updated_at = ?8
                     WHERE workflow_id = ?1 AND stage_index = ?2 AND task_key = ?3",
                    params![
                        workflow.id,
                        stage.index,
                        task.key,
                        task.status.as_str(),
                        task.binding_id,
                        result,
                        task.error,
                        at
                    ],
                )
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    /// Record an approval once; only a stage waiting for approval accepts it.
    pub fn approve(
        &self,
        id: &str,
        stage_index: u32,
        approved_at: &str,
        via: &str,
    ) -> Result<bool, String> {
        let conn = self.db.connection().map_err(err)?;
        let changed = conn
            .execute(
                "UPDATE workflow_stages SET approved_at = ?3, approved_via = ?4, updated_at = ?3
                 WHERE workflow_id = ?1 AND stage_index = ?2 AND approved_at IS NULL
                   AND status = 'waiting_approval'",
                params![id, stage_index, approved_at, via],
            )
            .map_err(err)?;
        Ok(changed == 1)
    }

    /// Outbox claim: pending → claimed. Only one caller can win.
    pub fn claim_task(&self, id: &str, stage_index: u32, key: &str) -> Result<bool, String> {
        let conn = self.db.connection().map_err(err)?;
        let changed = conn
            .execute(
                "UPDATE workflow_tasks SET status = 'claimed', updated_at = ?4
                 WHERE workflow_id = ?1 AND stage_index = ?2 AND task_key = ?3
                   AND status = 'pending'",
                params![id, stage_index, key, now()],
            )
            .map_err(err)?;
        Ok(changed == 1)
    }

    /// Settle a claimed task: running with its receipt binding, back to pending, or failed.
    pub fn settle_claim(
        &self,
        id: &str,
        stage_index: u32,
        key: &str,
        status: WorkflowTaskStatus,
        binding_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<bool, String> {
        let conn = self.db.connection().map_err(err)?;
        let changed = conn
            .execute(
                "UPDATE workflow_tasks SET status = ?4, binding_id = ?5, error = ?6, updated_at = ?7
                 WHERE workflow_id = ?1 AND stage_index = ?2 AND task_key = ?3
                   AND status = 'claimed'",
                params![id, stage_index, key, status.as_str(), binding_id, error, now()],
            )
            .map_err(err)?;
        Ok(changed == 1)
    }
}

fn insert_task(
    conn: &Connection,
    workflow_id: &str,
    stage_index: u32,
    task: &WorkflowTask,
    at: &str,
) -> Result<(), String> {
    let spec = serde_json::to_string(&task.spec).map_err(err)?;
    conn.execute(
        "INSERT INTO workflow_tasks (workflow_id, stage_index, task_key, spec_json, pool, status,
            binding_id, result_json, error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)",
        params![
            workflow_id,
            stage_index,
            task.key,
            spec,
            task.pool,
            task.status.as_str(),
            task.binding_id,
            task.error,
            at
        ],
    )
    .map_err(err)?;
    Ok(())
}

fn load(conn: &Connection, id: &str) -> Result<Option<Workflow>, String> {
    let head = conn
        .query_row(
            "SELECT pools_json, status, created_at, updated_at FROM workflows WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    parse::<WorkflowStatus>(row.get(1)?)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(err)?;
    let Some((pools_json, status, created_at, updated_at)) = head else {
        return Ok(None);
    };
    let pools: BTreeMap<String, u32> = serde_json::from_str(&pools_json).unwrap_or_default();
    let mut stages = load_stages(conn, id)?;
    for stage in &mut stages {
        stage.tasks = load_tasks(conn, id, stage.index)?;
    }
    Ok(Some(Workflow {
        id: id.to_string(),
        status,
        pools,
        stages,
        created_at,
        updated_at,
    }))
}

fn load_stages(conn: &Connection, id: &str) -> Result<Vec<WorkflowStage>, String> {
    conn.prepare(
        "SELECT stage_index, stage_key, title, requires_approval, status, approved_at,
            approved_via, error
         FROM workflow_stages WHERE workflow_id = ?1 ORDER BY stage_index",
    )
    .map_err(err)?
    .query_map(params![id], |row| {
        Ok(WorkflowStage {
            index: row.get(0)?,
            key: row.get(1)?,
            title: row.get(2)?,
            requires_approval: row.get(3)?,
            status: parse(row.get(4)?)?,
            approved_at: row.get(5)?,
            approved_via: row.get(6)?,
            error: row.get(7)?,
            tasks: Vec::new(),
        })
    })
    .map_err(err)?
    .collect::<Result<_, _>>()
    .map_err(err)
}

fn load_tasks(conn: &Connection, id: &str, stage_index: u32) -> Result<Vec<WorkflowTask>, String> {
    // rowid keeps declaration order (tasks are inserted in order, never re-inserted).
    conn.prepare(
        "SELECT task_key, spec_json, pool, status, binding_id, result_json, error
         FROM workflow_tasks WHERE workflow_id = ?1 AND stage_index = ?2 ORDER BY rowid",
    )
    .map_err(err)?
    .query_map(params![id, stage_index], |row| {
        let spec_json: String = row.get(1)?;
        let result_json: Option<String> = row.get(5)?;
        Ok(WorkflowTask {
            key: row.get(0)?,
            spec: serde_json::from_str(&spec_json).unwrap_or_default(),
            pool: row.get(2)?,
            status: parse(row.get(3)?)?,
            binding_id: row.get(4)?,
            result: result_json.and_then(|text| serde_json::from_str(&text).ok()),
            error: row.get(6)?,
        })
    })
    .map_err(err)?
    .collect::<Result<_, _>>()
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::workflow_engine::initial_workflow;

    fn repo() -> WorkflowRepository {
        WorkflowRepository::new(Arc::new(Database::new_in_memory().unwrap()))
    }

    fn sample() -> Workflow {
        let request: CreateWorkflowRequest = serde_json::from_value(serde_json::json!({
            "workflowId": "wf",
            "pools": {"codex": 2},
            "stages": [
                {"key": "plan", "tasks": [{"key": "a", "prompt": "p", "resultSchema": {"type": "object"}}]},
                {"key": "impl", "requiresApproval": true,
                 "tasks": [{"key": "z", "prompt": "z"}, {"key": "b", "prompt": "b", "cliTool": "codex"}]}
            ]
        }))
        .unwrap();
        initial_workflow(&request, "t0")
    }

    #[test]
    fn round_trips_and_rejects_duplicates() {
        let repo = repo();
        let workflow = sample();
        repo.insert(&workflow).unwrap();
        let loaded = repo.get("wf").unwrap().unwrap();
        assert_eq!(loaded.stages, workflow.stages);
        assert_eq!(loaded.pools.get("codex"), Some(&2));
        // Declaration order survives even when keys are not sorted.
        assert_eq!(loaded.stages[1].tasks[0].key, "z");
        assert!(repo
            .insert(&workflow)
            .unwrap_err()
            .contains("already exists"));
        assert!(repo.get("missing").unwrap().is_none());
    }

    #[test]
    fn claim_is_compare_and_set() {
        let repo = repo();
        repo.insert(&sample()).unwrap();
        assert!(repo.claim_task("wf", 0, "a").unwrap());
        assert!(
            !repo.claim_task("wf", 0, "a").unwrap(),
            "second claim must lose"
        );
        assert!(repo
            .settle_claim(
                "wf",
                0,
                "a",
                WorkflowTaskStatus::Running,
                Some("child"),
                None
            )
            .unwrap());
        assert!(!repo
            .settle_claim("wf", 0, "a", WorkflowTaskStatus::Failed, None, Some("late"))
            .unwrap());
        let task = &repo.get("wf").unwrap().unwrap().stages[0].tasks[0];
        assert_eq!(task.status, WorkflowTaskStatus::Running);
        assert_eq!(task.binding_id.as_deref(), Some("child"));
    }

    #[test]
    fn approval_survives_progress_saves_and_only_applies_when_waiting() {
        let repo = repo();
        let mut workflow = sample();
        repo.insert(&workflow).unwrap();
        assert!(
            !repo.approve("wf", 1, "t1", "desktop").unwrap(),
            "not waiting yet"
        );
        workflow.stages[1].status = WorkflowStageStatus::WaitingApproval;
        repo.save_progress(&workflow).unwrap();
        assert!(repo.approve("wf", 1, "t1", "desktop").unwrap());
        assert!(!repo.approve("wf", 1, "t2", "mcp").unwrap(), "idempotent");
        // A stale snapshot (approved_at = None) must not erase the approval.
        repo.save_progress(&workflow).unwrap();
        let stage = &repo.get("wf").unwrap().unwrap().stages[1];
        assert_eq!(stage.approved_at.as_deref(), Some("t1"));
        assert_eq!(stage.approved_via.as_deref(), Some("desktop"));
    }

    #[test]
    fn lists_active_workflows_only_when_asked() {
        let repo = repo();
        let mut workflow = sample();
        repo.insert(&workflow).unwrap();
        assert_eq!(repo.list(true, 10).unwrap().len(), 1);
        workflow.status = WorkflowStatus::Done;
        workflow.stages[0].tasks[0].result = Some(serde_json::json!({"x": 1}));
        repo.save_progress(&workflow).unwrap();
        assert!(repo.list(true, 10).unwrap().is_empty());
        let all = repo.list(false, 10).unwrap();
        assert_eq!(
            all[0].stages[0].tasks[0].result,
            Some(serde_json::json!({"x": 1}))
        );
    }
}
