//! IM 入站：从 Telegram 收消息交给 Bot，回复再发回去（批次2，先做 Telegram）。
//!
//! 走 Bot API 的 `getUpdates` 长轮询——不需要公网入口，也不需要 webhook。
//! 只有渠道里已配置 bot token + chat_id、并且显式打开「接收消息」的 Telegram
//! 渠道才会被轮询。
//!
//! 安全边界：只接受来自已配置 `chat_id` 的消息（私聊 = 你自己；群 = 群里所有人），
//! 其余一律丢弃并记日志。能发消息的人就能让 Bot 在本机读写文件、执行命令。
//!
//! 结构：每个渠道一个 poller（收消息、处理命令和审批按钮），外加一个 worker
//! 按到达顺序把普通消息交给 Bot（同一渠道严格串行，`/stop` 不被长回合挡住）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cc_notify::{ChannelConfig, ChannelType};
use cc_panes_core::services::SettingsService;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::services::bot_service::{bot_chat_id, BotMessageOrigin};
use crate::services::{AcpChatService, Bot, BotService};

const TELEGRAM_API: &str = "https://api.telegram.org";
const LONG_POLL_SECS: u64 = 50;
/// 长轮询的 HTTP 超时必须比 `timeout` 参数长。
const HTTP_TIMEOUT_SECS: u64 = LONG_POLL_SECS + 20;
const SUPERVISOR_TICK: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Telegram 单条消息上限 4096 字符，留余量。
const MESSAGE_LIMIT: usize = 4000;
/// 回合超过这个时长先回一句「处理中」，免得手机那头以为没收到。
const PROGRESS_NOTICE_AFTER: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------
// 纯函数（单测覆盖）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundCommand {
    Help,
    ListBots,
    SwitchBot(String),
    NewThread,
    Stop,
    /// 普通消息，交给当前 Bot。
    Message(String),
    Unknown(String),
}

/// 解析一条文本。命令可带 `@botname` 后缀（群里点命令时 Telegram 会自动加上）。
pub fn parse_command(text: &str) -> InboundCommand {
    let text = text.trim();
    if !text.starts_with('/') {
        return InboundCommand::Message(text.to_string());
    }
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let command = head
        .trim_start_matches('/')
        .split('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let rest = rest.trim();
    match command.as_str() {
        "start" | "help" => InboundCommand::Help,
        "bots" => InboundCommand::ListBots,
        "to" if !rest.is_empty() => InboundCommand::SwitchBot(rest.to_string()),
        "to" => InboundCommand::ListBots,
        "new" => InboundCommand::NewThread,
        "stop" | "cancel" => InboundCommand::Stop,
        _ => InboundCommand::Unknown(command),
    }
}

/// 来源 chat 是否就是渠道配置的那一个（数字 id 或 `@channelusername` 都按字面比）。
pub fn chat_allowed(configured: Option<&str>, chat: &Value) -> bool {
    let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let id_matches = chat["id"]
        .as_i64()
        .is_some_and(|id| id.to_string() == configured);
    let username_matches = chat["username"].as_str().is_some_and(|name| {
        configured
            .trim_start_matches('@')
            .eq_ignore_ascii_case(name)
    });
    id_matches || username_matches
}

/// 按字符数切片，尽量在换行处断开。
pub fn split_message(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(1);
    let mut parts = Vec::new();
    let mut rest: Vec<char> = text.chars().collect();
    while rest.len() > limit {
        let window = &rest[..limit];
        let cut = window
            .iter()
            .rposition(|c| *c == '\n')
            .filter(|index| *index > limit / 2)
            .map(|index| index + 1)
            .unwrap_or(limit);
        parts.push(
            rest[..cut]
                .iter()
                .collect::<String>()
                .trim_end()
                .to_string(),
        );
        rest = rest[cut..].to_vec();
    }
    let tail: String = rest.into_iter().collect();
    if !tail.trim().is_empty() || parts.is_empty() {
        parts.push(tail);
    }
    parts
}

/// 当前 Bot：显式切换过的 > 渠道默认 > 第一个。切换目标已被删除时回落。
pub fn resolve_bot<'a>(
    bots: &'a [Bot],
    current: Option<&str>,
    default: Option<&str>,
) -> Option<&'a Bot> {
    [current, default]
        .into_iter()
        .flatten()
        .find_map(|id| bots.iter().find(|bot| bot.id == id))
        .or_else(|| bots.first())
}

