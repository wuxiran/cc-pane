//! File scans and large copies must neither block the UI/Tokio workers nor
//! create an unbounded burst of disk work when several windows refresh.
use crate::utils::{AppError, AppResult};
use tokio::sync::Semaphore;

static IO_JOBS: Semaphore = Semaphore::const_new(4);

/// Async I/O uses the same admission limit without occupying a blocking thread.
pub(super) async fn run_async<T>(
    task: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let _permit = IO_JOBS
        .acquire()
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    task.await
}

pub(super) async fn run<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    run_with_limit(&IO_JOBS, task).await
}

async fn run_with_limit<T: Send + 'static>(
    limit: &'static Semaphore,
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let permit = limit
        .acquire()
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        // Hold the permit until real I/O ends, even if the caller is cancelled.
        let _permit = permit;
        task()
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_io_keeps_dispatch_responsive_and_cancel_does_not_release_capacity() {
        static LIMIT: Semaphore = Semaphore::const_new(1);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = tokio::spawn(run_with_limit(&LIMIT, move || {
            let _ = started_tx.send(());
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        first.abort();
        let second_started = Arc::new(AtomicBool::new(false));
        let observed = second_started.clone();
        let second = tokio::spawn(run_with_limit(&LIMIT, move || {
            observed.store(true, Ordering::SeqCst);
            Ok(7)
        }));
        tokio::task::yield_now().await;
        assert!(!second_started.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        assert_eq!(second.await.unwrap().unwrap(), 7);
    }

    #[tokio::test]
    async fn io_errors_are_preserved() {
        let error = run(|| Err::<(), _>(AppError::from("fixture failure")))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("fixture failure"));
    }
}
