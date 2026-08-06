# -*- coding: utf-8 -*-
import io
p = 'cc-panes-web/src/ws_handler.rs'
s = io.open(p, encoding='utf-8').read()

ESC = chr(92) + 'u{1b}'  # literal backslash-u{1b} as it appears in source

old = '''                        Ok(Some(snapshot)) => {
                            match replay_snapshot_delta(&last_snapshot, &snapshot.data) {
                                SnapshotDelta::Delta(data) => {
                                last_snapshot = snapshot.data;
                                let msg = serde_json::json!({
                                    "type": "output",
                                    "data": data,
                                })
                                .to_string();
                                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Ok(None) => break,'''
new = '''                        Ok(Some(snapshot)) => {
                            match replay_snapshot_delta(&last_snapshot, &snapshot.data) {
                                SnapshotDelta::Delta(data) => {
                                    last_snapshot = snapshot.data;
                                    let msg = serde_json::json!({
                                        "type": "output",
                                        "data": data,
                                    })
                                    .to_string();
                                    if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                                SnapshotDelta::Mismatch => {
                                    // 前缀断裂：发 desync 让前端走 snapshot 重放，
                                    // 绝不把整屏当增量 append（M3b-0）
                                    last_snapshot = snapshot.data;
                                    let msg = serde_json::json!({ "type": "desync" }).to_string();
                                    if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                                SnapshotDelta::Unchanged => {}
                            }
                        }
                        Ok(None) => break,'''
assert old in s, 'loop block not found'
s = s.replace(old, new, 1)

old_t = '''    #[test]
    fn replay_snapshot_delta_returns_only_new_suffix() {
        assert_eq!(
            replay_snapshot_delta("''' + ESC + '''[2Jready", "''' + ESC + '''[2Jready\\nnext"),
            Some("\\nnext".to_string())
        );
        assert_eq!(replay_snapshot_delta("same", "same"), None);
        assert_eq!(
            replay_snapshot_delta("old prefix", "new buffer"),
            Some("new buffer".to_string())
        );
    }'''
new_t = '''    #[test]
    fn replay_snapshot_delta_returns_only_new_suffix() {
        // 用例表与桌面 bridge 的 terminal_daemon_event_bridge.rs 同名测试对齐
        assert_eq!(
            replay_snapshot_delta("''' + ESC + '''[2Jready", "''' + ESC + '''[2Jready\\nnext"),
            SnapshotDelta::Delta("\\nnext".to_string())
        );
        assert_eq!(replay_snapshot_delta("same", "same"), SnapshotDelta::Unchanged);
        assert_eq!(replay_snapshot_delta("", ""), SnapshotDelta::Unchanged);
    }

    #[test]
    fn replay_snapshot_delta_mismatch_is_desync_not_full_resend() {
        // M3b-0：失配 = 不连续 = desync（与桌面侧同款约束）
        assert_eq!(
            replay_snapshot_delta("old prefix", "new buffer"),
            SnapshotDelta::Mismatch
        );
    }'''
assert old_t in s, 'test block not found'
s = s.replace(old_t, new_t, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('web complete')
