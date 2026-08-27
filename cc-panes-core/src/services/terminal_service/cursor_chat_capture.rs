//! Cursor Agent resume id：启动后扫描 `~/.cursor/chats/**/meta.json`。
//!
//! Cursor 无 OSC 标题 / issued session id；chat uuid 只在落盘 meta 后可见。
//! 策略对齐 Codex rollout-scan：新会话启动后后台轮询，匹配 cwd + createdAt ≥ launch，
//! emit `terminal-resume-id-detected`（source = `cursor-chat-scan`）供 bind_resume_id 落库。

use crate::constants::events as EV;
use crate::events::EventEmitter;
use crate::services::cursor_session_service;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tracing::{info, warn};

const MAX_ATTEMPTS: u32 = 60;
const EARLY_DELAY_MS: u64 = 500;
const LATE_DELAY_MS: u64 = 2_000;

#[derive(Clone)]
pub(super) struct CursorChatCaptureContext {
    pub session_id: String,
    pub runtime_kind: String,
    pub launch_id: Option<String>,
    pub project_path: String,
    pub workspace_path: Option<String>,
    pub wsl_distro: Option<String>,
    pub launch_started_at: SystemTime,
}

/// 启动后台扫描线程。返回的 handle 目前只作生命周期占位（线程自管 done）。
pub(super) struct CursorChatCapture {
    #[allow(dead_code)]
    done: Arc<AtomicBool>,
}

impl CursorChatCapture {
    pub(super) fn start(ctx: CursorChatCaptureContext, emitter: Arc<dyn EventEmitter>) -> Self {
        let done = Arc::new(AtomicBool::new(false));
        let done_flag = done.clone();
        std::thread::Builder::new()
            .name(format!(
                "cursor-chat-scan-{}",
                &ctx.session_id[..8.min(ctx.session_id.len())]
            ))
            .spawn(move || {
                run_scan(ctx, emitter, done_flag);
            })
            .ok();
        Self { done }
    }
}

fn run_scan(ctx: CursorChatCaptureContext, emitter: Arc<dyn EventEmitter>, done: Arc<AtomicBool>) {
    for attempt in 1..=MAX_ATTEMPTS {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let found = if ctx.runtime_kind == "wsl" {
            let after = chrono::DateTime::<chrono::Utc>::from(ctx.launch_started_at);
            cursor_session_service::detect_wsl_session_after(
                &ctx.project_path,
                after,
                ctx.wsl_distro.as_deref(),
            )
        } else {
            cursor_session_service::detect_session_after(&ctx.project_path, ctx.launch_started_at)
        };

        match found {
            Ok(Some(chat_id)) => {
                if done.swap(true, Ordering::AcqRel) {
                    return;
                }
                info!(
                    session_id = %ctx.session_id,
                    resume_session_id = %chat_id,
                    attempt,
                    "cursor: chat id detected via meta.json scan"
                );
                let _ = emitter.emit(
                    EV::TERMINAL_RESUME_ID_DETECTED,
                    serde_json::json!({
                        "sessionId": ctx.session_id,
                        "resumeSessionId": chat_id,
                        "source": "cursor-chat-scan",
                        "cliTool": "cursor",
                        "runtimeKind": ctx.runtime_kind,
                        "launchId": ctx.launch_id,
                        "projectPath": ctx.project_path,
                        "workspacePath": ctx.workspace_path,
                        "wslDistro": ctx.wsl_distro,
                    }),
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                if attempt == 1 || attempt % 10 == 0 {
                    warn!(
                        session_id = %ctx.session_id,
                        attempt,
                        error = %error,
                        "cursor-chat-scan: detect failed"
                    );
                }
            }
        }
        let delay = if attempt < 8 {
            EARLY_DELAY_MS
        } else {
            LATE_DELAY_MS
        };
        std::thread::sleep(Duration::from_millis(delay));
    }
    warn!(
        session_id = %ctx.session_id,
        project_path = %ctx.project_path,
        "cursor-chat-scan: exhausted attempts without detecting chat id"
    );
}
