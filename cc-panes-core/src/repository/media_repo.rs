use crate::models::{
    MediaAsset, MediaCachePolicy, MediaEdge, MediaEdgeSelector, MediaKind, MediaNode,
    MediaOperation, MediaProviderRef, MediaQueueSnapshot, MediaRun, MediaRunStatus,
    UpdateMediaNodeRequest, UpdateMediaRunRequest,
};
use crate::repository::Database;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::Value;
use std::str::FromStr;
use std::sync::Arc;

/// SQLite access for durable media canvas state.
pub struct MediaRepository {
    db: Arc<Database>,
}

/// A validated cache candidate. The service still verifies the controlled file
/// before turning this candidate into a succeeded run.
#[derive(Debug, Clone)]
pub struct MediaCacheHit {
    pub source_run_id: String,
    pub assets: Vec<MediaAsset>,
}

impl MediaRepository {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    // ---------------------------------------------------------------------
    // Nodes
    // ---------------------------------------------------------------------

    pub fn insert_node(&self, node: &MediaNode) -> Result<(), String> {
        let conn = self.connection()?;
        let (provider_id, model_id) = provider_columns(node.provider_ref.as_ref());
        conn.execute(
            "INSERT INTO media_nodes (
                id, workspace_id, layout_id, kind, title, default_operation,
                provider_id, model_id, parameters_json, deleted_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                node.id,
                node.workspace_id,
                node.layout_id,
                node.kind.as_str(),
                node.title,
                node.default_operation.as_str(),
                provider_id,
                model_id,
                json_text(&node.parameters)?,
                node.deleted_at,
                node.created_at,
                node.updated_at,
            ],
        )
        .map_err(|e| format!("Failed to insert media node: {e}"))?;
        Ok(())
    }

    pub fn get_node(&self, id: &str) -> Result<Option<MediaNode>, String> {
        let conn = self.connection()?;
        conn.query_row(
            &format!("{NODE_SELECT} WHERE id = ?1"),
            params![id],
            row_to_node,
        )
        .optional()
        .map_err(|e| format!("Failed to load media node: {e}"))
    }

    pub fn list_nodes(
        &self,
        workspace_id: &str,
        layout_id: Option<&str>,
        include_deleted: bool,
    ) -> Result<Vec<MediaNode>, String> {
        let conn = self.connection()?;
        let mut sql = String::from(NODE_LIST_SELECT);
        sql.push_str(" WHERE workspace_id = ?1");
        if layout_id.is_some() {
            sql.push_str(" AND layout_id = ?2");
        }
        if !include_deleted {
            sql.push_str(" AND deleted_at IS NULL");
        }
        sql.push_str(" ORDER BY updated_at DESC, created_at DESC");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare media node list: {e}"))?;
        let rows = if let Some(layout_id) = layout_id {
            stmt.query_map(params![workspace_id, layout_id], row_to_node)
                .map_err(|e| format!("Failed to query media nodes: {e}"))?
                .collect::<Result<Vec<_>, _>>()
        } else {
            stmt.query_map(params![workspace_id], row_to_node)
                .map_err(|e| format!("Failed to query media nodes: {e}"))?
                .collect::<Result<Vec<_>, _>>()
        };
        rows.map_err(|e| format!("Failed to read media nodes: {e}"))
    }

    pub fn update_node(
        &self,
        id: &str,
        req: &UpdateMediaNodeRequest,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if let Some(title) = &req.title {
            sets.push(format!("title = ?{index}"));
            values.push(Box::new(title.clone()));
            index += 1;
        }
        if let Some(operation) = req.default_operation {
            sets.push(format!("default_operation = ?{index}"));
            values.push(Box::new(operation.as_str().to_string()));
            index += 1;
        }
        if req.provider_ref.is_some() {
            let (provider_id, model_id) = provider_columns(req.provider_ref.as_ref());
            sets.push(format!("provider_id = ?{index}"));
            values.push(Box::new(provider_id));
            index += 1;
            sets.push(format!("model_id = ?{index}"));
            values.push(Box::new(model_id));
            index += 1;
        }
        if let Some(parameters) = &req.parameters {
            sets.push(format!("parameters_json = ?{index}"));
            values.push(Box::new(json_text(parameters)?));
            index += 1;
        }
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let sql = format!(
            "UPDATE media_nodes SET {} WHERE id = ?{} AND deleted_at IS NULL",
            sets.join(", "),
            index
        );
        values.push(Box::new(id.to_string()));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to update media node: {e}"))
    }

    pub fn soft_delete_node(&self, id: &str, deleted_at: &str) -> Result<bool, String> {
        let conn = self.connection()?;
        let changed = conn
            .execute(
                "UPDATE media_nodes SET deleted_at = ?1, updated_at = ?1
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![deleted_at, id],
            )
            .map_err(|e| format!("Failed to delete media node: {e}"))?;
        Ok(changed > 0)
    }

    // ---------------------------------------------------------------------
    // Runs
    // ---------------------------------------------------------------------

    pub fn insert_run(&self, run: &MediaRun) -> Result<(), String> {
        let mut conn = self.connection()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start media run transaction: {e}"))?;
        let (provider_id, model_id) = provider_columns(run.provider_ref.as_ref());
        tx.execute(
            "INSERT INTO media_runs (
                id, node_id, operation, status, attempt, priority, cache_policy, client_request_id,
                provider_id, model_id, request_json, remote_job_id, progress,
                error_code, error_message, lease_owner, lease_expires_at,
                execution_fingerprint, cache_hit, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                run.id,
                run.node_id,
                run.operation.as_str(),
                run.status.as_str(),
                run.attempt,
                run.priority,
                run.cache_policy.as_str(),
                run.client_request_id,
                provider_id,
                model_id,
                json_text(&run.request)?,
                run.remote_job_id,
                run.progress,
                run.error_code,
                run.error_message,
                run.lease_owner,
                run.lease_expires_at,
                run.execution_fingerprint,
                run.cache_hit as i32,
                run.created_at,
                run.updated_at,
            ],
        )
        .map_err(|e| format!("Failed to insert media run: {e}"))?;
        self.replace_run_assets(&tx, run)?;
        tx.commit()
            .map_err(|e| format!("Failed to commit media run: {e}"))?;
        Ok(())
    }

    pub fn get_run(&self, id: &str) -> Result<Option<MediaRun>, String> {
        let conn = self.connection()?;
        let run = conn
            .query_row(
                &format!("{RUN_SELECT} WHERE id = ?1"),
                params![id],
                row_to_run,
            )
            .optional()
            .map_err(|e| format!("Failed to query media run: {e}"))?;
        run.map(|run| load_run_assets(&conn, run))
            .transpose()
            .map_err(|e| format!("Failed to load media run: {e}"))
    }

    pub fn list_runs(
        &self,
        node_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<MediaRun>, String> {
        let conn = self.connection()?;
        let mut stmt = conn
            .prepare(&format!(
                "{RUN_SELECT} WHERE node_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3"
            ))
            .map_err(|e| format!("Failed to prepare media run list: {e}"))?;
        let rows = stmt
            .query_map(params![node_id, limit, offset], row_to_run)
            .map_err(|e| format!("Failed to query media runs: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(load_run_assets(&conn, row.map_err(|e| e.to_string())?)?);
        }
        Ok(result)
    }

    pub fn list_recoverable_runs(&self) -> Result<Vec<MediaRun>, String> {
        let conn = self.connection()?;
        let mut stmt = conn
            .prepare(&format!(
                "{RUN_SELECT} WHERE status IN ('queued', 'submitting', 'processing', 'downloading', 'canceling')
                 ORDER BY priority DESC, created_at ASC, id ASC"
            ))
            .map_err(|e| format!("Failed to prepare recoverable media runs: {e}"))?;
        let rows = stmt
            .query_map([], row_to_run)
            .map_err(|e| format!("Failed to query recoverable media runs: {e}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(load_run_assets(&conn, row.map_err(|e| e.to_string())?)?);
        }
        Ok(result)
    }

    /// Claim the oldest queued/expired run, or renew a live run already owned
    /// by this worker so a long provider job can be polled on every tick.
    ///
    /// The database connection is mutex-protected, so the select/update pair
    /// is serialized with other media mutations. The conditional update still
    /// guards against a future repository implementation using a pool.
    pub fn claim_next_run(
        &self,
        owner: &str,
        now: &str,
        lease_expires_at: &str,
    ) -> Result<Option<MediaRun>, String> {
        self.claim_next_run_excluding(owner, now, lease_expires_at, &[])
    }

    /// Variant used by a batch worker to avoid claiming the same live remote
    /// job more than once before the batch's futures have started processing.
    pub fn claim_next_run_excluding(
        &self,
        owner: &str,
        now: &str,
        lease_expires_at: &str,
        excluded_ids: &[String],
    ) -> Result<Option<MediaRun>, String> {
        if owner.trim().is_empty() {
            return Err("media lease owner cannot be empty".to_string());
        }
        let conn = self.connection()?;
        let mut stmt = conn
            .prepare(
                "SELECT id FROM media_runs
                 WHERE (status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at < ?2))
                    OR (status IN ('submitting', 'processing', 'downloading', 'canceling')
                        AND ((lease_expires_at IS NOT NULL AND lease_expires_at < ?2)
                             OR (lease_owner = ?1 AND remote_job_id IS NOT NULL)))
                 ORDER BY CASE
                            WHEN status IN ('submitting', 'processing', 'downloading', 'canceling')
                                 AND lease_owner = ?1 AND remote_job_id IS NOT NULL THEN 0
                            ELSE 1
                          END,
                          priority DESC, created_at ASC, id ASC",
            )
            .map_err(|e| format!("Failed to prepare media run lease query: {e}"))?;
        let mut rows = stmt
            .query_map(params![owner, now], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to select media run for lease: {e}"))?;
        let id = loop {
            let Some(row) = rows.next() else { break None };
            let candidate = row.map_err(|e| format!("Failed to read media run lease: {e}"))?;
            if !excluded_ids.iter().any(|excluded| excluded == &candidate) {
                break Some(candidate);
            }
        };
        drop(rows);
        drop(stmt);
        let Some(id) = id else { return Ok(None) };
        let changed = conn
            .execute(
                "UPDATE media_runs
                 SET status = CASE WHEN status = 'queued' THEN 'submitting' ELSE status END,
                     lease_owner = ?1, lease_expires_at = ?2, updated_at = ?3
                 WHERE id = ?4
                   AND ((status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at < ?3))
                     OR (status IN ('submitting', 'processing', 'downloading', 'canceling')
                         AND ((lease_expires_at IS NOT NULL AND lease_expires_at < ?3)
                              OR (lease_owner = ?1 AND remote_job_id IS NOT NULL))))",
                params![owner, lease_expires_at, now, id],
            )
            .map_err(|e| format!("Failed to claim media run: {e}"))?;
        if changed == 0 {
            return Ok(None);
        }
        let run = conn
            .query_row(
                &format!("{RUN_SELECT} WHERE id = ?1"),
                params![id],
                row_to_run,
            )
            .map_err(|e| format!("Failed to load claimed media run: {e}"))?;
        load_run_assets(&conn, run)
            .map(Some)
            .map_err(|e| format!("Failed to load claimed media assets: {e}"))
    }

    pub fn find_run_by_client_request_id(
        &self,
        client_request_id: &str,
    ) -> Result<Option<MediaRun>, String> {
        let conn = self.connection()?;
        let run = conn
            .query_row(
                &format!("{RUN_SELECT} WHERE client_request_id = ?1"),
                params![client_request_id],
                row_to_run,
            )
            .optional()
            .map_err(|e| format!("Failed to query idempotent media run: {e}"))?;
        run.map(|run| load_run_assets(&conn, run))
            .transpose()
            .map_err(|e| format!("Failed to load idempotent media run: {e}"))
    }

    /// Return the latest successful output set for an execution fingerprint.
    /// The cache index is deliberately separate from the run list so pruning
    /// or retrying historical runs cannot make lookup scan the whole table.
    pub fn find_cache_hit(
        &self,
        workspace_id: &str,
        execution_fingerprint: &str,
    ) -> Result<Option<MediaCacheHit>, String> {
        let conn = self.connection()?;
        let source_run_id: Option<String> = conn
            .query_row(
                "SELECT e.source_run_id
                 FROM media_cache_entries e
                 JOIN media_runs r ON r.id = e.source_run_id
                 WHERE e.workspace_id = ?1 AND e.execution_fingerprint = ?2
                   AND r.status = 'succeeded'
                 LIMIT 1",
                params![workspace_id, execution_fingerprint],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query media cache: {e}"))?;
        let Some(source_run_id) = source_run_id else {
            return Ok(None);
        };
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.workspace_id, a.run_id, a.relative_path, a.mime_type,
                        a.size_bytes, a.sha256, a.width, a.height, a.duration_ms,
                        a.metadata_json, a.created_at
                 FROM media_run_assets l
                 JOIN media_assets a ON a.id = l.asset_id
                 WHERE l.run_id = ?1 AND l.role = 'output'
                 ORDER BY l.ordinal ASC",
            )
            .map_err(|e| format!("Failed to prepare media cache assets: {e}"))?;
        let assets = stmt
            .query_map(params![source_run_id], row_to_asset)
            .map_err(|e| format!("Failed to query media cache assets: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read media cache assets: {e}"))?;
        if assets.is_empty() {
            return Ok(None);
        }
        Ok(Some(MediaCacheHit {
            source_run_id,
            assets,
        }))
    }

    pub fn register_cache_entry(
        &self,
        workspace_id: &str,
        execution_fingerprint: &str,
        source_run_id: &str,
        created_at: &str,
    ) -> Result<(), String> {
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO media_cache_entries (
                 workspace_id, execution_fingerprint, source_run_id, created_at,
                 last_hit_at, hit_count
             ) VALUES (?1, ?2, ?3, ?4, NULL, 0)
             ON CONFLICT(workspace_id, execution_fingerprint) DO UPDATE SET
                 source_run_id = excluded.source_run_id,
                 created_at = excluded.created_at",
            params![
                workspace_id,
                execution_fingerprint,
                source_run_id,
                created_at
            ],
        )
        .map_err(|e| format!("Failed to register media cache entry: {e}"))?;
        Ok(())
    }

    pub fn touch_cache_entry(
        &self,
        workspace_id: &str,
        execution_fingerprint: &str,
        hit_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE media_cache_entries
             SET last_hit_at = ?1, hit_count = hit_count + 1
             WHERE workspace_id = ?2 AND execution_fingerprint = ?3",
            params![hit_at, workspace_id, execution_fingerprint],
        )
        .map(|count| count > 0)
        .map_err(|e| format!("Failed to touch media cache entry: {e}"))
    }

    pub fn delete_cache_entry(
        &self,
        workspace_id: &str,
        execution_fingerprint: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute(
            "DELETE FROM media_cache_entries
             WHERE workspace_id = ?1 AND execution_fingerprint = ?2",
            params![workspace_id, execution_fingerprint],
        )
        .map(|count| count > 0)
        .map_err(|e| format!("Failed to delete media cache entry: {e}"))
    }

    pub fn queue_snapshot(&self) -> Result<MediaQueueSnapshot, String> {
        let conn = self.connection()?;
        conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status IN ('submitting', 'processing', 'downloading', 'canceling') THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END), 0),
                MAX(CASE WHEN status = 'queued' THEN priority END),
                MIN(CASE WHEN status = 'queued' THEN created_at END)
             FROM media_runs",
            [],
            |row| {
                Ok(MediaQueueSnapshot {
                    queued: row.get(0)?,
                    active: row.get(1)?,
                    succeeded: row.get(2)?,
                    failed: row.get(3)?,
                    canceled: row.get(4)?,
                    highest_priority: row.get(5)?,
                    oldest_queued_at: row.get(6)?,
                    sampled_at: Utc::now().to_rfc3339(),
                })
            },
        )
        .map_err(|e| format!("Failed to read media queue snapshot: {e}"))
    }

    /// Find a durable run by the provider's remote job id. Provider id is
    /// included when available so two independently configured engines using
    /// the same prompt id cannot update one another's runs.
    pub fn find_run_by_remote_job_id(
        &self,
        provider_id: Option<&str>,
        remote_job_id: &str,
    ) -> Result<Option<MediaRun>, String> {
        let conn = self.connection()?;
        // Keep the query construction explicit; this avoids interpolating any
        // provider-controlled identifier into SQL while supporting both forms.
        let run = if let Some(provider_id) = provider_id {
            conn.query_row(
                &format!("{RUN_SELECT} WHERE provider_id = ?1 AND remote_job_id = ?2"),
                params![provider_id, remote_job_id],
                row_to_run,
            )
            .optional()
            .map_err(|e| format!("Failed to query remote media run: {e}"))?
        } else {
            conn.query_row(
                &format!("{RUN_SELECT} WHERE remote_job_id = ?1"),
                params![remote_job_id],
                row_to_run,
            )
            .optional()
            .map_err(|e| format!("Failed to query remote media run: {e}"))?
        };
        run.map(|run| load_run_assets(&conn, run))
            .transpose()
            .map_err(|e| format!("Failed to load remote media run: {e}"))
    }

    /// Apply a non-terminal provider event without changing the durable state
    /// machine. Progress is monotonic, and terminal rows are left untouched;
    /// the worker still polls `/history` to decide success/failure and fetch
    /// outputs.
    pub fn apply_provider_event(
        &self,
        provider_id: Option<&str>,
        remote_job_id: &str,
        progress: Option<i32>,
        error_code: Option<&str>,
        error_message: Option<&str>,
        updated_at: &str,
    ) -> Result<Option<MediaRun>, String> {
        let Some(existing) = self.find_run_by_remote_job_id(provider_id, remote_job_id)? else {
            return Ok(None);
        };
        if existing.status.is_terminal() {
            return Ok(Some(existing));
        }
        let next_progress = match (existing.progress, progress) {
            (Some(current), Some(next)) => Some(current.max(next)),
            (None, Some(next)) => Some(next),
            (current, None) => current,
        };
        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if next_progress != existing.progress {
            sets.push(format!("progress = ?{index}"));
            values.push(Box::new(next_progress));
            index += 1;
        }
        if let Some(error_code) = error_code {
            sets.push(format!("error_code = ?{index}"));
            values.push(Box::new(error_code.to_string()));
            index += 1;
        }
        if let Some(error_message) = error_message {
            sets.push(format!("error_message = ?{index}"));
            values.push(Box::new(error_message.to_string()));
            index += 1;
        }
        if sets.is_empty() {
            return Ok(Some(existing));
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let provider_index = index;
        if let Some(provider_id) = provider_id {
            values.push(Box::new(provider_id.to_string()));
            index += 1;
            let remote_index = index;
            values.push(Box::new(remote_job_id.to_string()));
            index += 1;
            let id_index = index;
            values.push(Box::new(existing.id.clone()));
            let sql = format!(
                "UPDATE media_runs SET {} WHERE id = ?{id_index} AND provider_id = ?{provider_index}
                 AND remote_job_id = ?{remote_index} AND status NOT IN ('succeeded', 'failed', 'canceled')",
                sets.join(", ")
            );
            let params: Vec<&dyn rusqlite::types::ToSql> =
                values.iter().map(|value| value.as_ref()).collect();
            self.connection()?
                .execute(&sql, params.as_slice())
                .map_err(|e| format!("Failed to apply provider event: {e}"))?;
        } else {
            let remote_index = provider_index;
            values.push(Box::new(remote_job_id.to_string()));
            index += 1;
            let id_index = index;
            values.push(Box::new(existing.id.clone()));
            let sql = format!(
                "UPDATE media_runs SET {} WHERE id = ?{id_index} AND remote_job_id = ?{remote_index}
                 AND status NOT IN ('succeeded', 'failed', 'canceled')",
                sets.join(", ")
            );
            let params: Vec<&dyn rusqlite::types::ToSql> =
                values.iter().map(|value| value.as_ref()).collect();
            self.connection()?
                .execute(&sql, params.as_slice())
                .map_err(|e| format!("Failed to apply provider event: {e}"))?;
        }
        self.find_run_by_remote_job_id(provider_id, remote_job_id)
    }

    pub fn update_run(
        &self,
        id: &str,
        req: &UpdateMediaRunRequest,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if let Some(status) = req.status {
            sets.push(format!("status = ?{index}"));
            values.push(Box::new(status.as_str().to_string()));
            index += 1;
        }
        if let Some(attempt) = req.attempt {
            sets.push(format!("attempt = ?{index}"));
            values.push(Box::new(attempt));
            index += 1;
        }
        if let Some(priority) = req.priority {
            sets.push(format!("priority = ?{index}"));
            values.push(Box::new(priority));
            index += 1;
        }
        macro_rules! nullable_field {
            ($field:literal, $value:expr) => {
                if let Some(value) = &$value {
                    sets.push(format!(concat!($field, " = ?{}"), index));
                    values.push(Box::new(value.clone()));
                    index += 1;
                }
            };
        }
        nullable_field!("progress", req.progress);
        nullable_field!("remote_job_id", req.remote_job_id);
        nullable_field!("error_code", req.error_code);
        nullable_field!("error_message", req.error_message);
        nullable_field!("lease_owner", req.lease_owner);
        nullable_field!("lease_expires_at", req.lease_expires_at);
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let sql = format!(
            "UPDATE media_runs SET {} WHERE id = ?{}",
            sets.join(", "),
            index
        );
        values.push(Box::new(id.to_string()));
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to update media run: {e}"))
    }

    /// Update a run only while the caller still owns a live lease.  This is a
    /// fencing check for workers that wake up after another worker has taken
    /// over an expired lease; a read-then-write check alone is racy.
    pub fn update_run_for_owner(
        &self,
        id: &str,
        owner: &str,
        lease_now: &str,
        req: &UpdateMediaRunRequest,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if let Some(status) = req.status {
            sets.push(format!("status = ?{index}"));
            values.push(Box::new(status.as_str().to_string()));
            index += 1;
        }
        if let Some(attempt) = req.attempt {
            sets.push(format!("attempt = ?{index}"));
            values.push(Box::new(attempt));
            index += 1;
        }
        if let Some(priority) = req.priority {
            sets.push(format!("priority = ?{index}"));
            values.push(Box::new(priority));
            index += 1;
        }
        macro_rules! nullable_field {
            ($field:literal, $value:expr) => {
                if let Some(value) = &$value {
                    sets.push(format!(concat!($field, " = ?{}"), index));
                    values.push(Box::new(value.clone()));
                    index += 1;
                }
            };
        }
        nullable_field!("progress", req.progress);
        nullable_field!("remote_job_id", req.remote_job_id);
        nullable_field!("error_code", req.error_code);
        nullable_field!("error_message", req.error_message);
        nullable_field!("lease_owner", req.lease_owner);
        nullable_field!("lease_expires_at", req.lease_expires_at);
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let owner_index = index;
        values.push(Box::new(owner.to_string()));
        index += 1;
        let lease_now_index = index;
        values.push(Box::new(lease_now.to_string()));
        index += 1;
        let id_index = index;
        values.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE media_runs SET {} WHERE id = ?{id_index} AND lease_owner = ?{owner_index}
             AND lease_expires_at IS NOT NULL AND lease_expires_at > ?{lease_now_index}
             AND status NOT IN ('succeeded', 'failed', 'canceled')",
            sets.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to update leased media run: {e}"))
    }

    /// Fenced update that also requires the row to still have the status read
    /// by the caller.  This closes the read/validate/write race between two
    /// workers attempting different terminal transitions.
    pub fn update_run_for_owner_from_status(
        &self,
        id: &str,
        owner: &str,
        lease_now: &str,
        expected_status: MediaRunStatus,
        req: &UpdateMediaRunRequest,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if let Some(status) = req.status {
            sets.push(format!("status = ?{index}"));
            values.push(Box::new(status.as_str().to_string()));
            index += 1;
        }
        if let Some(attempt) = req.attempt {
            sets.push(format!("attempt = ?{index}"));
            values.push(Box::new(attempt));
            index += 1;
        }
        if let Some(priority) = req.priority {
            sets.push(format!("priority = ?{index}"));
            values.push(Box::new(priority));
            index += 1;
        }
        macro_rules! nullable_field {
            ($field:literal, $value:expr) => {
                if let Some(value) = &$value {
                    sets.push(format!(concat!($field, " = ?{}"), index));
                    values.push(Box::new(value.clone()));
                    index += 1;
                }
            };
        }
        nullable_field!("progress", req.progress);
        nullable_field!("remote_job_id", req.remote_job_id);
        nullable_field!("error_code", req.error_code);
        nullable_field!("error_message", req.error_message);
        nullable_field!("lease_owner", req.lease_owner);
        nullable_field!("lease_expires_at", req.lease_expires_at);
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let owner_index = index;
        values.push(Box::new(owner.to_string()));
        index += 1;
        let lease_now_index = index;
        values.push(Box::new(lease_now.to_string()));
        index += 1;
        let status_index = index;
        values.push(Box::new(expected_status.as_str().to_string()));
        index += 1;
        let id_index = index;
        values.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE media_runs SET {} WHERE id = ?{id_index} AND status = ?{status_index}
             AND lease_owner = ?{owner_index} AND lease_expires_at IS NOT NULL
             AND lease_expires_at > ?{lease_now_index}
             AND status NOT IN ('succeeded', 'failed', 'canceled')",
            sets.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to update leased media run: {e}"))
    }

    pub fn update_run_from_status(
        &self,
        id: &str,
        expected_status: MediaRunStatus,
        req: &UpdateMediaRunRequest,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        let mut sets: Vec<String> = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut index = 1;
        if let Some(status) = req.status {
            sets.push(format!("status = ?{index}"));
            values.push(Box::new(status.as_str().to_string()));
            index += 1;
        }
        if let Some(attempt) = req.attempt {
            sets.push(format!("attempt = ?{index}"));
            values.push(Box::new(attempt));
            index += 1;
        }
        if let Some(priority) = req.priority {
            sets.push(format!("priority = ?{index}"));
            values.push(Box::new(priority));
            index += 1;
        }
        macro_rules! nullable_field {
            ($field:literal, $value:expr) => {
                if let Some(value) = &$value {
                    sets.push(format!(concat!($field, " = ?{}"), index));
                    values.push(Box::new(value.clone()));
                    index += 1;
                }
            };
        }
        nullable_field!("progress", req.progress);
        nullable_field!("remote_job_id", req.remote_job_id);
        nullable_field!("error_code", req.error_code);
        nullable_field!("error_message", req.error_message);
        nullable_field!("lease_owner", req.lease_owner);
        nullable_field!("lease_expires_at", req.lease_expires_at);
        if sets.is_empty() {
            return Ok(false);
        }
        sets.push(format!("updated_at = ?{index}"));
        values.push(Box::new(updated_at.to_string()));
        index += 1;
        let status_index = index;
        values.push(Box::new(expected_status.as_str().to_string()));
        index += 1;
        let id_index = index;
        values.push(Box::new(id.to_string()));
        let sql = format!(
            "UPDATE media_runs SET {} WHERE id = ?{id_index} AND status = ?{status_index}",
            sets.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to update media run: {e}"))
    }

    pub fn renew_run_lease(
        &self,
        id: &str,
        owner: &str,
        lease_expires_at: &str,
        updated_at: &str,
    ) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE media_runs SET lease_expires_at = ?1, updated_at = ?2
             WHERE id = ?3 AND lease_owner = ?4 AND status NOT IN ('succeeded', 'failed', 'canceled')",
            params![lease_expires_at, updated_at, id, owner],
        )
        .map(|count| count > 0)
            .map_err(|e| format!("Failed to renew media run lease: {e}"))
    }

    pub fn clear_run_lease(&self, id: &str, owner: &str, updated_at: &str) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE media_runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?1
             WHERE id = ?2 AND lease_owner = ?3",
            params![updated_at, id, owner],
        )
        .map(|count| count > 0)
        .map_err(|e| format!("Failed to clear media run lease: {e}"))
    }

    pub fn retry_run(&self, id: &str, updated_at: &str) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE media_runs
             SET status = 'queued', attempt = attempt + 1, progress = 0,
                  error_code = NULL, error_message = NULL, remote_job_id = NULL,
                  lease_owner = NULL, lease_expires_at = NULL, cache_hit = 0, updated_at = ?1
             WHERE id = ?2 AND status IN ('failed', 'canceled')",
            params![updated_at, id],
        )
        .map(|count| count > 0)
        .map_err(|e| format!("Failed to retry media run: {e}"))
    }

    fn replace_run_assets(&self, conn: &Connection, run: &MediaRun) -> Result<(), String> {
        conn.execute(
            "DELETE FROM media_run_assets WHERE run_id = ?1",
            params![run.id],
        )
        .map_err(|e| format!("Failed to clear media run assets: {e}"))?;
        for (ordinal, id) in run.input_asset_ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO media_run_assets (run_id, asset_id, role, ordinal) VALUES (?1, ?2, 'input', ?3)",
                params![run.id, id, ordinal as i64],
            )
            .map_err(|e| format!("Failed to link media input asset: {e}"))?;
        }
        for (ordinal, id) in run.output_asset_ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO media_run_assets (run_id, asset_id, role, ordinal) VALUES (?1, ?2, 'output', ?3)",
                params![run.id, id, ordinal as i64],
            )
            .map_err(|e| format!("Failed to link media output asset: {e}"))?;
        }
        Ok(())
    }

    pub fn replace_run_assets_for_run(&self, run: &MediaRun) -> Result<(), String> {
        let mut conn = self.connection()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start media asset-link transaction: {e}"))?;
        self.replace_run_assets(&tx, run)?;
        tx.commit()
            .map_err(|e| format!("Failed to commit media asset links: {e}"))
    }

    // ---------------------------------------------------------------------
    // Assets
    // ---------------------------------------------------------------------

    pub fn insert_asset(&self, asset: &MediaAsset) -> Result<(), String> {
        let mut conn = self.connection()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start media asset transaction: {e}"))?;
        tx.execute(
            "INSERT INTO media_assets (
                id, workspace_id, run_id, relative_path, mime_type, size_bytes, sha256,
                width, height, duration_ms, metadata_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                asset.id,
                asset.workspace_id,
                asset.run_id,
                asset.relative_path,
                asset.mime_type,
                asset.size_bytes,
                asset.sha256,
                asset.width,
                asset.height,
                asset.duration_ms,
                json_text(&asset.metadata)?,
                asset.created_at,
            ],
        )
        .map_err(|e| format!("Failed to insert media asset: {e}"))?;
        if let Some(run_id) = &asset.run_id {
            tx.execute(
                "INSERT OR IGNORE INTO media_run_assets (run_id, asset_id, role, ordinal)
                 VALUES (?1, ?2, 'output', 0)",
                params![run_id, asset.id],
            )
            .map_err(|e| format!("Failed to link media asset to run: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit media asset: {e}"))?;
        Ok(())
    }

    /// Insert an output asset only while the worker still owns a live run
    /// lease. The ownership check and the asset/link writes share one
    /// transaction so an expired worker cannot attach a late download after a
    /// replacement worker has claimed the run.
    pub fn insert_asset_for_run_owner(
        &self,
        asset: &MediaAsset,
        owner: &str,
    ) -> Result<bool, String> {
        let Some(run_id) = asset.run_id.as_deref() else {
            return Err("leased media assets must reference a run".to_string());
        };
        let mut conn = self.connection()?;
        let tx = conn
            // Acquire the SQLite write lock before checking the lease. A
            // deferred transaction would allow another worker to claim the
            // expired run between the SELECT and the first INSERT.
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("Failed to start leased media asset transaction: {e}"))?;
        let now = Utc::now().to_rfc3339();
        let owned = tx
            .query_row(
                "SELECT 1 FROM media_runs
                 WHERE id = ?1 AND lease_owner = ?2 AND lease_expires_at IS NOT NULL
                   AND lease_expires_at > ?3
                   AND status NOT IN ('succeeded', 'failed', 'canceled')",
                params![run_id, owner, now],
                |_row| Ok(()),
            )
            .optional()
            .map_err(|e| format!("Failed to check media run lease: {e}"))?
            .is_some();
        if !owned {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO media_assets (
                id, workspace_id, run_id, relative_path, mime_type, size_bytes, sha256,
                width, height, duration_ms, metadata_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                asset.id,
                asset.workspace_id,
                asset.run_id,
                asset.relative_path,
                asset.mime_type,
                asset.size_bytes,
                asset.sha256,
                asset.width,
                asset.height,
                asset.duration_ms,
                json_text(&asset.metadata)?,
                asset.created_at,
            ],
        )
        .map_err(|e| format!("Failed to insert leased media asset: {e}"))?;
        let ordinal: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(ordinal) + 1, 0)
                 FROM media_run_assets WHERE run_id = ?1 AND role = 'output'",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to allocate media output ordinal: {e}"))?;
        tx.execute(
            "INSERT INTO media_run_assets (run_id, asset_id, role, ordinal)
             VALUES (?1, ?2, 'output', ?3)",
            params![run_id, asset.id, ordinal],
        )
        .map_err(|e| format!("Failed to link leased media asset to run: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit leased media asset: {e}"))?;
        Ok(true)
    }

    pub fn delete_asset(&self, id: &str) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM media_assets WHERE id = ?1", params![id])
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to delete media asset: {e}"))
    }

    pub fn get_asset(&self, id: &str) -> Result<Option<MediaAsset>, String> {
        let conn = self.connection()?;
        conn.query_row(
            &format!("{ASSET_SELECT} WHERE id = ?1"),
            params![id],
            row_to_asset,
        )
        .optional()
        .map_err(|e| format!("Failed to load media asset: {e}"))
    }

    pub fn list_assets(
        &self,
        workspace_id: &str,
        run_id: Option<&str>,
    ) -> Result<Vec<MediaAsset>, String> {
        let conn = self.connection()?;
        let mut result = if let Some(run_id) = run_id {
            let mut stmt = conn
                .prepare(
                    "SELECT a.id, a.workspace_id, a.run_id, a.relative_path, a.mime_type,
                                  a.size_bytes, a.sha256, a.width, a.height, a.duration_ms,
                                  a.metadata_json, a.created_at
                           FROM media_run_assets l
                           JOIN media_assets a ON a.id = l.asset_id
                           WHERE a.workspace_id = ?1 AND l.run_id = ?2 AND l.role = 'output'
                           ORDER BY l.ordinal ASC, a.created_at DESC",
                )
                .map_err(|e| format!("Failed to prepare media asset list: {e}"))?;
            let rows = stmt
                .query_map(params![workspace_id, run_id], row_to_asset)
                .map_err(|e| format!("Failed to query media assets: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to read media assets: {e}"))?
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, workspace_id, run_id, relative_path, mime_type, size_bytes, sha256,
                                  width, height, duration_ms, metadata_json, created_at
                           FROM media_assets WHERE workspace_id = ?1
                           ORDER BY created_at DESC",
                )
                .map_err(|e| format!("Failed to prepare media asset list: {e}"))?;
            let rows = stmt
                .query_map(params![workspace_id], row_to_asset)
                .map_err(|e| format!("Failed to query media assets: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to read media assets: {e}"))?
        };
        Ok(std::mem::take(&mut result))
    }

    // ---------------------------------------------------------------------
    // Edges
    // ---------------------------------------------------------------------

    pub fn insert_edge(&self, edge: &MediaEdge) -> Result<(), String> {
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO media_edges (
                id, workspace_id, layout_id, source_node_id, source_port,
                target_node_id, target_port, selector, asset_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                edge.id,
                edge.workspace_id,
                edge.layout_id,
                edge.source_node_id,
                edge.source_port,
                edge.target_node_id,
                edge.target_port,
                edge.selector.as_str(),
                edge.asset_id,
                edge.created_at,
            ],
        )
        .map_err(|e| format!("Failed to insert media edge: {e}"))?;
        Ok(())
    }

    pub fn get_edge(&self, id: &str) -> Result<Option<MediaEdge>, String> {
        let conn = self.connection()?;
        conn.query_row(
            &format!("{EDGE_SELECT} WHERE id = ?1"),
            params![id],
            row_to_edge,
        )
        .optional()
        .map_err(|e| format!("Failed to load media edge: {e}"))
    }

    pub fn list_edges(
        &self,
        workspace_id: &str,
        layout_id: Option<&str>,
    ) -> Result<Vec<MediaEdge>, String> {
        let conn = self.connection()?;
        let mut sql = String::from(EDGE_LIST_SELECT);
        sql.push_str(" WHERE workspace_id = ?1");
        if layout_id.is_some() {
            sql.push_str(" AND layout_id = ?2");
        }
        sql.push_str(" ORDER BY created_at ASC");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare media edge list: {e}"))?;
        let rows = if let Some(layout_id) = layout_id {
            stmt.query_map(params![workspace_id, layout_id], row_to_edge)
                .map_err(|e| format!("Failed to query media edges: {e}"))?
                .collect::<Result<Vec<_>, _>>()
        } else {
            stmt.query_map(params![workspace_id], row_to_edge)
                .map_err(|e| format!("Failed to query media edges: {e}"))?
                .collect::<Result<Vec<_>, _>>()
        };
        rows.map_err(|e| format!("Failed to read media edges: {e}"))
    }

    pub fn delete_edge(&self, id: &str) -> Result<bool, String> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM media_edges WHERE id = ?1", params![id])
            .map(|count| count > 0)
            .map_err(|e| format!("Failed to delete media edge: {e}"))
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.db.connection().map_err(|e| e.to_string())
    }
}

