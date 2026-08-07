use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};

/// 企业微信群机器人：markdown 消息（webhook key 已含在 URL 中，无加签）。
pub fn build(config: &ChannelConfig, payload: &NotifyPayload) -> Result<BuiltRequest, String> {
    let content = format!(
        "**{}**\n{}{}",
        payload.title,
        payload.body,
        super::context_suffix(payload)
    );
    let body = serde_json::json!({
        "msgtype": "markdown",
        "markdown": { "content": content }
    });

    Ok(BuiltRequest {
        url: config.url.clone(),
        body,
        headers: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChannelType;

    #[test]
    fn build_wecom_markdown() {
        let cfg = ChannelConfig {
            id: "c1".into(),
            channel_type: ChannelType::Wecom,
            name: "test".into(),
            url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz".into(),
            token: None,
            secret: None,
            chat_id: None,
            events: vec![],
            enabled: true,
        };
        let payload = NotifyPayload {
            kind: "error".into(),
            title: "❗ Error".into(),
            body: "Error: api_error".into(),
            workspace_name: None,
            project_name: Some("cc-panes".into()),
            project_path: None,
            session_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        };
        let req = build(&cfg, &payload).unwrap();
        assert_eq!(req.url, cfg.url);
        assert_eq!(req.body["msgtype"], "markdown");
        let content = req.body["markdown"]["content"].as_str().unwrap();
        assert!(content.contains("❗ Error"));
        assert!(content.contains("cc-panes"));
    }
}
