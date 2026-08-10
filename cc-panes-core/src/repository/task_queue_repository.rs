use crate::models::task_queue::{
    PermissionDecisionRecord, PermissionDecisionStatus, QueueItemState, TaskQueueClaim,
    TaskQueueControlPatch, TaskQueueItem, TaskQueueItemDraft, TaskQueueReason, TaskQueueRuntime,
    TaskQueueSnapshot, TaskQueueState,
};
use crate::repository::Database;
use crate::utils::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;
use uuid::Uuid;

pub struct TaskQueueRepository {
    db: Arc<Database>,
}

impl TaskQueueRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub fn runtime(&self) -> AppResult<TaskQueueRuntime> {
        let conn = self.db.connection()?;
        read_runtime(&conn)
    }

    pub fn set_global_enabled(&self, enabled: bool, now: i64) -> AppResult<TaskQueueRuntime> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_runtime(&tx, now)?;
        tx.execute(
            "UPDATE task_queue_runtime
             SET enabled = ?1, dispatch_generation = dispatch_generation + 1, updated_at = ?2
             WHERE id = 1",
            params![enabled as i64, now],
        )?;
        let runtime = read_runtime(&tx)?;
        tx.commit()?;
        Ok(runtime)
    }

    pub fn snapshot(&self, session_id: &str) -> AppResult<TaskQueueSnapshot> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_runtime(&tx, 0)?;
        ensure_queue(&tx, session_id, 0)?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn add_item(
        &self,
        session_id: &str,
        draft: &TaskQueueItemDraft,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        let draft = draft.validated()?;
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_runtime(&tx, now)?;
        ensure_queue(&tx, session_id, now)?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM terminal_task_queue_items WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        if count >= 100 {
            return Err(AppError::coded(
                "QUEUE_FULL",
                "Task queue cannot contain more than 100 active items",
            ));
        }
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0)
             FROM terminal_task_queue_items WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let image_refs = serde_json::to_string(&draft.image_refs)
            .map_err(|e| AppError::from(format!("Failed to serialize image refs: {e}")))?;
        tx.execute(
            "INSERT INTO terminal_task_queue_items
                (id, session_id, position, text, image_refs_json, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)",
            params![id, session_id, position, draft.text, image_refs, now],
        )?;
        bump_queue_revision(&tx, session_id, now)?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn delete_item(
        &self,
        session_id: &str,
        item_id: &str,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_queue(&tx, session_id, now)?;
        let row: Option<(i64, String)> = tx
            .query_row(
                "SELECT position, state FROM terminal_task_queue_items
                 WHERE session_id = ?1 AND id = ?2",
                params![session_id, item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((position, state)) = row else {
            return Err(AppError::coded(
                "QUEUE_ITEM_NOT_FOUND",
                "Task queue item not found",
            ));
        };
        if state == QueueItemState::Dispatching.as_db_str() {
            return Err(AppError::coded(
                "QUEUE_ITEM_INVALID",
                "A dispatching task cannot be cancelled",
            ));
        }
        tx.execute(
            "DELETE FROM terminal_task_queue_items WHERE session_id = ?1 AND id = ?2",
            params![session_id, item_id],
        )?;
        tx.execute(
            "UPDATE terminal_task_queue_items SET position = position - 1, updated_at = ?1
             WHERE session_id = ?2 AND position > ?3",
            params![now, session_id, position],
        )?;
        bump_queue_revision(&tx, session_id, now)?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn clear_queue(&self, session_id: &str, now: i64) -> AppResult<TaskQueueSnapshot> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_queue(&tx, session_id, now)?;
        tx.execute(
            "DELETE FROM terminal_task_queue_items WHERE session_id = ?1 AND state != 'dispatching'",
            params![session_id],
        )?;
        tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = 'running', reason = NULL, active_dispatch_token = NULL,
                 dispatch_started_at = NULL, revision = revision + 1, updated_at = ?1
             WHERE session_id = ?2 AND active_dispatch_token IS NULL",
            params![now, session_id],
        )?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn update_control(
        &self,
        session_id: &str,
        patch: &TaskQueueControlPatch,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        patch.validate()?;
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_queue(&tx, session_id, now)?;
        if let Some(paused) = patch.paused {
            tx.execute(
                "UPDATE terminal_task_queues SET paused = ?1, updated_at = ?2 WHERE session_id = ?3",
                params![paused as i64, now, session_id],
            )?;
        }
        if let Some(unattended) = patch.unattended {
            tx.execute(
                "UPDATE terminal_task_queues SET unattended = ?1, updated_at = ?2 WHERE session_id = ?3",
                params![unattended as i64, now, session_id],
            )?;
        }
        bump_queue_revision(&tx, session_id, now)?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn retry_item(
        &self,
        session_id: &str,
        item_id: &str,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_queue(&tx, session_id, now)?;
        let affected = tx.execute(
            "UPDATE terminal_task_queue_items
             SET state = 'queued', dispatch_token = NULL, last_error_code = NULL,
                 last_error_message = NULL, updated_at = ?1
             WHERE session_id = ?2 AND id = ?3 AND state IN ('failed', 'delivery_unknown')",
            params![now, session_id, item_id],
        )?;
        if affected == 0 {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM terminal_task_queue_items WHERE session_id = ?1 AND id = ?2)",
                params![session_id, item_id],
                |row| row.get(0),
            )?;
            return Err(AppError::coded(
                if exists {
                    "QUEUE_ITEM_INVALID"
                } else {
                    "QUEUE_ITEM_NOT_FOUND"
                },
                if exists {
                    "Only failed or unknown tasks can be retried"
                } else {
                    "Task queue item not found"
                },
            ));
        }
        tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = 'running', reason = NULL, active_dispatch_token = NULL,
                 dispatch_started_at = NULL, revision = revision + 1, updated_at = ?1
             WHERE session_id = ?2",
            params![now, session_id],
        )?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn set_runtime_status(
        &self,
        session_id: &str,
        state: TaskQueueState,
        reason: Option<TaskQueueReason>,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_runtime(&tx, now)?;
        ensure_queue(&tx, session_id, now)?;
        let reason = reason.map(TaskQueueReason::as_db_str);
        tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = ?1, reason = ?2, revision = revision + 1, updated_at = ?3
             WHERE session_id = ?4 AND active_dispatch_token IS NULL
               AND (runtime_state != ?1 OR reason IS NOT ?2)",
            params![state.as_db_str(), reason, now, session_id],
        )?;
        let snapshot = read_snapshot(&tx, session_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn claim_next(
        &self,
        session_id: &str,
        expected_generation: i64,
        now: i64,
    ) -> AppResult<Option<TaskQueueClaim>> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        let runtime = read_runtime(&tx)?;
        if !runtime.enabled || runtime.dispatch_generation != expected_generation {
            tx.commit()?;
            return Ok(None);
        }
        let queue: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT paused, active_dispatch_token FROM terminal_task_queues WHERE session_id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((paused, active_token)) = queue else {
            tx.commit()?;
            return Ok(None);
        };
        if paused != 0 || active_token.is_some() {
            tx.commit()?;
            return Ok(None);
        }
        let item = fetch_head(&tx, session_id)?;
        let Some(mut item) = item else {
            tx.commit()?;
            return Ok(None);
        };
        if item.state != QueueItemState::Queued {
            tx.commit()?;
            return Ok(None);
        }
        let token = Uuid::new_v4().to_string();
        let changed = tx.execute(
            "UPDATE terminal_task_queue_items
             SET state = 'dispatching', dispatch_token = ?1, updated_at = ?2
             WHERE session_id = ?3 AND id = ?4 AND state = 'queued' AND dispatch_token IS NULL",
            params![token, now, session_id, item.id],
        )?;
        if changed != 1 {
            tx.commit()?;
            return Ok(None);
        }
        let queue_changed = tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = 'dispatching', reason = NULL, active_dispatch_token = ?1,
                 dispatch_started_at = ?2, revision = revision + 1, updated_at = ?2
             WHERE session_id = ?3 AND active_dispatch_token IS NULL",
            params![token, now, session_id],
        )?;
        if queue_changed != 1 {
            return Err(AppError::coded(
                "QUEUE_CLAIM_CONFLICT",
                "Task queue dispatch claim changed concurrently",
            ));
        }
        item.state = QueueItemState::Dispatching;
        tx.commit()?;
        Ok(Some(TaskQueueClaim {
            token,
            dispatch_generation: expected_generation,
            item,
        }))
    }

    pub fn complete_claim(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        now: i64,
    ) -> AppResult<bool> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        let position: Option<i64> = tx
            .query_row(
                "SELECT position FROM terminal_task_queue_items
                 WHERE session_id = ?1 AND id = ?2 AND state = 'dispatching' AND dispatch_token = ?3
                   AND EXISTS (
                       SELECT 1 FROM terminal_task_queues q
                       WHERE q.session_id = ?1 AND q.active_dispatch_token = ?3
                   )",
                params![session_id, item_id, token],
                |row| row.get(0),
            )
            .optional()?;
        let Some(position) = position else {
            tx.commit()?;
            return Ok(false);
        };
        tx.execute(
            "DELETE FROM terminal_task_queue_items WHERE session_id = ?1 AND id = ?2
             AND state = 'dispatching' AND dispatch_token = ?3",
            params![session_id, item_id, token],
        )?;
        tx.execute(
            "UPDATE terminal_task_queue_items SET position = position - 1, updated_at = ?1
             WHERE session_id = ?2 AND position > ?3",
            params![now, session_id, position],
        )?;
        let affected = tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = 'running', reason = NULL, active_dispatch_token = NULL,
                 dispatch_started_at = NULL, revision = revision + 1, updated_at = ?1
             WHERE session_id = ?2 AND active_dispatch_token = ?3",
            params![now, session_id, token],
        )?;
        tx.commit()?;
        Ok(affected == 1)
    }

    pub fn return_claim_to_queue(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        now: i64,
    ) -> AppResult<bool> {
        self.finish_claim(FinishClaim {
            session_id,
            item_id,
            token,
            state: QueueItemState::Queued,
            code: None,
            message: None,
            now,
        })
    }

    pub fn fail_claim(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        code: &str,
        message: &str,
        now: i64,
    ) -> AppResult<bool> {
        self.finish_claim(FinishClaim {
            session_id,
            item_id,
            token,
            state: QueueItemState::Failed,
            code: Some(code),
            message: Some(message),
            now,
        })
    }

    pub fn mark_delivery_unknown(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        message: &str,
        now: i64,
    ) -> AppResult<bool> {
        self.finish_claim(FinishClaim {
            session_id,
            item_id,
            token,
            state: QueueItemState::DeliveryUnknown,
            code: Some("DELIVERY_UNKNOWN"),
            message: Some(message),
            now,
        })
    }

    pub fn recover_inflight(&self, now: i64) -> AppResult<usize> {
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = 'action_required', reason = 'delivery_unknown',
                 active_dispatch_token = NULL, dispatch_started_at = NULL,
                 revision = revision + 1, updated_at = ?1
             WHERE active_dispatch_token IS NOT NULL
                OR EXISTS (
                    SELECT 1 FROM terminal_task_queue_items i
                    WHERE i.session_id = terminal_task_queues.session_id AND i.state = 'dispatching'
                )",
            params![now],
        )?;
        let affected = tx.execute(
            "UPDATE terminal_task_queue_items
             SET state = 'delivery_unknown', dispatch_token = NULL,
                 last_error_code = 'DELIVERY_UNKNOWN',
                 last_error_message = 'Dispatch was interrupted before acknowledgement', updated_at = ?1
             WHERE state = 'dispatching'",
            params![now],
        )?;
        tx.commit()?;
        Ok(affected)
    }

    pub fn record_permission_decision(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_fingerprint: &str,
        now: i64,
    ) -> AppResult<PermissionDecisionRecord> {
        validate_permission_decision_key(tool_use_id, request_fingerprint)?;
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        ensure_queue(&tx, session_id, now)?;
        let result =
            upsert_permission_decision(&tx, session_id, tool_use_id, request_fingerprint, now)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn record_permission_decision_if_eligible(
        &self,
        session_id: &str,
        tool_use_id: &str,
        request_fingerprint: &str,
        now: i64,
    ) -> AppResult<Option<PermissionDecisionRecord>> {
        validate_permission_decision_key(tool_use_id, request_fingerprint)?;
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        let eligible = tx.query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM task_queue_runtime r
                 JOIN terminal_task_queues q ON q.session_id = ?1
                 WHERE r.id = 1 AND r.enabled = 1 AND q.unattended = 1
                   AND EXISTS (
                       SELECT 1 FROM terminal_task_queue_items i
                       WHERE i.session_id = q.session_id
                   )
             )",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if !eligible {
            tx.commit()?;
            return Ok(None);
        }

        let result =
            upsert_permission_decision(&tx, session_id, tool_use_id, request_fingerprint, now)?;
        tx.commit()?;
        Ok(Some(result))
    }

    pub fn active_session_ids(&self) -> AppResult<Vec<String>> {
        let conn = self.db.connection()?;
        let mut stmt = conn.prepare(
            "SELECT q.session_id FROM terminal_task_queues q
             WHERE EXISTS (SELECT 1 FROM terminal_task_queue_items i
                           WHERE i.session_id = q.session_id)
             ORDER BY q.updated_at ASC",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(AppError::from)
    }

    fn finish_claim(&self, finish: FinishClaim<'_>) -> AppResult<bool> {
        let FinishClaim {
            session_id,
            item_id,
            token,
            state,
            code,
            message,
            now,
        } = finish;
        let mut conn = self.db.connection()?;
        let tx = conn.transaction()?;
        let queue_state = match state {
            QueueItemState::Queued => TaskQueueState::Running.as_db_str(),
            QueueItemState::Failed => TaskQueueState::SendFailed.as_db_str(),
            QueueItemState::DeliveryUnknown => TaskQueueState::ActionRequired.as_db_str(),
            QueueItemState::Dispatching => TaskQueueState::Dispatching.as_db_str(),
        };
        let reason = match state {
            QueueItemState::Queued => None,
            QueueItemState::Failed => Some(TaskQueueReason::SubmitFailed.as_db_str()),
            QueueItemState::DeliveryUnknown => Some(TaskQueueReason::DeliveryUnknown.as_db_str()),
            QueueItemState::Dispatching => None,
        };
        let changed = tx.execute(
            "UPDATE terminal_task_queue_items
             SET state = ?1, dispatch_token = NULL, last_error_code = ?2,
                 last_error_message = ?3, updated_at = ?4
             WHERE session_id = ?5 AND id = ?6 AND state = 'dispatching' AND dispatch_token = ?7
               AND EXISTS (
                   SELECT 1 FROM terminal_task_queues q
                   WHERE q.session_id = ?5 AND q.active_dispatch_token = ?7
               )",
            params![
                state.as_db_str(),
                code,
                message,
                now,
                session_id,
                item_id,
                token
            ],
        )?;
        if changed == 0 {
            tx.commit()?;
            return Ok(false);
        }
        let queue_changed = tx.execute(
            "UPDATE terminal_task_queues
             SET runtime_state = ?1, reason = ?2, active_dispatch_token = NULL,
                 dispatch_started_at = NULL, revision = revision + 1, updated_at = ?3
             WHERE session_id = ?4 AND active_dispatch_token = ?5",
            params![queue_state, reason, now, session_id, token],
        )?;
        if queue_changed != 1 {
            return Err(AppError::coded(
                "QUEUE_CLAIM_CONFLICT",
                "Task queue dispatch claim changed concurrently",
            ));
        }
        tx.commit()?;
        Ok(true)
    }
}

