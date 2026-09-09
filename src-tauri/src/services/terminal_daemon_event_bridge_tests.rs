use super::*;

fn status(session_id: &str, status: SessionStatus, updated_at: u64) -> SessionStatusInfo {
    SessionStatusInfo {
        session_id: session_id.to_string(),
        status,
        last_output_at: updated_at,
        pid: Some(42),
        exit_code: None,
        current_tool_name: None,
        current_tool_use_id: None,
        current_tool_summary: None,
        updated_at,
    }
}

#[test]
fn replay_snapshot_delta_returns_only_new_suffix() {
    assert_eq!(
        replay_snapshot_delta("\u{1b}[2Jready", "\u{1b}[2Jready\nnext"),
        SnapshotDelta::Delta("\nnext".to_string())
    );
    assert_eq!(
        replay_snapshot_delta("same", "same"),
        SnapshotDelta::Unchanged
    );
    assert_eq!(replay_snapshot_delta("", ""), SnapshotDelta::Unchanged);
    assert_eq!(
        replay_snapshot_delta("", "fresh"),
        SnapshotDelta::Delta("fresh".to_string())
    );
}

#[test]
fn replay_snapshot_delta_mismatch_is_desync_not_full_resend() {
    // M3b-0：前缀断裂（front-drop / photo rebase）绝不把整屏当增量重发——
    // 那会在前端 append 出重复画面。失配 = 不连续 = desync。
    assert_eq!(
        replay_snapshot_delta("old prefix", "new buffer"),
        SnapshotDelta::Mismatch
    );
    assert_eq!(
        replay_snapshot_delta("abcdef", "cdef-extended"),
        SnapshotDelta::Mismatch
    );
}

/// 基线重置不变式（行为侧）：Mismatch 之后基线必须换成**新**快照。
///
/// 漏掉这一步的话基线永远停在断裂前的旧内容，之后**每一轮**轮询都判
/// Mismatch → 每 100ms 发一次 desync → 前端每轮 reset+全量重放，画面持续
/// 闪烁且永不收敛。症状看着像「daemon 一直在丢数据」，实际是基线卡住了。
/// 判据：连续两轮同一快照，第二轮必须 Unchanged 而不是再发一次 desync。
#[test]
fn mismatch_baseline_reset_makes_a_repeated_snapshot_unchanged() {
    // 模拟轮询循环：非 Unchanged 即重置基线（两侧实现的共同规格）。
    let mut baseline = String::new();
    let mut round = |current: &str| {
        let outcome = replay_snapshot_delta(&baseline, current);
        if !matches!(outcome, SnapshotDelta::Unchanged) {
            baseline = current.to_string();
        }
        outcome
    };

    assert_eq!(
        round("old prefix"),
        SnapshotDelta::Delta("old prefix".to_string()),
        "首轮空基线 = 全量增量"
    );
    assert_eq!(
        round("new buffer"),
        SnapshotDelta::Mismatch,
        "前缀断裂 = 失配"
    );
    assert_eq!(
        round("new buffer"),
        SnapshotDelta::Unchanged,
        "基线没重置：同一快照被反复判 Mismatch，desync 风暴"
    );
    assert_eq!(
        round("new buffer tail"),
        SnapshotDelta::Delta(" tail".to_string()),
        "重置后的基线必须能继续做前缀增量"
    );
}

