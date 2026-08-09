//! 状态机跃迁 → IM 外推事件的映射消费者。
//!
//! 走 `subscribe_transitions()` broadcast + tokio task，不走 sync `subscribe`
//! 回调——那条在 hook/PTY 线程同步执行，只准 O(1)+spawn，禁网络 IO。
//! kind / dedupe_key 与 NotificationService 的桌面通知同口径（前缀 `im:`），
//! 两条通道各自独立判闸。

use super::ImBridgeService;
use crate::services::TurnNotifyRegistry;
use cc_panes_core::services::terminal_service::SessionStatus;
use cc_panes_core::services::StateTransition;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{debug, warn};

pub fn spawn_im_transition_consumer(
    bridge: Arc<ImBridgeService>,
    turn_notify: Arc<TurnNotifyRegistry>,
    mut rx: broadcast::Receiver<StateTransition>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(transition) => handle_transition(&bridge, &turn_notify, &transition),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // 外推是事件摘要而非镜像，落后只记警告继续（丢的是重复度高的中间态）
                    warn!(skipped, "im_bridge: transition consumer lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn handle_transition(
    bridge: &ImBridgeService,
    turn_notify: &TurnNotifyRegistry,
    transition: &StateTransition,
) {
    let sid = transition.pty_session_id.as_str();
    match transition.to {
        SessionStatus::Idle => {
            // turn_notify 去重查标位：IM 兜底只在富通知**实际通过了 IM 转发闸门**
            // （im_forwarded=true）时才跳过。当前（docs/88 批次1 现状）AI 富通知
            // 尚未接 IM 转发，trigger 侧写入的 im_forwarded 恒 false，因此这里
            // **恒不跳过**——若按「有标记就跳」，桌面收了富摘要而用户 IM 侧本轮
            // 将什么都收不到。待 docs/88 批次2 接通 IM 转发后，trigger 侧按实际
            // 转发结果写 im_forwarded，此闸门自动生效，无需再改这里。
            if turn_notify
                .is_marked(sid)
                .map(|mark| mark.im_forwarded)
                .unwrap_or(false)
            {
                debug!(
                    session_id = %sid,
                    "turn_end IM fallback skipped: rich AI notification already forwarded to IM"
                );
                return;
            }
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
