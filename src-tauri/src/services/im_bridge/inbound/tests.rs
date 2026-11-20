use super::*;
use crate::services::PermissionBinding;
use serde_json::json;
use state::PendingMessage;

fn bot(id: &str, name: &str) -> Bot {
    Bot {
        id: id.into(),
        name: name.into(),
        avatar: String::new(),
        color: String::new(),
        persona: String::new(),
        engine_id: "claude".into(),
        cwd: None,
        auto_approve_kinds: vec![],
        acp_session_id: None,
        created_at: 0,
        updated_at: 0,
    }
}

fn channel(id: &str, token: &str, chat_id: &str, allowed: &[&str]) -> ChannelConfig {
    ChannelConfig {
        id: id.into(),
        channel_type: ChannelType::Telegram,
        name: id.into(),
        url: String::new(),
        token: Some(token.into()),
        secret: None,
        chat_id: Some(chat_id.into()),
        events: vec![],
        enabled: true,
        inbound_enabled: true,
        default_bot_id: None,
        inbound_allowed_user_ids: allowed.iter().map(|id| id.to_string()).collect(),
    }
}

fn binding(instance: &str, tool: &str) -> PermissionBinding {
    PermissionBinding {
        instance_id: instance.into(),
        tool_call_id: Some(tool.into()),
    }
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("ccp-im-inbound-{}", uuid::Uuid::new_v4()))
}

#[test]
fn parses_commands_and_messages() {
    assert_eq!(
        parse_command("  hello "),
        InboundCommand::Message("hello".into())
    );
    assert_eq!(parse_command("/start"), InboundCommand::Help);
    assert_eq!(parse_command("/bots@MyBot"), InboundCommand::ListBots);
    assert_eq!(
        parse_command("/to 周报 助手"),
        InboundCommand::SwitchBot("周报 助手".into())
    );
    assert_eq!(parse_command("/to"), InboundCommand::ListBots);
    assert_eq!(parse_command("/NEW"), InboundCommand::NewThread);
    assert_eq!(parse_command("/stop"), InboundCommand::Stop);
    assert_eq!(
        parse_command("/rm -rf"),
        InboundCommand::Unknown("rm".into())
    );
}

#[test]
fn private_chat_accepts_only_its_owner_by_default() {
    let config = channel("c", "t", " 123456789 ", &[]);
    let me = json!({"id": 123456789, "type": "private"});
    let my_user = json!({"id": 123456789, "is_bot": false});
    assert!(sender_allowed(&config, &me, &my_user));
    // 别的 chat、别的发送者、没有发送者、bot 发送者：都不行。
    let stranger = json!({"id": 987, "type": "private"});
    assert!(!sender_allowed(&config, &stranger, &json!({"id": 987})));
    assert!(!sender_allowed(&config, &me, &json!({"id": 42})));
    assert!(!sender_allowed(&config, &me, &json!({})));
    assert!(!sender_allowed(
        &config,
        &me,
        &json!({"id": 123456789, "is_bot": true})
    ));
}

#[test]
fn group_requires_an_explicit_sender_allowlist() {
    let group = json!({"id": -100200, "type": "supergroup", "username": "MyTeam"});
    let alice = json!({"id": 11});
    let mallory = json!({"id": 66});
    // 没配白名单：群里谁都不认。
    let open = channel("c", "t", "-100200", &[]);
    assert!(!sender_allowed(&open, &group, &alice));
    let listed = channel("c", "t", "-100200", &["11", " junk "]);
    assert!(sender_allowed(&listed, &group, &alice));
    assert!(!sender_allowed(&listed, &group, &mallory));
}

#[test]
fn usernames_are_never_an_inbound_identity() {
    let by_name = channel("c", "t", "@MyTeam", &["11"]);
    let group = json!({"id": -100200, "type": "supergroup", "username": "MyTeam"});
    assert!(numeric_chat_id(&by_name).is_none());
    assert!(!sender_allowed(&by_name, &group, &json!({"id": 11})));
}

