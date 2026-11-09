//! Telegram Bot API 的最小客户端（getUpdates 长轮询 + 发消息 / 按钮）。

use serde_json::{json, Value};
use tracing::warn;

use super::parse::split_message;
use super::MESSAGE_LIMIT;

#[derive(Clone)]
pub(super) struct TelegramApi {
    pub(super) client: reqwest::Client,
    pub(super) base: String,
    pub(super) token: String,
}

impl TelegramApi {
    pub(super) async fn call(&self, method: &str, body: Value) -> Result<Value, String> {
        let url = format!(
            "{}/bot{}/{method}",
            self.base.trim_end_matches('/'),
            self.token
        );
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            // reqwest 的错误文本里带 URL（含 token），只留类别。
            .map_err(|error| {
                format!("Telegram {method} request failed: {}", error.without_url())
            })?;
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Telegram {method} bad response: {}", error.without_url()))?;
        if value["ok"].as_bool() == Some(true) {
            Ok(value["result"].clone())
        } else {
            Err(format!(
                "Telegram {method} rejected: {}",
                value["description"].as_str().unwrap_or("unknown error")
            ))
        }
    }

    pub(super) async fn get_updates(
        &self,
        offset: i64,
        timeout: u64,
    ) -> Result<Vec<Value>, String> {
        let result = self
            .call(
                "getUpdates",
                json!({"offset": offset, "timeout": timeout, "allowed_updates": ["message", "callback_query"]}),
            )
            .await?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    pub(super) async fn send_text(&self, chat_id: i64, text: &str) {
        for part in split_message(text, MESSAGE_LIMIT) {
            if let Err(error) = self
                .call("sendMessage", json!({"chat_id": chat_id, "text": part}))
                .await
            {
                warn!(error = %error, "im inbound: sendMessage failed");
                return;
            }
        }
    }

    /// 发带按钮的消息，返回 message_id（撤按钮用）。
    pub(super) async fn send_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        buttons: Vec<(String, String)>,
    ) -> Option<i64> {
        let rows: Vec<Value> = buttons
            .into_iter()
            .map(|(label, data)| json!([{"text": label, "callback_data": data}]))
            .collect();
        let body =
            json!({"chat_id": chat_id, "text": text, "reply_markup": {"inline_keyboard": rows}});
        match self.call("sendMessage", body).await {
            Ok(message) => message["message_id"].as_i64(),
            Err(error) => {
                warn!(error = %error, "im inbound: permission prompt failed");
                None
            }
        }
    }

    /// 撤下按钮（请求已处理 / 已失效）。
    pub(super) async fn clear_keyboard(&self, chat_id: i64, message_id: i64) {
        let _ = self
            .call(
                "editMessageReplyMarkup",
                json!({"chat_id": chat_id, "message_id": message_id, "reply_markup": {"inline_keyboard": []}}),
            )
            .await;
    }

    pub(super) async fn answer_callback(&self, callback_id: &Value, text: &str) {
        let _ = self
            .call(
                "answerCallbackQuery",
                json!({"callback_query_id": callback_id, "text": text}),
            )
            .await;
    }

    pub(super) async fn typing(&self, chat_id: i64) {
        let _ = self
            .call(
                "sendChatAction",
                json!({"chat_id": chat_id, "action": "typing"}),
            )
            .await;
    }
}
