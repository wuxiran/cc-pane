//! IM 入站：从 Telegram 收消息交给 Bot，回复再发回去（批次2，先做 Telegram）。
//!
//! 走 Bot API 的 `getUpdates` 长轮询——不需要公网入口，也不需要 webhook。
//! 只有渠道里已配置 bot token + **数字** chat_id、并且显式打开「接收消息」的
//! Telegram 渠道才会被轮询；同一个 token 只允许一个渠道轮询（Telegram 同一
//! token 只能有一个 getUpdates 消费者）。
//!
//! 安全边界（`parse::sender_allowed`）：chat 必须是配置的数字 chat id，发送者
//! `from.id` 必须在白名单里；没配白名单时只接受私聊里的本人。其余一律丢弃并
//! 记日志。能发消息的人就能让 Bot 在本机读写文件、执行命令。
//!
//! 结构：每个渠道一个 poller（收消息、处理即时命令和审批按钮，从不等 Bot 锁），
//! 外加一个 worker 按到达顺序把普通消息交给 Bot（同一渠道严格串行，有界队列）。
//! `/new` 这类要动 Bot 生命周期的命令在独立任务里跑，poller 不会被长回合挡住。

mod approvals;
mod parse;
mod state;
mod telegram;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cc_notify::{ChannelConfig, ChannelType};
use cc_panes_core::services::SettingsService;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::services::bot_service::{bot_chat_id, is_own_external_prompt, BotMessageOrigin};
use crate::services::{AcpChatService, Bot, BotService, ChatEventStream};

use approvals::{binding_still_valid, ApprovalBook, TakeError};
use parse::{
    help_text, numeric_chat_id, parse_command, permission_summary, resolve_bot, sender_allowed,
    user_facing_error, InboundCommand,
};
use state::{dropped_notice, load_state, save_state, state_path, ChannelState, PendingMessage};
use telegram::TelegramApi;

use super::InboundStatusSink;

const TELEGRAM_API: &str = "https://api.telegram.org";
const LONG_POLL_SECS: u64 = 50;
/// 长轮询的 HTTP 超时必须比 `timeout` 参数长。
const HTTP_TIMEOUT_SECS: u64 = LONG_POLL_SECS + 20;
const SUPERVISOR_TICK: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Telegram 单条消息上限 4096 字符，留余量。
pub(super) const MESSAGE_LIMIT: usize = 4000;
/// 回合超过这个时长先回一句「处理中」，免得手机那头以为没收到。
const PROGRESS_NOTICE_AFTER: Duration = Duration::from_secs(15);
/// 每个渠道最多排队这么多条普通消息，多了直接回绝。
const QUEUE_CAPACITY: usize = 16;

// ---------------------------------------------------------------------------
// 监督：按设置增删每个渠道的 poller
// ---------------------------------------------------------------------------

/// 选出要轮询的渠道。数字 chat id 是入站的前提；同一 token 只给 id 最小的渠道。
fn select_pollers(
    channels: Vec<ChannelConfig>,
) -> (Vec<ChannelConfig>, Vec<(ChannelConfig, String)>) {
    let mut candidates: Vec<ChannelConfig> = channels
        .into_iter()
        .filter(|channel| {
            channel.channel_type == ChannelType::Telegram
                && channel.enabled
                && channel.inbound_enabled
                && channel
                    .token
                    .as_deref()
                    .is_some_and(|token| !token.trim().is_empty())
        })
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));
    let mut tokens = HashSet::new();
    let mut run = Vec::new();
    let mut refused = Vec::new();
    for channel in candidates {
        if numeric_chat_id(&channel).is_none() {
            refused.push((
                channel,
                "接收消息需要数字 Chat ID（@用户名 可被改名抢注，不能当身份）".to_string(),
            ));
            continue;
        }
        let token = channel
            .token
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !tokens.insert(token) {
            refused.push((
                channel,
                "另一个渠道已用同一个 Bot Token 在接收消息，这个渠道不会接收".to_string(),
            ));
            continue;
        }
        run.push(channel);
    }
    (run, refused)
}

fn poller_key(channel: &ChannelConfig, proxy_key: &str) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        channel.id,
        channel.token.as_deref().unwrap_or_default(),
        channel.chat_id.as_deref().unwrap_or_default(),
        channel.default_bot_id.as_deref().unwrap_or_default(),
        channel.inbound_allowed_user_ids.join(","),
        proxy_key
    )
}