#[test]
fn pollers_need_numeric_chat_ids_and_unique_tokens() {
    let mut disabled = channel("d", "t3", "1", &[]);
    disabled.inbound_enabled = false;
    let (run, refused) = select_pollers(vec![
        channel("b", "shared", "1", &[]),
        channel("a", "shared", "2", &[]),
        channel("c", "t2", "@name", &[]),
        disabled,
    ]);
    assert_eq!(
        run.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["a"]
    );
    let refused: HashMap<_, _> = refused
        .into_iter()
        .map(|(c, reason)| (c.id, reason))
        .collect();
    assert_eq!(refused.len(), 2);
    assert!(refused["b"].contains("同一个 Bot Token"));
    assert!(refused["c"].contains("数字 Chat ID"));
}

#[test]
fn splits_long_messages_on_newlines_and_chars() {
    use parse::split_message;
    assert_eq!(split_message("short", 10), vec!["short"]);
    assert_eq!(split_message("", 10), vec![""]);
    let parts = split_message("aaaaaa\nbbbbbbb\ncc", 10);
    assert_eq!(parts, vec!["aaaaaa", "bbbbbbb\ncc"]);
    assert_eq!(split_message("ab\ncdefghijk", 8), vec!["ab\ncdefg", "hijk"]);
    let parts = split_message(&"字".repeat(25), 10);
    assert_eq!(
        parts.iter().map(|p| p.chars().count()).collect::<Vec<_>>(),
        vec![10, 10, 5]
    );
    let joined: usize = split_message(&"x".repeat(9000), MESSAGE_LIMIT)
        .iter()
        .map(|p| p.len())
        .sum();
    assert_eq!(joined, 9000);
}

#[test]
fn resolves_current_then_default_then_first() {
    let bots = vec![bot("a", "A"), bot("b", "B"), bot("c", "C")];
    assert_eq!(resolve_bot(&bots, Some("b"), Some("c")).unwrap().id, "b");
    assert_eq!(resolve_bot(&bots, Some("gone"), Some("c")).unwrap().id, "c");
    assert_eq!(resolve_bot(&bots, None, None).unwrap().id, "a");
    assert!(resolve_bot(&[], None, None).is_none());
}

