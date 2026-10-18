//! Keep approval requests retryable until their reply was written successfully.
//! User replies and cancellation share one response gate, so only one outcome
//! can be sent for a request even when they race.

use crate::utils::{AppError, AppResult};
use serde_json::Value;
use std::{collections::HashMap, future::Future};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct PendingPermissions {
    requests: Mutex<HashMap<String, Value>>,
    responding: Mutex<()>,
}

impl PendingPermissions {
    pub(super) async fn insert(&self, key: String, id: Value) {
        self.requests.lock().await.insert(key, id);
    }

    pub(super) async fn clear(&self) {
        self.requests.lock().await.clear();
    }

    pub(super) async fn respond<F, Fut>(&self, key: &str, reply: F) -> AppResult<()>
    where
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let _responding = self.responding.lock().await;
        let id = self
            .requests
            .lock()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| {
                AppError::coded(
                    "ACP_PERMISSION_NOT_PENDING",
                    "ACP permission request is no longer pending",
                )
            })?;
        reply(id).await?;
        self.requests.lock().await.remove(key);
        Ok(())
    }

    pub(super) async fn cancel_all<F, Fut>(&self, mut reply: F) -> Vec<AppError>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let _responding = self.responding.lock().await;
        let pending = self.requests.lock().await.clone();
        let mut errors = Vec::new();
        for (key, id) in pending {
            match reply(id).await {
                Ok(()) => {
                    self.requests.lock().await.remove(&key);
                }
                Err(error) => errors.push(error),
            }
        }
        errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn failed_write_keeps_permission_for_retry() {
        let pending = PendingPermissions::default();
        pending.insert("srequest".into(), json!("request")).await;
        let error = pending
            .respond("srequest", |_| async {
                Err(AppError::coded("ACP_WRITE_FAILED", "fake broken pipe"))
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some("ACP_WRITE_FAILED"));
        pending
            .respond("srequest", |id| async move {
                assert_eq!(id, json!("request"));
                Ok(())
            })
            .await
            .unwrap();
        assert!(pending.requests.lock().await.is_empty());
    }

    #[tokio::test]
    async fn concurrent_reply_and_cancel_send_exactly_one_outcome() {
        let pending = Arc::new(PendingPermissions::default());
        pending.insert("n1".into(), json!(1)).await;
        let writes = Arc::new(AtomicUsize::new(0));
        let (started, writing) = oneshot::channel();
        let (finish, finished) = oneshot::channel();
        let task_pending = pending.clone();
        let task_writes = writes.clone();
        let selected = tokio::spawn(async move {
            task_pending
                .respond("n1", |_| async move {
                    started.send(()).unwrap();
                    finished.await.unwrap();
                    task_writes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });
        writing.await.unwrap();
        let task_pending = pending.clone();
        let task_writes = writes.clone();
        let cancelled = tokio::spawn(async move {
            task_pending
                .cancel_all(|_| {
                    let writes = task_writes.clone();
                    async move {
                        writes.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                })
                .await
        });
        finish.send(()).unwrap();
        selected.await.unwrap().unwrap();
        assert!(cancelled.await.unwrap().is_empty());
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(
            pending
                .respond("n1", |_| async { Ok(()) })
                .await
                .unwrap_err()
                .code(),
            Some("ACP_PERMISSION_NOT_PENDING")
        );
    }

    #[tokio::test]
    async fn cancelled_permission_cannot_be_selected_afterwards() {
        let pending = PendingPermissions::default();
        pending.insert("n2".into(), json!(2)).await;
        assert!(pending.cancel_all(|_| async { Ok(()) }).await.is_empty());
        assert_eq!(
            pending
                .respond("n2", |_| async { panic!("duplicate reply") })
                .await
                .unwrap_err()
                .code(),
            Some("ACP_PERMISSION_NOT_PENDING")
        );
    }
}
