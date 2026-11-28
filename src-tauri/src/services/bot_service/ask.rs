//! 外部提交：IM 入站与 Agent Chat 里的 `@Bot`。排队等 Bot 空闲 → 发 prompt →
//! 等回合结束 → 拼出助手回复文本。
//!
//! 取消（只给界面 `@Bot` 用）分两段：本条还没被 Bot 接下（排队 / 等空闲）时直接
//! 放弃；已接下（见到本条的 `external_prompt` 公告）时走 ACP cancel，等回合以
//! `cancelled` 收尾，返回已到达的部分回复。**本条接下之前绝不发 ACP cancel**——
//! 那会取消 Bot 正在跑的别人的回合（界面里手动发的、或 IM 那条）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{
    bot_chat_id, collect_reply_text, is_own_external_prompt, BotMessageOrigin, BotService,
    ExternalTurnOptions, EXTERNAL_PROMPT_EVENT_KIND,
};
use crate::services::{
    AcpChatEvent, AcpChatPhase, ChatEventStream, PromptAnnouncement, UserPrompt,
};
use crate::utils::{AppError, AppResult};

/// 外部消息最多等多久前一轮（界面里手动发起的）结束。
const WAIT_READY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WAIT_READY_POLL: Duration = Duration::from_millis(400);
/// 一轮回复的硬上限：超时取消该轮，避免调用方无限挂起。
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// 已要求取消、但本条还没被接下时，多久复查一次公告。
const CANCEL_POLL: Duration = Duration::from_millis(100);
const ASK_ID_MAX: usize = 64;

/// 一轮外部提交的结果。
pub struct ExternalTurn {
    pub reply: String,
    pub stop_reason: String,
}

/// `ask_bot` 的返回：回复正文 + 收尾原因（`cancelled` = 用户取消，正文可能是部分）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotAskReply {
    pub text: String,
    pub stop_reason: String,
    pub bot_chat_id: String,
}

/// 界面 `@Bot` 的在途请求：askId → 取消信号。
#[derive(Default)]
pub struct BotAskRegistry {
    inflight: std::sync::Mutex<HashMap<String, watch::Sender<bool>>>,
}

/// 在途登记的作用域守卫：请求结束（含出错 / future 被丢弃）即注销。
struct AskSlot<'a> {
    registry: &'a BotAskRegistry,
    ask_id: String,
}

impl Drop for AskSlot<'_> {
    fn drop(&mut self) {
        self.registry.lock().remove(&self.ask_id);
    }
}

impl BotAskRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, watch::Sender<bool>>> {
        self.inflight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn register(&self, ask_id: &str) -> AppResult<(AskSlot<'_>, watch::Receiver<bool>)> {
        let mut map = self.lock();
        if map.contains_key(ask_id) {
            return Err(AppError::coded(
                "BOT_ASK_DUPLICATE",
                "Ask id is already in use",
            ));
        }
        let (tx, rx) = watch::channel(false);
        map.insert(ask_id.to_string(), tx);
        Ok((
            AskSlot {
                registry: self,
                ask_id: ask_id.to_string(),
            },
            rx,
        ))
    }

