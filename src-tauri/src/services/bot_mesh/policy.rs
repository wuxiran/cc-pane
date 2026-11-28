//! 按 Bot 的远程权限策略（docs/112 §5.3）。
//!
//! 只作用于「由远程消息开启的回合」：本机桌面 / IM 发起的回合仍按 Bot 自己的
//! `autoApproveKinds`。远程回合期间会话的自动放行集合被临时替换成
//! [`remote_auto_approve_kinds`]，回合结束恢复；漏到审批卡上的请求再由
//! [`decide`] 兜底（deny 自动拒绝、full 自动放行、其余留给发起方 / 本机主人）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::acp_chat_service::{pick_auto_approve_option, AUTO_APPROVE_ALL};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RemotePolicy {
    /// 远程回合里的一切工具调用自动拒绝（可以聊天，不能动手）。
    Deny,
    /// 审批回传发起方（手机 / 发起设备），本机桌面也可代批。
    #[default]
    AskOrigin,
    /// 命中 `remoteAllowKinds` 自动放行，其余同 ask_origin。
    Allowlist,
    /// 最高权限：远程回合全部自动放行（与 Automations headless 同一通道）。
    Full,
}

impl RemotePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::AskOrigin => "ask_origin",
            Self::Allowlist => "allowlist",
            Self::Full => "full",
        }
    }
}

/// `full` 只对已配对设备（设备令牌）生效；Cookie 会话 / 未知来源降级为 ask_origin。
pub fn effective_policy(policy: RemotePolicy, paired_device: bool) -> RemotePolicy {
    if policy == RemotePolicy::Full && !paired_device {
        RemotePolicy::AskOrigin
    } else {
        policy
    }
}

/// 远程回合期间会话的自动放行集合。
pub fn remote_auto_approve_kinds(policy: RemotePolicy, allow_kinds: &[String]) -> Vec<String> {
    match policy {
        RemotePolicy::Deny | RemotePolicy::AskOrigin => Vec::new(),
        RemotePolicy::Allowlist => allow_kinds
            .iter()
            .map(|kind| kind.trim().to_string())
            // allowlist 不接受通配：要全放行请明确选 full。
            .filter(|kind| !kind.is_empty() && kind != AUTO_APPROVE_ALL)
            .collect(),
        RemotePolicy::Full => vec![AUTO_APPROVE_ALL.to_string()],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAction {
    /// 选这个 optionId 放行。
    Approve(String),
    /// 拒绝：有 reject 选项就选它，否则 None = 取消。
    Reject(Option<String>),
    /// 留着等人（发起方或本机主人）。
    Ask,
}

fn options_of(params: &Value) -> &[Value] {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn reject_option(options: &[Value]) -> Option<String> {
    let kind_of = |option: &Value| {
        option
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    options
        .iter()
        .find(|option| kind_of(option) == "reject_once")
        .or_else(|| {
            options
                .iter()
                .find(|option| kind_of(option).starts_with("reject"))
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `permission_request` 的 `params.toolCall.kind`（两类会话都归一成这个形状）。
pub fn tool_kind(params: &Value) -> Option<&str> {
    params
        .get("toolCall")
        .and_then(|call| call.get("kind"))
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
}

/// 远程回合里漏到审批卡上的请求怎么处理。
pub fn decide(policy: RemotePolicy, allow_kinds: &[String], params: &Value) -> PolicyAction {
    let options = options_of(params);
    match policy {
        RemotePolicy::Deny => PolicyAction::Reject(reject_option(options)),
        RemotePolicy::AskOrigin => PolicyAction::Ask,
        RemotePolicy::Allowlist => {
            let kinds = remote_auto_approve_kinds(policy, allow_kinds);
            if crate::services::acp_chat_service::auto_approves(&kinds, tool_kind(params)) {
                match pick_auto_approve_option(options, false)
                    .and_then(|id| id.as_str().map(str::to_string))
                {
                    Some(option) => PolicyAction::Approve(option),
                    // 多个 allow 并列（让用户选）→ 不替人乱答。
                    None => PolicyAction::Ask,
                }
            } else {
                PolicyAction::Ask
            }
        }
        RemotePolicy::Full => match pick_auto_approve_option(options, true)
            .and_then(|id| id.as_str().map(str::to_string))
        {
            Some(option) => PolicyAction::Approve(option),
            None => PolicyAction::Ask,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(kind: &str) -> Value {
        json!({
            "toolCall": {"toolCallId": "t1", "kind": kind, "title": "x"},
            "options": [
                {"optionId": "allow", "kind": "allow_once"},
                {"optionId": "always", "kind": "allow_always"},
                {"optionId": "no", "kind": "reject_once"},
            ],
        })
    }

    #[test]
    fn serde_uses_snake_case_and_defaults_to_ask_origin() {
        assert_eq!(
            serde_json::to_value(RemotePolicy::AskOrigin).unwrap(),
            "ask_origin"
        );
        let parsed: RemotePolicy = serde_json::from_value(json!("full")).unwrap();
        assert_eq!(parsed, RemotePolicy::Full);
        assert_eq!(RemotePolicy::default(), RemotePolicy::AskOrigin);
        assert!(serde_json::from_value::<RemotePolicy>(json!("root")).is_err());
    }

    #[test]
    fn full_requires_a_paired_device() {
        assert_eq!(
            effective_policy(RemotePolicy::Full, true),
            RemotePolicy::Full
        );
        assert_eq!(
            effective_policy(RemotePolicy::Full, false),
            RemotePolicy::AskOrigin
        );
        assert_eq!(
            effective_policy(RemotePolicy::Deny, false),
            RemotePolicy::Deny
        );
    }

    #[test]
    fn auto_approve_sets_per_level() {
        let allow = vec!["read".to_string(), "*".to_string(), " ".to_string()];
        assert!(remote_auto_approve_kinds(RemotePolicy::Deny, &allow).is_empty());
        assert!(remote_auto_approve_kinds(RemotePolicy::AskOrigin, &allow).is_empty());
        assert_eq!(
            remote_auto_approve_kinds(RemotePolicy::Allowlist, &allow),
            vec!["read"]
        );
        assert_eq!(
            remote_auto_approve_kinds(RemotePolicy::Full, &[]),
            vec!["*"]
        );
    }

    #[test]
    fn decide_per_level() {
        let allow = vec!["read".to_string()];
        assert_eq!(
            decide(RemotePolicy::Deny, &allow, &request("read")),
            PolicyAction::Reject(Some("no".into()))
        );
        assert_eq!(
            decide(RemotePolicy::Deny, &allow, &json!({"options": []})),
            PolicyAction::Reject(None)
        );
        assert_eq!(
            decide(RemotePolicy::AskOrigin, &allow, &request("read")),
            PolicyAction::Ask
        );
        assert_eq!(
            decide(RemotePolicy::Allowlist, &allow, &request("read")),
            PolicyAction::Approve("allow".into())
        );
        assert_eq!(
            decide(RemotePolicy::Allowlist, &allow, &request("execute")),
            PolicyAction::Ask
        );
        assert_eq!(
            decide(RemotePolicy::Full, &[], &request("execute")),
            PolicyAction::Approve("allow".into())
        );
    }
}
