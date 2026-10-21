//! ACP form questions are separate from permission approvals: they carry typed
//! answers, are never auto-approved, and remain retryable until the pipe write succeeds.
use super::*;
use std::future::Future;

static NEXT_QUESTION_KEY: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct PendingElicitations {
    state: Mutex<ElicitationState>,
}
#[derive(Default)]
struct ElicitationState {
    cancelled: bool,
    requests: HashMap<String, (Value, Value)>,
}

fn invalid_answer(message: impl Into<String>) -> AppError {
    AppError::coded("ACP_INVALID_ANSWER", message)
}

impl PendingElicitations {
    pub(super) async fn begin_turn(&self) {
        *self.state.lock().await = ElicitationState::default();
    }

    pub(super) async fn clear(&self) {
        let mut state = self.state.lock().await;
        state.cancelled = true;
        state.requests.clear();
    }

    pub(super) async fn register<F, Fut>(
        &self,
        key: String,
        id: Value,
        params: Value,
        reply: F,
    ) -> AppResult<bool>
    where
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let mut state = self.state.lock().await;
        if state.cancelled {
            reply(id).await?;
            return Ok(false);
        }
        if state.requests.len() >= 32 {
            return Err(invalid_answer("Too many pending agent questions"));
        }
        if state
            .requests
            .values()
            .any(|(pending_id, _)| *pending_id == id)
        {
            return Err(invalid_answer("Duplicate pending agent question ID"));
        }
        state.requests.insert(key, (id, params));
        Ok(true)
    }

    pub(super) async fn respond<F, Fut>(
        &self,
        key: &str,
        response: Value,
        reply: F,
    ) -> AppResult<()>
    where
        F: FnOnce(Value, Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let mut state = self.state.lock().await;
        let (id, params) = state.requests.get(key).ok_or_else(|| {
            AppError::coded(
                "ACP_QUESTION_NOT_PENDING",
                "This agent question is no longer pending",
            )
        })?;
        let answer = if state.cancelled {
            json!({"action":"cancel"})
        } else {
            validate_response(params, response)?
        };
        reply(id.clone(), answer).await?;
        state.requests.remove(key);
        Ok(())
    }

    pub(super) async fn cancel_request(&self, id: &Value) -> Option<String> {
        let mut state = self.state.lock().await;
        let key = state
            .requests
            .iter()
            .find(|(_, (pending_id, _))| pending_id == id)
            .map(|(key, _)| key.clone())?;
        state.requests.remove(&key);
        Some(key)
    }

    pub(super) async fn cancel_all<F, Fut>(&self, mut reply: F) -> Vec<AppError>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = AppResult<()>>,
    {
        let mut state = self.state.lock().await;
        state.cancelled = true;
        let mut errors = Vec::new();
        for (key, (id, _)) in state.requests.clone() {
            match reply(id).await {
                Ok(()) => {
                    state.requests.remove(&key);
                }
                Err(error) => errors.push(error),
            }
        }
        errors
    }
}

fn only_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

fn supported_choices(schema: &Value) -> bool {
    let variants = schema.get("oneOf").or_else(|| schema.get("anyOf"));
    if let Some(options) = variants {
        return schema.get("enum").is_none()
            && options.as_array().is_some_and(|options| {
                !options.is_empty()
                    && options.len() <= 256
                    && options.iter().enumerate().all(|(index, option)| {
                        only_keys(option, &["const", "title", "description", "_meta"])
                            && option["const"].is_string()
                            && !options[..index]
                                .iter()
                                .any(|previous| previous["const"] == option["const"])
                    })
            });
    }
    schema.get("enum").is_none_or(|options| {
        options.as_array().is_some_and(|options| {
            !options.is_empty()
                && options.len() <= 256
                && options
                    .iter()
                    .enumerate()
                    .all(|(index, option)| option.is_string() && !options[..index].contains(option))
        })
    })
}

