//! 把 `SessionNotifier` 的副作用转发到桌面（control 通道）。
//!
//! daemon 此前挂的是 `NoopNotifier`，导致 PTY 托管到本进程后，下面这些**不经
//! EventEmitter、走 Notifier 这条并行链**的行为在 daemon 模式下全部消失：
//! - PTY 推断出的 waiting-input（无 hook 的 CLI 只有这一条通道）
//! - 会话自然退出的系统通知
//! - last_prompt 回填与 NotificationService 清理
//! - CCChan 的 done / waiting 提醒
//!
//! 桌面侧收到后复用它自己已有的 notifier 实现，行为与本地 PTY 模式一致。

use std::sync::Arc;

use cc_panes_core::events::SessionNotifier;

use crate::ws_emitter::WsEmitter;

pub struct ControlSessionNotifier {
    emitter: Arc<WsEmitter>,
}

impl ControlSessionNotifier {
    pub fn new(emitter: Arc<WsEmitter>) -> Self {
        Self { emitter }
    }
}

impl SessionNotifier for ControlSessionNotifier {
    fn notify_waiting_input(&self, session_id: &str) {
        self.emitter
            .publish_notifier_event("waitingInput", session_id, None);
    }

    fn notify_session_exited(&self, session_id: &str, exit_code: i32) {
        self.emitter
            .publish_notifier_event("sessionExited", session_id, Some(exit_code));
    }

    fn cleanup_session(&self, session_id: &str) {
        self.emitter
            .publish_notifier_event("cleanup", session_id, None);
    }
}
