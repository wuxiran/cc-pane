//! One shared admission path for interactive and headless turns.
use super::*;

pub(super) type TurnResponse = AppResult<oneshot::Receiver<PendingResult>>;

impl AcpChatService {
    pub(super) async fn prepare_turn(
        &self,
        chat_id: &str,
        blocks: Vec<Value>,
    ) -> AppResult<(Arc<AcpChatSession>, TurnResponse)> {
        if blocks.is_empty() {
            return Err(AppError::coded(
                "ACP_PROMPT_REQUIRED",
                "ACP prompt cannot be empty",
            ));
        }
        let session = self.session(chat_id).await?;
        let turn = session.turn_control.lock().await;
        let acp_session_id = claim_ready_turn(&session.snapshot).await?;
        session.pending_permissions.begin_turn().await;
        if let Some(text) = blocks.iter().find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        }) {
            self.note_chat_title(&acp_session_id, text);
        }
        session.emit_state().await;
        let response = session
            .send_request(
                "session/prompt",
                json!({
                    "sessionId": acp_session_id, "prompt": blocks,
                }),
            )
            .await;
        drop(turn);
        // A transport failure still goes through run_turn's normal completion
        // events, preserving the interactive API's fire-and-forget contract.
        Ok((session, response))
    }
}

async fn claim_ready_turn(snapshot: &RwLock<AcpChatSnapshot>) -> AppResult<String> {
    let mut snapshot = snapshot.write().await;
    match snapshot.phase {
        AcpChatPhase::Ready => {}
        AcpChatPhase::Generating => {
            return Err(AppError::coded(
                "ACP_TURN_IN_PROGRESS",
                "ACP agent is still working on the previous message",
            ))
        }
        _ => {
            return Err(AppError::coded(
                "ACP_SESSION_NOT_READY",
                "ACP session is not ready for prompts",
            ))
        }
    }
    let session_id = snapshot.acp_session_id.clone().ok_or_else(|| {
        AppError::coded(
            "ACP_SESSION_NOT_READY",
            "ACP session has not finished starting",
        )
    })?;
    snapshot.phase = AcpChatPhase::Generating;
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_snapshot() -> AcpChatSnapshot {
        serde_json::from_value(
            json!({"chatId":"chat","engineId":"fake","phase":"ready","acpSessionId":"session"}),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn concurrent_turn_claims_admit_exactly_one_caller() {
        let snapshot = Arc::new(RwLock::new(ready_snapshot()));
        let barrier = Arc::new(tokio::sync::Barrier::new(24));
        let mut callers = tokio::task::JoinSet::new();
        for _ in 0..24 {
            let snapshot = snapshot.clone();
            let barrier = barrier.clone();
            callers.spawn(async move {
                barrier.wait().await;
                claim_ready_turn(&snapshot).await
            });
        }
        let mut accepted = 0;
        while let Some(result) = callers.join_next().await {
            match result.unwrap() {
                Ok(id) => {
                    assert_eq!(id, "session");
                    accepted += 1;
                }
                Err(error) => assert_eq!(error.code(), Some("ACP_TURN_IN_PROGRESS")),
            }
        }
        assert_eq!(accepted, 1);
        assert_eq!(snapshot.read().await.phase, AcpChatPhase::Generating);
    }

    #[tokio::test]
    async fn missing_session_identity_does_not_claim_the_turn() {
        let mut snapshot = ready_snapshot();
        snapshot.acp_session_id = None;
        let snapshot = RwLock::new(snapshot);
        assert!(claim_ready_turn(&snapshot).await.is_err());
        assert_eq!(snapshot.read().await.phase, AcpChatPhase::Ready);
    }
}