fn help_text() -> String {
    [
        "CC-Panes Bot",
        "直接发消息 = 交给当前 Bot。",
        "/bots 列出 Bot",
        "/to <名字> 切换 Bot",
        "/new 开新话题",
        "/stop 停止当前回复",
    ]
    .join("\n")
}

fn permission_summary(params: &Value) -> String {
    let tool = &params["toolCall"];
    let title = tool["title"].as_str().unwrap_or("").trim();
    let kind = tool["kind"].as_str().unwrap_or("other");
    if title.is_empty() {
        format!("需要批准一个操作（{kind}）")
    } else {
        format!("需要批准：{title}\n（{kind}）")
    }
}

// ---------------------------------------------------------------------------
// Telegram Bot API
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct TelegramApi {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl TelegramApi {
    async fn call(&self, method: &str, body: Value) -> Result<Value, String> {
        let url = format!(
            "{}/bot{}/{method}",
            self.base.trim_end_matches('/'),
            self.token
        );
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            // reqwest 的错误文本里带 URL（含 token），只留类别。
            .map_err(|error| {
                format!("Telegram {method} request failed: {}", error.without_url())
            })?;
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Telegram {method} bad response: {}", error.without_url()))?;
        if value["ok"].as_bool() == Some(true) {
            Ok(value["result"].clone())
        } else {
            Err(format!(
                "Telegram {method} rejected: {}",
                value["description"].as_str().unwrap_or("unknown error")
            ))
        }
    }

    async fn get_updates(&self, offset: i64, timeout: u64) -> Result<Vec<Value>, String> {
        let result = self
            .call(
                "getUpdates",
                json!({"offset": offset, "timeout": timeout, "allowed_updates": ["message", "callback_query"]}),
            )
            .await?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    async fn send_text(&self, chat_id: &Value, text: &str) {
        for part in split_message(text, MESSAGE_LIMIT) {
            if let Err(error) = self
                .call("sendMessage", json!({"chat_id": chat_id, "text": part}))
                .await
            {
                warn!(error = %error, "im inbound: sendMessage failed");
                return;
            }
        }
    }

    async fn send_keyboard(&self, chat_id: &Value, text: &str, buttons: Vec<(String, String)>) {
        let rows: Vec<Value> = buttons
            .into_iter()
            .map(|(label, data)| json!([{"text": label, "callback_data": data}]))
            .collect();
        let body =
            json!({"chat_id": chat_id, "text": text, "reply_markup": {"inline_keyboard": rows}});
        if let Err(error) = self.call("sendMessage", body).await {
            warn!(error = %error, "im inbound: permission prompt failed");
        }
    }

    async fn typing(&self, chat_id: &Value) {
        let _ = self
            .call(
                "sendChatAction",
                json!({"chat_id": chat_id, "action": "typing"}),
            )
            .await;
    }
}

// ---------------------------------------------------------------------------
// 状态（offset + 当前 Bot），落盘以便重启后不重放旧消息
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelState {
    #[serde(default)]
    offset: Option<i64>,
    #[serde(default)]
    current_bot_id: Option<String>,
}

fn state_path(dir: &Path, channel_id: &str) -> PathBuf {
    let safe: String = channel_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("telegram-{safe}.json"))
}

fn load_state(path: &Path) -> ChannelState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(path: &Path, state: &ChannelState) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string(state) {
        let _ = std::fs::write(path, raw);
    }
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
    state_path: PathBuf,
    state: Mutex<ChannelState>,
    /// 审批按钮 callback_data → (chatId, requestKey, optionId, 选项名)。
    approvals: Mutex<HashMap<String, (String, String, String, String)>>,
}

impl Context {
    fn chat(&self) -> Value {
        // 发回时用配置里的 chat_id：数字按数字发，其余（@username）按字符串。
        let raw = self.channel.chat_id.clone().unwrap_or_default();
        raw.trim()
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or(Value::String(raw))
    }

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

    async fn persist(&self) {
        let snapshot = self.state.lock().await.clone();
        save_state(&self.state_path, &snapshot);
    }
}

