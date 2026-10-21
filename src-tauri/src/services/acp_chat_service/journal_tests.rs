use super::*;
use serde_json::json;
fn record(id: &str) -> RunRecord {
    RunRecord {
        id: id.into(),
        chat_id: "chat".into(),
        engine_id: "fake".into(),
        acp_session_id: "session".into(),
        cwd: "/repo".into(),
        started_at: 1,
        finished_at: None,
        status: "running".into(),
        checkpoint_id: None,
        recording_error: None,
        event_count: 0,
    }
}
#[tokio::test]
async fn durable_prompt_events_completion_and_restart_are_ordered() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    journal
        .begin(
            record("done"),
            &json!({"prompt":[{"type":"text","text":"fix"}]}),
        )
        .await
        .unwrap();
    journal.event("done", "update", &json!({"text":"result"}));
    journal
        .finish("done".into(), "completed".into(), Some("checkpoint".into()))
        .await
        .unwrap();
    journal
        .begin(record("abandoned"), &json!({"prompt":[]}))
        .await
        .unwrap();
    // Drop every owner and wait for the writer to close SQLite and its lease.
    shutdown(journal).await;
    let reopened = RunJournal::new(temp.path().into());
    let page = reopened.list(RunFilter::default()).await.unwrap();
    assert_eq!(
        page.runs.iter().find(|r| r.id == "done").unwrap().status,
        "completed"
    );
    assert_eq!(
        page.runs
            .iter()
            .find(|r| r.id == "abandoned")
            .unwrap()
            .status,
        "interrupted"
    );
    let events = reopened.read("done".into(), 0).await.unwrap();
    assert_eq!(
        events
            .events
            .iter()
            .map(|e| e.kind.as_str())
            .collect::<Vec<_>>(),
        ["user_prompt", "update"]
    );
    assert!(events.events[1].seq > events.events[0].seq);
    shutdown(reopened).await;
}
#[tokio::test]
async fn pagination_filtering_and_incomplete_recording_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    journal
        .begin(record("r"), &json!({"prompt":[]}))
        .await
        .unwrap();
    for n in 0..205 {
        journal.event("r", "update", &json!(n));
    }
    journal
        .faults
        .lock()
        .unwrap()
        .insert("r".into(), "incomplete".into());
    let warning = journal
        .finish("r".into(), "completed".into(), None)
        .await
        .unwrap();
    assert_eq!(warning.as_deref(), Some("incomplete"));
    assert!(journal.faults.lock().unwrap().is_empty());
    let first = journal.read("r".into(), 0).await.unwrap();
    assert_eq!(first.events.len(), 200);
    assert!(first.has_more);
    let second = journal
        .read("r".into(), first.events.last().unwrap().seq)
        .await
        .unwrap();
    assert_eq!(second.events.len(), 6);
    assert!(!second.has_more);
    assert!(journal
        .list(RunFilter {
            chat_id: Some("other".into()),
            ..Default::default()
        })
        .await
        .unwrap()
        .runs
        .is_empty());
    assert_eq!(
        journal.list(RunFilter::default()).await.unwrap().runs[0]
            .recording_error
            .as_deref(),
        Some("incomplete")
    );
    shutdown(journal).await;
}
#[tokio::test]
async fn admission_rejects_unwritable_storage_before_work_starts() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("file");
    std::fs::write(&file, "x").unwrap();
    assert!(RunJournal::new(file)
        .begin(record("r"), &json!({}))
        .await
        .is_err());
}

async fn shutdown(journal: RunJournal) {
    let mut stopped = journal.stopped.clone();
    drop(journal);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !*stopped.borrow_and_update() {
            stopped.changed().await.unwrap();
        }
    })
    .await
    .expect("journal writer did not stop");
}

#[tokio::test]
async fn second_owner_cannot_recover_or_finalize_a_live_run() {
    let temp = tempfile::tempdir().unwrap();
    let owner = RunJournal::new(temp.path().into());
    owner
        .begin(record("live"), &json!({"prompt":[]}))
        .await
        .unwrap();
    let other = RunJournal::new(temp.path().into());
    assert!(other.list(RunFilter::default()).await.is_err());
    assert_eq!(
        owner.list(RunFilter::default()).await.unwrap().runs[0].status,
        "running"
    );
    assert_eq!(
        owner
            .finish("live".into(), "completed".into(), None)
            .await
            .unwrap(),
        None
    );
    shutdown(other).await;
    shutdown(owner).await;
    let restarted = RunJournal::new(temp.path().into());
    assert_eq!(
        restarted.list(RunFilter::default()).await.unwrap().runs[0].status,
        "completed"
    );
    shutdown(restarted).await;
}

#[tokio::test]
async fn prompt_admission_waits_before_encoding_and_releases_after_durable_ack() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    let hold = journal
        .admissions
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let task_journal = journal.clone();
    let mut pending = tokio::spawn(async move {
        task_journal
            .begin(record("queued"), &json!({"prompt":[]}))
            .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
            .await
            .is_err()
    );
    assert!(journal
        .list(RunFilter::default())
        .await
        .unwrap()
        .runs
        .is_empty());
    drop(hold);
    pending.await.unwrap().unwrap();
    assert_eq!(journal.admissions.available_permits(), 2);
    shutdown(journal).await;
}

