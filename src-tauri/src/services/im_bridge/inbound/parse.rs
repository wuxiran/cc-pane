//! 纯函数：命令解析、来源授权、切片、Bot 选择、文案。

use cc_notify::ChannelConfig;
use serde_json::Value;

use crate::services::Bot;

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

/// 入站只认数字 chat id（`@username` 可改名后被别人抢注，不能当身份）。
pub fn numeric_chat_id(channel: &ChannelConfig) -> Option<i64> {
    channel.chat_id.as_deref()?.trim().parse::<i64>().ok()
}

/// 渠道配置的发送者白名单（数字 user id）；非数字项忽略。
pub fn allowed_user_ids(channel: &ChannelConfig) -> Vec<i64> {
    channel
        .inbound_allowed_user_ids
        .iter()
        .filter_map(|id| id.trim().parse::<i64>().ok())
        .collect()
}

/// 来源是否可信：chat 必须是配置的数字 chat id；发送者（`from.id`）必须在
/// 白名单里。没配白名单时只接受私聊里的本人（私聊 `from.id == chat.id`）——
/// 群里默认谁都不认，避免「群里每个人都能让 Bot 执行命令」。
pub fn sender_allowed(channel: &ChannelConfig, chat: &Value, from: &Value) -> bool {
    let Some(configured) = numeric_chat_id(channel) else {
        return false;
    };
    if chat["id"].as_i64() != Some(configured) {
        return false;
    }
    let Some(sender) = from["id"].as_i64() else {
        return false;
    };
    if from["is_bot"].as_bool() == Some(true) {
        return false;
    }
    let allowed = allowed_user_ids(channel);
    if allowed.is_empty() {
        chat["type"].as_str() == Some("private") && sender == configured
    } else {
        allowed.contains(&sender)
    }
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

pub fn help_text() -> String {
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

pub fn permission_summary(params: &Value) -> String {
    let tool = &params["toolCall"];
    let title = tool["title"].as_str().unwrap_or("").trim();
    let kind = tool["kind"].as_str().unwrap_or("other");
    if title.is_empty() {
        format!("需要批准一个操作（{kind}）")
    } else {
        format!("需要批准：{title}\n（{kind}）")
    }
}

/// 发回 IM 的错误文案：只给用户能处理的提示，细节（路径、引擎输出）只进日志。
pub fn user_facing_error(code: Option<&str>) -> &'static str {
    match code {
        Some("BOT_BUSY") => "⚠️ Bot 还在忙上一轮，稍后再试。",
        Some("BOT_TURN_TIMEOUT") => "⚠️ 回复超时，已取消这一轮。",
        Some("BOT_NOT_FOUND") => "⚠️ 这个 Bot 已经不在了，/bots 看看有哪些。",
        Some("ACP_SESSION_NOT_READY") => "⚠️ Bot 的会话没在运行（可能刚被停止），再发一次试试。",
        _ => "⚠️ 出错了，详情见桌面端日志。",
    }
}
