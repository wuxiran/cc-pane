use super::*;

#[derive(Clone)]
pub(super) struct PendingRequest {
    id: Value,
    kind: RequestKind,
}
#[derive(Clone)]
enum RequestKind {
    Approval {
        choices: HashMap<String, Value>,
        cancel: Value,
    },
    Question {
        form: Value,
        tool_input: bool,
    },
}
impl PendingRequest {
    fn cancellation(&self) -> Value {
        match &self.kind {
            RequestKind::Approval { cancel, .. } => cancel.clone(),
            RequestKind::Question {
                tool_input: true, ..
            } => json!({"answers":{}}),
            RequestKind::Question { .. } => json!({"action":"cancel"}),
        }
    }
}

fn approval(method: &str, params: &Value) -> AppResult<(RequestKind, Value, &'static str)> {
    let permissions = method == "item/permissions/requestApproval";
    let kind = if method == "item/commandExecution/requestApproval" {
        "execute"
    } else if method == "item/fileChange/requestApproval" {
        "edit"
    } else {
        "other"
    };
    let defaults = ["accept", "acceptForSession", "decline", "cancel"];
    let decisions: Vec<&str> = params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| defaults.contains(value))
                .collect()
        })
        .unwrap_or_else(|| defaults.to_vec());
    let mut choices = HashMap::new();
    let mut options = Vec::new();
    if permissions {
        choices.insert(
            "accept".into(),
            json!({"permissions":params["permissions"],"scope":"turn"}),
        );
        choices.insert("decline".into(), json!({"permissions":{},"scope":"turn"}));
        options.push(json!({"optionId":"accept","name":"Allow for this turn","kind":"allow_once"}));
        options.push(json!({"optionId":"decline","name":"Decline","kind":"reject_once"}));
    } else {
        for decision in decisions {
            let (name, option_kind) = match decision {
                "accept" => ("Allow once", "allow_once"),
                "acceptForSession" => ("Allow for this session", "allow_always"),
                "decline" => ("Decline", "reject_once"),
                _ => ("Cancel", "reject_once"),
            };
            choices.insert(decision.into(), json!({"decision":decision}));
            options.push(json!({"optionId":decision,"name":name,"kind":option_kind}));
        }
        if options.is_empty() {
            return Err(AppError::from(
                "This approval offers no supported decisions",
            ));
        }
    }
    let cancel = if permissions {
        json!({"permissions":{},"scope":"turn"})
    } else {
        json!({"decision":"cancel"})
    };
    let title = params["command"]
        .as_str()
        .or_else(|| params["reason"].as_str())
        .unwrap_or(if permissions {
            "Additional permissions"
        } else {
            "Approve file changes"
        });
    Ok((
        RequestKind::Approval { choices, cancel },
        json!({"toolCall":{"toolCallId":params["itemId"],"title":title,"kind":kind,"rawInput":params},"options":options}),
        kind,
    ))
}

fn question_form(params: &Value) -> AppResult<Value> {
    let questions = params["questions"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 16)
        .ok_or_else(|| AppError::from("Invalid native question list"))?;
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for question in questions {
        let id = question["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppError::from("Question has no identity"))?;
        if question["isSecret"] == true {
            return Err(AppError::from(
                "Secret questions require a secure input surface not available in this client",
            ));
        }
        let mut field =
            json!({"type":"string","title":question["header"],"description":question["question"]});
        if question["isOther"] != true {
            let choices: Vec<_> = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|option| option["label"].as_str())
                .map(|label| json!(label))
                .collect();
            if !choices.is_empty() {
                field["enum"] = json!(choices);
            }
        }
        if properties.insert(id.into(), field).is_some() {
            return Err(AppError::from("Duplicate native question identity"));
        }
        required.push(id.to_string());
    }
    Ok(
        json!({"mode":"form","message":"Codex needs your input","requestedSchema":{"type":"object","properties":properties,"required":required}}),
    )
}