#[tokio::test]
async fn read_pages_have_byte_budget_and_stable_cursors_without_modifying_original_data() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    let image = "b".repeat(3 * 1024 * 1024);
    journal.begin(record("large"), &json!({"prompt":[{"type":"image","mimeType":"image/png","data":image,"name":"screen.png"}]})).await.unwrap();
    for n in 0..3 {
        journal.event("large", "update", &json!({"index":n,"nested":{"image":{"type":"image","data":"x".repeat(3 * 1024 * 1024),"mimeType":"image/png"}}}));
        // Drain between large events so this test checks reads rather than overflow.
        journal.list(RunFilter::default()).await.unwrap();
    }
    journal
        .finish("large".into(), "completed".into(), None)
        .await
        .unwrap();
    let mut after = 0;
    let mut count = 0;
    loop {
        let page = journal.read("large".into(), after).await.unwrap();
        assert_eq!(page.events.len(), 1);
        assert!(serde_json::to_vec(&page).unwrap().len() < 4096);
        assert!(page.events[0].seq > after);
        if count == 0 {
            let block = &page.events[0].payload["prompt"][0];
            assert_eq!(block["name"], "screen.png");
            assert_eq!(block["historyImageDataOmitted"], true);
            assert_eq!(block["historyImageDataBytes"], image.len());
            assert!(block.get("data").is_none());
        }
        after = page.events[0].seq;
        count += 1;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(count, 4);
    shutdown(journal).await;
    let conn = Connection::open(temp.path().join("runs.sqlite3")).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT payload FROM events WHERE kind='user_prompt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap()["prompt"][0]["data"],
        image
    );
}

#[test]
fn recursive_projection_retains_metadata_and_marks_image_and_text_omissions() {
    let mut payload = json!({"update":{"toolCallId":"tool","rawOutput":[
        {"resource":{"mimeType":"image/jpeg","blob":"image-bytes","uri":"file:///sample.jpg"}},
        {"image_url":{"url":"data:image/png;base64,abc"}},
        {"type":"text","text":"字".repeat(30000)},
        {"type":"input_image","image_url":"data:image/png;base64,abc"}
    ]}});
    project_history_payload(&mut payload);
    assert_eq!(payload["update"]["toolCallId"], "tool");
    assert_eq!(
        payload["update"]["rawOutput"][0]["resource"]["uri"],
        "file:///sample.jpg"
    );
    assert!(payload["update"]["rawOutput"][0]["resource"]
        .get("blob")
        .is_none());
    assert_eq!(
        payload["update"]["rawOutput"][1]["image_url"]["historyImageDataOmitted"],
        true
    );
    assert_eq!(
        payload["update"]["rawOutput"][3]["historyImageDataOmitted"],
        true
    );
    assert!(payload["update"]["rawOutput"][2]["text"]
        .as_str()
        .unwrap()
        .contains("truncated"));
}

#[test]
fn bounded_encoder_rejects_large_records_without_allocating_the_full_encoding() {
    assert!(encode_limited(&json!("x".repeat(1000)), 64).is_err());
    assert_eq!(
        encode_limited(&json!({"ok":true}), 64).unwrap(),
        "{\"ok\":true}"
    );
}

#[tokio::test]
async fn finishing_a_missing_run_is_an_error_not_a_false_durable_ack() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    assert!(journal
        .finish("missing".into(), "completed".into(), None)
        .await
        .is_err());
    shutdown(journal).await;
}

#[tokio::test]
async fn cancelled_admission_waiter_cannot_release_a_still_queued_prompt_permit() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    journal.list(RunFilter::default()).await.unwrap();
    let blocker = Connection::open(temp.path().join("runs.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let pending_journal = journal.clone();
    let pending = tokio::spawn(async move {
        pending_journal
            .begin(record("cancelled-waiter"), &json!({"prompt":[]}))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while journal.admissions.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert_eq!(journal.admissions.available_permits(), 1);
    blocker.execute_batch("COMMIT").unwrap();
    assert_eq!(
        journal.list(RunFilter::default()).await.unwrap().runs.len(),
        1
    );
    assert_eq!(journal.admissions.available_permits(), 2);
    drop(blocker);
    shutdown(journal).await;
}

#[tokio::test]
async fn explicit_shutdown_drains_events_and_releases_owner_while_old_clones_remain() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    let retained = journal.clone();
    journal
        .begin(record("drain"), &json!({"prompt":[]}))
        .await
        .unwrap();
    for n in 0..205 {
        journal.event("drain", "update", &json!({"part":n}));
    }
    let (first, second) = tokio::join!(journal.shutdown(), retained.shutdown());
    first.unwrap();
    second.unwrap();
    journal.shutdown().await.unwrap();
    assert_eq!(journal.queued.load(Ordering::Relaxed), 0);
    assert!(retained.list(RunFilter::default()).await.is_err());
    assert!(retained
        .begin(record("after-close"), &json!({"prompt":[]}))
        .await
        .is_err());
    // No sleeps and no dropping the old handles: the acknowledgement is the
    // deterministic boundary for opening the same store in a new service.
    let reopened = RunJournal::new(temp.path().into());
    let page = reopened.list(RunFilter::default()).await.unwrap();
    assert_eq!(page.runs[0].event_count, 206);
    assert_eq!(page.runs[0].status, "interrupted");
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_a_shutdown_waiter_does_not_cancel_the_shared_close_barrier() {
    let temp = tempfile::tempdir().unwrap();
    let journal = RunJournal::new(temp.path().into());
    journal
        .begin(record("drain"), &json!({"prompt":[]}))
        .await
        .unwrap();
    let blocker = Connection::open(temp.path().join("runs.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    journal.event("drain", "update", &json!({"text":"last queued event"}));
    let closing = journal.clone();
    let waiter = tokio::spawn(async move { closing.shutdown().await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !journal.shutdown_started.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!*journal.stopped.borrow());
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    blocker.execute_batch("COMMIT").unwrap();
    journal.shutdown().await.unwrap();
    drop(blocker);
    let reopened = RunJournal::new(temp.path().into());
    assert_eq!(
        reopened.read("drain".into(), 0).await.unwrap().events.len(),
        2
    );
    reopened.shutdown().await.unwrap();
}
