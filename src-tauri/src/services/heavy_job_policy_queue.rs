//! Per-session FIFO for blocking policy effects. Register before returning a
//! grant, so a fast release cannot overtake a slow status lookup/apply request.
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::oneshot;

#[derive(Default)]
pub(crate) struct PolicyQueue {
    tails: Mutex<HashMap<String, (u64, oneshot::Receiver<()>)>>,
    sequence: AtomicU64,
}

impl PolicyQueue {
    pub(crate) fn enqueue(self: &Arc<Self>, session: &str, effect: impl FnOnce() + Send + 'static) {
        let session = session.to_string();
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (complete, next) = oneshot::channel();
        let previous = self.tails.lock().insert(session.clone(), (seq, next));
        let queue = self.clone();
        tokio::spawn(async move {
            if let Some((_, previous)) = previous {
                let _ = previous.await;
            }
            if let Err(error) = tokio::task::spawn_blocking(effect).await {
                tracing::warn!(%error, "heavy job policy task failed");
            }
            // Remove only our tail; a newer queued operation must keep its barrier.
            let mut tails = queue.tails.lock();
            if tails.get(&session).is_some_and(|(tail, _)| *tail == seq) {
                tails.remove(&session);
            }
            let _ = complete.send(());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn release_waits_for_inflight_grant_but_other_sessions_progress() {
        let queue = Arc::new(PolicyQueue::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (unblock, blocked) = std::sync::mpsc::channel();
        let (started_tx, started) = oneshot::channel();
        let values = order.clone();
        queue.enqueue("same", move || {
            started_tx.send(()).unwrap();
            blocked.recv().unwrap();
            values.lock().push("grant");
        });
        started.await.unwrap();
        let values = order.clone();
        let (done_tx, done) = oneshot::channel();
        queue.enqueue("same", move || {
            values.lock().push("release");
            done_tx.send(()).unwrap();
        });
        let (other_tx, other) = oneshot::channel();
        queue.enqueue("other", move || {
            other_tx.send(()).unwrap();
        });
        let independent = tokio::time::timeout(std::time::Duration::from_secs(2), other).await;
        unblock.send(()).unwrap();
        independent.expect("other sessions must progress").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), done)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*order.lock(), vec!["grant", "release"]);
    }
}