#[test]
fn state_file_names_are_sanitized_and_round_trip() {
    let dir = temp_dir();
    let path = state_path(&dir, "../evil/id");
    assert_eq!(path.parent().unwrap(), dir);
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("telegram-"));
    save_state(
        &path,
        &ChannelState {
            offset: Some(42),
            current_bot_id: Some("b".into()),
            pending: vec![PendingMessage {
                update_id: 41,
                text: "hi".into(),
            }],
        },
    );
    let loaded = load_state(&path);
    assert_eq!(loaded.offset, Some(42));
    assert_eq!(loaded.current_bot_id.as_deref(), Some("b"));
    assert_eq!(loaded.pending.len(), 1);
    assert!(!path.with_extension("json.tmp").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn offset_is_persisted_before_each_update_is_handled() {
    let dir = temp_dir();
    let path = state_path(&dir, "c");
    let mut state = ChannelState {
        offset: Some(10),
        ..Default::default()
    };
    assert!(begin_update(&mut state, &path, &json!({"update_id": 10})));
    // 处理之前就已落盘：此刻崩溃，重启后不会重放 10。
    assert_eq!(load_state(&path).offset, Some(11));
    assert!(!begin_update(&mut state, &path, &json!({"update_id": 10})));
    assert!(!begin_update(&mut state, &path, &json!({})));
    assert!(begin_update(&mut state, &path, &json!({"update_id": 15})));
    assert_eq!(load_state(&path).offset, Some(16));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn unprocessed_messages_are_reported_not_replayed() {
    assert!(dropped_notice(&[]).is_none());
    let pending: Vec<PendingMessage> = (0..12)
        .map(|n| PendingMessage {
            update_id: n,
            text: format!("msg {n}"),
        })
        .collect();
    let notice = dropped_notice(&pending).unwrap();
    assert!(notice.contains("12 条"));
    assert!(notice.contains("msg 0"));
    assert!(notice.contains("另有 2 条"));
}

#[test]
fn approval_tap_invalidates_sibling_buttons() {
    let mut book = ApprovalBook::default();
    let now = Instant::now();
    let buttons = book.insert(
        "bot-a",
        "n7",
        binding("i1", "t1"),
        vec![
            ("allow".into(), "Allow".into()),
            ("deny".into(), "Deny".into()),
        ],
        now,
    );
    assert_eq!(buttons.len(), 2);
    assert!(buttons.iter().all(|(_, token)| token.len() <= 64));
    let entry = book.take(&buttons[0].1, now).unwrap();
    assert_eq!(entry.option_id, "allow");
    assert_eq!(entry.request_key, "n7");
    assert_eq!(book.take(&buttons[1].1, now), Err(TakeError::Unknown));
    assert_eq!(book.take("p:forged", now), Err(TakeError::Unknown));
}

#[test]
fn approvals_expire_and_are_purged_with_their_messages() {
    let mut book = ApprovalBook::default();
    let start = Instant::now();
    let old = book.insert(
        "bot-a",
        "n1",
        binding("i1", "t1"),
        vec![("allow".into(), "Allow".into())],
        start,
    );
    book.set_message("bot-a", "n1", 100);
    let later = start + approvals::APPROVAL_TTL + Duration::from_secs(1);
    assert_eq!(book.take(&old[0].1, later), Err(TakeError::Expired));

    book.insert(
        "bot-a",
        "n2",
        binding("i1", "t2"),
        vec![("a".into(), "A".into())],
        start,
    );
    book.set_message("bot-a", "n2", 200);
    book.insert(
        "bot-a",
        "n3",
        binding("i1", "t3"),
        vec![("a".into(), "A".into())],
        start,
    );
    book.set_message("bot-a", "n3", 300);
    book.insert(
        "bot-b",
        "n4",
        binding("i2", "t4"),
        vec![("a".into(), "A".into())],
        start,
    );
    assert_eq!(book.remove_request("bot-a", "n2"), vec![200]);
    assert_eq!(book.remove_chat("bot-a"), vec![300]);
    assert!(!book.is_empty());
    assert!(book.remove_expired(later).is_empty());
    assert!(book.is_empty());
}

#[test]
fn stale_button_cannot_approve_a_new_request_with_the_same_key() {
    let mut book = ApprovalBook::default();
    let now = Instant::now();
    let buttons = book.insert(
        "bot-a",
        "n7",
        binding("process-1", "tool-old"),
        vec![("allow".into(), "Allow".into())],
        now,
    );
    let entry = book.take(&buttons[0].1, now).unwrap();
    // 适配器进程换了，新进程的 n7 是另一个请求。
    assert!(!binding_still_valid(
        &entry,
        Some(&binding("process-2", "tool-new"))
    ));
    // 同一进程，同 key 但不同 toolCall。
    assert!(!binding_still_valid(
        &entry,
        Some(&binding("process-1", "tool-new"))
    ));
    // 已不在等待。
    assert!(!binding_still_valid(&entry, None));
    assert!(binding_still_valid(
        &entry,
        Some(&binding("process-1", "tool-old"))
    ));
}

#[test]
fn turn_end_and_process_exit_end_the_watch() {
    assert!(ends_watch("turn_ended", &json!({})));
    assert!(ends_watch("state", &json!({"phase": "exited"})));
    assert!(ends_watch("state", &json!({"phase": "failed"})));
    assert!(!ends_watch("state", &json!({"phase": "generating"})));
    assert!(!ends_watch("update", &json!({})));
}

#[test]
fn errors_sent_to_telegram_are_generic() {
    let generic = user_facing_error(Some("SOMETHING_INTERNAL"));
    assert!(generic.contains("桌面端日志"));
    assert_eq!(user_facing_error(None), generic);
    assert!(user_facing_error(Some("BOT_BUSY")).contains("忙"));
}

#[test]
fn permission_summary_mentions_tool() {
    let text = permission_summary(&json!({"toolCall": {"title": "rm build/", "kind": "execute"}}));
    assert!(text.contains("rm build/"));
    assert!(text.contains("execute"));
    assert!(permission_summary(&json!({})).contains("other"));
}

// ---------------------------------------------------------------------------
// 本地 mock Telegram：真走 HTTP
// ---------------------------------------------------------------------------

/// 按顺序回放 `bodies`（每个连接一条），记录收到的请求（路径 + body）。
async fn serve(bodies: Vec<&'static str>) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for body in bodies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = vec![0u8; 8192];
            loop {
                let n = socket.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if rest.len() >= length {
                        break;
                    }
                }
            }
            log.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request).to_string());
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (format!("http://{addr}"), seen)
}

