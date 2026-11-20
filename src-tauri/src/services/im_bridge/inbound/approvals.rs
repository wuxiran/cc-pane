//! 转发到 Telegram 的审批按钮账本。
//!
//! 按钮的 `callback_data` 只是短随机令牌；令牌映射回「哪个会话实例的哪个请求」。
//! ACP 适配器的 requestKey 是 JSON-RPC id（`n7`），换一个适配器进程会从头再来，
//! 所以条目必须绑定会话实例 id + toolCallId，点按时再和会话里仍在等待的请求
//! 对一遍；对不上（请求已处理、进程换了、超时）一律作废，绝不会批准一个用户
//! 没见过的新请求。回合结束 / 请求在别处被处理 / 进程退出时整批清掉并撤下按钮。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::services::PermissionBinding;

/// 按钮有效期：超过就作废（到桌面端处理）。
pub const APPROVAL_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalEntry {
    pub chat_id: String,
    pub request_key: String,
    pub binding: PermissionBinding,
    pub option_id: String,
    pub label: String,
}

#[derive(Debug)]
struct Prompt {
    chat_id: String,
    request_key: String,
    binding: PermissionBinding,
    created: Instant,
    message_id: Option<i64>,
    /// token → (optionId, 选项名)
    options: HashMap<String, (String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TakeError {
    /// 不认识的令牌（已处理 / 已清理 / 伪造）。
    Unknown,
    Expired,
}

#[derive(Default)]
pub struct ApprovalBook {
    prompts: Vec<Prompt>,
}

impl ApprovalBook {
    /// 登记一个请求的全部选项，返回 (选项名, 令牌) 用于生成按钮。
    pub fn insert(
        &mut self,
        chat_id: &str,
        request_key: &str,
        binding: PermissionBinding,
        options: Vec<(String, String)>,
        now: Instant,
    ) -> Vec<(String, String)> {
        self.remove_request(chat_id, request_key);
        let mut tokens = HashMap::new();
        let mut buttons = Vec::new();
        for (option_id, label) in options {
            // callback_data 上限 64 字节：用短随机令牌映射回完整请求。
            let token = format!("p:{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
            tokens.insert(token.clone(), (option_id, label.clone()));
            buttons.push((label, token));
        }
        self.prompts.push(Prompt {
            chat_id: chat_id.to_string(),
            request_key: request_key.to_string(),
            binding,
            created: now,
            message_id: None,
            options: tokens,
        });
        buttons
    }

    /// 记下按钮所在的 Telegram 消息，清理时据此撤下按钮。
    pub fn set_message(&mut self, chat_id: &str, request_key: &str, message_id: i64) {
        if let Some(prompt) = self
            .prompts
            .iter_mut()
            .find(|p| p.chat_id == chat_id && p.request_key == request_key)
        {
            prompt.message_id = Some(message_id);
        }
    }

    /// 点按：取出并作废该请求的所有按钮（一个请求只能回答一次）。
    pub fn take(&mut self, token: &str, now: Instant) -> Result<ApprovalEntry, TakeError> {
        let index = self
            .prompts
            .iter()
            .position(|p| p.options.contains_key(token))
            .ok_or(TakeError::Unknown)?;
        let prompt = self.prompts.remove(index);
        if now.duration_since(prompt.created) > APPROVAL_TTL {
            return Err(TakeError::Expired);
        }
        let (option_id, label) = prompt
            .options
            .get(token)
            .cloned()
            .ok_or(TakeError::Unknown)?;
        Ok(ApprovalEntry {
            chat_id: prompt.chat_id,
            request_key: prompt.request_key,
            binding: prompt.binding,
            option_id,
            label,
        })
    }

    /// 请求已在别处处理：清掉，返回需要撤按钮的消息。
    pub fn remove_request(&mut self, chat_id: &str, request_key: &str) -> Vec<i64> {
        self.drain(|p| p.chat_id == chat_id && p.request_key == request_key)
    }

    /// 回合结束 / 进程退出：清掉这个会话的全部按钮。
    pub fn remove_chat(&mut self, chat_id: &str) -> Vec<i64> {
        self.drain(|p| p.chat_id == chat_id)
    }

    /// 清掉超时的按钮。
    pub fn remove_expired(&mut self, now: Instant) -> Vec<i64> {
        self.drain(|p| now.duration_since(p.created) > APPROVAL_TTL)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.prompts.is_empty()
    }

    fn drain(&mut self, mut matches: impl FnMut(&Prompt) -> bool) -> Vec<i64> {
        let mut messages = Vec::new();
        self.prompts.retain(|prompt| {
            if matches(prompt) {
                messages.extend(prompt.message_id);
                false
            } else {
                true
            }
        });
        messages
    }
}

/// 点按时的最后一道校验：会话里此刻仍在等待的同一个请求（同实例、同 toolCall）。
pub fn binding_still_valid(entry: &ApprovalEntry, live: Option<&PermissionBinding>) -> bool {
    live.is_some_and(|live| live == &entry.binding)
}
