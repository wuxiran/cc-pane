use serde_json::{json, Value};
use tokio::sync::oneshot;

/// No implicit approval in pipes/JSON mode. Unknown requests also fail closed.
pub(super) async fn respond(
    method: &str,
    params: &Value,
    interactive: bool,
) -> (Option<Value>, bool) {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let accepted = interactive && confirm(method, params).await;
            (
                Some(json!({ "decision": if accepted { "accept" } else { "decline" } })),
                !accepted,
            )
        }
        "item/permissions/requestApproval" => {
            let accepted = interactive && confirm(method, params).await;
            let permissions = if accepted {
                params["permissions"].clone()
            } else {
                json!({})
            };
            (
                Some(json!({ "permissions": permissions, "scope": "turn" })),
                !accepted,
            )
        }
        "item/tool/requestUserInput" => user_input(params, interactive).await,
        "mcpServer/elicitation/request" => {
            eprintln!(
                "Codex requested an MCP form/URL interaction; use the Agent UI to complete it."
            );
            (Some(json!({ "action": "decline", "content": null })), true)
        }
        _ => (None, true),
    }
}

async fn confirm(method: &str, params: &Value) -> bool {
    // JSON escaping keeps control sequences in remote descriptions inert.
    eprintln!("\nCodex approval: {method}\n{params}\nAllow once? [y/N]");
    read_line()
        .await
        .is_some_and(|answer| matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

async fn user_input(params: &Value, interactive: bool) -> (Option<Value>, bool) {
    let mut answers = serde_json::Map::new();
    let mut declined = false;
    for question in params["questions"].as_array().into_iter().flatten() {
        let Some(id) = question["id"].as_str() else {
            continue;
        };
        if !interactive || question["isSecret"] == true {
            // Never echo a requested secret through a regular terminal input.
            answers.insert(id.to_owned(), json!({ "answers": [] }));
            declined = true;
            continue;
        }
        eprintln!("\n{}", question["question"]);
        let options = question["options"].as_array();
        if let Some(options) = options {
            for (index, option) in options.iter().enumerate() {
                eprintln!(
                    "  {}. {} — {}",
                    index + 1,
                    option["label"],
                    option["description"]
                );
            }
        }
        eprintln!("Enter an answer or option number (empty = skip):");
        let answer = read_line().await.unwrap_or_default();
        let answer = option_answer(answer.trim(), options);
        declined |= answer.is_empty();
        answers.insert(
            id.to_owned(),
            json!({"answers": if answer.is_empty() { vec![] } else { vec![answer] }}),
        );
    }
    (Some(json!({ "answers": answers })), declined)
}

fn option_answer(answer: &str, options: Option<&Vec<Value>>) -> String {
    let index = answer
        .parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1));
    index
        .and_then(|index| options?.get(index))
        .and_then(|option| option["label"].as_str())
        .unwrap_or(answer)
        .to_owned()
}

async fn read_line() -> Option<String> {
    let (sender, receiver) = oneshot::channel();
    // A dedicated OS thread lets cancellation exit without waiting for blocking
    // stdin. Do not use spawn_blocking, which the Tokio runtime waits on at exit.
    // Spawn failure drops the sender, so the read resolves to None instead of panicking.
    let spawned = std::thread::Builder::new()
        .name("ctl-stdin-line".into())
        .spawn(move || {
            let mut line = String::new();
            let result = std::io::stdin()
                .read_line(&mut line)
                .ok()
                .filter(|count| *count > 0)
                .map(|_| line);
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        eprintln!("cc-panes-ctl: stdin reader unavailable: {error}");
        return None;
    }
    receiver.await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn noninteractive_requests_never_grant_permissions() {
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        ] {
            let (reply, denied) = respond(method, &json!({"command":"rm -rf /"}), false).await;
            assert_eq!(reply.unwrap(), json!({"decision":"decline"}));
            assert!(denied);
        }
        let (reply, denied) = respond(
            "item/permissions/requestApproval",
            &json!({"permissions":{"network":{"enabled":true}}}),
            false,
        )
        .await;
        assert_eq!(reply.unwrap(), json!({"permissions":{},"scope":"turn"}));
        assert!(denied);
    }

    #[tokio::test]
    async fn piped_questions_do_not_fabricate_answers() {
        let (reply, denied) = respond(
            "item/tool/requestUserInput",
            &json!({
                "questions":[{"id":"q1","question":"Delete data?","options":[{"label":"Yes"}]}]
            }),
            false,
        )
        .await;
        assert_eq!(reply.unwrap(), json!({"answers":{"q1":{"answers":[]}}}));
        assert!(denied);
        assert_eq!(
            respond("unrecognized/request", &json!({}), false).await,
            (None, true)
        );
    }

    #[test]
    fn numbered_answers_send_option_labels_and_preserve_free_text() {
        let options = vec![json!({"label":"Keep"}), json!({"label":"Replace"})];
        assert_eq!(option_answer("2", Some(&options)), "Replace");
        assert_eq!(option_answer("0", Some(&options)), "0");
        assert_eq!(option_answer("my choice", Some(&options)), "my choice");
    }
}
