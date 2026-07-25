use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Value};

const EXPECTED_SCHEMA_VERSION: i64 = 23;
const EXPECTED_USER_VERSION: i64 = 0;
const SELECT_FIELDS: &str = "id, title, role, parent_id, plan_path, normalized_plan_path, prompt, \
    session_id, resume_id, pane_id, tab_id, todo_id, project_path, workspace_name, cli_tool, \
    status, progress, completion_summary, exit_code, sort_order, metadata, created_at, updated_at";
const EXPECTED_COLUMNS: &[&str] = &[
    "id",
    "title",
    "prompt",
    "session_id",
    "todo_id",
    "project_path",
    "workspace_name",
    "cli_tool",
    "status",
    "progress",
    "completion_summary",
    "exit_code",
    "sort_order",
    "created_at",
    "updated_at",
    "role",
    "parent_id",
    "plan_path",
    "normalized_plan_path",
    "pane_id",
    "tab_id",
    "resume_id",
    "metadata",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OfflineDbError {
    Conflict(String),
    Invalid(String),
    Database(String),
}

impl OfflineDbError {
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict(_))
    }
}

impl fmt::Display for OfflineDbError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(message) | Self::Invalid(message) | Self::Database(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for OfflineDbError {}

#[derive(Debug, Clone)]
pub struct OfflineCloseRequest {
    pub id: String,
    pub status: String,
    pub progress: i32,
    pub completion_summary: Option<String>,
    pub exit_code: Option<i32>,
}

/// 只读 fallback。返回值显式标记 `source=offline-db` 和 `incomplete=true`。
pub fn list_bindings(db_path: &Path) -> Result<Value, OfflineDbError> {
    let conn = open_existing(db_path, true)?;
    validate_schema(&conn)?;
    let sql = format!(
        "SELECT {SELECT_FIELDS} FROM task_bindings ORDER BY sort_order ASC, created_at ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|error| db_error("准备离线 binding 查询", error))?;
    let items = stmt
        .query_map([], row_to_binding)
        .map_err(|error| db_error("执行离线 binding 查询", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("解析离线 binding", error))?;
    Ok(json!({
        "items": items,
        "total": items.len(),
        "hasMore": false,
        "source": "offline-db",
        "incomplete": true,
        "warning": "orchestrator 不可达；结果绕过服务层且可能缺少尚未落库的运行态"
    }))
}

/// 紧急逃生阀：只允许 terminal close 字段，使用 BEGIN IMMEDIATE、updated_at+status CAS
/// 并在同一事务内回读。该路径绕过 service lock、校验、事件、leader 通知与补投队列。
pub fn close_binding(
    db_path: &Path,
    request: &OfflineCloseRequest,
) -> Result<Value, OfflineDbError> {
    validate_close_request(request)?;
    let mut conn = open_existing(db_path, false)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| db_error("设置 SQLite busy timeout", error))?;
    validate_schema(&conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("BEGIN IMMEDIATE", error))?;
    let (expected_updated_at, expected_status) = binding_cas_state(&tx, &request.id)?;
    let affected = tx
        .execute(
            "UPDATE task_bindings
             SET status = ?1, progress = ?2, completion_summary = ?3, exit_code = ?4,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?5 AND updated_at = ?6 AND status = ?7",
            params![
                request.status,
                request.progress,
                request.completion_summary,
                request.exit_code,
                request.id,
                expected_updated_at,
                expected_status,
            ],
        )
        .map_err(|error| db_error("CAS 更新 TaskBinding", error))?;
    if affected != 1 {
        return Err(OfflineDbError::Conflict(format!(
            "TaskBinding '{}' 已被并发修改，未写入",
            request.id
        )));
    }
    let binding = get_binding(&tx, &request.id)?.ok_or_else(|| {
        OfflineDbError::Conflict(format!("TaskBinding '{}' 更新后消失", request.id))
    })?;
    if binding["status"] != request.status || binding["progress"] != request.progress {
        return Err(OfflineDbError::Conflict(format!(
            "TaskBinding '{}' 事务后回读校验失败",
            request.id
        )));
    }
    tx.commit()
        .map_err(|error| db_error("提交离线 TaskBinding 更新", error))?;
    Ok(json!({
        "binding": binding,
        "source": "offline-db",
        "limited": true,
        "warning": offline_write_warning()
    }))
}

/// 有限离线 reconcile：仅用 daemon 活会话把 running/waiting 的失联 binding 标为 failed。
/// 前端 pane/tab 快照、事件与通知均不可用，因此结果绝不宣称与服务层等价。
pub fn reconcile_bindings(
    db_path: &Path,
    leader_id: Option<&str>,
    plan_path: Option<&str>,
    live_sessions: &HashSet<String>,
) -> Result<Value, OfflineDbError> {
    if leader_id.is_none() == plan_path.is_none() {
        return Err(OfflineDbError::Invalid(
            "离线 reconcile 必须且只能提供 --leader-id 或 --plan-path".to_string(),
        ));
    }
    let mut conn = open_existing(db_path, false)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| db_error("设置 SQLite busy timeout", error))?;
    validate_schema(&conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| db_error("BEGIN IMMEDIATE", error))?;
    let resolved_leader = resolve_leader_id(&tx, leader_id, plan_path)?;
    let sql = "SELECT id, session_id, status, updated_at FROM task_bindings
               WHERE id = ?1 OR parent_id = ?1 ORDER BY sort_order ASC, created_at ASC";
    let candidates = {
        let mut stmt = tx
            .prepare(sql)
            .map_err(|error| db_error("准备离线 reconcile", error))?;
        let rows = stmt
            .query_map(params![resolved_leader], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| db_error("查询离线 reconcile candidates", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| db_error("解析离线 reconcile candidates", error))?;
        rows
    };
    let mut updated_ids = Vec::new();
    for (id, session_id, status, updated_at) in candidates {
        let active_status = status == "running" || status == "waiting";
        let session_live = session_id
            .as_ref()
            .is_some_and(|session_id| live_sessions.contains(session_id));
        if !active_status || session_live {
            continue;
        }
        let affected = tx
            .execute(
                "UPDATE task_bindings
                 SET status = 'failed', exit_code = COALESCE(exit_code, -1),
                     completion_summary = COALESCE(NULLIF(completion_summary, ''),
                         'offline reconcile: daemon session not active'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1 AND updated_at = ?2 AND status = ?3",
                params![id, updated_at, status],
            )
            .map_err(|error| db_error("CAS reconcile TaskBinding", error))?;
        if affected != 1 {
            return Err(OfflineDbError::Conflict(format!(
                "TaskBinding '{id}' 已被并发修改，reconcile 已回滚"
            )));
        }
        let verified = get_binding(&tx, &id)?.is_some_and(|binding| binding["status"] == "failed");
        if !verified {
            return Err(OfflineDbError::Conflict(format!(
                "TaskBinding '{id}' reconcile 回读校验失败"
            )));
        }
        updated_ids.push(id);
    }
    tx.commit()
        .map_err(|error| db_error("提交离线 reconcile", error))?;
    Ok(json!({
        "leaderId": resolved_leader,
        "updatedIds": updated_ids,
        "source": "offline-db",
        "limited": true,
        "warning": format!(
            "{}；离线 reconcile 仅参考 daemon 活会话，不含前端 pane/tab 快照",
            offline_write_warning()
        )
    }))
}

fn open_existing(path: &Path, read_only: bool) -> Result<Connection, OfflineDbError> {
    if !path.is_file() {
        return Err(OfflineDbError::Invalid(format!(
            "数据库不存在: {}",
            path.display()
        )));
    }
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Connection::open_with_flags(path, flags)
        .map_err(|error| db_error("打开既有 SQLite 数据库", error))
}

fn validate_schema(conn: &Connection) -> Result<(), OfflineDbError> {
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| db_error("读取 PRAGMA user_version", error))?;
    if user_version != EXPECTED_USER_VERSION {
        return Err(OfflineDbError::Invalid(format!(
            "拒绝离线访问: user_version={user_version}，期望 {EXPECTED_USER_VERSION}"
        )));
    }
    let schema_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| db_error("读取 schema_migrations", error))?;
    if schema_version != EXPECTED_SCHEMA_VERSION {
        return Err(OfflineDbError::Invalid(format!(
            "拒绝离线访问: schema version={schema_version}，期望 {EXPECTED_SCHEMA_VERSION}"
        )));
    }
    let mut stmt = conn
        .prepare("PRAGMA table_info(task_bindings)")
        .map_err(|error| db_error("读取 task_bindings schema", error))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| db_error("查询 task_bindings columns", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("解析 task_bindings columns", error))?;
    if columns != EXPECTED_COLUMNS {
        return Err(OfflineDbError::Invalid(format!(
            "拒绝离线访问: task_bindings 列不匹配，实际为 {}",
            columns.join(",")
        )));
    }
    Ok(())
}

fn validate_close_request(request: &OfflineCloseRequest) -> Result<(), OfflineDbError> {
    if request.status != "completed" && request.status != "failed" {
        return Err(OfflineDbError::Invalid(
            "bindings close 的 status 只能是 completed 或 failed".to_string(),
        ));
    }
    if !(0..=100).contains(&request.progress) {
        return Err(OfflineDbError::Invalid(
            "bindings close 的 progress 必须在 0-100".to_string(),
        ));
    }
    Ok(())
}

fn binding_cas_state(tx: &Transaction<'_>, id: &str) -> Result<(String, String), OfflineDbError> {
    tx.query_row(
        "SELECT updated_at, status FROM task_bindings WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| db_error("读取 TaskBinding CAS 状态", error))?
    .ok_or_else(|| OfflineDbError::Invalid(format!("TaskBinding '{id}' 不存在")))
}

fn resolve_leader_id(
    tx: &Transaction<'_>,
    leader_id: Option<&str>,
    plan_path: Option<&str>,
) -> Result<String, OfflineDbError> {
    if let Some(id) = leader_id {
        let exists = tx
            .query_row(
                "SELECT 1 FROM task_bindings WHERE id = ?1 AND role = 'leader'",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| db_error("查找 leader", error))?
            .is_some();
        return exists
            .then(|| id.to_string())
            .ok_or_else(|| OfflineDbError::Invalid(format!("leader '{id}' 不存在")));
    }
    let path = plan_path.expect("validated caller");
    tx.query_row(
        "SELECT id FROM task_bindings
         WHERE role = 'leader' AND (plan_path = ?1 OR normalized_plan_path = ?1)
         ORDER BY updated_at DESC LIMIT 1",
        params![path],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| db_error("按 plan path 查找 leader", error))?
    .ok_or_else(|| OfflineDbError::Invalid(format!("plan '{path}' 没有 leader binding")))
}

fn get_binding(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>, OfflineDbError> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM task_bindings WHERE id = ?1");
    tx.query_row(&sql, params![id], row_to_binding)
        .optional()
        .map_err(|error| db_error("回读 TaskBinding", error))
}

fn row_to_binding(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata: Option<String> = row.get(20)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "role": row.get::<_, String>(2)?,
        "parentId": row.get::<_, Option<String>>(3)?,
        "planPath": row.get::<_, Option<String>>(4)?,
        "normalizedPlanPath": row.get::<_, Option<String>>(5)?,
        "prompt": row.get::<_, Option<String>>(6)?,
        "sessionId": row.get::<_, Option<String>>(7)?,
        "resumeId": row.get::<_, Option<String>>(8)?,
        "paneId": row.get::<_, Option<String>>(9)?,
        "tabId": row.get::<_, Option<String>>(10)?,
        "todoId": row.get::<_, Option<String>>(11)?,
        "projectPath": row.get::<_, String>(12)?,
        "workspaceName": row.get::<_, Option<String>>(13)?,
        "cliTool": row.get::<_, String>(14)?,
        "status": row.get::<_, String>(15)?,
        "progress": row.get::<_, i32>(16)?,
        "completionSummary": row.get::<_, Option<String>>(17)?,
        "exitCode": row.get::<_, Option<i32>>(18)?,
        "sortOrder": row.get::<_, i32>(19)?,
        "metadata": metadata.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
        "createdAt": row.get::<_, String>(21)?,
        "updatedAt": row.get::<_, String>(22)?,
    }))
}

