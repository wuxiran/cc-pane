//! Cheap page snapshot identity without scanning/hashing the task table.
//!
//! SQLite's total_changes covers writes through this connection; data_version
//! covers commits from other connections. The repository epoch prevents comparing
//! connection-local counters across a restart. Both counters are sampled while
//! the same read transaction owns the page's count and rows.
use rusqlite::{Connection, Transaction, TransactionBehavior};

fn version(transaction: &Transaction<'_>) -> Result<(u64, i64), String> {
    // This pragma establishes/reads the main database snapshot. Unsupported
    // engines fail the request rather than returning an unversioned mixed page.
    let external: i64 = transaction
        .query_row("PRAGMA main.data_version", [], |row| row.get(0))
        .map_err(|error| format!("Unable to read task page revision: {error}"))?;
    Ok((transaction.total_changes(), external))
}

pub(super) fn read<T>(
    connection: &mut Connection,
    epoch: &str,
    read_page: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<(T, String), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Unable to start task page snapshot: {error}"))?;
    let before = version(&transaction)?;
    let page = read_page(&transaction)?;
    let after = version(&transaction)?;
    if before != after {
        return Err("[TASK_QUERY_SNAPSHOT_CHANGED] Task page snapshot changed during the read; retry the query".into());
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to finish task page snapshot: {error}"))?;
    // Rollbacks and writes to unrelated tables can conservatively invalidate a
    // revision. Clients must treat it as opaque, not as a count or task version.
    Ok((
        page,
        format!("task-page-v1:{epoch}:{}:{}", before.0, before.1),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_commit_between_count_and_rows_keeps_one_snapshot_and_changes_the_next() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("snapshot.sqlite");
        let mut reader = Connection::open(&path).unwrap();
        reader
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))
            .unwrap();
        reader.execute_batch("CREATE TABLE sample(id TEXT PRIMARY KEY, value TEXT); INSERT INTO sample VALUES('old','before');").unwrap();
        let writer = Connection::open(&path).unwrap();
        let ((count, rows), revision) = read(&mut reader, "epoch", |transaction| {
            let count: u32 = transaction.query_row("SELECT count(*) FROM sample", [], |row| row.get(0)).unwrap();
            writer.execute_batch("BEGIN; DELETE FROM sample; INSERT INTO sample VALUES('new','after'); INSERT INTO sample VALUES('extra','after'); COMMIT;").unwrap();
            let mut statement = transaction.prepare("SELECT id FROM sample ORDER BY id").unwrap();
            let rows = statement.query_map([], |row| row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
            Ok((count, rows))
        }).unwrap();
        assert_eq!(count, 1);
        assert_eq!(rows, ["old"]);
        let (new_count, new_revision) = read(&mut reader, "epoch", |transaction| {
            transaction
                .query_row("SELECT count(*) FROM sample", [], |row| {
                    row.get::<_, u32>(0)
                })
                .map_err(|error| error.to_string())
        })
        .unwrap();
        assert_eq!(new_count, 2);
        assert_ne!(revision, new_revision);
    }

    #[test]
    fn external_rollback_leaves_committed_revision_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollback.sqlite");
        let mut reader = Connection::open(&path).unwrap();
        reader
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))
            .unwrap();
        reader
            .execute_batch("CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1);")
            .unwrap();
        let writer = Connection::open(&path).unwrap();
        let (_, before) = read(&mut reader, "epoch", |_| Ok(())).unwrap();
        writer
            .execute_batch("BEGIN; UPDATE sample SET id=2; ROLLBACK;")
            .unwrap();
        let (value, after) = read(&mut reader, "epoch", |transaction| {
            transaction
                .query_row("SELECT id FROM sample", [], |row| row.get::<_, i32>(0))
                .map_err(|error| error.to_string())
        })
        .unwrap();
        assert_eq!(value, 1);
        assert_eq!(before, after);
    }

    #[test]
    fn inconsistent_snapshot_returns_retry_marker_instead_of_successful_page() {
        let mut reader = Connection::open_in_memory().unwrap();
        reader
            .execute_batch("CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1);")
            .unwrap();
        let error = read(&mut reader, "epoch", |transaction| {
            // Simulate a read callback/counter source that changed its snapshot.
            // No successful page may escape, and dropping the transaction rolls it back.
            transaction.execute("UPDATE sample SET id=2", []).unwrap();
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("[TASK_QUERY_SNAPSHOT_CHANGED]"));
        assert_eq!(
            reader
                .query_row("SELECT id FROM sample", [], |row| row.get::<_, i32>(0))
                .unwrap(),
            1
        );
    }
}