fn supported_field(schema: &Value) -> bool {
    let common = ["type", "title", "description", "default", "_meta"];
    let extra: &[&str] = match schema["type"].as_str() {
        Some("string") => &["oneOf", "enum", "minLength", "maxLength"],
        Some("number" | "integer") => &["minimum", "maximum"],
        Some("boolean") => &[],
        Some("array") => &["items", "minItems", "maxItems"],
        _ => return false,
    };
    if !only_keys(schema, &[common.as_slice(), extra].concat()) || !supported_choices(schema) {
        return false;
    }
    for key in [
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
    ] {
        if let Some(value) = schema.get(key) {
            if !value.as_f64().is_some_and(|value| {
                value.is_finite()
                    && (key.ends_with("imum") || (value >= 0.0 && value.fract() == 0.0))
            }) {
                return false;
            }
        }
    }
    if schema["type"] == "array" {
        let items = &schema["items"];
        return only_keys(items, &["type", "enum", "anyOf", "_meta"])
            && items.get("type").is_none_or(|kind| kind == "string")
            && (items.get("enum").is_some() || items.get("anyOf").is_some())
            && supported_choices(items);
    }
    true
}

fn supported_schema(schema: &Value) -> bool {
    if !only_keys(
        schema,
        &[
            "type",
            "properties",
            "required",
            "title",
            "description",
            "_meta",
        ],
    ) || schema.get("type").is_some_and(|kind| kind != "object")
    {
        return false;
    }
    let Some(fields) = schema["properties"].as_object() else {
        return false;
    };
    fields.len() <= 128
        && fields.values().all(supported_field)
        && schema.get("required").is_none_or(|required| {
            required.as_array().is_some_and(|required| {
                required
                    .iter()
                    .all(|key| key.as_str().is_some_and(|key| fields.contains_key(key)))
            })
        })
}

fn validate_response(params: &Value, response: Value) -> AppResult<Value> {
    match response.get("action").and_then(Value::as_str) {
        Some("cancel") => return Ok(json!({"action":"cancel"})),
        Some("decline") => return Ok(json!({"action":"decline"})),
        Some("accept") => {}
        _ => return Err(invalid_answer("Unknown question response action")),
    }
    if serde_json::to_vec(&response).map_or(true, |bytes| bytes.len() > 128 * 1024) {
        return Err(invalid_answer("Question answer exceeds 128 KiB"));
    }
    let schema = &params["requestedSchema"];
    if !supported_schema(schema) {
        return Err(invalid_answer(
            "Unsupported question schema; skip this question and reply in the chat",
        ));
    }
    let properties = schema["properties"]
        .as_object()
        .ok_or_else(|| invalid_answer("Unsupported question schema"))?;
    let content = response["content"]
        .as_object()
        .ok_or_else(|| invalid_answer("Question answer must be an object"))?;
    if content.keys().any(|key| !properties.contains_key(key)) {
        return Err(invalid_answer("Answer contains an unknown question field"));
    }
    for id in schema["required"].as_array().into_iter().flatten() {
        if !id.as_str().is_some_and(|key| content.contains_key(key)) {
            return Err(invalid_answer(
                "Answer all required questions before sending",
            ));
        }
    }
    for (key, value) in content {
        if !valid_value(&properties[key], value) {
            return Err(invalid_answer(format!(
                "Answer does not match question field: {key}"
            )));
        }
    }
    Ok(json!({"action":"accept","content":content}))
}

fn bounded(value: f64, min: &Value, max: &Value) -> bool {
    min.as_f64().is_none_or(|min| value >= min) && max.as_f64().is_none_or(|max| value <= max)
}

fn valid_choice(schema: &Value, value: &str) -> bool {
    if let Some(choices) = schema.get("oneOf").or_else(|| schema.get("anyOf")) {
        return choices.as_array().is_some_and(|choices| {
            choices
                .iter()
                .any(|choice| choice["const"].as_str() == Some(value))
        });
    }
    schema.get("enum").is_none_or(|choices| {
        choices
            .as_array()
            .is_some_and(|choices| choices.iter().any(|choice| choice.as_str() == Some(value)))
    })
}