/// 启动入站监督循环：按设置增删每个渠道的 poller（配置改动 5 秒内生效）。
pub fn spawn_im_inbound(
    app: AppHandle,
    settings: Arc<SettingsService>,
    bots: Arc<BotService>,
    acp: Arc<AcpChatService>,
    state_dir: PathBuf,
) {
    tauri::async_runtime::spawn(async move {
        let mut running: HashMap<String, tauri::async_runtime::JoinHandle<()>> = HashMap::new();
        loop {
            let all = settings.get_settings();
            let proxy_key = serde_json::to_string(&all.proxy).unwrap_or_default();
            let desired: HashMap<String, ChannelConfig> = all
                .im
                .channels
                .into_iter()
                .filter(|channel| {
                    channel.channel_type == ChannelType::Telegram
                        && channel.enabled
                        && channel.inbound_enabled
                        && channel
                            .token
                            .as_deref()
                            .is_some_and(|token| !token.trim().is_empty())
                        && channel
                            .chat_id
                            .as_deref()
                            .is_some_and(|chat| !chat.trim().is_empty())
                })
                .map(|channel| {
                    let key = format!(
                        "{}|{}|{}|{}|{}",
                        channel.id,
                        channel.token.as_deref().unwrap_or_default(),
                        channel.chat_id.as_deref().unwrap_or_default(),
                        channel.default_bot_id.as_deref().unwrap_or_default(),
                        proxy_key
                    );
                    (key, channel)
                })
                .collect();
            running.retain(|key, handle| {
                let keep = desired.contains_key(key);
                if !keep {
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
                    state: Mutex::new(load_state(&path)),
                    state_path: path,
                    channel,
                    approvals: Mutex::new(HashMap::new()),
                });
                info!(channel = %ctx.channel.id, "im inbound: telegram poller started");
                running.insert(key, tauri::async_runtime::spawn(run_poller(ctx)));
            }
            tokio::time::sleep(SUPERVISOR_TICK).await;
        }
    });
}

