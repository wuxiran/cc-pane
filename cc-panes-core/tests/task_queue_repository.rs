use cc_panes_core::models::task_queue::{
    PermissionDecisionStatus, QueueItemState, TaskQueueControlPatch, TaskQueueItemDraft,
    TaskQueueReason, TaskQueueState,
};
use cc_panes_core::repository::{Database, TaskQueueRepository};
use std::sync::Arc;

fn repo() -> TaskQueueRepository {
    TaskQueueRepository::new(Arc::new(Database::new_fallback().expect("database")))
}

#[test]
fn migration_v34_creates_runtime_and_queue_tables() {
    let db = Database::new_fallback().expect("database");
    let conn = db.connection().expect("connection");
    for table in [
        "task_queue_runtime",
        "terminal_task_queues",
        "terminal_task_queue_items",
        "terminal_task_queue_permission_decisions",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .expect("table query");
        assert!(exists, "missing {table}");
    }
    let runtime: (i64, i64) = conn
        .query_row(
            "SELECT enabled, dispatch_generation FROM task_queue_runtime WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("runtime row");
    assert_eq!(runtime, (1, 0));

    assert!(conn
        .execute(
            "INSERT INTO terminal_task_queue_items
             (id, session_id, position, text, state, created_at, updated_at)
             VALUES ('orphan', 'missing', 0, 'x', 'queued', 0, 0)",
            [],
        )
        .is_err());
    assert!(conn
        .execute(
            "INSERT INTO terminal_task_queues
             (session_id, runtime_state, created_at, updated_at)
             VALUES ('invalid', 'not-a-state', 0, 0)",
            [],
        )
        .is_err());
}

#[test]
fn migration_v34_upgrades_a_v33_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("v33.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         INSERT INTO schema_migrations(version, description) VALUES (33, 'seeded');",
    )
    .unwrap();
    drop(conn);

    let db = Database::new(path).expect("upgrade v33");
    let conn = db.connection().unwrap();
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    // 只断言 v34 确实应用过，不锁死"最新版本恰好是几"：后者每加一条迁移就要改一次
    // （v35 落地时就是这样挂的），而"迁移跑到了最后一条"已由 db.rs 内部单测用
    // MIGRATIONS.last() 覆盖——MIGRATIONS 是私有常量，集成测试拿不到，只能取下界。
    assert!(version >= 34, "v33 库应至少升到 v34，实际 {version}");
    let enabled: i64 = conn
        .query_row(
            "SELECT enabled FROM task_queue_runtime WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(enabled, 1);
}

#[test]
fn failure_retains_head_stale_token_is_ignored_and_retry_is_explicit() {
    let repo = repo();
    repo.add_item("pty", &TaskQueueItemDraft::new("first", vec![]).unwrap(), 1)
        .unwrap();
    let generation = repo.runtime().unwrap().dispatch_generation;
    let claim = repo.claim_next("pty", generation, 2).unwrap().unwrap();
    assert!(!repo
        .fail_claim("pty", &claim.item.id, "stale", "SUBMIT_FAILED", "no", 3)
        .unwrap());
    assert!(repo
        .fail_claim(
            "pty",
            &claim.item.id,
            &claim.token,
            "SUBMIT_FAILED",
            "write failed",
            4,
        )
        .unwrap());
    let failed = repo.snapshot("pty").unwrap();
    assert_eq!(failed.state, TaskQueueState::SendFailed);
    assert_eq!(failed.reason, Some(TaskQueueReason::SubmitFailed));
    assert_eq!(failed.items[0].state, QueueItemState::Failed);
    assert!(repo.claim_next("pty", generation, 5).unwrap().is_none());

    let retried = repo.retry_item("pty", &claim.item.id, 6).unwrap();
    assert_eq!(retried.items[0].state, QueueItemState::Queued);
    assert_eq!(retried.state, TaskQueueState::Running);
    assert!(repo.claim_next("pty", generation, 7).unwrap().is_some());
}

#[test]
fn permission_decisions_are_idempotent_and_reject_fingerprint_mismatch() {
    let repo = repo();
    let inserted = repo
        .record_permission_decision("pty", "tool-1", "fingerprint", 1)
        .unwrap();
    assert_eq!(inserted.status, PermissionDecisionStatus::Inserted);
    let existing = repo
        .record_permission_decision("pty", "tool-1", "fingerprint", 2)
        .unwrap();
    assert_eq!(existing.status, PermissionDecisionStatus::Existing);
    let mismatch = repo
        .record_permission_decision("pty", "tool-1", "other", 3)
        .unwrap();
    assert_eq!(
        mismatch.status,
        PermissionDecisionStatus::FingerprintMismatch
    );
    assert_eq!(mismatch.decision, None);
}

#[test]
fn fifo_limit_and_position_compaction_are_transactional() {
    let repo = repo();
    let first = repo
        .add_item(
            "pty-1",
            &TaskQueueItemDraft::new("first", vec![]).unwrap(),
            1,
        )
        .expect("first");
    let second = repo
        .add_item(
            "pty-1",
            &TaskQueueItemDraft::new("second", vec![]).unwrap(),
            2,
        )
        .expect("second");
    assert_eq!(first.items[0].position, 0);
    assert_eq!(second.items[1].position, 1);
    let id = first.items[0].id.clone();
    let snapshot = repo.delete_item("pty-1", &id, 3).expect("delete");
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.items[0].position, 0);

    for i in 0..99 {
        repo.add_item(
            "pty-1",
            &TaskQueueItemDraft::new(format!("task-{i}"), vec![]).unwrap(),
            10 + i,
        )
        .expect("under limit");
    }
    let err = repo
        .add_item(
            "pty-1",
            &TaskQueueItemDraft::new("overflow", vec![]).unwrap(),
            200,
        )
        .expect_err("queue should be full");
    assert_eq!(err.code(), Some("QUEUE_FULL"));
}