fn api(base: String) -> TelegramApi {
    TelegramApi {
        client: reqwest::Client::new(),
        base,
        token: "T".into(),
    }
}

#[tokio::test]
async fn telegram_api_parses_results_and_errors() {
    let (base, _) = serve(vec![
        r#"{"ok":true,"result":[{"update_id":7,"message":{"text":"hi"}}]}"#,
    ])
    .await;
    let updates = api(base).get_updates(0, 0).await.unwrap();
    assert_eq!(updates[0]["update_id"], 7);
    let (base, _) = serve(vec![r#"{"ok":false,"description":"Unauthorized"}"#]).await;
    let error = api(base).get_updates(0, 0).await.unwrap_err();
    assert!(error.contains("Unauthorized"));
    assert!(!error.contains("botT"), "token must not leak into errors");
}

/// 跳过积压失败时不能带着 offset=None 开始轮询（那会重放 24 小时的消息）。
#[tokio::test]
async fn backlog_skip_retries_until_it_has_an_offset() {
    let (base, seen) = serve(vec![
        r#"{"ok":false,"description":"Bad Gateway"}"#,
        r#"{"ok":false,"description":"Bad Gateway"}"#,
        r#"{"ok":true,"result":[{"update_id":5},{"update_id":9}]}"#,
    ])
    .await;
    let dir = temp_dir();
    let path = state_path(&dir, "c");
    let state = Mutex::new(ChannelState::default());
    let api = api(base);
    tokio::time::timeout(Duration::from_secs(30), skip_backlog(&api, &state, &path))
        .await
        .expect("skip_backlog should finish once Telegram answers");
    assert_eq!(state.lock().await.offset, Some(10));
    assert_eq!(load_state(&path).offset, Some(10));
    assert_eq!(seen.lock().unwrap().len(), 3);
    // 已有 offset：不再请求。
    skip_backlog(&api, &state, &path).await;
    assert_eq!(seen.lock().unwrap().len(), 3);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn permission_prompt_keeps_message_id_and_clearing_removes_buttons() {
    let (base, seen) = serve(vec![
        r#"{"ok":true,"result":{"message_id":321}}"#,
        r#"{"ok":true,"result":true}"#,
    ])
    .await;
    let api = api(base);
    let id = api
        .send_keyboard(42, "approve?", vec![("Allow".into(), "p:abc".into())])
        .await;
    assert_eq!(id, Some(321));
    api.clear_keyboard(42, 321).await;
    let seen = seen.lock().unwrap();
    assert!(seen[0].contains("/botT/sendMessage") && seen[0].contains("p:abc"));
    assert!(seen[1].contains("/botT/editMessageReplyMarkup"));
    assert!(seen[1].contains("\"message_id\":321") && seen[1].contains("\"inline_keyboard\":[]"));
}
