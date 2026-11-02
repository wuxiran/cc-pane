use super::*;

impl Session {
    pub(in crate::services::acp_chat_service) async fn admit(
        self: &Arc<Self>,
        blocks: Vec<Value>,
    ) -> AppResult<oneshot::Receiver<AppResult<String>>> {
        let input = protocol::input(&blocks)?;
        let _control = self.control.lock().await;
        if self.snapshot.read().await.phase != AcpChatPhase::Ready {
            return Err(AppError::coded(
                "ACP_TURN_IN_PROGRESS",
                "Codex is not ready for another turn",
            ));
        }
        let thread = self.thread_id().await?;
        let receiver = self.begin_run(&thread, &blocks).await?;
        let params = self.turn_params(&thread, input).await?;
        self.accept_started_turn(self.client.request("turn/start", params).await)
            .await;
        Ok(receiver)
    }

    async fn begin_run(
        &self,
        thread: &str,
        blocks: &[Value],
    ) -> AppResult<oneshot::Receiver<AppResult<String>>> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let checkpoints = self.checkpoints.clone();
        let (chat, turn, cwd) = (self.chat_id.clone(), run_id.clone(), self.cwd.clone());
        let checkpoint = run_checkpoint_job(move || checkpoints.begin(&chat, &turn, &cwd)).await?;
        let record = self.run_record(&run_id, thread, &checkpoint.id);
        if let Err(error) = self.journal.begin(record, &json!({"prompt":blocks})).await {
            let checkpoints = self.checkpoints.clone();
            let id = checkpoint.id;
            let _ = run_checkpoint_job(move || checkpoints.finish(&id, "failed")).await;
            return Err(error);
        }
        let (done, receiver) = oneshot::channel();
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) = Some(ActiveTurn {
            run_id,
            checkpoint_id: checkpoint.id,
            turn_id: None,
            cancelled: false,
            done: Some(done),
        });
        self.stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        *self.response_gate.lock().await = false;
        self.pending.lock().await.clear();
        self.snapshot.write().await.phase = AcpChatPhase::Generating;
        self.emit_state().await;
        Ok(receiver)
    }

    fn run_record(&self, id: &str, thread: &str, checkpoint: &str) -> journal::RunRecord {
        journal::RunRecord {
            id: id.into(),
            chat_id: self.chat_id.clone(),
            engine_id: ENGINE.into(),
            acp_session_id: thread.into(),
            cwd: self.cwd.to_string_lossy().into(),
            started_at: unix_millis(),
            finished_at: None,
            status: "running".into(),
            checkpoint_id: Some(checkpoint.into()),
            recording_error: None,
            event_count: 0,
        }
    }

    async fn turn_params(&self, thread: &str, input: Vec<Value>) -> AppResult<Value> {
        let options = self.selections.read().await;
        let mut params = json!({
            "threadId": thread, "input": input, "cwd": self.cwd,
            "sandboxPolicy": protocol::mode_policy(&options.mode)?, "approvalsReviewer": "user",
            "approvalPolicy": if options.mode == "danger-full-access" { "never" } else { "on-request" },
        });
        if !options.model.is_empty() {
            params["model"] = json!(options.model);
        }
        if !options.effort.is_empty() {
            params["effort"] = json!(options.effort);
        }
        Ok(params)
    }

    async fn accept_started_turn(&self, response: AppResult<Value>) {
        let result = response.and_then(|response| {
            response
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| AppError::from("Codex returned no turn identity"))
        });
        match result {
            Ok(id) => {
                if let Some(active) = self
                    .active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_mut()
                {
                    active.turn_id = Some(id);
                }
            }
            Err(error) => {
                // A timed-out start may have been accepted. Kill the owned process
                // before admitting another turn or capturing the final file state.
                let _ = self.client.shutdown().await;
                self.finish_turn("failed", Some(error.to_string()), true)
                    .await;
                self.snapshot.write().await.phase = AcpChatPhase::Failed;
                self.emit_state().await;
            }
        }
    }

    pub(in crate::services::acp_chat_service) async fn cancel(&self) -> AppResult<()> {
        let _control = self.control.lock().await;
        let thread = self.thread_id().await?;
        let turn = {
            let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
            let Some(active) = active.as_mut() else {
                return Ok(());
            };
            active.cancelled = true;
            active.turn_id.clone()
        };
        self.cancel_requests().await;
        if let Some(turn) = turn {
            self.client
                .request("turn/interrupt", json!({"threadId":thread,"turnId":turn}))
                .await?;
        }
        // The server's turn/completed event is the only normal completion fence.
        Ok(())
    }

    pub(in crate::services::acp_chat_service) async fn stop(
        &self,
        error: Option<String>,
    ) -> AppResult<()> {
        // Shutdown must interrupt a stalled turn/start before waiting on the
        // admission lock. Waiting for that lock first can make Stop hang.
        self.client.shutdown().await?;
        let _control = self.control.lock().await;
        self.finish_turn("interrupted", error.clone(), true).await;
        let mut snapshot = self.snapshot.write().await;
        snapshot.phase = if error.is_some() {
            AcpChatPhase::Failed
        } else {
            AcpChatPhase::Exited
        };
        snapshot.error = error;
        drop(snapshot);
        self.emit_state().await;
        Ok(())
    }

    pub(in crate::services::acp_chat_service) async fn background_in(
        &self,
        repository: &Path,
    ) -> bool {
        if !self.cwd.starts_with(repository) && !repository.starts_with(&self.cwd) {
            return false;
        }
        if matches!(
            self.snapshot.read().await.phase,
            AcpChatPhase::Exited | AcpChatPhase::Failed
        ) {
            return false;
        }
        self.background_reason().await.is_some()
    }
    async fn background_reason(&self) -> Option<String> {
        let thread = match self.thread_id().await {
            Ok(thread) => thread,
            Err(error) => return Some(error.to_string()),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            self.client.request(
                "thread/backgroundTerminals/list",
                json!({"threadId":thread}),
            ),
        )
        .await;
        match result {
            Ok(Ok(value)) if background_list_is_idle(&value) => None,
            Ok(Ok(_)) => Some("Codex background commands are active or their status could not be verified; turn restore is unavailable".into()),
            _ => Some("This Codex version cannot verify background-command completion; captured files remain reviewable but restore is unavailable".into()),
        }
    }

    pub(super) async fn finish_turn(&self, status: &str, error: Option<String>, stopped: bool) {
        let active = self.active.lock().unwrap_or_else(|p| p.into_inner()).take();
        let Some(active) = active else {
            return;
        };
        self.cancel_requests().await;
        let status = if active.cancelled {
            "cancelled"
        } else {
            status
        }
        .to_string();
        let reason = if stopped {
            None
        } else {
            self.background_reason().await
        };
        let checkpoints = self.checkpoints.clone();
        let id = active.checkpoint_id.clone();
        let outcome = status.clone();
        let completed = run_checkpoint_job(move || match reason {
            Some(reason) => checkpoints.finish_unavailable(&id, &outcome, &reason),
            None => checkpoints.finish(&id, &outcome),
        })
        .await;
        if let Err(cause) = completed {
            self.journal.event(
                &active.run_id,
                "recording_notice",
                &json!({"error":cause.to_string()}),
            );
        }
        let stop_reason = match status.as_str() {
            "completed" => "end_turn",
            "cancelled" | "interrupted" => "cancelled",
            _ => "error",
        };
        let payload = json!({"stopReason":stop_reason,"error":error});
        self.journal.event(&active.run_id, "turn_ended", &payload);
        if let Err(cause) = self
            .journal
            .finish(active.run_id, status.clone(), Some(active.checkpoint_id))
            .await
        {
            tracing::error!(%cause,"Native Codex run journal completion failed");
        }
        if !stopped {
            self.snapshot.write().await.phase = AcpChatPhase::Ready;
        }
        self.emit("turn_ended", payload);
        self.emit_state().await;
        if !self.chat_id.starts_with("auto-") {
            if let Some(notifier) = self
                .notifier
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
            {
                notifier(AcpTurnNotice {
                    chat_id: self.chat_id.clone(),
                    engine_id: ENGINE.into(),
                    detail: error.clone().unwrap_or_else(|| stop_reason.into()),
                    is_error: error.is_some(),
                });
            }
        }
        if let Some(done) = active.done {
            let _ = done.send(match error {
                Some(error) => Err(AppError::from(error)),
                None => Ok(stop_reason.into()),
            });
        }
    }

    pub(super) async fn notification(&self, method: &str, params: Value) -> AppResult<()> {
        let _control = self.control.lock().await;
        if matches!(
            self.snapshot.read().await.phase,
            AcpChatPhase::Exited | AcpChatPhase::Failed
        ) {
            return Ok(());
        }
        if method.starts_with("item/") || method.starts_with("turn/") {
            let incoming = params["turnId"]
                .as_str()
                .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
            let scoped = self
                .active
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|active| {
                    active
                        .turn_id
                        .as_deref()
                        .is_some_and(|id| incoming == Some(id))
                });
            if !scoped {
                return Ok(());
            }
        }
        let thread = self.thread_id().await.ok();
        if let Some(id) = params.get("threadId").and_then(Value::as_str) {
            if thread.as_deref() != Some(id) {
                return Ok(());
            }
        }
        self.dispatch_notification(method, &params, thread).await;
        Ok(())
    }

    async fn dispatch_notification(&self, method: &str, params: &Value, thread: Option<String>) {
        match method {
            "turn/completed" => self.complete_notification(params).await,
            "item/agentMessage/delta" | "item/reasoning/summaryTextDelta" => {
                self.text_delta(method, params).await
            }
            // A completed plan is authoritative and may differ from its deltas.
            "item/plan/delta" => {}
            "item/started" | "item/completed" => {
                self.item_notification(&params["item"], method == "item/completed")
                    .await
            }
            "item/commandExecution/outputDelta" => self.command_output_delta(params),
            "turn/plan/updated" => self.plan_notification(params).await,
            "thread/name/updated" => self.name_notification(thread, params).await,
            "serverRequest/resolved" => self.resolve_server_request(&params["requestId"]).await,
            _ => self.emit(
                "notification",
                json!({"method":method,"params":params,"protocol":"codex-app-server"}),
            ),
        }
    }

    async fn complete_notification(&self, params: &Value) {
        let status = match params.pointer("/turn/status").and_then(Value::as_str) {
            Some("completed") => "completed",
            Some("interrupted") => "interrupted",
            _ => "failed",
        };
        let error = params
            .pointer("/turn/error/message")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let error = if status == "failed" {
            Some(error.unwrap_or_else(|| "Codex turn failed".into()))
        } else {
            error
        };
        self.finish_turn(status, error, false).await;
    }

    async fn text_delta(&self, method: &str, params: &Value) {
        let delta = params["delta"].as_str().unwrap_or_default();
        let id = params["itemId"].as_str().unwrap_or_default();
        let key = format!("{method}:{id}");
        {
            let mut stream = self.stream.lock().unwrap_or_else(|p| p.into_inner());
            if stream.len() < 256 {
                let text = stream.entry(key).or_default();
                if text.len() + delta.len() <= 256 * 1024 {
                    text.push_str(delta);
                }
            }
        }
        self.emit_update(protocol::text_update(
            if method.contains("reasoning") {
                "agent_thought_chunk"
            } else {
                "agent_message_chunk"
            },
            delta,
        ))
        .await;
    }

    async fn item_notification(&self, item: &Value, completed: bool) {
        if completed && item["type"] == "commandExecution" {
            self.finish_command_output(item);
        }
        if let Some(update) = protocol::item_update(item, completed) {
            self.emit_update(update).await;
        } else if completed {
            self.complete_text(item).await;
        }
    }

    async fn plan_notification(&self, params: &Value) {
        let entries: Vec<_> = params["plan"].as_array().into_iter().flatten().map(|entry| json!({
            "content": entry["step"], "priority": "medium",
            "status": match entry["status"].as_str() { Some("completed") => "completed", Some("inProgress") => "in_progress", _ => "pending" },
        })).collect();
        self.emit_update(json!({"sessionUpdate":"plan","entries":entries}))
            .await;
    }

    async fn name_notification(&self, thread: Option<String>, params: &Value) {
        if let (Some(id), Some(name)) = (
            thread,
            params["threadName"]
                .as_str()
                .or_else(|| params["name"].as_str()),
        ) {
            apply_agent_title(&self.chats_dir, &id, name);
            self.emit_update(json!({"sessionUpdate":"session_info_update","title":name}))
                .await;
        }
    }

    fn command_output_delta(&self, params: &Value) {
        let id = params["itemId"].as_str().unwrap_or_default();
        let delta = params["delta"].as_str().unwrap_or_default();
        let output = {
            let mut stream = self.stream.lock().unwrap_or_else(|p| p.into_inner());
            let key = format!("command:{id}");
            if stream.len() >= 256 && !stream.contains_key(&key) {
                return;
            }
            let text = stream.entry(key).or_default();
            let mut allowed = (256 * 1024usize)
                .saturating_sub(text.len())
                .min(delta.len());
            while !delta.is_char_boundary(allowed) {
                allowed -= 1;
            }
            text.push_str(&delta[..allowed]);
            text.clone()
        };
        self.emit(
            "terminal_output",
            json!({"terminalId":id,"output":output,"truncated":output.len()>=256*1024}),
        );
    }

    fn finish_command_output(&self, item: &Value) {
        let id = item["id"].as_str().unwrap_or_default();
        let buffered = self
            .stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&format!("command:{id}"))
            .unwrap_or_default();
        let output = item["aggregatedOutput"].as_str().unwrap_or(&buffered);
        let exit = item["exitCode"]
            .as_i64()
            .map(|code| json!({"exitCode":code}))
            .unwrap_or_else(|| json!({}));
        self.emit("terminal_output",json!({"terminalId":id,"output":output,"truncated":output.len()>=256*1024,"exitStatus":exit}));
    }

    pub(super) async fn complete_text(&self, item: &Value) {
        let kind = item["type"].as_str().unwrap_or_default();
        let method = match kind {
            "agentMessage" => "item/agentMessage/delta",
            "plan" => "item/plan/delta",
            "reasoning" => "item/reasoning/summaryTextDelta",
            _ => return,
        };
        let text = if kind == "reasoning" {
            item["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            item["text"].as_str().unwrap_or_default().into()
        };
        let previous = self
            .stream
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&format!(
                "{method}:{}",
                item["id"].as_str().unwrap_or_default()
            ))
            .unwrap_or_default();
        let rest = text
            .strip_prefix(&previous)
            .unwrap_or(if previous.is_empty() { &text } else { "" });
        if !rest.is_empty() {
            self.emit_update(protocol::text_update(
                if kind == "reasoning" {
                    "agent_thought_chunk"
                } else {
                    "agent_message_chunk"
                },
                rest,
            ))
            .await;
        }
    }
}

fn background_list_is_idle(value: &Value) -> bool {
    value
        .get("terminals")
        .or_else(|| value.get("data"))
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
        && value.get("nextCursor").is_none_or(Value::is_null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_paginated_empty_page_never_proves_background_commands_are_finished() {
        assert!(background_list_is_idle(
            &json!({"data":[],"nextCursor":null})
        ));
        assert!(!background_list_is_idle(
            &json!({"data":[],"nextCursor":"more"})
        ));
        assert!(!background_list_is_idle(
            &json!({"data":[{"id":"running"}]})
        ));
        assert!(!background_list_is_idle(&json!({})));
    }
}
