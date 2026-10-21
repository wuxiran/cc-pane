//! Real repository/SQLite regressions for pages read by desktop and Web clients.
use super::*;
use serde_json::json;

fn item(id: &str) -> TaskBinding {
    serde_json::from_value(json!({
        "id":id,"title":id,"role":"task","projectPath":"/repo","cliTool":"claude",
        "status":"pending","progress":0,"sortOrder":0,
        "createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z"
    }))
    .unwrap()
}

fn page(repo: &TaskBindingRepository, offset: u32) -> TaskBindingQueryResult {
    repo.query(&TaskBindingQuery {
        limit: Some(200),
        offset: Some(offset),
        ..Default::default()
    })
    .unwrap()
}

fn revision(page: &TaskBindingQueryResult) -> String {
    serde_json::to_value(page)
        .unwrap()
        .get("revision")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .expect("query pages must carry a snapshot revision")
        .to_owned()
}

#[test]
fn query_revision_covers_same_connection_metadata_order_and_delete_insert() {
    let db = Arc::new(Database::new_in_memory().unwrap());
    let repo = TaskBindingRepository::new(db);
    for n in 0..401 {
        repo.insert(&item(&format!("task-{n:04}"))).unwrap();
    }
    let first = page(&repo, 0);
    assert_eq!(first.items.len(), 200);
    assert!(first.has_more);
    let mut previous = revision(&first);
    assert_eq!(revision(&page(&repo, 200)), previous);
    for update in [
        UpdateTaskBindingRequest {
            metadata: Some(json!({"ui":{"note":"changed"}})),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            sort_order: Some(-1),
            ..Default::default()
        },
        UpdateTaskBindingRequest {
            progress: Some(70),
            ..Default::default()
        },
    ] {
        repo.update("task-0400", &update).unwrap();
        let current = revision(&page(&repo, 200));
        assert_ne!(current, previous);
        previous = current;
    }
    repo.delete("task-0000").unwrap();
    repo.insert(&item("new-task")).unwrap();
    let changed = page(&repo, 200);
    assert_eq!(
        changed.total, first.total,
        "same count cannot detect a delete plus insert"
    );
    assert_ne!(revision(&changed), previous);
}

#[test]
fn query_revision_covers_external_connection_writes_and_repository_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("queries.db");
    let db = Arc::new(Database::new(path.clone()).unwrap());
    let repo = TaskBindingRepository::new(db.clone());
    repo.insert(&item("a")).unwrap();
    let first = page(&repo, 0);
    let second = rusqlite::Connection::open(&path).unwrap();
    second
        .execute(
            "UPDATE task_bindings SET title='external', sort_order=8 WHERE id='a'",
            [],
        )
        .unwrap();
    let changed = page(&repo, 0);
    assert_ne!(revision(&changed), revision(&first));
    assert_eq!(changed.items[0].title, "external");
    assert_eq!(revision(&page(&repo, 0)), revision(&changed));
    let recreated = TaskBindingRepository::new(db.clone());
    assert_ne!(
        revision(&page(&recreated, 0)),
        revision(&changed),
        "a new repo must not reuse an old connection-local revision namespace"
    );
    drop(second);
    drop(recreated);
    drop(repo);
    drop(db);
    let reopened = TaskBindingRepository::new(Arc::new(Database::new(path).unwrap()));
    assert_ne!(revision(&page(&reopened, 0)), revision(&changed));
}

#[test]
fn query_stable_tie_breaker_keeps_identical_sort_keys_in_id_order() {
    let repo = TaskBindingRepository::new(Arc::new(Database::new_in_memory().unwrap()));
    for id in ["d", "b", "c", "a"] {
        repo.insert(&item(id)).unwrap();
    }
    let query = |offset| {
        repo.query(&TaskBindingQuery {
            limit: Some(2),
            offset: Some(offset),
            ..Default::default()
        })
        .unwrap()
    };
    let first = query(0);
    let second = query(2);
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(
        second
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["c", "d"]
    );
}

#[test]
fn query_rollback_never_exposes_uncommitted_rows_and_subsequent_reads_stabilize() {
    let db = Arc::new(Database::new_in_memory().unwrap());
    let repo = TaskBindingRepository::new(db.clone());
    repo.insert(&item("a")).unwrap();
    let before = page(&repo, 0);
    db.connection()
        .unwrap()
        .execute_batch(
            "BEGIN; UPDATE task_bindings SET title='rolled back' WHERE id='a'; ROLLBACK;",
        )
        .unwrap();
    let after = page(&repo, 0);
    assert_eq!(after.items[0].title, before.items[0].title);
    // total_changes may conservatively invalidate a rolled-back local write.
    assert_eq!(revision(&after), revision(&page(&repo, 0)));
}

#[test]
fn query_never_returns_a_successful_partial_page_when_a_row_cannot_be_decoded() {
    let db = Arc::new(Database::new_in_memory().unwrap());
    let repo = TaskBindingRepository::new(db.clone());
    for id in ["a", "b", "c"] {
        repo.insert(&item(id)).unwrap();
    }
    // Malformed optional metadata retains the established fallback, without
    // dropping the task or changing the pagination cardinality.
    db.connection()
        .unwrap()
        .execute(
            "UPDATE task_bindings SET metadata='{broken' WHERE id='b'",
            [],
        )
        .unwrap();
    let complete = page(&repo, 0);
    assert_eq!(complete.total, 3);
    assert_eq!(complete.items.len(), 3);
    assert!(complete
        .items
        .iter()
        .find(|item| item.id == "b")
        .unwrap()
        .metadata
        .is_none());
    // SQLite's non-STRICT integer column can hold damaged text. Skipping that
    // row would make client offsets advance by fewer rows than SQL consumed.
    db.connection()
        .unwrap()
        .execute(
            "UPDATE task_bindings SET progress='not-an-integer' WHERE id='b'",
            [],
        )
        .unwrap();
    let error = repo.query(&TaskBindingQuery::default()).unwrap_err();
    assert!(
        error.contains("Unable to decode task binding page"),
        "{error}"
    );
    db.connection()
        .unwrap()
        .execute("UPDATE task_bindings SET progress=0 WHERE id='b'", [])
        .unwrap();
    assert_eq!(page(&repo, 0).items.len(), 3);
}
