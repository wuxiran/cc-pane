//! bot_service 单元测试（拆出以保持主文件 <800 行）。
use super::*;

fn event(chat_id: &str, kind: &str, payload: Value) -> AcpChatEvent {
    AcpChatEvent {
        chat_id: chat_id.into(),
        kind: kind.into(),
        payload,
    }
}

fn chunk(chat_id: &str, text: &str) -> AcpChatEvent {
    event(
        chat_id,
        "update",
        json!({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}),
    )
}

fn bot(name: &str, persona: &str) -> Bot {
    Bot {
        id: "b1".into(),
        name: name.into(),
        avatar: String::new(),
        color: String::new(),
        persona: persona.into(),
        engine_id: "claude".into(),
        cwd: None,
        auto_approve_kinds: vec![],
        acp_session_id: None,
        remote_shared: true,
        remote_policy: Default::default(),
        remote_allow_kinds: vec![],
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn reply_joins_main_agent_chunks_until_turn_end() {
    let events = vec![
        // 排队期间界面里那一轮的输出，以及别的 IM 消息的公告：都不算。
        chunk("bot-a", "desktop turn"),
        event("bot-a", "turn_ended", json!({"stopReason": "end_turn"})),
        event(
            "bot-a",
            EXTERNAL_PROMPT_EVENT_KIND,
            json!({"text": "x", "promptId": "p0"}),
        ),
        event(
            "bot-a",
            EXTERNAL_PROMPT_EVENT_KIND,
            json!({"text": "hi", "promptId": "p1"}),
        ),
        chunk("bot-a", "Hel"),
        chunk("bot-other", "noise"),
        event(
            "bot-a",
            "update",
            json!({"update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}}}),
        ),
        event(
            "bot-a",
            "update",
            json!({"update": {"sessionUpdate": "agent_message_chunk", "_meta": {"claudeCode": {"parentToolUseId": "t1"}}, "content": {"type": "text", "text": "sub"}}}),
        ),
        chunk("bot-a", "lo "),
        event("bot-a", "turn_ended", json!({"stopReason": "end_turn"})),
        chunk("bot-a", "next turn"),
    ];
    assert_eq!(collect_reply_text("bot-a", "p1", events.iter()), "Hello");
}

#[test]
fn reply_empty_without_chunks() {
    let events = [
        event(
            "bot-a",
            EXTERNAL_PROMPT_EVENT_KIND,
            json!({"promptId": "p"}),
        ),
        event("bot-a", "turn_ended", json!({})),
    ];
    assert_eq!(collect_reply_text("bot-a", "p", events.iter()), "");
    // 没见到本条公告（例如被拒绝）就什么都不收。
    let events = [chunk("bot-a", "other turn")];
    assert_eq!(collect_reply_text("bot-a", "p", events.iter()), "");
}

#[test]
fn engine_or_cwd_change_resets_the_thread() {
    let base = bot("a", "");
    let mut same = base.clone();
    same.persona = "new persona".into();
    same.cwd = Some("  ".into());
    assert!(!thread_identity_changed(&base, &same));
    let mut engine = base.clone();
    engine.engine_id = "codex".into();
    assert!(thread_identity_changed(&base, &engine));
    let mut cwd = base.clone();
    cwd.cwd = Some("/repo".into());
    assert!(thread_identity_changed(&base, &cwd));
    let mut trimmed = cwd.clone();
    trimmed.cwd = Some(" /repo ".into());
    assert!(!thread_identity_changed(&cwd, &trimmed));
}

#[test]
fn persona_markdown_falls_back_to_default() {
    let md = persona_markdown(&bot("小助", "  "));
    assert!(md.starts_with("# 小助"));
    assert!(md.contains("乐于助人"));
    let md = persona_markdown(&bot("Rev", "You review PRs."));
    assert!(md.contains("You review PRs."));
}

#[test]
fn preamble_only_when_persona_present() {
    assert!(persona_preamble(&bot("a", "")).is_none());
    let text = persona_preamble(&bot("a", "be terse")).unwrap();
    assert!(text.contains("be terse"));
}

#[test]
fn bot_ids_are_path_safe() {
    assert!(valid_bot_id("8b0c-1_a"));
    assert!(!valid_bot_id("../etc"));
    assert!(!valid_bot_id(""));
    assert_eq!(bot_chat_id("x"), "bot-x");
}

fn service() -> (tempfile::TempDir, BotService) {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().to_string_lossy().into_owned();
    let acp = Arc::new(AcpChatService::new(temp.path().join("agent-chats")));
    let service = BotService::new(
        temp.path().join("bots"),
        acp,
        Arc::new(AppPaths::new(Some(data))),
    );
    (temp, service)
}

/// IM 长回合持有的是队列锁；开新话题 / 删除只要生命周期锁，不被挡住。
#[tokio::test]
async fn long_im_turn_does_not_block_new_thread_or_delete() {
    let (_temp, service) = service();
    let mut b = bot("a", "");
    b.id = "b1".into();
    b.acp_session_id = Some("old-thread".into());
    service.write(&b).unwrap();
    let queue = service.queue_lock("b1");
    let _turn = queue.lock().await;
    let fresh = tokio::time::timeout(Duration::from_secs(5), service.new_thread("b1"))
        .await
        .expect("new_thread must not wait for the IM queue")
        .unwrap();
    assert!(fresh.acp_session_id.is_none());
    tokio::time::timeout(Duration::from_secs(5), service.delete("b1"))
        .await
        .expect("delete must not wait for the IM queue")
        .unwrap();
    assert!(service.get("b1").is_err());
}

#[test]
fn bot_json_tolerates_missing_optional_fields() {
    let parsed: Bot = serde_json::from_str(r#"{"id":"a","name":"n","engineId":"claude"}"#).unwrap();
    assert!(parsed.cwd.is_none());
    assert!(parsed.auto_approve_kinds.is_empty());
}
