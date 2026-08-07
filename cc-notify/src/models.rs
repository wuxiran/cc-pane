use serde::{Deserialize, Serialize};

/// 通知载荷
///
/// `kind` 是自由字符串，与 NotificationService 的 kind 同一口径
/// （turn_end / waiting_input / error / session_exited / slow_tool / test）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPayload {
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// RFC3339
    pub timestamp: String,
}

/// 渠道类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelType {
    Webhook,
    Telegram,
    Dingtalk,
    Wecom,
    Lark,
    Slack,
}

/// 渠道配置
///
/// `events` 为空 = 订阅全部事件（缺省即全量，避免旧配置升级后静默停发）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    pub id: String,
    pub channel_type: ChannelType,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub token: Option<String>,
    /// 钉钉加签 secret / 飞书签名校验 secret
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
    pub enabled: bool,
}

impl ChannelConfig {
    /// 该渠道是否订阅了此 kind 的事件（events 空 = 全订阅）
    pub fn subscribes(&self, kind: &str) -> bool {
        self.events.is_empty() || self.events.iter().any(|e| e == kind)
    }
}

/// 构建好的出站请求：由传输层（reqwest）执行
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltRequest {
    pub url: String,
    pub body: serde_json::Value,
    /// 额外 header（如 Authorization），(name, value)
    pub headers: Vec<(String, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribes_empty_events_means_all() {
        let cfg = ChannelConfig {
            id: "c1".into(),
            channel_type: ChannelType::Dingtalk,
            name: "test".into(),
            url: "https://example.com".into(),
            token: None,
            secret: None,
            chat_id: None,
            events: vec![],
            enabled: true,
        };
        assert!(cfg.subscribes("turn_end"));
        assert!(cfg.subscribes("anything"));
    }

    #[test]
    fn subscribes_filters_by_kind() {
        let cfg = ChannelConfig {
            id: "c1".into(),
            channel_type: ChannelType::Lark,
            name: "test".into(),
            url: "https://example.com".into(),
            token: None,
            secret: None,
            chat_id: None,
            events: vec!["error".into(), "waiting_input".into()],
            enabled: true,
        };
        assert!(cfg.subscribes("error"));
        assert!(!cfg.subscribes("turn_end"));
    }

    #[test]
    fn channel_config_deserializes_without_new_fields() {
        // 旧落盘配置没有 secret/events 字段，必须能反序列化
        let json = r#"{
            "id": "c1", "channelType": "dingtalk", "name": "n",
            "url": "https://example.com", "enabled": true
        }"#;
        let cfg: ChannelConfig = serde_json::from_str(json).expect("deserialize");
        assert!(cfg.events.is_empty());
        assert!(cfg.secret.is_none());
    }
}