fn validate_permission_decision_key(tool_use_id: &str, fingerprint: &str) -> AppResult<()> {
    if tool_use_id.trim().is_empty() || fingerprint.trim().is_empty() {
        return Err(AppError::coded(
            "QUEUE_ITEM_INVALID",
            "Permission decisions require a tool id and fingerprint",
        ));
    }
    Ok(())
}

fn upsert_permission_decision(
    conn: &Connection,
    session_id: &str,
    tool_use_id: &str,
    request_fingerprint: &str,
    now: i64,
) -> AppResult<PermissionDecisionRecord> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT request_fingerprint FROM terminal_task_queue_permission_decisions
             WHERE session_id = ?1 AND tool_use_id = ?2",
            params![session_id, tool_use_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match existing {
        None => {
            conn.execute(
                "INSERT INTO terminal_task_queue_permission_decisions
                 (session_id, tool_use_id, request_fingerprint, decision, created_at)
                 VALUES (?1, ?2, ?3, 'allow', ?4)",
                params![session_id, tool_use_id, request_fingerprint, now],
            )?;
            PermissionDecisionRecord {
                status: PermissionDecisionStatus::Inserted,
                decision: Some("allow".into()),
            }
        }
        Some(fingerprint) if fingerprint == request_fingerprint => PermissionDecisionRecord {
            status: PermissionDecisionStatus::Existing,
            decision: Some("allow".into()),
        },
        Some(_) => PermissionDecisionRecord {
            status: PermissionDecisionStatus::FingerprintMismatch,
            decision: None,
        },
    })
}

