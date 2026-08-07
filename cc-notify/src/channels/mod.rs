pub mod dingtalk;
pub mod lark;
pub mod slack;
pub mod telegram;
pub mod webhook;
pub mod wecom;

use crate::models::{BuiltRequest, ChannelConfig, ChannelType, NotifyPayload};

/// 构建指定渠道的出站请求（纯函数，不做网络 IO）。
///
/// `now_ms` 是 Unix 毫秒时间戳，由调用方传入——钉钉/飞书加签需要，
/// 参数化保证可单测（固定时间戳可断言签名向量）。
pub fn build_request(
    config: &ChannelConfig,
    payload: &NotifyPayload,
    now_ms: i64,
) -> Result<BuiltRequest, String> {
    match config.channel_type {
        ChannelType::Webhook => webhook::build(config, payload),
        ChannelType::Telegram => telegram::build(config, payload),
        ChannelType::Dingtalk => dingtalk::build(config, payload, now_ms),
        ChannelType::Wecom => wecom::build(config, payload),
        ChannelType::Lark => lark::build(config, payload, now_ms),
        ChannelType::Slack => slack::build(config, payload),
    }
}

/// 各 IM 渠道共用的 markdown 上下文尾部（工作空间/项目/会话）。
/// 返回空串或以 "\n" 开头的若干行。
pub(crate) fn context_suffix(payload: &NotifyPayload) -> String {
    let mut out = String::new();
    if let Some(ws) = payload.workspace_name.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n> 工作空间: {}", ws));
    }
    if let Some(proj) = payload.project_name.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n> 项目: {}", proj));
    }
    if let Some(sid) = payload.session_id.as_deref().filter(|s| !s.is_empty()) {
        // 完整 id 太长，IM 里给前 8 位足够人工对照
        let short: String = sid.chars().take(8).collect();
        out.push_str(&format!("\n> 会话: {}", short));
    }
    out
}
