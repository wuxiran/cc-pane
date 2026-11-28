//! `/acp/ws/{chatId}?afterSeq=N` 的帧编排（docs/112 §3.4），与 axum 解耦以便测试。
//!
//! 顺序：先订阅实时 → 读环（同一把锁，见 `event_log`）→ `afterSeq < floorSeq-1`
//! （或大于 lastSeq）时发 `reset` → 补发 `seq > max(afterSeq, floorSeq-1)` →
//! `synchronized` → 实时（过滤 `seq <= 已发`）。
//! 广播落后（Lagged）时按已发 seq 重读环补齐，必要时再发一次 `reset`。

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::services::acp_chat_service::event_log::{
    AcpEventHub, LoggedEvent, ReplayPlan, Subscription,
};
use crate::services::AcpChatService;

/// 事件来源：生产用 `AcpChatService`，测试直接用 `AcpEventHub`。
pub trait AcpEventSource: Send + Sync {
    fn subscribe(&self, chat_id: &str, after_seq: u64) -> Option<Subscription>;
    fn replay(&self, chat_id: &str, after_seq: u64) -> Option<(ReplayPlan, Option<Value>)>;
}

impl AcpEventSource for AcpEventHub {
    fn subscribe(&self, chat_id: &str, after_seq: u64) -> Option<Subscription> {
        AcpEventHub::subscribe(self, chat_id, after_seq)
    }
    fn replay(&self, chat_id: &str, after_seq: u64) -> Option<(ReplayPlan, Option<Value>)> {
        AcpEventHub::replay(self, chat_id, after_seq)
    }
}

impl AcpEventSource for AcpChatService {
    fn subscribe(&self, chat_id: &str, after_seq: u64) -> Option<Subscription> {
        self.subscribe_events(chat_id, after_seq)
    }
    fn replay(&self, chat_id: &str, after_seq: u64) -> Option<(ReplayPlan, Option<Value>)> {
        self.replay_events(chat_id, after_seq)
    }
}

/// 把续传计划展开成帧；返回帧列表与展开后的「已发最大 seq」。
pub fn plan_frames(
    plan: &ReplayPlan,
    snapshot: Option<&Value>,
    already_sent: u64,
) -> (Vec<Value>, u64) {
    let mut frames = Vec::new();
    let mut sent = already_sent;
    if let ReplayPlan::Reset { floor_seq, .. } = plan {
        frames.push(json!({
            "type": "reset",
            "snapshot": snapshot.cloned().unwrap_or(Value::Null),
            "floorSeq": floor_seq,
        }));
        // reset 之后客户端从 floorSeq 起重放，旧的「已发」作废。
        sent = floor_seq.saturating_sub(1);
    }
    for event in plan.events() {
        if event.seq > sent {
            frames.push(event.frame());
            sent = event.seq;
        }
    }
    (frames, sent)
}

/// 输出端抽象：返回 false 表示对端已断开。
pub trait FrameSink: Send {
    fn send_frame(&mut self, frame: Value) -> impl std::future::Future<Output = bool> + Send;
}

/// 驱动一个连接直到对端断开或 `stop` 完成。chat 不存在时返回 false（未发任何帧）。
pub async fn pump<S, F>(
    source: Arc<dyn AcpEventSource>,
    chat_id: &str,
    after_seq: u64,
    sink: &mut S,
    stop: F,
) -> bool
where
    S: FrameSink,
    F: std::future::Future<Output = ()>,
{
    let Some(mut subscription) = source.subscribe(chat_id, after_seq) else {
        return false;
    };
    let (frames, _) = plan_frames(
        &subscription.plan,
        subscription.snapshot.as_ref(),
        after_seq,
    );
    for frame in frames {
        if !sink.send_frame(frame).await {
            return true;
        }
    }
    // 无论 Delta 还是 Reset，补发完毕时客户端都已持有到环的 lastSeq 为止的全部事件。
    let mut sent = subscription.last_seq;
    if !sink
        .send_frame(json!({"type": "synchronized", "lastSeq": sent}))
        .await
    {
        return true;
    }
    tokio::pin!(stop);
    loop {
        let event = tokio::select! {
            _ = &mut stop => return true,
            event = subscription.receiver.recv() => event,
        };
        match event {
            Ok(event) => {
                if !forward(sink, &event, &mut sent).await {
                    return true;
                }
            }
            Err(RecvError::Lagged(_)) => {
                let Some((plan, snapshot)) = source.replay(chat_id, sent) else {
                    return true;
                };
                let (frames, next) = plan_frames(&plan, snapshot.as_ref(), sent);
                for frame in frames {
                    if !sink.send_frame(frame).await {
                        return true;
                    }
                }
                sent = next;
            }
            Err(RecvError::Closed) => return true,
        }
    }
}

async fn forward<S: FrameSink>(sink: &mut S, event: &Arc<LoggedEvent>, sent: &mut u64) -> bool {
    if event.seq <= *sent {
        return true;
    }
    *sent = event.seq;
    sink.send_frame(event.frame()).await
}

#[cfg(test)]
#[path = "acp_bridge_ws_tests.rs"]
mod tests;