struct FinishClaim<'a> {
    session_id: &'a str,
    item_id: &'a str,
    token: &'a str,
    state: QueueItemState,
    code: Option<&'a str>,
    message: Option<&'a str>,
    now: i64,
}

fn ensure_runtime(conn: &Connection, now: i64) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO task_queue_runtime(id, enabled, dispatch_generation, updated_at)
         VALUES (1, 1, 0, ?1)",
        params![now],
    )?;
    Ok(())
}

fn ensure_queue(conn: &Connection, session_id: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO terminal_task_queues
         (session_id, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![session_id, now],
    )?;
    Ok(())
}

fn bump_queue_revision(conn: &Connection, session_id: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE terminal_task_queues SET revision = revision + 1, updated_at = ?1 WHERE session_id = ?2",
        params![now, session_id],
    )?;
    Ok(())
}

fn read_runtime(conn: &Connection) -> AppResult<TaskQueueRuntime> {
    conn.query_row(
        "SELECT enabled, dispatch_generation, updated_at FROM task_queue_runtime WHERE id = 1",
        [],
        |row| {
            Ok(TaskQueueRuntime {
                enabled: row.get::<_, i64>(0)? != 0,
                dispatch_generation: row.get(1)?,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::coded("QUEUE_RUNTIME_MISSING", "Task queue runtime row is missing"))
}

fn fetch_head(conn: &Connection, session_id: &str) -> AppResult<Option<TaskQueueItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, position, text, image_refs_json, state,
                created_at, last_error_code, last_error_message
         FROM terminal_task_queue_items WHERE session_id = ?1
         ORDER BY position ASC LIMIT 1",
    )?;
    let mut rows = stmt.query(params![session_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    parse_item(row).map(Some)
}

fn fetch_items(conn: &Connection, session_id: &str) -> AppResult<Vec<TaskQueueItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, position, text, image_refs_json, state,
                created_at, last_error_code, last_error_message
         FROM terminal_task_queue_items WHERE session_id = ?1 ORDER BY position ASC",
    )?;
    let rows = stmt.query_map(params![session_id], read_raw_item)?;
    rows.map(|row| parse_raw_item(row?)).collect()
}

fn parse_item(row: &rusqlite::Row<'_>) -> AppResult<TaskQueueItem> {
    parse_raw_item(read_raw_item(row)?)
}

struct RawTaskQueueItem {
    id: String,
    session_id: String,
    position: i64,
    text: String,
    image_refs_json: String,
    state: String,
    created_at: i64,
    error_code: Option<String>,
    error_message: Option<String>,
}

fn read_raw_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawTaskQueueItem> {
    Ok(RawTaskQueueItem {
        id: row.get(0)?,
        session_id: row.get(1)?,
        position: row.get(2)?,
        text: row.get(3)?,
        image_refs_json: row.get(4)?,
        state: row.get(5)?,
        created_at: row.get(6)?,
        error_code: row.get(7)?,
        error_message: row.get(8)?,
    })
}

fn parse_raw_item(raw: RawTaskQueueItem) -> AppResult<TaskQueueItem> {
    let image_refs = serde_json::from_str(&raw.image_refs_json).map_err(|e| {
        AppError::coded("QUEUE_ROW_INVALID", format!("Invalid image refs JSON: {e}"))
    })?;
    let state = QueueItemState::from_db_str(&raw.state)?;
    let last_error = raw.error_message.or(raw.error_code);
    Ok(TaskQueueItem {
        id: raw.id,
        session_id: raw.session_id,
        position: raw.position,
        text: raw.text,
        image_refs,
        state,
        created_at: raw.created_at,
        last_error,
    })
}

fn read_snapshot(conn: &Connection, session_id: &str) -> AppResult<TaskQueueSnapshot> {
    let runtime = read_runtime(conn)?;
    let queue = conn
        .query_row(
            "SELECT paused, unattended, runtime_state, reason, revision, updated_at
             FROM terminal_task_queues WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::coded("SESSION_NOT_FOUND", "Task queue session is missing"))?;
    let persisted_state = TaskQueueState::from_db_str(&queue.2)?;
    let persisted_reason = queue
        .3
        .as_deref()
        .map(TaskQueueReason::from_db_str)
        .transpose()?;
    let (state, reason) = if !runtime.enabled {
        (
            TaskQueueState::Disabled,
            Some(TaskQueueReason::GlobalDisabled),
        )
    } else if queue.0 != 0 {
        (TaskQueueState::Paused, Some(TaskQueueReason::UserPaused))
    } else {
        (persisted_state, persisted_reason)
    };
    Ok(TaskQueueSnapshot {
        session_id: session_id.to_string(),
        paused: queue.0 != 0,
        unattended: queue.1 != 0,
        unattended_supported: false,
        state,
        reason,
        items: fetch_items(conn, session_id)?,
        revision: queue.4,
        updated_at: queue.5,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> TaskQueueRepository {
        TaskQueueRepository::new(Arc::new(Database::new_fallback().expect("database")))
    }

    #[test]
    fn repository_round_trip_and_stale_token_are_safe() {
        let repo = repository();
        let snapshot = repo
            .add_item("pty", &TaskQueueItemDraft::new("hello", vec![]).unwrap(), 1)
            .unwrap();
        let runtime = repo.runtime().unwrap();
        let claim = repo
            .claim_next("pty", runtime.dispatch_generation, 2)
            .unwrap()
            .unwrap();
        assert_eq!(claim.item.id, snapshot.items[0].id);
        assert!(!repo
            .complete_claim("pty", &claim.item.id, "stale", 3)
            .unwrap());
        assert!(repo
            .complete_claim("pty", &claim.item.id, &claim.token, 4)
            .unwrap());
        assert!(repo.snapshot("pty").unwrap().items.is_empty());
    }
}
