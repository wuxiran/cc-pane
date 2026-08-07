//! 状态机跃迁 → IM 外推事件的映射消费者。
//!
//! 走 `subscribe_transitions()` broadcast + tokio task，不走 sync `subscribe`
//! 回调——那条在 hook/PTY 线程同步执行，只准 O(1)+spawn，禁网络 IO。
//! kind / dedupe_key 与 NotificationService 的桌面通知同口径（前缀 `im:`），
//! 两条通道各自独立判闸。

use super::ImBridgeService;
use cc_panes_core::services::terminal_service::SessionStatus;
use cc_panes_core::services::StateTransition;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::warn;

pub fn spawn_im_transition_consumer(
    bridge: Arc<ImBridgeService>,
    mut rx: broadcast::Receiver<StateTransition>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(transition) => handle_transition(&bridge, &transition),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // 外推是事件摘要而非镜像，落后只记警告继续（丢的是重复度高的中间态）
                    warn!(skipped, "im_bridge: transition consumer lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn handle_transition(bridge: &ImBridgeService, transition: &StateTransition) {
    let sid = transition.pty_session_id.as_str();
    match transition.to {
        SessionStatus::Idle => {
            bridge.dispatch(
                "turn_end",
                "✅ Completed",
                "Claude finished this turn",
                Some(sid),
                &format!("im:turn_end:{sid}:{}", transition.turn_seq),
            );
        }
        SessionStatus::WaitingInput => {
            bridge.dispatch(
                "waiting_input",
                "🟡 Action Required",
                "Terminal is waiting for input confirmation",
                Some(sid),
                &format!("im:waiting_input:{sid}"),
            );
        }
        SessionStatus::Error => {
            let etype = transition.error_type.as_deref().unwrap_or("unknown");
            bridge.dispatch(
                "error",
                "❗ Error",
                &format!("Error: {etype}"),
                Some(sid),
                &format!("im:error:{sid}:{etype}"),
            );
        }
        SessionStatus::Exited => {
            // hook SessionEnd 与 pty-exit 两条路径都会到这里，dedupe 收敛为一条
            bridge.dispatch(
                "session_exited",
                "Session Exited",
                "Session has exited",
                Some(sid),
                &format!("im:session_exited:{sid}"),
            );
        }
        // slow_tool（ToolRunning ≥60s timer）批次4 补齐；其余中间态不外推
        _ => {}
    }
}