const NODE_SELECT: &str = "SELECT id, workspace_id, layout_id, kind, title, default_operation,
    provider_id, model_id, parameters_json, deleted_at, created_at, updated_at
    FROM media_nodes";

const NODE_LIST_SELECT: &str = "SELECT id, workspace_id, layout_id, kind, title, default_operation,
    provider_id, model_id, parameters_json, deleted_at, created_at, updated_at
    FROM media_nodes";

const RUN_SELECT: &str =
    "SELECT id, node_id, operation, status, attempt, priority, cache_policy, client_request_id,
    provider_id, model_id, request_json, remote_job_id, progress, error_code, error_message,
    lease_owner, lease_expires_at, execution_fingerprint, cache_hit, created_at, updated_at
    FROM media_runs";

const ASSET_SELECT: &str = "SELECT id, workspace_id, run_id, relative_path, mime_type, size_bytes,
    sha256, width, height, duration_ms, metadata_json, created_at
    FROM media_assets";

const EDGE_SELECT: &str = "SELECT id, workspace_id, layout_id, source_node_id, source_port,
    target_node_id, target_port, selector, asset_id, created_at
    FROM media_edges";

const EDGE_LIST_SELECT: &str = "SELECT id, workspace_id, layout_id, source_node_id, source_port,
    target_node_id, target_port, selector, asset_id, created_at
    FROM media_edges";

