use std::cell::Cell;

use serde_json::json;

use crate::permission_request::{process, PermissionRequestContext, PermissionResponse};

fn valid_payload() -> String {
    json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "claude-session",
        "tool_use_id": "toolu_01H",
        "tool_name": "Bash",
        "tool_input": { "command": "cargo test" }
    })
    .to_string()
}

fn claude_context() -> PermissionRequestContext {
    PermissionRequestContext {
        cli_tool: Some("claude".to_string()),
        pty_session_id: Some("pty-1".to_string()),
        task_binding_id: Some("task-1".to_string()),
    }
}

#[test]
fn valid_permission_request_prints_only_exact_allow_response() {
    let calls = Cell::new(0);
    let output = process(&valid_payload(), claude_context(), |body| {
        calls.set(calls.get() + 1);
        assert_eq!(body["ptySessionId"], "pty-1");
        assert_eq!(body["cliTool"], "claude");
        assert_eq!(body["payload"]["hook_event_name"], "PermissionRequest");
        assert_eq!(body["payload"]["tool_use_id"], "toolu_01H");
        assert_eq!(body["payload"]["tool_name"], "Bash");
        assert_eq!(body["payload"]["tool_input"]["command"], "cargo test");
        PermissionResponse {
            status: 200,
            body: json!({
                "hookSpecificOutput": {
                    "decision": { "behavior": "allow" }
                }
            })
            .to_string(),
        }
    });

    assert_eq!(calls.get(), 1);
    assert_eq!(
        output.as_deref(),
        Some(r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}"#)
    );
}

#[test]
fn malformed_missing_id_notification_and_elicitation_never_call_backend() {
    let cases = [
        "not-json".to_string(),
        json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {}
        })
        .to_string(),
        json!({
            "hook_event_name": "Notification",
            "tool_use_id": "toolu_01H",
            "tool_name": "Bash",
            "tool_input": {}
        })
        .to_string(),
        json!({
            "hook_event_name": "Elicitation",
            "tool_use_id": "toolu_01H",
            "tool_name": "AskUserQuestion",
            "tool_input": {}
        })
        .to_string(),
    ];

    for raw in cases {
        let output = process(&raw, claude_context(), |_| {
            panic!("invalid requests must not reach the backend")
        });
        assert_eq!(output, None);
    }
}

#[test]
fn non_claude_tools_fail_closed_before_http() {
    for cli_tool in ["codex", "grok", "opencode"] {
        let mut context = claude_context();
        context.cli_tool = Some(cli_tool.to_string());
        let output = process(&valid_payload(), context, |_| {
            panic!("non-Claude hooks must not reach the backend")
        });
        assert_eq!(output, None);
    }
}

#[test]
fn malformed_and_non_200_backend_responses_emit_no_decision() {
    let responses = [
        PermissionResponse {
            status: 204,
            body: String::new(),
        },
        PermissionResponse {
            status: 500,
            body: r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}"#.to_string(),
        },
        PermissionResponse {
            status: 200,
            body: "not-json".to_string(),
        },
        PermissionResponse {
            status: 200,
            body: r#"{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}"#.to_string(),
        },
        PermissionResponse {
            status: 200,
            body: r#"{"hookSpecificOutput":{"decision":{"behavior":"allow"}},"extra":true}"#
                .to_string(),
        },
    ];

    for response in responses {
        assert_eq!(
            process(&valid_payload(), claude_context(), |_| response),
            None
        );
    }
}

#[test]
fn missing_cli_or_session_identity_fails_closed() {
    let contexts = [
        PermissionRequestContext {
            cli_tool: None,
            ..claude_context()
        },
        PermissionRequestContext {
            pty_session_id: None,
            ..claude_context()
        },
    ];

    for context in contexts {
        assert_eq!(
            process(&valid_payload(), context, |_| {
                panic!("missing identity must not reach the backend")
            }),
            None
        );
    }
}
