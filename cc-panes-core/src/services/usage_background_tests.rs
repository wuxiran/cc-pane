use super::*;
use crate::repository::{Database, HistoryRepository};

#[tokio::test(flavor = "current_thread")]
async fn background_scan_does_not_block_async_dispatch_when_database_is_busy() {
    let db = Arc::new(Database::new_in_memory().unwrap());
    let home = tempfile::tempdir().unwrap();
    let history = Arc::new(LaunchHistoryService::new(Arc::new(HistoryRepository::new(
        db.clone(),
    ))));
    let service = Arc::new(UsageStatsService::new_with_isolated_scan_home(
        Arc::new(UsageStatsRepository::new(db.clone())),
        history,
        home.path().to_path_buf(),
    ));
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let owner = std::thread::spawn(move || {
        let _connection = db.connection().unwrap();
        locked_tx.send(()).unwrap();
        // A broken implementation unblocks eventually instead of hanging the test runner.
        release_rx.recv_timeout(Duration::from_secs(3)).is_ok()
    });
    locked_rx.await.unwrap();
    let scan = tokio::spawn(service.clone().refresh_usage_stats_from_cache_logged());
    tokio::time::timeout(Duration::from_secs(1), async {
        while !service.scan_running.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("async dispatcher must run while scan waits for SQLite");
    assert!(!scan.is_finished());
    release_tx.send(()).unwrap();
    assert!(owner.join().unwrap());
    scan.await.unwrap();
    assert!(!service.scan_running.load(Ordering::SeqCst));
}
