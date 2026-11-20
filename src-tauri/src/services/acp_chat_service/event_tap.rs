//! 进程内事件旁路：按 chat 订阅、无界队列。
//!
//! 订阅方（Bot 运行时收集回复、IM 入站转发审批）只关心自己那个 chat 的一轮
//! 事件，但这一轮必须完整——旧实现是全局 broadcast（容量 2048），长回合或
//! 别的会话同时刷 token 时会 `Lagged`，回复开头直接丢掉。按 chat 分发后
//! 别的会话的流量不占配额；一轮的事件量有限，无界队列不会失控。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::AcpChatEvent;

pub type ChatEventStream = mpsc::UnboundedReceiver<AcpChatEvent>;

#[derive(Clone, Default)]
pub(crate) struct EventTap {
    subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<AcpChatEvent>>>>>,
}

impl EventTap {
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, Vec<mpsc::UnboundedSender<AcpChatEvent>>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn subscribe(&self, chat_id: &str) -> ChatEventStream {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut map = self.lock();
        let subscribers = map.entry(chat_id.trim().to_string()).or_default();
        subscribers.retain(|existing| !existing.is_closed());
        subscribers.push(tx);
        rx
    }

    /// 没有订阅者时不克隆载荷（token 流是热路径）。
    pub(crate) fn send(&self, event: &AcpChatEvent) {
        let mut map = self.lock();
        let Some(subscribers) = map.get_mut(&event.chat_id) else {
            return;
        };
        subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        if subscribers.is_empty() {
            map.remove(&event.chat_id);
        }
    }

    #[cfg(test)]
    fn subscriber_count(&self, chat_id: &str) -> usize {
        self.lock().get(chat_id).map_or(0, Vec::len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(chat_id: &str, n: usize) -> AcpChatEvent {
        AcpChatEvent {
            chat_id: chat_id.into(),
            kind: "update".into(),
            payload: json!({"n": n}),
        }
    }

    #[test]
    fn long_turns_and_noisy_neighbours_lose_nothing() {
        let tap = EventTap::default();
        let mut mine = tap.subscribe("bot-a");
        // 远超旧 broadcast 容量（2048），且夹杂别的会话的流量。
        for n in 0..10_000 {
            tap.send(&event("other", n));
            tap.send(&event("bot-a", n));
        }
        let mut received = 0;
        while let Ok(event) = mine.try_recv() {
            assert_eq!(event.chat_id, "bot-a");
            assert_eq!(event.payload["n"], received);
            received += 1;
        }
        assert_eq!(received, 10_000);
    }

    #[test]
    fn dropped_subscribers_are_pruned() {
        let tap = EventTap::default();
        let first = tap.subscribe("c");
        let _second = tap.subscribe("c");
        drop(first);
        tap.send(&event("c", 0));
        assert_eq!(tap.subscriber_count("c"), 1);
        drop(_second);
        tap.send(&event("c", 1));
        assert_eq!(tap.subscriber_count("c"), 0);
    }
}