    /// 要求取消；不在途（已结束 / 未知）返回 false。
    pub fn cancel(&self, ask_id: &str) -> bool {
        match self.lock().get(ask_id) {
            Some(tx) => {
                tx.send_replace(true);
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

type CancelRx = Option<watch::Receiver<bool>>;

/// 取消信号到达才返回；没有信号源（IM）或发送端已注销则永不返回。
async fn cancelled(cancel: &mut CancelRx) {
    match cancel {
        Some(rx) => {
            if rx.wait_for(|flag| *flag).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

fn is_cancelled(cancel: &CancelRx) -> bool {
    cancel.as_ref().is_some_and(|rx| *rx.borrow())
}

fn ask_cancelled() -> AppError {
    AppError::coded("BOT_ASK_CANCELLED", "Bot request was cancelled")
}

fn valid_ask_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ASK_ID_MAX
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 一轮外部提交要发出的内容（重试占回合时原样复用）。
struct TurnRequest<'a> {
    prompt_id: &'a str,
    blocks: Vec<Value>,
    announce: PromptAnnouncement,
    user: UserPrompt,
    auto_approve_override: Option<&'a [String]>,
}

/// 本条消息这一轮的事件：先订阅再提交，整轮一个不丢；也用来判断本条是否已被接下。
struct TurnTap {
    events: ChatEventStream,
    seen: Vec<AcpChatEvent>,
}

impl TurnTap {
    fn drain(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            self.seen.push(event);
        }
    }

    fn admitted(&mut self, chat_id: &str, prompt_id: &str) -> bool {
        self.drain();
        self.seen
            .iter()
            .any(|event| is_own_external_prompt(event, chat_id, prompt_id))
    }
}

impl BotService {
    /// IM 入站：排队等前一轮结束，发出后等回合结束，返回助手回复文本。
    ///
    /// `prompt_id` 进 `external_prompt` 公告的载荷，调用方据此认出
    /// 「本条消息这一轮」的事件。
    pub async fn submit_external(
        self: &Arc<Self>,
        app: &AppHandle,
        bot_id: &str,
        prompt_id: &str,
        text: &str,
        origin: BotMessageOrigin,
    ) -> AppResult<String> {
        self.submit_external_with(
            app,
            bot_id,
            prompt_id,
            text,
            origin,
            ExternalTurnOptions::default(),
        )
        .await
    }

    /// [`Self::submit_external`] + 组网选项（来源、临时权限策略、公告附加字段）。
    pub async fn submit_external_with(
        self: &Arc<Self>,
        app: &AppHandle,
        bot_id: &str,
        prompt_id: &str,
        text: &str,
        origin: BotMessageOrigin,
        options: ExternalTurnOptions,
    ) -> AppResult<String> {
        let turn = self
            .submit_turn(app, bot_id, prompt_id, text, origin, options, None)
            .await?;
        if turn.reply.is_empty() && turn.stop_reason == "cancelled" {
            return Ok("（已取消）".to_string());
        }
        Ok(turn.reply)
    }

    /// Agent Chat 里的 `@Bot`：交给 Bot 跑一轮，返回回复。`ask_id` 同时是本轮的
    /// promptId（界面据此把 Bot 对话里的公告对上卡片）与取消句柄。
    pub async fn ask(
        self: &Arc<Self>,
        app: &AppHandle,
        ask_id: &str,
        bot_id: &str,
        text: &str,
        from_chat_id: &str,
    ) -> AppResult<BotAskReply> {
        let ask_id = ask_id.trim();
        if !valid_ask_id(ask_id) {
            return Err(AppError::coded("BOT_ASK_BAD_ID", "Ask id is invalid"));
        }
        let from_chat_id = from_chat_id.trim();
        if from_chat_id == bot_chat_id(bot_id) {
            return Err(AppError::coded(
                "BOT_ASK_SELF",
                "A bot cannot be asked from its own chat",
            ));
        }
        self.get(bot_id)?;
        let (_slot, cancel) = self.asks.register(ask_id)?;
        let origin = BotMessageOrigin::Chat {
            from_chat_id: from_chat_id.to_string(),
        };
        let turn = self
            .submit_turn(
                app,
                bot_id,
                ask_id,
                text,
                origin,
                ExternalTurnOptions::default(),
                Some(cancel),
            )
            .await?;
        Ok(BotAskReply {
            text: turn.reply,
            stop_reason: turn.stop_reason,
            bot_chat_id: bot_chat_id(bot_id),
        })
    }

    pub fn cancel_ask(&self, ask_id: &str) -> bool {
        self.asks.cancel(ask_id.trim())
    }

    #[allow(clippy::too_many_arguments)]
    async fn submit_turn(
        self: &Arc<Self>,
        app: &AppHandle,
        bot_id: &str,
        prompt_id: &str,
        text: &str,
        origin: BotMessageOrigin,
        options: ExternalTurnOptions,
        mut cancel: CancelRx,
    ) -> AppResult<ExternalTurn> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AppError::coded(
                "ACP_PROMPT_REQUIRED",
                "Message cannot be empty",
            ));
        }
        let queue = self.queue_lock(bot_id);
        let _queued = tokio::select! {
            guard = queue.lock() => guard,
            _ = cancelled(&mut cancel) => return Err(ask_cancelled()),
        };
        // 启动过程不打断（中途丢弃会留下半启动的进程），启动完再看是否已取消。
        self.ensure_started(app, bot_id).await?;
        if is_cancelled(&cancel) {
            return Err(ask_cancelled());
        }
        let chat_id = bot_chat_id(bot_id);
        let mut tap = TurnTap {
            events: self.acp.subscribe_chat(&chat_id),
            seen: Vec::new(),
        };
        let mut payload = origin.announce_payload(text, prompt_id);
        if let Some(Value::Object(extra)) = options.announce_extra {
            for (key, value) in extra {
                payload[key] = value;
            }
        }
        let announce = PromptAnnouncement {
            kind: EXTERNAL_PROMPT_EVENT_KIND.to_string(),
            payload,
        };
        // 同一条 prompt 也以 `user_prompt` 进事件环（docs/112 §3），手机 / 桌面据此对齐。
        let prompt_origin = options
            .prompt_origin
            .unwrap_or_else(|| origin.as_prompt_origin().to_string());
        let turn = TurnRequest {
            prompt_id,
            blocks: vec![json!({"type": "text", "text": text})],
            announce,
            user: UserPrompt::new(Some(prompt_id.to_string()), prompt_origin),
            auto_approve_override: options.auto_approve_override.as_deref(),
        };
        let stop_reason = self
            .run_external_turn(&chat_id, &turn, &mut tap, &mut cancel)
            .await?;
        tap.drain();
        let reply = collect_reply_text(&chat_id, prompt_id, tap.seen.iter());
        Ok(ExternalTurn { reply, stop_reason })
    }

    /// 等会话空闲并原子地占到回合（界面里抢先发的那条先跑，这条继续等），
    /// 占到后再计回合超时。
    async fn run_external_turn(
        self: &Arc<Self>,
        chat_id: &str,
        turn: &TurnRequest<'_>,
        tap: &mut TurnTap,
        cancel: &mut CancelRx,
    ) -> AppResult<String> {
        let deadline = Instant::now() + WAIT_READY_TIMEOUT;
        loop {
            match self.chat_phase(chat_id).await {
                Some(AcpChatPhase::Ready) => {
                    // 远程策略只罩住本回合：占回合前换上，结束（或没占到）就换回。
                    let restore = match turn.auto_approve_override {
                        Some(kinds) => Some(self.swap_auto_approve(chat_id, kinds).await?),
                        None => None,
                    };
                    let attempt = self.drive_turn(chat_id, turn, tap, cancel).await;
                    if let Some(previous) = restore {
                        let _ = self.acp.set_auto_approve(chat_id, previous).await;
                    }
                    match attempt {
                        Err(error) if error.code() == Some("ACP_TURN_IN_PROGRESS") => {}
                        other => return other,
                    }
                }
                Some(AcpChatPhase::Starting | AcpChatPhase::Generating) => {}
                _ => {
                    return Err(AppError::coded(
                        "ACP_SESSION_NOT_READY",
                        "Bot session is not running",
                    ))
                }
            }
            if is_cancelled(cancel) {
                return Err(ask_cancelled());
            }
            if Instant::now() >= deadline {
                return Err(AppError::coded(
                    "BOT_BUSY",
                    "Bot is still busy with a previous turn",
                ));
            }
            tokio::select! {
                _ = tokio::time::sleep(WAIT_READY_POLL) => {}
                _ = cancelled(cancel) => return Err(ask_cancelled()),
            }
        }
    }

    /// 提交一次并等回合结束；期间收到取消，等本条被接下后再发 ACP cancel。
    async fn drive_turn(
        self: &Arc<Self>,
        chat_id: &str,
        request: &TurnRequest<'_>,
        tap: &mut TurnTap,
        cancel: &mut CancelRx,
    ) -> AppResult<String> {
        let prompt_id = request.prompt_id;
        let turn = self.acp.prompt_and_wait_from(
            chat_id,
            request.blocks.clone(),
            Some(request.announce.clone()),
            request.user.clone(),
        );
        tokio::pin!(turn);
        let turn_deadline = Instant::now() + TURN_TIMEOUT;
        let mut cancel_wanted = is_cancelled(cancel);
        let mut cancel_sent = false;
        loop {
            if cancel_wanted && !cancel_sent && tap.admitted(chat_id, prompt_id) {
                let _ = self.acp.cancel(chat_id).await;
                cancel_sent = true;
            }
            tokio::select! {
                result = &mut turn => {
                    // 本条没被接下（别人的回合抢先）而用户已取消：不再重排。
                    let not_admitted = matches!(
                        &result,
                        Err(error) if error.code() == Some("ACP_TURN_IN_PROGRESS")
                    );
                    if cancel_wanted && not_admitted {
                        return Err(ask_cancelled());
                    }
                    return result;
                }
                _ = tokio::time::sleep_until(turn_deadline) => {
                    let _ = self.acp.cancel(chat_id).await;
                    return Err(AppError::coded("BOT_TURN_TIMEOUT", "Bot reply timed out"));
                }
                _ = cancelled(cancel), if !cancel_wanted => cancel_wanted = true,
                _ = tokio::time::sleep(CANCEL_POLL), if cancel_wanted && !cancel_sent => {}
            }
        }
    }

    /// 换上新的自动放行集合，返回原来的（供回合结束后恢复）。
    async fn swap_auto_approve(&self, chat_id: &str, kinds: &[String]) -> AppResult<Vec<String>> {
        let previous = self
            .acp
            .snapshot(chat_id)
            .await
            .map(|snapshot| snapshot.auto_approve_kinds)
            .unwrap_or_default();
        self.acp.set_auto_approve(chat_id, kinds.to_vec()).await?;
        Ok(previous)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_ids_are_bounded_and_safe() {
        assert!(valid_ask_id("ask-1_a"));
        assert!(!valid_ask_id(""));
        assert!(!valid_ask_id("a b"));
        assert!(!valid_ask_id(&"x".repeat(ASK_ID_MAX + 1)));
    }

    #[test]
    fn registry_cancels_only_inflight_and_unregisters_on_drop() {
        let registry = BotAskRegistry::default();
        assert!(!registry.cancel("a1"));
        {
            let (_slot, rx) = registry.register("a1").unwrap();
            assert!(registry.register("a1").is_err(), "duplicate ids rejected");
            assert!(!*rx.borrow());
            assert!(registry.cancel("a1"));
            assert!(*rx.borrow());
            assert_eq!(registry.len(), 1);
        }
        assert_eq!(registry.len(), 0);
        assert!(!registry.cancel("a1"));
    }

    #[tokio::test]
    async fn cancelled_waits_for_signal_and_ignores_missing_source() {
        let (tx, rx) = watch::channel(false);
        let mut cancel: CancelRx = Some(rx);
        assert!(!is_cancelled(&cancel));
        let pending = tokio::time::timeout(Duration::from_millis(20), cancelled(&mut cancel)).await;
        assert!(pending.is_err(), "no signal yet");
        tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), cancelled(&mut cancel))
            .await
            .expect("signal wakes the waiter");
        assert!(is_cancelled(&cancel));

        let mut none: CancelRx = None;
        let idle = tokio::time::timeout(Duration::from_millis(20), cancelled(&mut none)).await;
        assert!(idle.is_err(), "IM path never cancels");

        let (tx, rx) = watch::channel(false);
        drop(tx);
        let mut orphan: CancelRx = Some(rx);
        let idle = tokio::time::timeout(Duration::from_millis(20), cancelled(&mut orphan)).await;
        assert!(idle.is_err(), "dropped sender is not a cancel");
    }

    #[test]
    fn tap_detects_own_announcement() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tap = TurnTap {
            events: rx,
            seen: Vec::new(),
        };
        assert!(!tap.admitted("bot-a", "p1"));
        let announce = |prompt_id: &str| AcpChatEvent {
            chat_id: "bot-a".into(),
            kind: EXTERNAL_PROMPT_EVENT_KIND.into(),
            payload: json!({"promptId": prompt_id}),
        };
        tx.send(announce("p0")).unwrap();
        assert!(!tap.admitted("bot-a", "p1"), "someone else's turn");
        tx.send(announce("p1")).unwrap();
        assert!(tap.admitted("bot-a", "p1"));
        assert_eq!(tap.seen.len(), 2);
    }
}