fn offline_write_warning() -> &'static str {
    "紧急离线直写已绕过 TaskBindingService update lock、字段校验、事件 emit、leader 通知与补投队列"
}

fn db_error(context: &str, error: impl fmt::Display) -> OfflineDbError {
    OfflineDbError::Database(format!("{context}失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("data.db")).expect("db");
        conn.execute_batch(&format!(
            "PRAGMA user_version = 0;
             CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
             INSERT INTO schema_migrations(version) VALUES ({EXPECTED_SCHEMA_VERSION});
             CREATE TABLE task_bindings(
               id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT, session_id TEXT, todo_id TEXT,
               project_path TEXT NOT NULL, workspace_name TEXT, cli_tool TEXT NOT NULL,
               status TEXT NOT NULL, progress INTEGER NOT NULL, completion_summary TEXT,
               exit_code INTEGER, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, role TEXT NOT NULL, parent_id TEXT, plan_path TEXT,
               normalized_plan_path TEXT, pane_id TEXT, tab_id TEXT, resume_id TEXT, metadata TEXT
             );"
        ))
        .expect("schema");
        conn.execute(
            "INSERT INTO task_bindings(
               id,title,project_path,cli_tool,status,progress,sort_order,created_at,updated_at,role
             ) VALUES ('leader-1','Leader','/project','codex','pending',0,0,'t0','t0','leader')",
            [],
        )
        .expect("leader");
        conn.execute(
            "INSERT INTO task_bindings(
               id,title,parent_id,project_path,cli_tool,status,progress,sort_order,created_at,updated_at,role
             ) VALUES ('worker-1','Worker','leader-1','/project','codex','running',20,1,'t0','t0','worker')",
            [],
        )
        .expect("binding");
        dir
    }

    #[test]
    fn offline_close_uses_whitelist_and_verifies_result() {
        let dir = create_test_db();
        let result = close_binding(
            &dir.path().join("data.db"),
            &OfflineCloseRequest {
                id: "worker-1".to_string(),
                status: "completed".to_string(),
                progress: 100,
                completion_summary: Some("done".to_string()),
                exit_code: Some(0),
            },
        )
        .expect("close");
        assert_eq!(result["binding"]["status"], "completed");
        assert_eq!(result["limited"], true);
    }

    #[test]
    fn rejects_schema_version_drift() {
        let dir = create_test_db();
        let conn = Connection::open(dir.path().join("data.db")).expect("db");
        conn.execute("UPDATE schema_migrations SET version = 24", [])
            .expect("version");
        drop(conn);
        let error = list_bindings(&dir.path().join("data.db")).unwrap_err();
        assert!(error.to_string().contains("schema version=24"));
    }

    #[test]
    fn offline_reconcile_marks_only_missing_active_sessions_failed() {
        let dir = create_test_db();
        let result = reconcile_bindings(
            &dir.path().join("data.db"),
            Some("leader-1"),
            None,
            &HashSet::new(),
        )
        .expect("reconcile");
        assert_eq!(result["updatedIds"], json!(["worker-1"]));
        let bindings = list_bindings(&dir.path().join("data.db")).expect("list");
        let worker = bindings["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|binding| binding["id"] == "worker-1")
            .unwrap();
        assert_eq!(worker["status"], "failed");
        assert_eq!(result["limited"], true);
    }
}