fn provider_columns(provider: Option<&MediaProviderRef>) -> (Option<String>, Option<String>) {
    provider
        .map(|p| (Some(p.provider_id.clone()), Some(p.model_id.clone())))
        .unwrap_or((None, None))
}

fn json_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Failed to serialize media JSON: {e}"))
}

fn parse_json(value: String, field: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid {field}: {e}"),
            )),
        )
    })
}

fn row_to_node(row: &Row<'_>) -> rusqlite::Result<MediaNode> {
    let provider_id: Option<String> = row.get(6)?;
    let model_id: Option<String> = row.get(7)?;
    Ok(MediaNode {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        layout_id: row.get(2)?,
        kind: MediaKind::from_str(row.get::<_, String>(3)?.as_str()).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            )
        })?,
        title: row.get(4)?,
        default_operation: MediaOperation::from_str(row.get::<_, String>(5)?.as_str()).map_err(
            |e| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            },
        )?,
        provider_ref: provider_id
            .zip(model_id)
            .map(|(provider_id, model_id)| MediaProviderRef {
                provider_id,
                model_id,
            }),
        parameters: parse_json(row.get(8)?, "parameters_json")?,
        deleted_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn row_to_run(row: &Row<'_>) -> rusqlite::Result<MediaRun> {
    let provider_id: Option<String> = row.get(8)?;
    let model_id: Option<String> = row.get(9)?;
    Ok(MediaRun {
        id: row.get(0)?,
        node_id: row.get(1)?,
        operation: MediaOperation::from_str(row.get::<_, String>(2)?.as_str()).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            )
        })?,
        status: MediaRunStatus::from_str(row.get::<_, String>(3)?.as_str()).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            )
        })?,
        attempt: row.get(4)?,
        priority: row.get(5)?,
        cache_policy: MediaCachePolicy::from_str(row.get::<_, String>(6)?.as_str()).map_err(
            |e| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            },
        )?,
        client_request_id: row.get(7)?,
        provider_ref: provider_id
            .zip(model_id)
            .map(|(provider_id, model_id)| MediaProviderRef {
                provider_id,
                model_id,
            }),
        request: parse_json(row.get(10)?, "request_json")?,
        remote_job_id: row.get(11)?,
        progress: row.get(12)?,
        error_code: row.get(13)?,
        error_message: row.get(14)?,
        lease_owner: row.get(15)?,
        lease_expires_at: row.get(16)?,
        execution_fingerprint: row.get(17)?,
        cache_hit: row.get::<_, i32>(18)? != 0,
        input_asset_ids: Vec::new(),
        output_asset_ids: Vec::new(),
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn load_run_assets(conn: &Connection, mut run: MediaRun) -> Result<MediaRun, String> {
    let mut stmt = conn
        .prepare(
            "SELECT asset_id, role FROM media_run_assets WHERE run_id = ?1 ORDER BY role, ordinal",
        )
        .map_err(|e| format!("Failed to prepare media run asset links: {e}"))?;
    let links = stmt
        .query_map(params![run.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query media run asset links: {e}"))?;
    for link in links {
        let (asset_id, role) = link.map_err(|e| e.to_string())?;
        if role == "input" {
            run.input_asset_ids.push(asset_id);
        } else {
            run.output_asset_ids.push(asset_id);
        }
    }
    Ok(run)
}

fn row_to_asset(row: &Row<'_>) -> rusqlite::Result<MediaAsset> {
    Ok(MediaAsset {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        run_id: row.get(2)?,
        relative_path: row.get(3)?,
        mime_type: row.get(4)?,
        size_bytes: row.get(5)?,
        sha256: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        duration_ms: row.get(9)?,
        metadata: parse_json(row.get(10)?, "metadata_json")?,
        created_at: row.get(11)?,
    })
}

fn row_to_edge(row: &Row<'_>) -> rusqlite::Result<MediaEdge> {
    Ok(MediaEdge {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        layout_id: row.get(2)?,
        source_node_id: row.get(3)?,
        source_port: row.get(4)?,
        target_node_id: row.get(5)?,
        target_port: row.get(6)?,
        selector: MediaEdgeSelector::from_str(row.get::<_, String>(7)?.as_str()).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            )
        })?,
        asset_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MediaOperation;

    fn repo() -> MediaRepository {
        MediaRepository::new(Arc::new(Database::new_in_memory().expect("database")))
    }

    fn node(id: &str) -> MediaNode {
        MediaNode {
            id: id.to_string(),
            workspace_id: "ws".to_string(),
            layout_id: "layout".to_string(),
            kind: MediaKind::Image,
            title: "Image".to_string(),
            default_operation: MediaOperation::TextToImage,
            provider_ref: None,
            parameters: serde_json::json!({"width": 512}),
            deleted_at: None,
            created_at: "2026-08-25T00:00:00Z".to_string(),
            updated_at: "2026-08-25T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn node_round_trip_and_soft_delete() {
        let repo = repo();
        let item = node("n1");
        repo.insert_node(&item).unwrap();
        assert_eq!(repo.get_node("n1").unwrap(), Some(item));
        assert_eq!(
            repo.list_nodes("ws", Some("layout"), false).unwrap().len(),
            1
        );
        assert!(repo.soft_delete_node("n1", "2026-08-25T01:00:00Z").unwrap());
        assert!(repo
            .list_nodes("ws", Some("layout"), false)
            .unwrap()
            .is_empty());
        assert_eq!(
            repo.list_nodes("ws", Some("layout"), true).unwrap().len(),
            1
        );
    }

    #[test]
    fn run_assets_round_trip_and_idempotency_lookup() {
        let repo = repo();
        repo.insert_node(&node("n1")).unwrap();
        let run = MediaRun {
            id: "r1".to_string(),
            node_id: "n1".to_string(),
            operation: MediaOperation::TextToImage,
            status: MediaRunStatus::Queued,
            attempt: 1,
            priority: 0,
            cache_policy: MediaCachePolicy::ReadWrite,
            client_request_id: Some("client-1".to_string()),
            provider_ref: None,
            request: serde_json::json!({"prompt":"hello"}),
            remote_job_id: None,
            progress: Some(0),
            error_code: None,
            error_message: None,
            lease_owner: None,
            lease_expires_at: None,
            execution_fingerprint: None,
            cache_hit: false,
            input_asset_ids: vec![],
            output_asset_ids: vec![],
            created_at: "2026-08-25T00:00:00Z".to_string(),
            updated_at: "2026-08-25T00:00:00Z".to_string(),
        };
        repo.insert_run(&run).unwrap();
        assert_eq!(
            repo.find_run_by_client_request_id("client-1")
                .unwrap()
                .unwrap()
                .id,
            "r1"
        );
        let asset = MediaAsset {
            id: "a1".to_string(),
            workspace_id: "ws".to_string(),
            run_id: Some("r1".to_string()),
            relative_path: "ws/a1.png".to_string(),
            mime_type: "image/png".to_string(),
            size_bytes: 10,
            sha256: Some("abc".to_string()),
            width: Some(2),
            height: Some(3),
            duration_ms: None,
            metadata: serde_json::json!({}),
            created_at: run.created_at.clone(),
        };
        repo.insert_asset(&asset).unwrap();
        let mut loaded = repo.get_run("r1").unwrap().unwrap();
        loaded.output_asset_ids = vec!["a1".to_string()];
        repo.replace_run_assets_for_run(&loaded).unwrap();
        assert_eq!(
            repo.get_run("r1").unwrap().unwrap().output_asset_ids,
            vec!["a1"]
        );
    }

    #[test]
    fn same_owner_can_renew_a_live_run_for_polling() {
        let repo = repo();
        repo.insert_node(&node("n-live")).unwrap();
        repo.insert_run(&MediaRun {
            id: "r-live".to_string(),
            node_id: "n-live".to_string(),
            operation: MediaOperation::TextToImage,
            status: MediaRunStatus::Queued,
            attempt: 1,
            priority: 0,
            cache_policy: MediaCachePolicy::ReadWrite,
            client_request_id: None,
            provider_ref: None,
            request: serde_json::json!({}),
            remote_job_id: None,
            progress: Some(0),
            error_code: None,
            error_message: None,
            lease_owner: None,
            lease_expires_at: None,
            execution_fingerprint: None,
            cache_hit: false,
            input_asset_ids: vec![],
            output_asset_ids: vec![],
            created_at: "2026-08-25T00:00:00Z".to_string(),
            updated_at: "2026-08-25T00:00:00Z".to_string(),
        })
        .unwrap();

        let first = repo
            .claim_next_run("worker-a", "2026-08-25T00:01:00Z", "2026-08-25T01:01:00Z")
            .unwrap()
            .expect("first claim");
        assert_eq!(first.status, MediaRunStatus::Submitting);
        repo.update_run(
            "r-live",
            &UpdateMediaRunRequest {
                status: Some(MediaRunStatus::Processing),
                remote_job_id: Some(Some("remote-live".to_string())),
                ..Default::default()
            },
            "2026-08-25T00:01:01Z",
        )
        .unwrap();
        let renewed = repo
            .claim_next_run("worker-a", "2026-08-25T00:02:00Z", "2026-08-25T01:02:00Z")
            .unwrap()
            .expect("same owner should renew the live run");
        assert_eq!(renewed.id, first.id);
        assert_eq!(renewed.lease_owner.as_deref(), Some("worker-a"));
        assert_eq!(
            renewed.lease_expires_at.as_deref(),
            Some("2026-08-25T01:02:00Z")
        );
        assert!(repo
            .claim_next_run("worker-b", "2026-08-25T00:03:00Z", "2026-08-25T01:03:00Z",)
            .unwrap()
            .is_none());
    }

    #[test]
    fn leased_asset_insert_is_fenced_by_live_owner() {
        let repo = repo();
        repo.insert_node(&node("n1")).unwrap();
        let run = MediaRun {
            id: "r-lease".to_string(),
            node_id: "n1".to_string(),
            operation: MediaOperation::TextToImage,
            status: MediaRunStatus::Processing,
            attempt: 1,
            priority: 0,
            cache_policy: MediaCachePolicy::ReadWrite,
            client_request_id: None,
            provider_ref: None,
            request: serde_json::json!({}),
            remote_job_id: Some("remote-1".to_string()),
            progress: Some(50),
            error_code: None,
            error_message: None,
            lease_owner: Some("owner-a".to_string()),
            lease_expires_at: Some("2999-01-01T00:00:00Z".to_string()),
            execution_fingerprint: None,
            cache_hit: false,
            input_asset_ids: vec![],
            output_asset_ids: vec![],
            created_at: "2026-08-25T00:00:00Z".to_string(),
            updated_at: "2026-08-25T00:00:00Z".to_string(),
        };
        repo.insert_run(&run).unwrap();
        let asset = MediaAsset {
            id: "a-lease".to_string(),
            workspace_id: "ws".to_string(),
            run_id: Some(run.id.clone()),
            relative_path: "ws/a-lease.png".to_string(),
            mime_type: "image/png".to_string(),
            size_bytes: 1,
            sha256: None,
            width: None,
            height: None,
            duration_ms: None,
            metadata: serde_json::json!({}),
            created_at: run.created_at.clone(),
        };
        assert!(!repo.insert_asset_for_run_owner(&asset, "owner-b").unwrap());
        assert!(repo.get_asset(&asset.id).unwrap().is_none());
        assert!(repo.insert_asset_for_run_owner(&asset, "owner-a").unwrap());
        assert_eq!(
            repo.get_run(&run.id).unwrap().unwrap().output_asset_ids,
            vec![asset.id]
        );
    }

    #[test]
    fn insert_run_rolls_back_when_asset_link_fails() {
        let repo = repo();
        repo.insert_node(&node("n1")).unwrap();
        let run = MediaRun {
            id: "r-rollback".to_string(),
            node_id: "n1".to_string(),
            operation: MediaOperation::TextToImage,
            status: MediaRunStatus::Queued,
            attempt: 1,
            priority: 0,
            cache_policy: MediaCachePolicy::ReadWrite,
            client_request_id: None,
            provider_ref: None,
            request: serde_json::json!({}),
            remote_job_id: None,
            progress: Some(0),
            error_code: None,
            error_message: None,
            lease_owner: None,
            lease_expires_at: None,
            execution_fingerprint: None,
            cache_hit: false,
            input_asset_ids: vec!["missing".into()],
            output_asset_ids: vec![],
            created_at: "2026-08-25T00:00:00Z".into(),
            updated_at: "2026-08-25T00:00:00Z".into(),
        };
        assert!(repo.insert_run(&run).is_err());
        assert!(repo.get_run(&run.id).unwrap().is_none());
    }
}
