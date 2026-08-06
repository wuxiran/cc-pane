# -*- coding: utf-8 -*-
import io

def rw(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8').write(s)

def sub(s, old, new, p):
    assert old in s, "MISS in %s: %r" % (p, old[:90])
    return s.replace(old, new, 1)

# ================= bridge =================
p = 'src-tauri/src/services/terminal_daemon_event_bridge.rs'
s = rw(p)

s = sub(s, '''fn replay_snapshot_delta(previous: &str, current: &str) -> Option<String> {
    if current.is_empty() {
        return None;
    }
    if previous.is_empty() {
        return Some(current.to_string());
    }
    if current == previous {
        return None;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return Some(delta.to_string());
    }
    Some(current.to_string())
}''',
'''/// 快照增量三态（M3b-0）：失配不再冒充增量。
#[derive(Debug, PartialEq)]
enum SnapshotDelta {
    Unchanged,
    Delta(String),
    /// 当前快照不再以上次快照为前缀（8MB front-drop / 未来的 photo rebase）：
    /// 中段不连续。把整屏当增量 append 会产生重复画面——唯一诚实做法是发
    /// desync 走统一快照恢复（前端 reset + 全量重放）。
    Mismatch,
}

fn replay_snapshot_delta(previous: &str, current: &str) -> SnapshotDelta {
    if current.is_empty() {
        return SnapshotDelta::Unchanged;
    }
    if previous.is_empty() {
        return SnapshotDelta::Delta(current.to_string());
    }
    if current == previous {
        return SnapshotDelta::Unchanged;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return SnapshotDelta::Delta(delta.to_string());
    }
    SnapshotDelta::Mismatch
}''', p)

s = sub(s, '''    fn apply_snapshot_delta(
        &self,
        session_id: &str,
        snapshot: &TerminalReplaySnapshot,
    ) -> Option<String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let state = sessions.entry(session_id.to_string()).or_default();
        let delta = replay_snapshot_delta(&state.last_snapshot, &snapshot.data)?;
        state.last_snapshot = snapshot.data.clone();
        Some(delta)
    }''',
'''    fn apply_snapshot_delta(
        &self,
        session_id: &str,
        snapshot: &TerminalReplaySnapshot,
    ) -> SnapshotDelta {
        let mut sessions = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        let state = sessions.entry(session_id.to_string()).or_default();
        let outcome = replay_snapshot_delta(&state.last_snapshot, &snapshot.data);
        // Mismatch 也要重置基线：desync 恢复后前端画面 == 当前快照，
        // 下一轮轮询从此处继续前缀比对。
        if !matches!(outcome, SnapshotDelta::Unchanged) {
            state.last_snapshot = snapshot.data.clone();
        }
        outcome
    }''', p)

s = sub(s, '''        if let Some(delta) = self.apply_snapshot_delta(session_id, &snapshot) {
            self.emit_to_webview(
                EV::TERMINAL_OUTPUT,
                serde_json::to_value(TerminalOutput {
                    session_id: session_id.to_string(),
                    data: delta,
                })?,
            )?;
        }

        Ok(())''',
'''        match self.apply_snapshot_delta(session_id, &snapshot) {
            SnapshotDelta::Delta(delta) => {
                self.emit_to_webview(
                    EV::TERMINAL_OUTPUT,
                    serde_json::to_value(TerminalOutput {
                        session_id: session_id.to_string(),
                        data: delta,
                    })?,
                )?;
            }
            SnapshotDelta::Mismatch => {
                self.emit_to_webview(
                    EV::TERMINAL_DESYNC,
                    serde_json::json!({ "sessionId": session_id }),
                )?;
            }
            SnapshotDelta::Unchanged => {}
        }

        Ok(())''', p)

s = sub(s, '''    #[test]
    fn replay_snapshot_delta_returns_only_new_suffix() {
        assert_eq!(
            replay_snapshot_delta("\\u{1b}[2Jready", "\\u{1b}[2Jready\\nnext"),
            Some("\\nnext".to_string())
        );
        assert_eq!(replay_snapshot_delta("same", "same"), None);
        assert_eq!(
            replay_snapshot_delta("old prefix", "new buffer"),
            Some("new buffer".to_string())
        );
        assert_eq!(replay_snapshot_delta("", ""), None);
    }''',
'''    #[test]
    fn replay_snapshot_delta_returns_only_new_suffix() {
        assert_eq!(
            replay_snapshot_delta("\\u{1b}[2Jready", "\\u{1b}[2Jready\\nnext"),
            SnapshotDelta::Delta("\\nnext".to_string())
        );
        assert_eq!(replay_snapshot_delta("same", "same"), SnapshotDelta::Unchanged);
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
    }''', p)
wr(p, s)
print('bridge patched')

# ================= web ws_handler =================
p = 'cc-panes-web/src/ws_handler.rs'
s = rw(p)

s = sub(s, '''fn replay_snapshot_delta(previous: &str, current: &str) -> Option<String> {
    if current.is_empty() {
        return None;
    }
    if previous.is_empty() {
        return Some(current.to_string());
    }
    if current == previous {
        return None;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return Some(delta.to_string());
    }
    Some(current.to_string())
}''',
'''/// 快照增量三态（与桌面 bridge 的同名实现保持用例表对齐，见双方测试互指注释）。
#[derive(Debug, PartialEq)]
enum SnapshotDelta {
    Unchanged,
    Delta(String),
    /// 前缀断裂：中段不连续，整屏当增量 append 会重复画面——发 desync
    /// 让前端走 snapshot 重放（isWebSocketDesyncMessage 已接）。
    Mismatch,
}

fn replay_snapshot_delta(previous: &str, current: &str) -> SnapshotDelta {
    if current.is_empty() {
        return SnapshotDelta::Unchanged;
    }
    if previous.is_empty() {
        return SnapshotDelta::Delta(current.to_string());
    }
    if current == previous {
        return SnapshotDelta::Unchanged;
    }
    if let Some(delta) = current.strip_prefix(previous) {
        return SnapshotDelta::Delta(delta.to_string());
    }
    SnapshotDelta::Mismatch
}''', p)

s = sub(s, '''                        Ok(Some(snapshot)) => {
                            if let Some(data) =
                                replay_snapshot_delta(&last_snapshot, &snapshot.data)
                            {
                                last_snapshot = snapshot.data;
                                let msg = serde_json::json!({
                                    "type": "output",
                                    "data": data,
                                })
                                .to_string();
                                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                    break;''',
'''                        Ok(Some(snapshot)) => {
                            match replay_snapshot_delta(&last_snapshot, &snapshot.data) {
                                SnapshotDelta::Delta(data) => {
                                last_snapshot = snapshot.data;
                                let msg = serde_json::json!({
                                    "type": "output",
                                    "data": data,
                                })
                                .to_string();
                                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                    break;''', p)
wr(p, s)
print('web patched (part 1) — finish loop tail by hand-read')
