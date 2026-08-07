use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};

/// Telegram Bot API：sendMessage
pub fn build(config: &ChannelConfig, payload: &NotifyPayload) -> Result<BuiltRequest, String> {
    let token = config
        .token
        .as_deref()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Telegram 需要 bot token".to_string())?;
    let chat_id = config
        .chat_id
        .as_deref()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "Telegram 需要 chat_id".to_string())?;

    let body = serde_json::json!({
        "chat_id": chat_id,
        "text": format!("*{}*\n{}", payload.title, payload.body),
        "parse_mode": "Markdown"
    });
    Ok(BuiltRequest {
        url: format!("https://api.telegram.org/bot{}/sendMessage", token),
        body,
        headers: vec![],
    })
}