type NormalizedRequest = (RequestKind, Value, Option<&'static str>);

fn request_kind(method: &str, params: &Value) -> AppResult<Option<NormalizedRequest>> {
    Ok(Some(match method {
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => {
            let (kind, payload, tool_kind) = approval(method, params)?;
            (kind, payload, Some(tool_kind))
        }
        "item/tool/requestUserInput" => {
            let form = question_form(params)?;
            (
                RequestKind::Question {
                    form: form.clone(),
                    tool_input: true,
                },
                form,
                None,
            )
        }
        "mcpServer/elicitation/request" if params["mode"] == "form" => (
            RequestKind::Question {
                form: params.clone(),
                tool_input: false,
            },
            params.clone(),
            None,
        ),
        _ => return Ok(None),
    }))
}

impl Session {
    pub(in crate::services::acp_chat_service) async fn server_request(
        &self,
        id: Value,
        method: &str,
        params: Value,
    ) -> AppResult<()> {
        // Admission waits for turn/start's actual ID. Never auto-approve a
        // delayed request from a previous turn or an unscoped MCP request.
        let _control = self.control.lock().await;
        let scoped = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|active| {
                active
                    .turn_id
                    .as_deref()
                    .is_some_and(|id| params["turnId"].as_str() == Some(id))
            });
        if !scoped {
            return self
                .client
                .respond_error(id, -32602, "Request is not scoped to the active Codex turn")
                .await;
        }
        if params["threadId"].as_str() != Some(self.thread_id().await?.as_str()) {
            return self
                .client
                .respond_error(id, -32602, "Request does not belong to this thread")
                .await;
        }
        let key = format!(
            "native-{}-{}",
            self.instance_id,
            permission_request_key(&id)
        );
        let Some((kind, payload, auto_kind)) = request_kind(method, &params)? else {
            return self
                .client
                .respond_error(
                    id,
                    -32601,
                    "This Codex server request is not supported by CC-Panes",
                )
                .await;
        };
        self.queue_request(key, PendingRequest { id, kind }, payload, auto_kind)
            .await
    }

    async fn queue_request(
        &self,
        key: String,
        request: PendingRequest,
        payload: Value,
        auto_kind: Option<&str>,
    ) -> AppResult<()> {
        let _gate = self.response_gate.lock().await;
        if *_gate || self.snapshot.read().await.phase != AcpChatPhase::Generating {
            return self
                .client
                .respond(request.id.clone(), request.cancellation())
                .await;
        }
        if self.pending.lock().await.len() >= 32 {
            return Err(AppError::from("Too many pending native server requests"));
        }
        let snapshot = self.snapshot().await;
        if let Some(tool_kind) = auto_kind {
            if auto_approves(&snapshot.auto_approve_kinds, Some(tool_kind)) {
                if let RequestKind::Approval { choices, .. } = &request.kind {
                    if let Some(result) = choices.get("accept") {
                        self.client
                            .respond(request.id.clone(), result.clone())
                            .await?;
                        self.emit("notification",json!({"method":"ccpanes/auto-approved","resolvedKind":tool_kind,"params":payload}));
                        return Ok(());
                    }
                }
            }
        }
        self.pending.lock().await.insert(key.clone(), request);
        self.emit(
            if auto_kind.is_some() {
                "permission_request"
            } else {
                "elicitation_request"
            },
            json!({"requestKey":key,"params":payload}),
        );
        Ok(())
    }

    pub(in crate::services::acp_chat_service) async fn respond_permission(
        &self,
        key: String,
        option: Option<String>,
    ) -> AppResult<()> {
        let cancelling = self.response_gate.lock().await;
        let request = self
            .pending
            .lock()
            .await
            .get(&key)
            .cloned()
            .ok_or_else(|| AppError::from("This permission is no longer pending"))?;
        let RequestKind::Approval { choices, .. } = &request.kind else {
            return Err(AppError::from("This request is a question"));
        };
        let result = if *cancelling || option.is_none() {
            request.cancellation()
        } else {
            choices
                .get(option.as_deref().unwrap_or_default())
                .cloned()
                .ok_or_else(|| AppError::from("This approval option was not offered"))?
        };
        self.client.respond(request.id, result).await?;
        self.pending.lock().await.remove(&key);
        self.emit("permission_resolved", json!({"requestKey":key}));
        Ok(())
    }
    pub(in crate::services::acp_chat_service) async fn respond_elicitation(
        &self,
        key: String,
        response: Value,
    ) -> AppResult<()> {
        let cancelling = self.response_gate.lock().await;
        let request = self
            .pending
            .lock()
            .await
            .get(&key)
            .cloned()
            .ok_or_else(|| AppError::from("This question is no longer pending"))?;
        let RequestKind::Question { form, tool_input } = &request.kind else {
            return Err(AppError::from("This request is a permission"));
        };
        let answer = if *cancelling {
            json!({"action":"cancel"})
        } else {
            elicitation::validate_response(form, response)?
        };
        let result = if *tool_input {
            let mut answers = serde_json::Map::new();
            if answer["action"] == "accept" {
                for (key, value) in answer["content"].as_object().into_iter().flatten() {
                    answers.insert(key.clone(), json!({"answers":[value]}));
                }
            }
            json!({"answers":answers})
        } else {
            answer
        };
        self.client.respond(request.id, result).await?;
        self.pending.lock().await.remove(&key);
        self.emit("elicitation_cancelled", json!({"requestKey":key}));
        Ok(())
    }
    pub(in crate::services::acp_chat_service) async fn cancel_requests(&self) {
        let mut gate = self.response_gate.lock().await;
        *gate = true;
        let requests = self.pending.lock().await.clone();
        for (key, request) in requests {
            if self
                .client
                .respond(request.id.clone(), request.cancellation())
                .await
                .is_ok()
            {
                self.pending.lock().await.remove(&key);
                self.emit(
                    match request.kind {
                        RequestKind::Approval { .. } => "permission_resolved",
                        _ => "elicitation_cancelled",
                    },
                    json!({"requestKey":key}),
                );
            }
        }
    }
    pub(in crate::services::acp_chat_service) async fn resolve_server_request(&self, id: &Value) {
        let _gate = self.response_gate.lock().await;
        let key = self
            .pending
            .lock()
            .await
            .iter()
            .find(|(_, request)| &request.id == id)
            .map(|(key, _)| key.clone());
        if let Some(key) = key {
            if let Some(request) = self.pending.lock().await.remove(&key) {
                self.emit(
                    match request.kind {
                        RequestKind::Approval { .. } => "permission_resolved",
                        _ => "elicitation_cancelled",
                    },
                    json!({"requestKey":key}),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approvals_never_offer_unadvertised_amendments_and_questions_are_separate() {
        let (kind, payload, _) = approval(
            "item/commandExecution/requestApproval",
            &json!({"availableDecisions":["decline",{"acceptWithExecpolicyAmendment":{}}]}),
        )
        .unwrap();
        let RequestKind::Approval { choices, .. } = kind else {
            panic!()
        };
        assert!(!choices.contains_key("accept"));
        assert_eq!(payload["options"].as_array().unwrap().len(), 1);
        let form=question_form(&json!({"questions":[{"id":"q","header":"Choice","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]})).unwrap();
        assert!(elicitation::validate_response(
            &form,
            json!({"action":"accept","content":{"q":"C"}})
        )
        .is_err());
        assert!(question_form(&json!({"questions":[{"id":"secret","isSecret":true}]})).is_err());
    }
}
