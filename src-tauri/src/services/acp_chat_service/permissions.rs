//! Keep approval requests retryable until their reply was written successfully.
//! User replies and cancellation share one response gate, so only one outcome
//! can be sent for a request even when they race.

use crate::utils::{AppError, AppResult};
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct PendingPermissions {
    requests: Mutex<HashMap<String, Value>>,
    /// True from the cancellation fence until the next admitted prompt.
    responding: Mutex<bool>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PermissionResolution {
    Pending,
    Approved,
    Cancelled,
}

impl PendingPermissions {
    pub(super) async fn begin_turn(&self) {
        *self.responding.lock().await = false;
        // A new prompt starts a new ACP turn. Any unresolved approval from the
        // previous turn must not be selectable in the new one.
        self.requests.lock().await.clear();
    }

    /// Registration, automatic replies and cancellation share one fence. A
    /// request that was already on the wire when Stop was pressed is cancelled
    /// on arrival, even when its tool kind would normally be approved.
    pub(super) async fn register<F, Fut>(
        &self,
        key: String,
        id: Value,
        auto_outcome: Option<Value>,
        reply: F,
    ) -> AppResult<PermissionResolution>
    where
        F: FnOnce(Value, Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let cancelling = self.responding.lock().await;
        self.requests.lock().await.insert(key.clone(), id.clone());
        let (outcome, resolution) = if *cancelling {
            (
                json!({"outcome": {"outcome": "cancelled"}}),
                PermissionResolution::Cancelled,
            )
        } else if let Some(outcome) = auto_outcome {
            (outcome, PermissionResolution::Approved)
        } else {
            return Ok(PermissionResolution::Pending);
        };
        reply(id, outcome).await?;
        self.requests.lock().await.remove(&key);
        Ok(resolution)
    }

    #[cfg(test)]
    async fn insert(&self, key: String, id: Value) {
        self.requests.lock().await.insert(key, id);
    }

    pub(super) async fn clear(&self) {
        self.requests.lock().await.clear();
    }

    pub(super) async fn respond<F, Fut>(&self, key: &str, reply: F) -> AppResult<()>
    where
        F: FnOnce(Value, bool) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let cancelling = self.responding.lock().await;
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
        reply(id, *cancelling).await?;
        self.requests.lock().await.remove(key);
        Ok(())
    }

    pub(super) async fn cancel_all<F, Fut>(&self, mut reply: F) -> Vec<AppError>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let mut cancelling = self.responding.lock().await;
        *cancelling = true;
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
            .respond("srequest", |_, _| async {
                Err(AppError::coded("ACP_WRITE_FAILED", "fake broken pipe"))
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some("ACP_WRITE_FAILED"));
        pending
            .respond("srequest", |id, _| async move {
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
                .respond("n1", |_, _| async move {
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
                .respond("n1", |_, _| async { Ok(()) })
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
                .respond("n2", |_, _| async { panic!("duplicate reply") })
                .await
                .unwrap_err()
                .code(),
            Some("ACP_PERMISSION_NOT_PENDING")
        );
    }
    #[tokio::test]
    async fn cancellation_overrides_late_automatic_approval_until_next_turn() {
        let pending = PendingPermissions::default();
        assert!(pending.cancel_all(|_| async { Ok(()) }).await.is_empty());
        let selected = json!({"outcome":{"outcome":"selected","optionId":"allow"}});
        let resolution = pending
            .register(
                "late".into(),
                json!("late"),
                Some(selected.clone()),
                |id, outcome| async move {
                    assert_eq!(id, "late");
                    assert_eq!(outcome["outcome"]["outcome"], "cancelled");
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(resolution, PermissionResolution::Cancelled);
        assert!(pending.requests.lock().await.is_empty());

        pending.begin_turn().await;
        let resolution = pending
            .register(
                "new".into(),
                json!("new"),
                Some(selected),
                |_, outcome| async move {
                    assert_eq!(outcome["outcome"]["outcome"], "selected");
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(resolution, PermissionResolution::Approved);
    }

    #[tokio::test]
    async fn in_flight_registration_cannot_escape_the_cancel_sweep() {
        let pending = Arc::new(PendingPermissions::default());
        pending.insert("first".into(), json!("first")).await;
        let (entered, started) = oneshot::channel();
        let (complete, completed) = oneshot::channel();
        let cancelling = pending.clone();
        let task = tokio::spawn(async move {
            let mut entered = Some(entered);
            let mut completed = Some(completed);
            cancelling
                .cancel_all(|_| {
                    let entered = entered.take().unwrap();
                    let completed = completed.take().unwrap();
                    async move {
                        entered.send(()).unwrap();
                        completed.await.unwrap();
                        Ok(())
                    }
                })
                .await
        });
        started.await.unwrap();
        let late = pending.clone();
        let request = tokio::spawn(async move {
            late.register(
                "late".into(),
                json!("late"),
                None,
                |_, outcome| async move {
                    assert_eq!(outcome["outcome"]["outcome"], "cancelled");
                    Ok(())
                },
            )
            .await
        });
        complete.send(()).unwrap();
        assert!(task.await.unwrap().is_empty());
        assert_eq!(
            request.await.unwrap().unwrap(),
            PermissionResolution::Cancelled
        );
        assert!(pending.requests.lock().await.is_empty());
    }

    #[tokio::test]
    async fn failed_cancellation_reply_cannot_later_be_retried_as_selected() {
        let pending = PendingPermissions::default();
        pending.insert("request".into(), json!("request")).await;
        assert_eq!(
            pending
                .cancel_all(|_| async {
                    Err(AppError::coded(
                        "ACP_WRITE_FAILED",
                        "fake transient failure",
                    ))
                })
                .await
                .len(),
            1
        );
        pending
            .respond("request", |_, cancelling| async move {
                assert!(cancelling, "manual retry must be forced to cancelled");
                Ok(())
            })
            .await
            .unwrap();
    }
}