/// 基线重置不变式（接线侧）。
///
/// 上面那条锁的是规格，这条锁的是**本文件真的照规格接了线**——
/// `apply_snapshot_delta` 依赖 `AppHandle<Wry>`，`tauri::test::mock_app()`
/// 只给得出 `MockRuntime` 句柄，构造不出来，所以行为测试够不到它。
/// 删掉 Mismatch 分支的基线赋值不会有任何测试变红，这条扫源码补上缺口
/// （与 boundary_events / daemonEventContract 的扫源码守卫同款手法）。
#[test]
fn apply_snapshot_delta_resets_baseline_on_non_unchanged_outcomes() {
    let source = include_str!("terminal_daemon_event_bridge.rs");
    // 只看生产代码段，避免扫到本测试自己的文本而自证。
    let production = source
        .split("#[cfg(test)]")
        .next()
        .expect("production section");
    let body = production
        .split("fn apply_snapshot_delta")
        .nth(1)
        .expect("apply_snapshot_delta must exist")
        .split("\n    fn ")
        .next()
        .expect("function body");

    assert!(
        body.contains("SnapshotDelta::Unchanged") && body.contains("state.last_snapshot ="),
        "Mismatch/Delta 之后必须重置基线，否则每轮都重发 desync"
    );
}

#[test]
fn same_status_payload_detects_relevant_changes() {
    let first = status("s1", SessionStatus::Active, 10);
    let same = status("s1", SessionStatus::Active, 10);
    let changed = status("s1", SessionStatus::Exited, 11);
    let mut changed_exit_code = changed.clone();
    changed_exit_code.updated_at = first.updated_at;
    changed_exit_code.last_output_at = first.last_output_at;
    changed_exit_code.status = first.status;
    changed_exit_code.exit_code = Some(7);

    assert!(same_status_payload(&first, &same));
    assert!(!same_status_payload(&first, &changed));
    assert!(!same_status_payload(&first, &changed_exit_code));
}

#[test]
fn hook_exited_for_present_session_is_not_process_exit_evidence() {
    let exited = status("s1", SessionStatus::Exited, 10);

    assert_eq!(
        poll_status_from_session_presence(Some(&exited)),
        PollStatus::Continue
    );
    assert_eq!(poll_status_from_session_presence(None), PollStatus::Done);
}