fn valid_value(schema: &Value, value: &Value) -> bool {
    // Do not silently accept constraints this renderer cannot validate.
    if schema.get("pattern").is_some() || schema.get("format").is_some() {
        return false;
    }
    match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|value| {
            bounded(
                value.chars().count() as f64,
                &schema["minLength"],
                &schema["maxLength"],
            ) && valid_choice(schema, value)
        }),
        Some("number" | "integer") => value.as_f64().is_some_and(|value| {
            value.is_finite()
                && (schema["type"] != "integer" || value.fract() == 0.0)
                && bounded(value, &schema["minimum"], &schema["maximum"])
        }),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.as_array().is_some_and(|values| {
            bounded(
                values.len() as f64,
                &schema["minItems"],
                &schema["maxItems"],
            ) && values.iter().enumerate().all(|(index, value)| {
                value
                    .as_str()
                    .is_some_and(|value| valid_choice(&schema["items"], value))
                    && !values[..index].contains(value)
            })
        }),
        _ => false,
    }
}

impl AcpChatService {
    pub async fn respond_elicitation(
        &self,
        chat_id: &str,
        request_key: String,
        response: Value,
    ) -> AppResult<()> {
        let session = self.session(chat_id).await?;
        let session_ref = &session;
        session
            .pending_elicitations
            .respond(&request_key, response, |id, answer| async move {
                session_ref.respond(&id, Ok(answer)).await
            })
            .await
    }
}

pub(super) async fn register(session: &Arc<AcpChatSession>, id: Value, params: Value) {
    let valid = params["mode"] == "form"
        && params["message"].is_string()
        && params["requestedSchema"]["properties"]
            .as_object()
            .is_some_and(|fields| fields.len() <= 128)
        && serde_json::to_vec(&params).is_ok_and(|bytes| bytes.len() <= 256 * 1024);
    if !valid || session.chat_id.starts_with("auto-") {
        let result = if valid {
            Ok(json!({"action":"decline"}))
        } else {
            Err(json!({"code":-32602,"message":"CC-Panes supports ACP form questions only"}))
        };
        if let Err(error) = session.respond(&id, result).await {
            debug!(error = %error, "failed to reject ACP form");
        }
        return;
    }
    // A restarted adapter may reuse its JSON-RPC IDs. A late UI reply must
    // never resolve a different question in the replacement session.
    let key = format!(
        "question-{}",
        NEXT_QUESTION_KEY.fetch_add(1, Ordering::Relaxed)
    );
    let result = session
        .pending_elicitations
        .register(key.clone(), id.clone(), params.clone(), |id| async move {
            session.respond(&id, Ok(json!({"action":"cancel"}))).await
        })
        .await;
    match result {
        Ok(true) => session.emit(
            "elicitation_request",
            json!({"requestKey":key,"params":params}),
        ),
        Ok(false) => {}
        Err(error) => {
            let _ = session
                .respond(&id, Err(json!({"code":-32603,"message":error.to_string()})))
                .await;
        }
    }
}