#[test]
fn claim_is_fifo_compare_and_swap_and_recovery_is_unknown() {
    let repo = repo();
    repo.add_item(
        "pty-1",
        &TaskQueueItemDraft::new("first", vec![]).unwrap(),
        1,
    )
    .expect("add");
    let runtime = repo.runtime().expect("runtime");
    let claim = repo
        .claim_next("pty-1", runtime.dispatch_generation, 2)
        .expect("claim")
        .expect("head");
    assert_eq!(claim.item.text, "first");
    assert_eq!(claim.item.state, QueueItemState::Dispatching);
    assert!(repo
        .claim_next("pty-1", runtime.dispatch_generation, 3)
        .expect("second claim")
        .is_none());
    repo.recover_inflight(4).expect("recover");
    let snapshot = repo.snapshot("pty-1").expect("snapshot");
    assert_eq!(snapshot.items[0].state, QueueItemState::DeliveryUnknown);
}

#[test]
fn concurrent_claim_attempts_have_a_single_winner() {
    let repo = Arc::new(repo());
    repo.add_item("pty", &TaskQueueItemDraft::new("once", vec![]).unwrap(), 1)
        .unwrap();
    let generation = repo.runtime().unwrap().dispatch_generation;
    let handles = (0..8)
        .map(|index| {
            let repo = repo.clone();
            std::thread::spawn(move || repo.claim_next("pty", generation, 2 + index).unwrap())
        })
        .collect::<Vec<_>>();
    let winners = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().is_some())
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
}

#[test]
fn disabling_runtime_invalidates_old_generation_and_control_patch_is_independent() {
    let repo = repo();
    repo.add_item(
        "pty-1",
        &TaskQueueItemDraft::new("first", vec![]).unwrap(),
        1,
    )
    .expect("add");
    let generation = repo.runtime().expect("runtime").dispatch_generation;
    let updated = repo.set_global_enabled(false, 2).expect("disable");
    assert!(!updated.enabled);
    assert!(repo
        .claim_next("pty-1", generation, 3)
        .expect("claim")
        .is_none());
    let snapshot = repo
        .update_control(
            "pty-1",
            &TaskQueueControlPatch {
                paused: Some(true),
                unattended: Some(true),
            },
            4,
        )
        .expect("control");
    assert!(snapshot.paused);
    assert!(snapshot.unattended);
}