/// 启动入站监督循环：按设置增删每个渠道的 poller（配置改动 5 秒内生效）。
pub fn spawn_im_inbound(
    app: AppHandle,
    settings: Arc<SettingsService>,
    bots: Arc<BotService>,
    acp: Arc<AcpChatService>,
    state_dir: PathBuf,
    status: InboundStatusSink,
) {
    tauri::async_runtime::spawn(async move {
        let mut running: HashMap<String, tauri::async_runtime::JoinHandle<()>> = HashMap::new();
        let mut reported: HashMap<String, String> = HashMap::new();
        loop {
            let all = settings.get_settings();
            let proxy_key = serde_json::to_string(&all.proxy).unwrap_or_default();
            let (run, refused) = select_pollers(all.im.channels);
            let mut still_refused = HashSet::new();
            for (channel, reason) in refused {
                still_refused.insert(channel.id.clone());
                if reported.get(&channel.id) != Some(&reason) {
                    warn!(channel = %channel.id, reason = %reason, "im inbound: channel refused");
                    status.refused(&channel, reason.clone());
                    reported.insert(channel.id.clone(), reason);
                }
            }
            reported.retain(|id, _| still_refused.contains(id));
            let desired: HashMap<String, ChannelConfig> = run
                .into_iter()
                .map(|channel| (poller_key(&channel, &proxy_key), channel))
                .collect();
            running.retain(|key, handle| {
                let keep = desired.contains_key(key);
                if !keep {
                    // poller 持有 worker 的 AbortOnDrop：一起停。
                    handle.abort();
                }
                keep
            });
            for (key, channel) in desired {
                if running.contains_key(&key) {
                    continue;
                }
                let client =
                    match super::build_http_client_with_timeout(&all.proxy, HTTP_TIMEOUT_SECS) {
                        Ok(client) => client,
                        Err(error) => {
                            warn!(error = %error, "im inbound: http client build failed");
                            continue;
                        }
                    };
                let Some(chat) = numeric_chat_id(&channel) else {
                    continue;
                };
                let api = TelegramApi {
                    client,
                    base: TELEGRAM_API.to_string(),
                    token: channel.token.clone().unwrap_or_default(),
                };
                let path = state_path(&state_dir, &channel.id);
                let ctx = Arc::new(Context {
                    app: app.clone(),
                    bots: bots.clone(),
                    acp: acp.clone(),
                    api,
                    chat,
                    state: Mutex::new(load_state(&path)),
                    state_path: path,
                    channel,
                    approvals: Mutex::new(ApprovalBook::default()),
                    running_bot: Mutex::new(None),
                });
                info!(channel = %ctx.channel.id, "im inbound: telegram poller started");
                running.insert(key, tauri::async_runtime::spawn(run_poller(ctx)));
            }
            tokio::time::sleep(SUPERVISOR_TICK).await;
        }
    });
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

struct Context {
    app: AppHandle,
    bots: Arc<BotService>,
    acp: Arc<AcpChatService>,
    api: TelegramApi,
    channel: ChannelConfig,
    /// 配置的数字 chat id（回复都发这里）。
    chat: i64,
    state_path: PathBuf,
    state: Mutex<ChannelState>,
    approvals: Mutex<ApprovalBook>,
    /// 正在跑 IM 回合的 Bot（`/stop` 停它，而不是「当前 Bot」）。
    running_bot: Mutex<Option<String>>,
}

impl Context {
    async fn current_bot(&self) -> Option<Bot> {
        let bots = self.bots.list_bots();
        let current = self.state.lock().await.current_bot_id.clone();
        resolve_bot(
            &bots,
            current.as_deref(),
            self.channel.default_bot_id.as_deref(),
        )
        .cloned()
    }

    async fn update_state(&self, change: impl FnOnce(&mut ChannelState)) {
        let mut state = self.state.lock().await;
        change(&mut state);
        save_state(&self.state_path, &state);
    }

    async fn send(&self, text: &str) {
        self.api.send_text(self.chat, text).await;
    }

    async fn clear_keyboards(&self, messages: Vec<i64>) {
        for message_id in messages {
            self.api.clear_keyboard(self.chat, message_id).await;
        }
    }
}

/// poller 被 abort（渠道关闭 / 改配置 / 退出）时 worker 跟着停，不会有孤儿回合。
struct AbortOnDrop(tauri::async_runtime::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 第一次启用：跳过积压的旧消息（Telegram 会保留 24 小时），只处理之后发来的。
/// 失败就退避重试——offset 没定下来之前绝不开始轮询，否则会把积压全部重放。
async fn skip_backlog(api: &TelegramApi, state: &Mutex<ChannelState>, path: &std::path::Path) {
    if state.lock().await.offset.is_some() {
        return;
    }
    let mut backoff = Duration::from_secs(1);
    loop {
        match api.get_updates(-1, 0).await {
            Ok(updates) => {
                let next = updates
                    .iter()
                    .filter_map(|update| update["update_id"].as_i64())
                    .max()
                    .map(|id| id + 1)
                    .unwrap_or(0);
                let mut state = state.lock().await;
                state.offset = Some(next);
                save_state(path, &state);
                return;
            }
            Err(error) => {
                warn!(error = %error, "im inbound: skipping backlog failed; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// 处理一条 update 之前：推进 offset 并立即落盘（至多一次）。已处理过的返回 false。
fn begin_update(state: &mut ChannelState, path: &std::path::Path, update: &Value) -> bool {
    let Some(id) = update["update_id"].as_i64() else {
        return false;
    };
    if state.offset.is_some_and(|offset| id < offset) {
        return false;
    }
    state.advance(id);
    save_state(path, state);
    true
}

async fn run_poller(ctx: Arc<Context>) {
    skip_backlog(&ctx.api, &ctx.state, &ctx.state_path).await;
    let dropped = std::mem::take(&mut ctx.state.lock().await.pending);
    if let Some(notice) = dropped_notice(&dropped) {
        ctx.update_state(|_| {}).await;
        ctx.send(&notice).await;
    }
    let (tx, rx) = mpsc::channel::<PendingMessage>(QUEUE_CAPACITY);
    let _worker = AbortOnDrop(tauri::async_runtime::spawn(run_worker(ctx.clone(), rx)));
    let mut backoff = Duration::from_secs(1);
    loop {
        let offset = ctx.state.lock().await.offset.unwrap_or(0);
        match ctx.api.get_updates(offset, LONG_POLL_SECS).await {
            Ok(updates) => {
                backoff = Duration::from_secs(1);
                for update in updates {
                    let fresh = {
                        let mut state = ctx.state.lock().await;
                        begin_update(&mut state, &ctx.state_path, &update)
                    };
                    if fresh {
                        handle_update(&ctx, &update, &tx).await;
                    }
                }
                let expired = ctx.approvals.lock().await.remove_expired(Instant::now());
                ctx.clear_keyboards(expired).await;
            }
            Err(error) => {
                warn!(channel = %ctx.channel.id, error = %error, "im inbound: getUpdates failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn handle_update(ctx: &Arc<Context>, update: &Value, tx: &mpsc::Sender<PendingMessage>) {
    if let Some(callback) = update.get("callback_query") {
        handle_callback(ctx, callback).await;
        return;
    }
    let Some(message) = update.get("message") else {
        return;
    };
    if !sender_allowed(&ctx.channel, &message["chat"], &message["from"]) {
        warn!(
            channel = %ctx.channel.id,
            chat = %message["chat"]["id"],
            from = %message["from"]["id"],
            "im inbound: dropped message from an unauthorized sender"
        );
        return;
    }
    let Some(text) = message["text"].as_str() else {
        ctx.send("目前只支持文字消息。").await;
        return;
    };
    match parse_command(text) {
        InboundCommand::Message(text) if text.is_empty() => {}
        InboundCommand::Message(text) => {
            let update_id = update["update_id"].as_i64().unwrap_or_default();
            enqueue(ctx, tx, PendingMessage { update_id, text }).await;
        }
        InboundCommand::Help => ctx.send(&help_text()).await,
        InboundCommand::Unknown(command) => {
            ctx.send(&format!("不认识的命令 /{command}\n\n{}", help_text()))
                .await
        }
        InboundCommand::ListBots => list_bots(ctx).await,
        InboundCommand::SwitchBot(name) => switch_bot(ctx, &name).await,
        // 要等 Bot 生命周期锁、要停进程：放到独立任务，poller 继续收 /stop 和审批。
        InboundCommand::NewThread => {
            tauri::async_runtime::spawn(new_thread(ctx.clone()));
        }
        InboundCommand::Stop => {
            let running = ctx.running_bot.lock().await.clone();
            let target = match running {
                Some(id) => Some(id),
                None => ctx.current_bot().await.map(|bot| bot.id),
            };
            if let Some(bot_id) = target {
                let _ = ctx.bots.cancel(&bot_id).await;
                ctx.send("已请求停止。").await;
            }
        }
    }
}

/// 收下并排队；先记进 `pending` 再入队，重启时能告诉用户哪些没处理。
async fn enqueue(ctx: &Arc<Context>, tx: &mpsc::Sender<PendingMessage>, message: PendingMessage) {
    ctx.update_state(|state| state.pending.push(message.clone()))
        .await;
    if tx.try_send(message.clone()).is_err() {
        ctx.update_state(|state| state.pending.retain(|item| item != &message))
            .await;
        ctx.send(&format!(
            "排队的消息太多了（最多 {QUEUE_CAPACITY} 条），这条没有处理，稍后再发。"
        ))
        .await;
    }
}

async fn list_bots(ctx: &Arc<Context>) {
    let bots = ctx.bots.list_bots();
    let current = ctx.current_bot().await.map(|bot| bot.id);
    let text = if bots.is_empty() {
        "还没有 Bot。先在 CC-Panes 桌面端「联系人」里新建一个。".to_string()
    } else {
        bots.iter()
            .map(|bot| {
                let mark = if Some(&bot.id) == current.as_ref() {
                    "▶"
                } else {
                    "·"
                };
                format!("{mark} {} {}", bot.avatar.trim(), bot.name)
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n\n/to <名字> 切换"
    };
    ctx.send(&text).await;
}

async fn switch_bot(ctx: &Arc<Context>, name: &str) {
    match ctx.bots.find(name) {
        Some(bot) => {
            let id = bot.id.clone();
            ctx.update_state(|state| state.current_bot_id = Some(id))
                .await;
            ctx.send(&format!("已切换到 {} {}", bot.avatar.trim(), bot.name))
                .await;
        }
        None => {
            ctx.send(&format!("没有叫「{name}」的 Bot。/bots 看看有哪些。"))
                .await
        }
    }
}

/// `/new`：BotService 先取消进行中的回合，再停进程、忘线程。
async fn new_thread(ctx: Arc<Context>) {
    let Some(bot) = ctx.current_bot().await else {
        ctx.send("还没有 Bot。").await;
        return;
    };
    match ctx.bots.new_thread(&bot.id).await {
        Ok(_) => {
            crate::services::bot_service::emit_changed(&ctx.app);
            ctx.send(&format!("{} 已开新话题。", bot.name)).await
        }
        Err(error) => {
            warn!(bot = %bot.id, error = %error, "im inbound: /new failed");
            ctx.send(user_facing_error(error.code())).await
        }
    }
}

async fn handle_callback(ctx: &Arc<Context>, callback: &Value) {
    let callback_id = callback["id"].clone();
    if !sender_allowed(
        &ctx.channel,
        &callback["message"]["chat"],
        &callback["from"],
    ) {
        warn!(
            channel = %ctx.channel.id,
            from = %callback["from"]["id"],
            "im inbound: dropped approval tap from an unauthorized sender"
        );
        ctx.api.answer_callback(&callback_id, "无权操作").await;
        return;
    }
    let token = callback["data"].as_str().unwrap_or_default();
    let taken = ctx.approvals.lock().await.take(token, Instant::now());
    let answer = match taken {
        Ok(entry) => {
            let live = ctx
                .acp
                .permission_binding(&entry.chat_id, &entry.request_key)
                .await;
            if !binding_still_valid(&entry, live.as_ref()) {
                "这个请求已失效（已处理或会话已重启）".to_string()
            } else {
                match ctx
                    .acp
                    .respond_permission(
                        &entry.chat_id,
                        entry.request_key.clone(),
                        Some(entry.option_id.clone()),
                    )
                    .await
                {
                    Ok(()) => format!("已选择：{}", entry.label),
                    Err(_) => "这个请求已经处理过了".to_string(),
                }
            }
        }
        Err(TakeError::Expired) => "这个请求已过期，请到桌面端处理".to_string(),
        Err(TakeError::Unknown) => "这个请求已经处理过了".to_string(),
    };
    ctx.api.answer_callback(&callback_id, &answer).await;
    if let Some(message_id) = callback["message"]["message_id"].as_i64() {
        ctx.api.clear_keyboard(ctx.chat, message_id).await;
    }
}

async fn run_worker(ctx: Arc<Context>, mut rx: mpsc::Receiver<PendingMessage>) {
    while let Some(message) = rx.recv().await {
        // 交给 Bot 之前出账（至多一次）：中途退出不会在重启后再执行一遍。
        ctx.update_state(|state| state.pending.retain(|item| item != &message))
            .await;
        let Some(bot) = ctx.current_bot().await else {
            ctx.send("还没有 Bot。先在 CC-Panes 桌面端「联系人」里新建一个。")
                .await;
            continue;
        };
        ctx.api.typing(ctx.chat).await;
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let chat_id = bot_chat_id(&bot.id);
        // 先订阅再提交：watcher 只从本条消息的 external_prompt 之后开始转发。
        let events = ctx.acp.subscribe_chat(&chat_id);
        let watcher = AbortOnDrop(tauri::async_runtime::spawn(watch_turn(
            ctx.clone(),
            chat_id.clone(),
            prompt_id.clone(),
            events,
        )));
        *ctx.running_bot.lock().await = Some(bot.id.clone());
        let result = ctx
            .bots
            .submit_external(
                &ctx.app,
                &bot.id,
                &prompt_id,
                &message.text,
                BotMessageOrigin::Im,
            )
            .await;
        *ctx.running_bot.lock().await = None;
        drop(watcher);
        let leftover = ctx.approvals.lock().await.remove_chat(&chat_id);
        ctx.clear_keyboards(leftover).await;
        let reply = match result {
            Ok(reply) if reply.is_empty() => "（没有文字回复）".to_string(),
            Ok(reply) => reply,
            Err(error) => {
                warn!(bot = %bot.id, error = %error, "im inbound: bot turn failed");
                user_facing_error(error.code()).to_string()
            }
        };
        let reply = if ctx.bots.list_bots().len() > 1 {
            format!("{} {}：\n{reply}", bot.avatar.trim(), bot.name)
        } else {
            reply
        };
        ctx.send(&reply).await;
    }
}

/// 事件是否意味着这一轮（或整个会话）结束了。
fn ends_watch(event_kind: &str, payload: &Value) -> bool {
    match event_kind {
        "turn_ended" => true,
        "state" => matches!(payload["phase"].as_str(), Some("exited" | "failed")),
        _ => false,
    }
}

/// 回合进行中：转发审批请求（带按钮）、请求在别处被处理时撤按钮、提示需要
/// 桌面端回答的问题、超时报「处理中」。订阅在提交之前，但只有见到本条消息
/// 的 `external_prompt` 之后才开始转发——排队期间界面里那一轮的审批不会发到手机。
async fn watch_turn(
    ctx: Arc<Context>,
    chat_id: String,
    prompt_id: String,
    mut events: ChatEventStream,
) {
    let progress = tokio::time::sleep(PROGRESS_NOTICE_AFTER);
    tokio::pin!(progress);
    let mut progress_sent = false;
    let mut started = false;
    loop {
        tokio::select! {
            () = &mut progress, if !progress_sent => {
                progress_sent = true;
                ctx.send("⏳ 处理中…").await;
            }
            event = events.recv() => {
                let Some(event) = event else { return };
                if !started {
                    started = is_own_external_prompt(&event, &chat_id, &prompt_id);
                    continue;
                }
                if ends_watch(&event.kind, &event.payload) {
                    let messages = ctx.approvals.lock().await.remove_chat(&chat_id);
                    ctx.clear_keyboards(messages).await;
                    return;
                }
                match event.kind.as_str() {
                    "permission_request" => forward_permission(&ctx, &chat_id, &event.payload).await,
                    "permission_resolved" => {
                        if let Some(key) = event.payload["requestKey"].as_str() {
                            let messages = ctx.approvals.lock().await.remove_request(&chat_id, key);
                            ctx.clear_keyboards(messages).await;
                        }
                    }
                    "elicitation_request" => {
                        ctx.send("❓ Bot 在问一个问题，需要到桌面端回答。").await;
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn forward_permission(ctx: &Arc<Context>, chat_id: &str, payload: &Value) {
    let Some(request_key) = payload["requestKey"].as_str() else {
        return;
    };
    let params = &payload["params"];
    // 绑定此刻会话里真实等待的那个请求（实例 + toolCall）；已不在等待就不发。
    let Some(binding) = ctx.acp.permission_binding(chat_id, request_key).await else {
        return;
    };
    let options: Vec<(String, String)> = params["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let option_id = option["optionId"].as_str()?;
            let label = option["name"].as_str().unwrap_or(option_id);
            Some((option_id.to_string(), label.to_string()))
        })
        .collect();
    if options.is_empty() {
        ctx.send(&format!("{}\n请到桌面端处理。", permission_summary(params)))
            .await;
        return;
    }
    let buttons =
        ctx.approvals
            .lock()
            .await
            .insert(chat_id, request_key, binding, options, Instant::now());
    if let Some(message_id) = ctx
        .api
        .send_keyboard(ctx.chat, &permission_summary(params), buttons)
        .await
    {
        ctx.approvals
            .lock()
            .await
            .set_message(chat_id, request_key, message_id);
    }
}