async fn run_poller(ctx: Arc<Context>) {
    // 第一次启用：跳过积压的旧消息（Telegram 会保留 24 小时），只处理之后发来的。
    if ctx.state.lock().await.offset.is_none() {
        if let Ok(updates) = ctx.api.get_updates(-1, 0).await {
            let next = updates
                .iter()
                .filter_map(|update| update["update_id"].as_i64())
                .max()
                .map(|id| id + 1)
                .unwrap_or(0);
            ctx.state.lock().await.offset = Some(next);
            ctx.persist().await;
        }
    }
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    // poller 被 abort 时 tx 随之 drop，worker 自然退出。
    tauri::async_runtime::spawn(run_worker(ctx.clone(), rx));
    let mut backoff = Duration::from_secs(1);
    loop {
        let offset = ctx.state.lock().await.offset.unwrap_or(0);
        match ctx.api.get_updates(offset, LONG_POLL_SECS).await {
            Ok(updates) => {
                backoff = Duration::from_secs(1);
                if updates.is_empty() {
                    continue;
                }
                for update in updates {
                    if let Some(id) = update["update_id"].as_i64() {
                        let mut state = ctx.state.lock().await;
                        state.offset = Some(state.offset.unwrap_or(0).max(id + 1));
                    }
                    handle_update(&ctx, &update, &tx).await;
                }
                ctx.persist().await;
            }
            Err(error) => {
                warn!(channel = %ctx.channel.id, error = %error, "im inbound: getUpdates failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn handle_update(ctx: &Arc<Context>, update: &Value, tx: &mpsc::UnboundedSender<String>) {
    if let Some(callback) = update.get("callback_query") {
        handle_callback(ctx, callback).await;
        return;
    }
    let Some(message) = update.get("message") else {
        return;
    };
    if !chat_allowed(ctx.channel.chat_id.as_deref(), &message["chat"]) {
        warn!(
            channel = %ctx.channel.id,
            from = %message["chat"]["id"],
            "im inbound: dropped message from an unconfigured chat"
        );
        return;
    }
    let Some(text) = message["text"].as_str() else {
        ctx.api.send_text(&ctx.chat(), "目前只支持文字消息。").await;
        return;
    };
    match parse_command(text) {
        InboundCommand::Message(text) if text.is_empty() => {}
        InboundCommand::Message(text) => {
            let _ = tx.send(text);
        }
        InboundCommand::Help => ctx.api.send_text(&ctx.chat(), &help_text()).await,
        InboundCommand::Unknown(command) => {
            ctx.api
                .send_text(
                    &ctx.chat(),
                    &format!("不认识的命令 /{command}\n\n{}", help_text()),
                )
                .await
        }
        InboundCommand::ListBots => {
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
            ctx.api.send_text(&ctx.chat(), &text).await;
        }
        InboundCommand::SwitchBot(name) => match ctx.bots.find(&name) {
            Some(bot) => {
                ctx.state.lock().await.current_bot_id = Some(bot.id.clone());
                ctx.persist().await;
                ctx.api
                    .send_text(
                        &ctx.chat(),
                        &format!("已切换到 {} {}", bot.avatar.trim(), bot.name),
                    )
                    .await;
            }
            None => {
                ctx.api
                    .send_text(
                        &ctx.chat(),
                        &format!("没有叫「{name}」的 Bot。/bots 看看有哪些。"),
                    )
                    .await
            }
        },
        InboundCommand::NewThread => match ctx.current_bot().await {
            Some(bot) => match ctx.bots.new_thread(&bot.id).await {
                Ok(_) => {
                    crate::services::bot_service::emit_changed(&ctx.app);
                    ctx.api
                        .send_text(&ctx.chat(), &format!("{} 已开新话题。", bot.name))
                        .await
                }
                Err(error) => ctx.api.send_text(&ctx.chat(), &format!("⚠️ {error}")).await,
            },
            None => ctx.api.send_text(&ctx.chat(), "还没有 Bot。").await,
        },
        InboundCommand::Stop => {
            if let Some(bot) = ctx.current_bot().await {
                let _ = ctx.bots.cancel(&bot.id).await;
                ctx.api.send_text(&ctx.chat(), "已请求停止。").await;
            }
        }
    }
}

async fn handle_callback(ctx: &Arc<Context>, callback: &Value) {
    let callback_id = callback["id"].clone();
    let allowed = chat_allowed(ctx.channel.chat_id.as_deref(), &callback["message"]["chat"]);
    let data = callback["data"].as_str().unwrap_or_default().to_string();
    let entry = if allowed {
        ctx.approvals.lock().await.remove(&data)
    } else {
        None
    };
    let answer = match entry {
        Some((chat_id, request_key, option_id, label)) => {
            // 同一请求的其他选项按钮一并作废。
            ctx.approvals
                .lock()
                .await
                .retain(|_, (_, key, _, _)| key != &request_key);
            match ctx
                .acp
                .respond_permission(&chat_id, request_key, Some(option_id))
                .await
            {
                Ok(()) => format!("已选择：{label}"),
                Err(_) => "这个请求已经处理过了".to_string(),
            }
        }
        None => "这个请求已经处理过了".to_string(),
    };
    let _ = ctx
        .api
        .call(
            "answerCallbackQuery",
            json!({"callback_query_id": callback_id, "text": answer}),
        )
        .await;
    if let Some(message_id) = callback["message"]["message_id"].as_i64() {
        let _ = ctx
            .api
            .call(
                "editMessageReplyMarkup",
                json!({"chat_id": callback["message"]["chat"]["id"], "message_id": message_id, "reply_markup": {"inline_keyboard": []}}),
            )
            .await;
    }
}

async fn run_worker(ctx: Arc<Context>, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(text) = rx.recv().await {
        let Some(bot) = ctx.current_bot().await else {
            ctx.api
                .send_text(
                    &ctx.chat(),
                    "还没有 Bot。先在 CC-Panes 桌面端「联系人」里新建一个。",
                )
                .await;
            continue;
        };
        ctx.api.typing(&ctx.chat()).await;
        let watcher = tauri::async_runtime::spawn(watch_turn(ctx.clone(), bot.id.clone()));
        let result = ctx
            .bots
            .submit_external(&ctx.app, &bot.id, &text, BotMessageOrigin::Im)
            .await;
        watcher.abort();
        let many = ctx.bots.list_bots().len() > 1;
        let reply = match result {
            Ok(reply) if reply.is_empty() => "（没有文字回复）".to_string(),
            Ok(reply) => reply,
            Err(error) => format!("⚠️ {error}"),
        };
        let reply = if many {
            format!("{} {}：\n{reply}", bot.avatar.trim(), bot.name)
        } else {
            reply
        };
        ctx.api.send_text(&ctx.chat(), &reply).await;
    }
}

/// 回合进行中：转发审批请求（带按钮）、提示需要桌面端回答的问题、超时报「处理中」。
async fn watch_turn(ctx: Arc<Context>, bot_id: String) {
    let chat_id = bot_chat_id(&bot_id);
    let mut events = ctx.acp.subscribe_events();
    let progress = tokio::time::sleep(PROGRESS_NOTICE_AFTER);
    tokio::pin!(progress);
    let mut progress_sent = false;
    loop {
        tokio::select! {
            () = &mut progress, if !progress_sent => {
                progress_sent = true;
                ctx.api.send_text(&ctx.chat(), "⏳ 处理中…").await;
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                };
                if event.chat_id != chat_id {
                    continue;
                }
                match event.kind.as_str() {
                    "permission_request" => forward_permission(&ctx, &chat_id, &event.payload).await,
                    "elicitation_request" => {
                        ctx.api
                            .send_text(&ctx.chat(), "❓ Bot 在问一个问题，需要到桌面端回答。")
                            .await;
                    }
                    "turn_ended" => return,
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
    let mut buttons = Vec::new();
    let mut approvals = ctx.approvals.lock().await;
    for option in params["options"].as_array().into_iter().flatten() {
        let Some(option_id) = option["optionId"].as_str() else {
            continue;
        };
        let label = option["name"].as_str().unwrap_or(option_id).to_string();
        // callback_data 上限 64 字节：用短随机键映射回完整请求。
        let key = format!("p:{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        approvals.insert(
            key.clone(),
            (
                chat_id.to_string(),
                request_key.to_string(),
                option_id.to_string(),
                label.clone(),
            ),
        );
        buttons.push((label, key));
    }
    drop(approvals);
    if buttons.is_empty() {
        ctx.api
            .send_text(
                &ctx.chat(),
                &format!("{}\n请到桌面端处理。", permission_summary(params)),
            )
            .await;
        return;
    }
    ctx.api
        .send_keyboard(&ctx.chat(), &permission_summary(params), buttons)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn only_the_configured_chat_is_allowed() {
        let me = json!({"id": 123456789, "type": "private"});
        let stranger = json!({"id": 987, "type": "private"});
        let channel = json!({"id": -100200, "username": "MyTeam"});
        assert!(chat_allowed(Some("123456789"), &me));
        assert!(chat_allowed(Some(" 123456789 "), &me));
        assert!(!chat_allowed(Some("123456789"), &stranger));
        assert!(chat_allowed(Some("@myteam"), &channel));
        assert!(chat_allowed(Some("-100200"), &channel));
        assert!(!chat_allowed(None, &me));
        assert!(!chat_allowed(Some(""), &me));
        assert!(!chat_allowed(Some("123456789"), &json!({})));
    }

    #[test]
    fn splits_long_messages_on_newlines_and_chars() {
        assert_eq!(split_message("short", 10), vec!["short"]);
        assert_eq!(split_message("", 10), vec![""]);
        // 后半窗口里有换行就在换行处断，否则硬切。
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
        let dir = std::env::temp_dir().join(format!("ccp-im-inbound-{}", uuid::Uuid::new_v4()));
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
            },
        );
        let loaded = load_state(&path);
        assert_eq!(loaded.offset, Some(42));
        assert_eq!(loaded.current_bot_id.as_deref(), Some("b"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn permission_summary_mentions_tool() {
        let text =
            permission_summary(&json!({"toolCall": {"title": "rm build/", "kind": "execute"}}));
        assert!(text.contains("rm build/"));
        assert!(text.contains("execute"));
        assert!(permission_summary(&json!({})).contains("other"));
    }

    /// 真走一遍 HTTP：getUpdates 解析与 ok=false 的报错（本地 mock Telegram）。
    #[tokio::test]
    async fn telegram_api_parses_results_and_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn serve(body: &'static str) -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let _ = socket.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
            format!("http://{addr}")
        }
        let api = |base: String| TelegramApi {
            client: reqwest::Client::new(),
            base,
            token: "T".into(),
        };
        let ok =
            api(serve(r#"{"ok":true,"result":[{"update_id":7,"message":{"text":"hi"}}]}"#).await);
        let updates = ok.get_updates(0, 0).await.unwrap();
        assert_eq!(updates[0]["update_id"], 7);
        let bad = api(serve(r#"{"ok":false,"description":"Unauthorized"}"#).await);
        let error = bad.get_updates(0, 0).await.unwrap_err();
        assert!(error.contains("Unauthorized"));
        assert!(!error.contains("botT"), "token must not leak into errors");
    }
}
