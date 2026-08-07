use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// 钉钉群机器人：markdown 消息，配置了 secret 时走加签模式。
pub fn build(
    config: &ChannelConfig,
    payload: &NotifyPayload,
    now_ms: i64,
) -> Result<BuiltRequest, String> {
    let url = match config.secret.as_deref().filter(|s| !s.is_empty()) {
        Some(secret) => signed_url(&config.url, secret, now_ms)?,
        None => config.url.clone(),
    };

    let text = format!(
        "### {}\n{}{}",
        payload.title,
        payload.body,
        super::context_suffix(payload)
    );
    let body = serde_json::json!({
        "msgtype": "markdown",
        "markdown": { "title": payload.title, "text": text }
    });

    Ok(BuiltRequest {
        url,
        body,
        headers: vec![],
    })
}

/// 钉钉加签：HmacSHA256(key=secret, data="{timestamp}\n{secret}") → base64 → urlencode，
/// 追加 &timestamp=..&sign=.. 到 webhook URL。
fn signed_url(base_url: &str, secret: &str, now_ms: i64) -> Result<String, String> {
    let string_to_sign = format!("{}\n{}", now_ms, secret);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("钉钉加签初始化失败: {}", e))?;
    mac.update(string_to_sign.as_bytes());
    let sign = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let sign = urlencoding::encode(&sign).into_owned();
    let sep = if base_url.contains('?') { '&' } else { '?' };
    Ok(format!("{base_url}{sep}timestamp={now_ms}&sign={sign}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChannelType;

    fn test_config(secret: Option<&str>) -> ChannelConfig {
        ChannelConfig {
            id: "c1".into(),
            channel_type: ChannelType::Dingtalk,
            name: "test".into(),
            url: "https://oapi.dingtalk.com/robot/send?access_token=abc".into(),
            token: None,
            secret: secret.map(String::from),
            chat_id: None,
            events: vec![],
            enabled: true,
        }
    }

    fn test_payload() -> NotifyPayload {
        NotifyPayload {
            kind: "turn_end".into(),
            title: "✅ Completed".into(),
            body: "Claude finished this turn".into(),
            workspace_name: Some("cc-book".into()),
            project_name: None,
            project_path: None,
            session_id: Some("sess-12345678-rest".into()),
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn build_without_secret_keeps_url() {
        let req = build(&test_config(None), &test_payload(), 1_700_000_000_000).unwrap();
        assert_eq!(
            req.url,
            "https://oapi.dingtalk.com/robot/send?access_token=abc"
        );
        assert_eq!(req.body["msgtype"], "markdown");
        let text = req.body["markdown"]["text"].as_str().unwrap();
        assert!(text.contains("cc-book"));
        assert!(text.contains("sess-123"));
        assert!(!text.contains("sess-12345678-rest"), "会话 id 应截短");
    }

    #[test]
    fn build_with_secret_appends_signature() {
        // 固定输入的签名向量：与独立参考实现（Python hmac + base64 + quote）核对得出
        let req = build(
            &test_config(Some("SECabc123")),
            &test_payload(),
            1_700_000_000_000,
        )
        .unwrap();
        assert!(req.url.contains("&timestamp=1700000000000&sign="));
        let sign = req.url.split("sign=").nth(1).unwrap();
        assert_eq!(sign, "N5P09a4%2Bp1AMJIJWnIvQd2Yxw9%2Bfu%2FoEBnPrjCcsLXk%3D");
    }
}
