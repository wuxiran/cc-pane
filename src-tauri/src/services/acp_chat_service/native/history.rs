use super::*;

impl Session {
    pub(super) async fn replay(&self, response: &Value) -> AppResult<()> {
        let thread = self.thread_id().await?;
        self.emit(
            "history_replay",
            json!({"phase":"begin","acpSessionId":thread}),
        );
        let result = self.history_turns(response).await;
        match result {
            Ok(turns) => {
                for turn in turns {
                    for item in turn["items"].as_array().into_iter().flatten() {
                        self.replay_item(item).await;
                    }
                }
                self.emit(
                    "history_replay",
                    json!({"phase":"commit","acpSessionId":thread}),
                );
                Ok(())
            }
            Err(error) => {
                self.emit(
                    "history_replay",
                    json!({"phase":"abort","acpSessionId":thread}),
                );
                Err(error)
            }
        }
    }
    async fn history_turns(&self, response: &Value) -> AppResult<Vec<Value>> {
        let turns = response
            .pointer("/thread/turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if response
            .pointer("/thread/historyMode")
            .and_then(Value::as_str)
            != Some("paginated")
            && response
                .get("turnsBackwardsCursor")
                .is_none_or(Value::is_null)
        {
            return Ok(turns);
        }
        let thread = self.thread_id().await?;
        let mut cursor = Value::Null;
        let mut result = Vec::new();
        for _ in 0..200 {
            let page=self.client.request("thread/turns/list",json!({"threadId":thread,"sortDirection":"asc","itemsView":"full","limit":100,"cursor":cursor})).await?;
            result.extend(page["data"].as_array().into_iter().flatten().cloned());
            if result.len() > 20_000 {
                return Err(AppError::from(
                    "Thread history exceeds the safe replay limit",
                ));
            }
            let next = page["nextCursor"].clone();
            if next.is_null() {
                return Ok(result);
            }
            if next == cursor {
                return Err(AppError::from("Codex returned a repeated history cursor"));
            }
            cursor = next;
        }
        Err(AppError::from("Thread history exceeds pagination limit"))
    }
    async fn replay_item(&self, item: &Value) {
        match item["type"].as_str() {
            Some("userMessage") => {
                for update in protocol::history_user_updates(item) {
                    self.emit_update(update).await;
                }
            }
            Some("agentMessage" | "plan" | "reasoning") => self.complete_text(item).await,
            _ => {
                if let Some(update) = protocol::item_update(item, true) {
                    self.emit_update(update).await;
                }
            }
        }
    }
}
