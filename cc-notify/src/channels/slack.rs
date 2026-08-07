use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};

/// Slack Incoming Webhook：Block Kit 消息
pub fn build(config: &ChannelConfig, payload: &NotifyPayload) -> Result<BuiltRequest, String> {
    let body = serde_json::json!({
        "blocks": [{
            "type": "header",
            "text": { "type": "plain_text", "text": payload.title }
        }, {
            "type": "section",
            "text": { "type": "mrkdwn", "text": payload.body }
        }]
    });
    Ok(BuiltRequest {
        url: config.url.clone(),
        body,
        headers: vec![],
    })
}
