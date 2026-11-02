//! Completion policy and human acceptance are deliberately outside agent-editable metadata.
use super::TaskBindingRepository;
use crate::models::task_verification::{
    TaskCompletionAcceptance, TaskCompletionCriteria, TaskCompletionRecord,
};
use crate::utils::{AppError, AppResult};
use rusqlite::{params, OptionalExtension};

fn conflict() -> AppError {
    AppError::coded(
        "COMPLETION_CONFLICT",
        "Task or completion criteria changed; refresh before accepting",
    )
}

impl TaskBindingRepository {
    pub fn completion_record(&self, task_id: &str) -> AppResult<TaskCompletionRecord> {
        let conn = self.db.connection()?;
        let record: Option<(i64, String, Option<String>)> = conn.query_row(
            "SELECT revision, criteria_json, acceptance_json FROM task_completion WHERE task_id = ?1",
            params![task_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((revision, criteria, acceptance)) = record else {
            return Ok(TaskCompletionRecord::default());
        };
        Ok(TaskCompletionRecord {
            revision,
            criteria: serde_json::from_str(&criteria)
                .map_err(|error| AppError::from(error.to_string()))?,
            acceptance: acceptance
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|error| AppError::from(error.to_string()))?,
        })
    }

    pub fn set_completion_criteria(
        &self,
        task_id: &str,
        expected_revision: i64,
        criteria: &TaskCompletionCriteria,
    ) -> AppResult<()> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        tx.execute("INSERT OR IGNORE INTO task_completion (task_id) SELECT id FROM task_bindings WHERE id = ?1", params![task_id])?;
        let json =
            serde_json::to_string(criteria).map_err(|error| AppError::from(error.to_string()))?;
        let updated = tx.execute(
            "UPDATE task_completion SET criteria_json = ?1, revision = revision + 1, acceptance_json = NULL WHERE task_id = ?2 AND revision = ?3",
            params![json, task_id, expected_revision],
        )?;
        if updated != 1 {
            return Err(conflict());
        }
        tx.commit()?;
        Ok(())
    }

    pub fn accept_completion(
        &self,
        task_id: &str,
        acceptance: &TaskCompletionAcceptance,
    ) -> AppResult<()> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        tx.execute("INSERT OR IGNORE INTO task_completion (task_id) SELECT id FROM task_bindings WHERE id = ?1", params![task_id])?;
        let json =
            serde_json::to_string(acceptance).map_err(|error| AppError::from(error.to_string()))?;
        let updated = tx.execute(
            "UPDATE task_completion SET acceptance_json = ?1 WHERE task_id = ?2 AND revision = ?3 AND EXISTS (SELECT 1 FROM task_bindings WHERE id = ?2 AND report_revision = ?4 AND status = 'completed')",
            params![json, task_id, acceptance.criteria_revision, acceptance.report_revision],
        )?;
        if updated != 1 {
            return Err(conflict());
        }
        tx.commit()?;
        Ok(())
    }
}
