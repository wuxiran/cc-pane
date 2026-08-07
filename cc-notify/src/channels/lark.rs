use crate::models::{BuiltRequest, ChannelConfig, NotifyPayload};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// 飞书群机器人：interactive card，配置了 secret 时在 body 里带 timestamp+sign。
pub fn build(
    config: &ChannelConfig,
    payload: &NotifyPayload,
    now_ms: i64,
) -> Result<BuiltRequest, String> {
    let template = match payload.kind.as_str() {
        "error" | "session_exited" => "red",
        "waiting_input" | "slow_tool" => "orange",
        _ => "blue",
    };
    let mut body = serde_json::json!({
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": { "tag": "plain_text", "content": payload.title },
                "template": template
            },
            "elements": [{
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": format!("{}{}", payload.body, super::context_suffix(payload))
                }
            }]
        }
    });

    if let Some(secret) = config.secret.as_deref().filter(|s| !s.is_empty()) {
        // 飞书签名：秒级时间戳；HmacSHA256 的 key 是 "{timestamp}\n{secret}"，data 为空
        let ts_sec = now_ms / 1000;
        let key = format!("{}\n{}", ts_sec, secret);
        let mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())
            .map_err(|e| format!("飞书签名初始化失败: {}", e))?;
        let sign = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        body["timestamp"] = serde_json::json!(ts_sec.to_string());
        body["sign"] = serde_json::json!(sign);
    }

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

    fn test_config(secret: Option<&str>) -> ChannelConfig {
        ChannelConfig {
            id: "c1".into(),
            channel_type: ChannelType::Lark,
            name: "test".into(),
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc".into(),
            token: None,
            secret: secret.map(String::from),
            chat_id: None,
            events: vec![],
            enabled: true,
        }
    }

    fn test_payload(kind: &str) -> NotifyPayload {
        NotifyPayload {
            kind: kind.into(),
            title: "t".into(),
            body: "b".into(),
            workspace_name: None,
            project_name: None,
            project_path: None,
            session_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn build_maps_kind_to_header_color() {
        let req = build(&test_config(None), &test_payload("error"), 0).unwrap();
        assert_eq!(req.body["card"]["header"]["template"], "red");
        let req = build(&test_config(None), &test_payload("waiting_input"), 0).unwrap();
        assert_eq!(req.body["card"]["header"]["template"], "orange");
        let req = build(&test_config(None), &test_payload("turn_end"), 0).unwrap();
        assert_eq!(req.body["card"]["header"]["template"], "blue");
        assert!(req.body.get("sign").is_none());
    }

    #[test]
    fn build_with_secret_signs_body() {
        // 固定输入的签名向量：与独立参考实现（Python hmac，key=ts\nsecret，data 为空）核对
        let req = build(
            &test_config(Some("larksecret")),
            &test_payload("turn_end"),
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(req.body["timestamp"], "1700000000");
        assert_eq!(
            req.body["sign"],
            "9tAorv8A/4Mb2NzIxVauBMTDHC2MjRxDs/a0kZWnTWE="
        );
    }
}