pub(super) async fn cancel_all(session: &AcpChatSession) {
    for error in session
        .pending_elicitations
        .cancel_all(|id| async move { session.respond(&id, Ok(json!({"action":"cancel"}))).await })
        .await
    {
        debug!(error = %error, "failed to cancel ACP question");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> Value {
        json!({"mode":"form","message":"Choose a behavior","requestedSchema":{"type":"object","properties":{
            "choice":{"type":"string","oneOf":[{"const":"automatic","title":"Automatic"},{"const":"None of the above","title":"Other"}]},
            "choice_note":{"type":"string","_meta":{"codex":{"questionId":"choice","role":"user_note"}}}
        },"required":["choice"]}})
    }

    #[test]
    fn forwards_exact_choice_and_free_text_properties() {
        let answer = json!({"action":"accept","content":{"choice":"None of the above","choice_note":"截图后让我补充说明"}});
        assert_eq!(validate_response(&form(), answer.clone()).unwrap(), answer);
        for invalid in [
            json!({"action":"accept","content":{}}),
            json!({"action":"accept","content":{"choice":"invented"}}),
            json!({"action":"accept","content":{"choice":"automatic","foreign":"x"}}),
        ] {
            assert!(validate_response(&form(), invalid).is_err());
        }
    }

    #[test]
    fn validates_types_constraints_and_skip_without_answers() {
        assert_eq!(
            validate_response(&form(), json!({"action":"decline"})).unwrap(),
            json!({"action":"decline"})
        );
        assert!(valid_value(&json!({"type":"boolean"}), &json!(false)));
        assert!(!valid_value(&json!({"type":"integer"}), &json!(1.5)));
        assert!(!valid_value(
            &json!({"type":"number","maximum":2}),
            &json!(3)
        ));
        assert!(!valid_value(
            &json!({"type":"array","items":{"enum":["a"]}}),
            &json!(["a", "a"])
        ));
        assert!(!valid_value(
            &json!({"type":"string","minLength":3}),
            &json!("好")
        ));
    }

    #[tokio::test]
    async fn failed_write_preserves_question_and_success_is_exactly_once() {
        let pending = PendingElicitations::default();
        assert!(pending
            .register("s1".into(), json!("one"), form(), |_| async {
                unreachable!()
            })
            .await
            .unwrap());
        assert!(pending
            .respond("s1", json!({"action":"decline"}), |_, _| async {
                Err(invalid_answer("broken pipe"))
            })
            .await
            .is_err());
        pending
            .respond("s1", json!({"action":"decline"}), |id, answer| async move {
                assert_eq!(id, "one");
                assert_eq!(answer["action"], "decline");
                Ok(())
            })
            .await
            .unwrap();
        assert!(pending
            .respond("s1", json!({"action":"decline"}), |_, _| async {
                unreachable!()
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancellation_fences_late_questions_and_admits_the_next_turn() {
        let pending = PendingElicitations::default();
        pending.cancel_all(|_| async { Ok(()) }).await;
        assert!(!pending
            .register("s1".into(), json!(1), form(), |id| async move {
                assert_eq!(id, 1);
                Ok(())
            })
            .await
            .unwrap());
        pending.begin_turn().await;
        assert!(pending
            .register("s2".into(), json!(2), form(), |_| async { unreachable!() })
            .await
            .unwrap());
        assert_eq!(
            pending.cancel_request(&json!(2)).await,
            Some("s2".to_string())
        );
        assert!(pending
            .respond("s2", json!({"action":"decline"}), |_, _| async {
                unreachable!()
            })
            .await
            .is_err());
    }
    #[test]
    fn unsupported_constraints_cannot_be_silently_accepted() {
        for field in [
            json!({"type":"number","multipleOf":2}),
            json!({"type":"string","const":"fixed"}),
            json!({"type":"string","oneOf":[{"const":"a"}],"enum":["b"]}),
        ] {
            assert!(!supported_field(&field));
        }
        assert!(!supported_schema(
            &json!({"type":"object","properties":{},"required":["missing"]})
        ));
    }

    #[tokio::test]
    async fn answer_and_cancellation_write_exactly_one_response() {
        let pending = Arc::new(PendingElicitations::default());
        pending
            .register("q1".into(), json!(1), form(), |_| async { unreachable!() })
            .await
            .unwrap();
        let (started, writing) = oneshot::channel();
        let (finish, finished) = oneshot::channel();
        let replies = Arc::new(AtomicU64::new(0));
        let task_pending = pending.clone();
        let task_replies = replies.clone();
        let selected = tokio::spawn(async move {
            task_pending
                .respond("q1", json!({"action":"decline"}), |_, _| async move {
                    started.send(()).unwrap();
                    finished.await.unwrap();
                    task_replies.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });
        writing.await.unwrap();
        let task_pending = pending.clone();
        let task_replies = replies.clone();
        let cancelled = tokio::spawn(async move {
            task_pending
                .cancel_all(|_| {
                    let replies = task_replies.clone();
                    async move {
                        replies.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                })
                .await
        });
        finish.send(()).unwrap();
        selected.await.unwrap().unwrap();
        assert!(cancelled.await.unwrap().is_empty());
        assert_eq!(replies.load(Ordering::SeqCst), 1);
    }
}
