//! 订阅额度（usage limit）快照解析。
//!
//! 只解析 CLI 自己写进本地会话日志的数字，不访问网络、不读凭据：
//! - Codex：rollout JSONL 里 `event_msg` / `token_count` 事件的 `payload.rate_limits`
//!   （Codex 后端随每次响应下发，`primary` / `secondary` 两个窗口）。新版给
//!   `resets_at`（epoch 秒），旧版给 `resets_in_seconds`（相对事件时间）。
//! - Claude Code：transcript 不记录额度，这里没有对应解析——宁可不显示也不编数字。

use crate::models::{RateLimitSnapshot, RateLimitWindow};
use serde_json::Value;

pub(crate) const CODEX_SESSION_LOG_SOURCE: &str = "codex-session-log";
const WINDOW_SLOTS: [&str; 2] = ["primary", "secondary"];

/// 从一行 Codex rollout 事件里取额度。不是 token_count 或没有可用窗口时返回 None。
pub(crate) fn codex_rate_limits_from_event(event: &Value) -> Option<RateLimitSnapshot> {
    if event.get("type").and_then(Value::as_str) != Some("event_msg")
        || event.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
    {
        return None;
    }
    let observed_at = event
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|time| time.timestamp_millis());
    parse_codex_rate_limits(event.pointer("/payload/rate_limits")?, observed_at)
}

/// `rate_limits` 对象 → 快照。`observed_at` 是事件时间（毫秒），用来换算旧版相对重置时间。
pub(crate) fn parse_codex_rate_limits(
    value: &Value,
    observed_at: Option<i64>,
) -> Option<RateLimitSnapshot> {
    let object = value.as_object()?;
    let windows: Vec<RateLimitWindow> = WINDOW_SLOTS
        .iter()
        .filter_map(|slot| parse_window(slot, object.get(*slot)?, observed_at))
        .collect();
    if windows.is_empty() {
        return None;
    }
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some(RateLimitSnapshot {
        source: CODEX_SESSION_LOG_SOURCE.to_string(),
        windows,
        plan_type: text("plan_type"),
        limit_reached_type: text("rate_limit_reached_type"),
        observed_at,
    })
}

fn parse_window(slot: &str, value: &Value, observed_at: Option<i64>) -> Option<RateLimitWindow> {
    let used_percent = value.get("used_percent")?.as_f64()?;
    if !used_percent.is_finite() || used_percent < 0.0 {
        return None;
    }
    let window_minutes = value
        .get("window_minutes")
        .and_then(Value::as_u64)
        .filter(|minutes| *minutes > 0);
    let resets_at = match value.get("resets_at").and_then(Value::as_i64) {
        Some(seconds) if seconds > 0 => seconds.checked_mul(1000),
        _ => value
            .get("resets_in_seconds")
            .and_then(Value::as_i64)
            .zip(observed_at)
            .and_then(|(seconds, at)| at.checked_add(seconds.checked_mul(1000)?)),
    };
    Some(RateLimitWindow {
        slot: slot.to_string(),
        used_percent: used_percent.min(100.0),
        window_minutes,
        resets_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 截自 Codex CLI 0.13x 的真实 rollout 行（数值保留，无隐私字段）。
    const CURRENT_FIXTURE: &str = r#"{"timestamp":"2026-11-06T00:53:50.319Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3113355,"cached_input_tokens":3003136,"output_tokens":14226,"total_tokens":3127581},"model_context_window":828400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":35.0,"window_minutes":10080,"resets_at":1794212338},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"pro","rate_limit_reached_type":null}}}"#;

    /// 旧版 Codex：5 小时 + 每周两个窗口，重置时间是相对秒数。
    const LEGACY_FIXTURE: &str = r#"{"timestamp":"2025-09-10T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":40,"window_minutes":10080,"resets_in_seconds":86400}}}}"#;

    #[test]
    fn current_codex_payload_uses_absolute_reset_time() {
        let event: Value = serde_json::from_str(CURRENT_FIXTURE).unwrap();
        let snapshot = codex_rate_limits_from_event(&event).unwrap();
        assert_eq!(snapshot.source, CODEX_SESSION_LOG_SOURCE);
        assert_eq!(snapshot.plan_type.as_deref(), Some("pro"));
        assert_eq!(snapshot.limit_reached_type, None);
        assert_eq!(snapshot.observed_at, Some(1_793_926_430_319));
        assert_eq!(
            snapshot.windows,
            vec![RateLimitWindow {
                slot: "primary".into(),
                used_percent: 35.0,
                window_minutes: Some(10080),
                resets_at: Some(1_794_212_338_000),
            }]
        );
    }

    #[test]
    fn legacy_codex_payload_resolves_relative_reset_time() {
        let event: Value = serde_json::from_str(LEGACY_FIXTURE).unwrap();
        let snapshot = codex_rate_limits_from_event(&event).unwrap();
        let at = snapshot.observed_at.unwrap();
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].window_minutes, Some(300));
        assert_eq!(snapshot.windows[0].resets_at, Some(at + 3_600_000));
        assert_eq!(snapshot.windows[1].slot, "secondary");
        assert_eq!(snapshot.windows[1].used_percent, 40.0);
        assert_eq!(snapshot.windows[1].resets_at, Some(at + 86_400_000));
    }

    #[test]
    fn relative_reset_without_event_time_is_unknown() {
        let snapshot = parse_codex_rate_limits(
            &json!({"primary": {"used_percent": 10, "resets_in_seconds": 60}}),
            None,
        )
        .unwrap();
        assert_eq!(snapshot.windows[0].resets_at, None);
        assert_eq!(snapshot.windows[0].window_minutes, None);
    }

    #[test]
    fn reached_limit_and_overflow_are_reported_as_given() {
        let snapshot = parse_codex_rate_limits(
            &json!({
                "primary": {"used_percent": 104.2, "window_minutes": 300, "resets_at": 1},
                "rate_limit_reached_type": "primary",
            }),
            None,
        )
        .unwrap();
        assert_eq!(snapshot.windows[0].used_percent, 100.0);
        assert_eq!(snapshot.limit_reached_type.as_deref(), Some("primary"));
    }

    #[test]
    fn empty_or_unrelated_payloads_yield_nothing() {
        assert!(parse_codex_rate_limits(&json!(null), None).is_none());
        assert!(
            parse_codex_rate_limits(&json!({"primary": null, "secondary": null}), None).is_none()
        );
        assert!(
            parse_codex_rate_limits(&json!({"primary": {"used_percent": "x"}}), None).is_none()
        );
        assert!(parse_codex_rate_limits(&json!({"primary": {"used_percent": -1}}), None).is_none());
        let other = json!({"type": "event_msg", "payload": {"type": "agent_message", "rate_limits": {"primary": {"used_percent": 1}}}});
        assert!(codex_rate_limits_from_event(&other).is_none());
    }
}
