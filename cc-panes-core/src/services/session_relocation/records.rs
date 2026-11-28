//! CC-Panes 自己的记录：`launch_history.project_path / launch_cwd`、`task_bindings.project_path`。
//! 只改匹配旧路径前缀的值；改之前把原值写进备份目录的 `records.json`。

use super::{remap_path, Job, SessionRelocationReport};
use crate::utils::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;

/// (表, 主键列, 路径列)
const FIELDS: &[(&str, &str, &str)] = &[
    ("launch_history", "id", "project_path"),
    ("launch_history", "id", "launch_cwd"),
    ("task_bindings", "id", "project_path"),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    table: &'static str,
    #[serde(skip)]
    key: &'static str,
    column: &'static str,
    /// 主键（launch_history 是整数，统一转成字符串记录）
    id: String,
    old: String,
    new: String,
}

fn table_exists(conn: &Connection, table: &str) -> AppResult<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(|error| AppError::from(error.to_string()))
}

fn collect(conn: &Connection, job: &Job<'_>) -> AppResult<Vec<Change>> {
    let mut changes = Vec::new();
    for &(table, key, column) in FIELDS {
        if !table_exists(conn, table)? {
            continue;
        }
        // 先用 LIKE 粗筛（`_`/`%` 可能多选，下面用 remap_path 精确过滤），避免全表读进内存。
        let sql = format!(
            "SELECT CAST({key} AS TEXT), {column} FROM {table} \
             WHERE {column} IS NOT NULL AND substr({column}, 1, ?1) = ?2"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| AppError::from(error.to_string()))?;
        let rows = statement
            .query_map(params![job.from.chars().count() as i64, job.from], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| AppError::from(error.to_string()))?;
        for row in rows {
            let (id, old) = row.map_err(|error| AppError::from(error.to_string()))?;
            if let Some(new) = remap_path(&old, &job.from, &job.to) {
                changes.push(Change {
                    table,
                    key,
                    column,
                    id,
                    old,
                    new,
                });
            }
        }
    }
    Ok(changes)
}

pub(super) fn relocate(
    job: &Job<'_>,
    conn: &Connection,
    report: &mut SessionRelocationReport,
) -> AppResult<()> {
    let changes = collect(conn, job)?;
    let count_rows = |table: &str| {
        let mut ids: Vec<&str> = changes
            .iter()
            .filter(|change| change.table == table)
            .map(|change| change.id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    };
    report.launch_history_rows = count_rows("launch_history");
    report.task_binding_rows = count_rows("task_bindings");
    if job.dry_run || changes.is_empty() {
        return Ok(());
    }

    std::fs::create_dir_all(&job.backup_dir)?;
    let body = serde_json::to_string_pretty(&changes)
        .map_err(|error| AppError::from(format!("Failed to serialize records backup: {error}")))?;
    std::fs::write(job.backup_dir.join("records.json"), body)?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|error| AppError::from(error.to_string()))?;
    for change in &changes {
        let sql = format!(
            "UPDATE {} SET {} = ?1 WHERE CAST({} AS TEXT) = ?2 AND {} = ?3",
            change.table, change.column, change.key, change.column
        );
        tx.execute(&sql, params![change.new, change.id, change.old])
            .map_err(|error| AppError::from(error.to_string()))?;
    }
    tx.commit()
        .map_err(|error| AppError::from(error.to_string()))?;
    Ok(())
}
