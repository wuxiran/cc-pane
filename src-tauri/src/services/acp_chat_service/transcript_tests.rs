use super::*;
use crate::services::AcpChatService;

fn item(id: &str, kind: &str, text: &str) -> Value {
    json!({"type": kind, "id": id, "at": 1, "text": text})
}

fn ids(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn save_then_inherit_restores_into_new_session_and_chains() {
    let dir = tempfile::tempdir().unwrap();
    save(
        dir.path(),
        "s1",
        vec![item("a", "user", "hi"), item("b", "assistant", "hello")],
    )
    .unwrap();
    assert_eq!(ids(&load(dir.path(), "s1").unwrap().0), ["a", "b"]);

    let payload = inherit(dir.path(), "s1", "s2").expect("s1 has a transcript");
    assert_eq!(payload["fromAcpSessionId"], "s1");
    assert_eq!(payload["acpSessionId"], "s2");
    assert_eq!(payload["truncated"], false);
    assert_eq!(ids(payload["items"].as_array().unwrap()), ["a", "b"]);

    // 新会话的保存只替换自己的正文段，继承段保留——第二次降级仍能看到 s1。
    save(dir.path(), "s2", vec![item("c", "user", "again")]).unwrap();
    save(
        dir.path(),
        "s2",
        vec![item("c", "user", "again"), item("d", "assistant", "ok")],
    )
    .unwrap();
    assert_eq!(
        ids(&load(dir.path(), "s2").unwrap().0),
        ["a", "b", "c", "d"]
    );
    let chained = inherit(dir.path(), "s2", "s3").unwrap();
    assert_eq!(
        ids(chained["items"].as_array().unwrap()),
        ["a", "b", "c", "d"]
    );
}

#[test]
fn inherit_without_transcript_or_same_id_is_none() {
    let dir = tempfile::tempdir().unwrap();
    assert!(inherit(dir.path(), "missing", "s2").is_none());
    save(dir.path(), "s1", vec![item("a", "user", "hi")]).unwrap();
    assert!(inherit(dir.path(), "s1", "s1").is_none());
    save(dir.path(), "empty", Vec::new()).unwrap();
    assert!(inherit(dir.path(), "empty", "s2").is_none());
}

#[test]
fn bound_caps_count_bytes_and_strings_dropping_oldest_first() {
    let many: Vec<Value> = (0..MAX_ITEMS + 5)
        .map(|i| item(&format!("n{i}"), "assistant", "x"))
        .collect();
    let (older, newer, truncated) = bound(vec![item("old", "user", "o")], many);
    assert!(truncated);
    assert!(older.is_empty(), "inherited records are evicted first");
    assert_eq!(newer.len(), MAX_ITEMS);
    assert_eq!(newer[0]["id"], "n5");

    let big = "y".repeat(MAX_STRING_BYTES * 2);
    let (_, clamped, truncated) = bound(Vec::new(), vec![item("big", "assistant", &big)]);
    assert!(!truncated, "string clamping keeps the item");
    let text = clamped[0]["text"].as_str().unwrap();
    assert!(text.len() < MAX_STRING_BYTES + 64);
    assert!(text.ends_with("[truncated in local transcript]"));

    let chunk = "z".repeat(MAX_STRING_BYTES - 100);
    let heavy: Vec<Value> = (0..40)
        .map(|i| item(&format!("h{i}"), "assistant", &chunk))
        .collect();
    let (_, kept, truncated) = bound(Vec::new(), heavy);
    assert!(truncated);
    let total: usize = kept.iter().map(|v| v.to_string().len()).sum();
    assert!(total <= MAX_BYTES);
    assert_eq!(kept.last().unwrap()["id"], "h39", "newest items survive");
}

#[test]
fn bound_drops_unknown_items_and_oversized_image_data() {
    let image = json!({"type": "image", "id": "img", "at": 1, "mimeType": "image/png",
        "data": "A".repeat(MAX_STRING_BYTES + 1)});
    let (_, kept, truncated) = bound(
        Vec::new(),
        vec![
            json!({"type": "bogus", "id": "x"}),
            json!("not an object"),
            image,
        ],
    );
    assert!(truncated);
    assert_eq!(kept.len(), 1);
    assert!(kept[0].get("data").is_none());
    assert_eq!(kept[0]["dataOmitted"], true);
}

#[test]
fn prune_keeps_file_count_bounded() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..MAX_FILES + 3 {
        save(dir.path(), &format!("s{i}"), vec![item("a", "user", "hi")]).unwrap();
    }
    let count = std::fs::read_dir(dir.path().join(TRANSCRIPT_DIR))
        .unwrap()
        .count();
    assert_eq!(count, MAX_FILES);
    let newest = format!("s{}", MAX_FILES + 2);
    assert!(load(dir.path(), &newest).is_some());
}

#[test]
fn rejects_unsafe_session_ids() {
    let dir = tempfile::tempdir().unwrap();
    assert!(save(dir.path(), "../evil", Vec::new()).is_err());
    assert!(transcript_path_in(dir.path(), "a/b").is_none());
    assert!(delete(dir.path(), "../evil").is_ok());
}

#[test]
fn service_saves_only_known_sessions_and_deletes_with_history() {
    let dir = tempfile::tempdir().unwrap();
    let service = AcpChatService::new(dir.path().into());
    service
        .save_chat_transcript("orphan", vec![item("a", "user", "hi")])
        .unwrap();
    assert!(
        load(dir.path(), "orphan").is_none(),
        "no meta → not persisted"
    );

    service.write_chat_meta("s1", "fake", "/repo", None);
    service
        .save_chat_transcript("s1", vec![item("a", "user", "hi")])
        .unwrap();
    assert!(load(dir.path(), "s1").is_some());
    // 转写放在子目录，不混进历史列表。
    assert_eq!(service.list_chat_history().len(), 1);

    service.delete_chat_history("s1").unwrap();
    assert!(load(dir.path(), "s1").is_none());
    assert!(service.list_chat_history().is_empty());
}
