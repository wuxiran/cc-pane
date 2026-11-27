use super::*;
use serde_json::json;

fn seqs(events: &[Arc<LoggedEvent>]) -> Vec<u64> {
    events.iter().map(|event| event.seq).collect()
}

#[test]
fn seq_starts_at_one_and_floor_is_smallest_retained() {
    let mut ring = EventRing::new(RingLimits::default());
    assert_eq!(ring.floor_seq(), 1, "empty ring: floor = lastSeq + 1");
    assert_eq!(ring.push("update", json!({"a":1})).seq, 1);
    assert_eq!(ring.push("update", json!({"a":2})).seq, 2);
    assert_eq!(ring.last_seq(), 2);
    assert_eq!(ring.floor_seq(), 1);
}

#[test]
fn count_cap_trims_head_and_advances_floor() {
    let mut ring = EventRing::new(RingLimits {
        max_events: 3,
        max_bytes: usize::MAX,
    });
    for index in 0..5 {
        ring.push("update", json!(index));
    }
    assert_eq!(ring.len(), 3);
    assert_eq!(ring.floor_seq(), 3);
    assert_eq!(seqs(ring.replay(2).events()), vec![3, 4, 5]);
}

#[test]
fn byte_cap_trims_but_keeps_newest_event() {
    let mut ring = EventRing::new(RingLimits {
        max_events: 100,
        max_bytes: 16,
    });
    ring.push("k", json!("aaaa"));
    ring.push("k", json!("x".repeat(64)));
    assert_eq!(ring.len(), 1, "oversized single event is still retained");
    assert_eq!(ring.floor_seq(), 2);
    assert_eq!(seqs(ring.replay(1).events()), vec![2]);
}

#[test]
fn replay_within_window_is_delta() {
    let mut ring = EventRing::new(RingLimits::default());
    for index in 0..4 {
        ring.push("update", json!(index));
    }
    assert!(matches!(ring.replay(0), ReplayPlan::Delta(_)));
    assert_eq!(seqs(ring.replay(2).events()), vec![3, 4]);
    assert!(matches!(ring.replay(4), ReplayPlan::Delta(events) if events.is_empty()));
}

#[test]
fn replay_below_floor_resets_with_all_retained() {
    let mut ring = EventRing::new(RingLimits {
        max_events: 2,
        max_bytes: usize::MAX,
    });
    for index in 0..5 {
        ring.push("update", json!(index));
    }
    // retained = [4, 5], floor = 4：afterSeq = floor-1 = 3 仍无缺口，2 不行。
    assert!(matches!(ring.replay(3), ReplayPlan::Delta(_)));
    match ring.replay(2) {
        ReplayPlan::Reset { floor_seq, events } => {
            assert_eq!(floor_seq, 4);
            assert_eq!(seqs(&events), vec![4, 5]);
        }
        other => panic!("expected reset, got {other:?}"),
    }
}

#[test]
fn replay_beyond_last_seq_resets() {
    let mut ring = EventRing::new(RingLimits::default());
    ring.push("update", json!(1));
    assert!(matches!(
        ring.replay(99),
        ReplayPlan::Reset { floor_seq: 1, .. }
    ));
}

#[test]
fn hub_tracks_state_and_unknown_chats() {
    let hub = AcpEventHub::default();
    assert!(hub.subscribe("nope", 0).is_none());
    hub.publish("mobile-1", "state", &json!({"phase":"ready"}));
    hub.publish("tab-1", "update", &json!({}));
    assert_eq!(hub.info("tab-1").unwrap().last_seq, 1);
    let sub = hub.subscribe("mobile-1", 0).unwrap();
    assert_eq!(sub.last_seq, 1);
    assert_eq!(sub.snapshot, Some(json!({"phase":"ready"})));
}

#[test]
fn user_prompt_is_deduped_by_prompt_id() {
    let hub = AcpEventHub::default();
    let prompt = json!({"promptId":"p1","blocks":[],"origin":"mobile"});
    assert_eq!(hub.publish("c", USER_PROMPT_KIND, &prompt), Some(1));
    assert_eq!(hub.publish("c", USER_PROMPT_KIND, &prompt), None);
    assert!(hub.has_prompt("c", "p1"));
    assert!(!hub.has_prompt("other", "p1"));
    // 不同 chat 互不影响；不同 promptId 照常入环。
    assert_eq!(hub.publish("other", USER_PROMPT_KIND, &prompt), Some(1));
    let next = json!({"promptId":"p2","blocks":[],"origin":"desktop"});
    assert_eq!(hub.publish("c", USER_PROMPT_KIND, &next), Some(2));
    assert_eq!(hub.info("c").unwrap().last_seq, 2);
}

#[test]
fn prompt_id_window_is_bounded() {
    let hub = AcpEventHub::default();
    for index in 0..(PROMPT_ID_WINDOW + 10) {
        hub.publish(
            "c",
            USER_PROMPT_KIND,
            &json!({"promptId": index.to_string()}),
        );
    }
    assert!(!hub.has_prompt("c", "0"));
    assert!(hub.has_prompt("c", &(PROMPT_ID_WINDOW + 9).to_string()));
}

#[tokio::test]
async fn subscribe_then_live_has_no_gap_or_duplicate() {
    let hub = Arc::new(AcpEventHub::default());
    for index in 0..3 {
        hub.publish("c", "update", &json!(index));
    }
    let mut sub = hub.subscribe("c", 1).unwrap();
    assert_eq!(seqs(sub.plan.events()), vec![2, 3]);
    hub.publish("c", "update", &json!(3));
    hub.publish("c", "update", &json!(4));
    let mut live = Vec::new();
    while let Ok(event) = sub.receiver.try_recv() {
        if event.seq > sub.last_seq {
            live.push(event.seq);
        }
    }
    assert_eq!(live, vec![4, 5]);
}

#[test]
fn closed_logs_are_pruned_beyond_cap() {
    let hub = AcpEventHub::default();
    for index in 0..(MAX_CLOSED_LOGS + 5) {
        let id = format!("c{index}");
        hub.publish(&id, "state", &json!({"phase":"exited"}));
    }
    hub.publish("live", "state", &json!({"phase":"ready"}));
    let logs = hub.lock();
    assert!(logs.len() <= MAX_CLOSED_LOGS + 1);
    assert!(logs.contains_key("live"));
}