#[test]
fn daemon_stream_message_parses_output_and_exit_payloads() {
    match serde_json::from_str::<DaemonStreamMessage>(r#"{"type":"output","data":"ready"}"#)
        .expect("output message")
    {
        DaemonStreamMessage::Output { data, end_seq } => {
            assert_eq!(data, "ready");
            assert_eq!(end_seq, None, "旧 daemon 不发 endSeq，必须解析为 None");
        }
        other => panic!("unexpected message: {other:?}"),
    }

    match serde_json::from_str::<DaemonStreamMessage>(
        r#"{"type":"output","data":"ready","endSeq":42}"#,
    )
    .expect("output message with seq")
    {
        DaemonStreamMessage::Output { end_seq, .. } => assert_eq!(end_seq, Some(42)),
        other => panic!("unexpected message: {other:?}"),
    }

    match serde_json::from_str::<DaemonStreamMessage>(r#"{"type":"exit","exitCode":7}"#)
        .expect("exit message")
    {
        DaemonStreamMessage::Exit { exit_code } => assert_eq!(exit_code, 7),
        other => panic!("unexpected message: {other:?}"),
    }
}

/// desync 契约（daemon 输出队列溢出跳段）必须被识别为专用变体，
/// 不能落进 Unknown 静默忽略——那会让缺口后的增量输出直接花屏。
#[test]
fn daemon_stream_message_parses_desync_marker() {
    match serde_json::from_str::<DaemonStreamMessage>(r#"{"type":"desync"}"#)
        .expect("desync message")
    {
        DaemonStreamMessage::Desync => {}
        other => panic!("unexpected message: {other:?}"),
    }
}

fn text_frame(payload: &str) -> WsMessage {
    WsMessage::Text(payload.into())
}

/// 竞态回归：状态轮询判定会话消失时，队列里的 killed/reason 不能因 socket drop 丢失。
#[tokio::test]
async fn drain_delivers_queued_killed_before_bridge_exits() {
    let mut stream = futures_util::stream::iter(vec![
        Ok(text_frame(r#"{"type":"output","data":"bye"}"#)),
        Ok(text_frame(r#"{"type":"killed","reason":"mcp"}"#)),
        Ok(text_frame(r#"{"type":"output","data":"never read"}"#)),
    ]);

    let mut seen = Vec::new();
    let terminated = drain_ready_messages_with(&mut stream, Duration::ZERO, |text| {
        seen.push(text.to_string());
        Ok(matches!(
            serde_json::from_str::<DaemonStreamMessage>(text)?,
            DaemonStreamMessage::Killed { .. }
        ))
    })
    .await
    .expect("drain must succeed");

    assert!(
        terminated,
        "读到 killed 后应返回 true，调用方据此跳过静默 -1"
    );
    assert_eq!(seen.len(), 2, "killed 之后的消息不再消费");
    assert!(seen[1].contains(r#""reason":"mcp""#), "reason 必须完整送达");
}

/// 完整回归：hook Exited 只改变 CLI 状态，daemon session 仍存在时桥接必须继续；
/// 随后的 backend kill 要消费 killed 帧并构造前端 session-killed 事件载荷。
#[tokio::test]
async fn hook_exited_session_stays_bridged_until_killed_event_is_forwarded() {
    let exited = status("s-hook-exited", SessionStatus::Exited, 10);
    assert_eq!(
        poll_status_from_session_presence(Some(&exited)),
        PollStatus::Continue
    );

    let mut stream =
        futures_util::stream::iter(vec![Ok(text_frame(r#"{"type":"killed","reason":"mcp"}"#))]);
    let mut forwarded = Vec::new();
    let terminated = drain_ready_messages_with(&mut stream, Duration::ZERO, |text| {
        let message = serde_json::from_str::<DaemonStreamMessage>(text)?;
        if let DaemonStreamMessage::Killed { reason } = message {
            forwarded.push((
                EV::SESSION_KILLED,
                session_killed_event_payload("s-hook-exited", reason.as_deref()),
            ));
            return Ok(true);
        }
        Ok(false)
    })
    .await
    .expect("killed frame must be consumed");

    assert!(terminated, "killed 帧应结束会话桥接");
    assert_eq!(
        forwarded,
        vec![(
            EV::SESSION_KILLED,
            serde_json::json!({
                "sessionId": "s-hook-exited",
                "reason": "mcp",
            }),
        )]
    );
}

#[tokio::test]
async fn drain_returns_false_when_no_terminal_message_is_queued() {
    let mut stream =
        futures_util::stream::iter(vec![Ok(text_frame(r#"{"type":"output","data":"alive"}"#))]);

    let terminated = drain_ready_messages_with(&mut stream, Duration::ZERO, |_| Ok(false))
        .await
        .expect("drain must succeed");

    assert!(!terminated, "没有终止性消息时应交回调用方按原逻辑处理");
}

#[tokio::test]
async fn drain_stops_at_close_frame_without_consuming_rest() {
    let mut stream = futures_util::stream::iter(vec![
        Ok(WsMessage::Close(None)),
        Ok(text_frame(r#"{"type":"killed","reason":"mcp"}"#)),
    ]);

    let mut seen = 0usize;
    let terminated = drain_ready_messages_with(&mut stream, Duration::ZERO, |_| {
        seen += 1;
        Ok(true)
    })
    .await
    .expect("drain must succeed");

    assert!(!terminated);
    assert_eq!(seen, 0, "close 帧后不再处理消息，走调用方原有 -1 路径");
}

#[test]
fn daemon_stream_message_parses_killed_and_tolerates_unknown_type() {
    match serde_json::from_str::<DaemonStreamMessage>(
        r#"{"type":"killed","reason":"orphan-reclaim"}"#,
    )
    .expect("killed message")
    {
        DaemonStreamMessage::Killed { reason } => {
            assert_eq!(reason.as_deref(), Some("orphan-reclaim"))
        }
        other => panic!("unexpected message: {other:?}"),
    }

    match serde_json::from_str::<DaemonStreamMessage>(r#"{"type":"future-thing","x":1}"#)
        .expect("unknown message must not fail")
    {
        DaemonStreamMessage::Unknown => {}
        other => panic!("unexpected message: {other:?}"),
    }
}
