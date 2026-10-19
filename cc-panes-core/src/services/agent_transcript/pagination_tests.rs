use super::*;
use std::io::Write;

fn append(path: &std::path::Path, range: std::ops::Range<usize>) {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    for index in range {
        writeln!(file, "{}", serde_json::json!({"type":"assistant","id":format!("m{index}"),"content":format!("message {index}")})).unwrap();
    }
}

#[test]
fn cursor_pages_remain_contiguous_when_new_messages_are_appended() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(GROK_CHAT_HISTORY_FILE);
    append(&path, 0..450);
    let first = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        200,
        0,
        None,
    );
    assert_eq!(first.messages[0].text, "message 250");
    assert!(first.has_earlier);
    append(&path, 450..475);
    let second = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        200,
        200,
        first.next_before_message_id.as_deref(),
    );
    assert_eq!(second.messages.first().unwrap().text, "message 50");
    assert_eq!(second.messages.last().unwrap().text, "message 249");
    let last = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        200,
        400,
        second.next_before_message_id.as_deref(),
    );
    assert_eq!(last.messages.len(), 50);
    assert_eq!(last.messages[0].text, "message 0");
    assert!(!last.has_earlier);
    assert!(last.next_before_message_id.is_none());
    assert!(
        last.truncated,
        "legacy field still reports omitted newer messages"
    );
    let ids: std::collections::HashSet<_> = last
        .messages
        .iter()
        .chain(&second.messages)
        .chain(&first.messages)
        .map(|message| &message.id)
        .collect();
    assert_eq!(ids.len(), 450);
}

#[test]
fn missing_cursor_reports_refresh_required_instead_of_offset_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(GROK_CHAT_HISTORY_FILE);
    append(&path, 0..3);
    let result = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        2,
        1,
        Some("L42:missing"),
    );
    assert_eq!(
        result.error_code,
        Some(AgentTranscriptErrorCode::CursorExpired)
    );
    assert!(result.messages.is_empty());
    assert!(!result.has_earlier);
}

#[test]
fn legacy_offsets_still_work_and_beginning_does_not_advertise_earlier_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(GROK_CHAT_HISTORY_FILE);
    append(&path, 0..3);
    let result = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        2,
        1,
        None,
    );
    assert_eq!(result.messages.len(), 2);
    assert_eq!(result.messages[0].text, "message 0");
    assert!(!result.has_earlier);
    assert!(result.truncated);
    let empty = page_messages(
        read_grok_transcript_messages(&path).unwrap(),
        &path,
        2,
        100,
        None,
    );
    assert!(empty.messages.is_empty());
    assert!(!empty.has_earlier);
}
