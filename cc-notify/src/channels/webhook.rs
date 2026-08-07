use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};

/// 通用 Webhook：POST 完整 NotifyPayload JSON，可选 Bearer token。
pub fn build(config: &ChannelConfig, payload: &NotifyPayload) -> Result<BuiltRequest, String> {
    let body = serde_json::to_value(payload).map_err(|e| format!("序列化失败: {}", e))?;
    let mut headers = vec![];
    if let Some(token) = config.token.as_deref().filter(|t| !t.is_empty()) {
        headers.push(("Authorization".to_string(), format!("Bearer {}", token)));
    }
    Ok(BuiltRequest {
        url: config.url.clone(),
        body,
        headers,
    })
}
