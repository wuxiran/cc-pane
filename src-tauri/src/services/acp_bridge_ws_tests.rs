use super::*;
use crate::services::acp_chat_service::event_log::RingLimits;
use tokio::sync::{mpsc, oneshot};

struct ChannelSink(mpsc::UnboundedSender<Value>);

impl FrameSink for ChannelSink {
    async fn send_frame(&mut self, frame: Value) -> bool {
        self.0.send(frame).is_ok()
    }
}

fn event_seqs(frames: &[Value]) -> Vec<u64> {
    frames
        .iter()
        .filter(|frame| frame["type"] == "event")
        .map(|frame| frame["seq"].as_u64().unwrap())
        .collect()
}

async fn drain_until_synchronized(rx: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = rx.recv().await.expect("frame");
        let done = frame["type"] == "synchronized";
        frames.push(frame);
        if done {
            return frames;
        }
    }
}

fn spawn_pump(
    hub: Arc<AcpEventHub>,
    chat: &'static str,
    after: u64,
) -> (
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<bool>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let mut sink = ChannelSink(tx);
        pump(hub, chat, after, &mut sink, async {
            let _ = stop_rx.await;
        })
        .await
    });
    (rx, stop_tx, handle)
}

#[tokio::test]
async fn unknown_chat_sends_nothing() {
    let hub = Arc::new(AcpEventHub::default());
    let (_rx, _stop, handle) = spawn_pump(hub, "missing", 0);
    assert!(!handle.await.unwrap());
}

#[tokio::test]
async fn replay_then_live_has_no_gap_and_no_duplicate() {
    let hub = Arc::new(AcpEventHub::default());
    for index in 0..5 {
        hub.publish("c", "update", &json!(index));
    }
    let (mut rx, stop, handle) = spawn_pump(hub.clone(), "c", 2);
    let replay = drain_until_synchronized(&mut rx).await;
    assert_eq!(event_seqs(&replay), vec![3, 4, 5]);
    assert_eq!(replay.last().unwrap()["lastSeq"], 5);

    // Concurrent publishers racing the subscriber are still delivered once, in order.
    let publisher = {
        let hub = hub.clone();
        tokio::spawn(async move {
            for index in 0..200 {
                hub.publish("c", "update", &json!(index));
                if index % 17 == 0 {
                    tokio::task::yield_now().await;
                }
            }
        })
    };
    publisher.await.unwrap();
    let mut live = Vec::new();
    while live.len() < 200 {
        let frame = rx.recv().await.unwrap();
        live.push(frame["seq"].as_u64().unwrap());
    }
    assert_eq!(live, (6..206).collect::<Vec<_>>());
    stop.send(()).unwrap();
    assert!(handle.await.unwrap());
}

#[tokio::test]
async fn subscribe_racing_publish_never_gaps() {
    // 订阅与发布并发：所有收到的 seq 必须恰好是 (afterSeq, N] 的连续区间。
    for _ in 0..20 {
        let hub = Arc::new(AcpEventHub::default());
        hub.publish("c", "update", &json!(0));
        let publisher = {
            let hub = hub.clone();
            tokio::spawn(async move {
                for index in 0..100 {
                    hub.publish("c", "update", &json!(index));
                    tokio::task::yield_now().await;
                }
            })
        };
        let (mut rx, stop, _handle) = spawn_pump(hub.clone(), "c", 0);
        publisher.await.unwrap();
        let mut seen = Vec::new();
        while seen.last().copied() != Some(101) {
            let frame = rx.recv().await.unwrap();
            if frame["type"] == "event" {
                seen.push(frame["seq"].as_u64().unwrap());
            }
        }
        assert_eq!(seen, (1..=101).collect::<Vec<_>>());
        let _ = stop.send(());
    }
}

#[tokio::test]
async fn after_seq_below_floor_sends_reset_first() {
    let hub = Arc::new(AcpEventHub::new(RingLimits {
        max_events: 3,
        max_bytes: usize::MAX,
    }));
    hub.publish("c", "state", &json!({"phase":"ready"}));
    for index in 0..5 {
        hub.publish("c", "update", &json!(index));
    }
    // retained = [4, 5, 6]，floor = 4；afterSeq = 2 < floor-1 → reset。
    let (mut rx, _stop, _handle) = spawn_pump(hub.clone(), "c", 2);
    let frames = drain_until_synchronized(&mut rx).await;
    assert_eq!(frames[0]["type"], "reset");
    assert_eq!(frames[0]["floorSeq"], 4);
    assert_eq!(frames[0]["snapshot"], json!({"phase":"ready"}));
    assert_eq!(event_seqs(&frames), vec![4, 5, 6]);
    assert_eq!(frames.last().unwrap()["lastSeq"], 6);
    // afterSeq = floor-1 恰好无缺口：不 reset，补 4..=6。
    let (mut rx, _stop, _handle) = spawn_pump(hub, "c", 3);
    let frames = drain_until_synchronized(&mut rx).await;
    assert_eq!(frames[0]["type"], "event");
    assert_eq!(event_seqs(&frames), vec![4, 5, 6]);
}

#[tokio::test]
async fn after_seq_beyond_last_seq_resets_from_floor() {
    let hub = Arc::new(AcpEventHub::default());
    hub.publish("c", "state", &json!({"phase":"ready"}));
    hub.publish("c", "update", &json!(1));
    let (mut rx, _stop, _handle) = spawn_pump(hub, "c", 99);
    let frames = drain_until_synchronized(&mut rx).await;
    assert_eq!(frames[0]["type"], "reset");
    assert_eq!(frames[0]["floorSeq"], 1);
    assert_eq!(event_seqs(&frames), vec![1, 2]);
}

#[test]
fn plan_frames_skips_already_sent() {
    let mut ring =
        crate::services::acp_chat_service::event_log::EventRing::new(RingLimits::default());
    for index in 0..3 {
        ring.push("update", json!(index));
    }
    let (frames, sent) = plan_frames(&ring.replay(0), None, 2);
    assert_eq!(event_seqs(&frames), vec![3]);
    assert_eq!(sent, 3);
}

#[test]
fn unknown_kinds_pass_through_verbatim() {
    let hub = AcpEventHub::default();
    hub.publish("c", "future_kind_v9", &json!({"x":[1,2]}));
    let sub = hub.subscribe("c", 0).unwrap();
    let (frames, _) = plan_frames(&sub.plan, None, 0);
    assert_eq!(
        frames[0],
        json!({"type":"event","seq":1,"kind":"future_kind_v9","payload":{"x":[1,2]}})
    );
}
