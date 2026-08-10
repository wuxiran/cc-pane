use cc_cli_adapters::{
    ClaudeAdapter, CliToolAdapter, PermissionRequestCapability, StructuredPermissionRequest,
};
use serde_json::{json, Value};

use crate::common::{
    env::optional_env,
    http::{post_json_response, ApiEndpoint},
    stdin::read_raw_stdin,
};

const PERMISSION_REQUEST_ROUTE: &str = "/api/task-queue/permission-request";

#[derive(Debug, Clone)]
pub(crate) struct PermissionRequestContext {
    pub cli_tool: Option<String>,
    pub pty_session_id: Option<String>,
    pub task_binding_id: Option<String>,
}

pub(crate) struct PermissionResponse {
    pub status: u16,
    pub body: String,
}

pub fn run() {
    let raw = read_raw_stdin().unwrap_or_default();
    let context = PermissionRequestContext {
        cli_tool: optional_env("CC_PANES_CLI_TOOL"),
        pty_session_id: optional_env("CC_PANES_PTY_SESSION_ID"),
        task_binding_id: optional_env("CC_PANES_TASK_BINDING_ID"),
    };

    let output = process(&raw, context, |body| {
        let response = ApiEndpoint::resolve()
            .and_then(|endpoint| post_json_response(&endpoint, PERMISSION_REQUEST_ROUTE, body));
        match response {
            Ok(response) => PermissionResponse {
                status: response.status,
                body: response.body,
            },
            Err(_) => {
                eprintln!(
                    "[cc-panes-cli-hook] permission-request: backend unavailable; no decision"
                );
                PermissionResponse {
                    status: 0,
                    body: String::new(),
                }
            }
        }
    });

    if let Some(output) = output {
        println!("{output}");
    }
}

pub(crate) fn process<F>(
    raw_stdin: &str,
    context: PermissionRequestContext,
    send: F,
) -> Option<String>
where
    F: FnOnce(&Value) -> PermissionResponse,
{
    if context.cli_tool.as_deref() != Some("claude") {
        return None;
    }
    let pty_session_id = context
        .pty_session_id
        .as_deref()
        .filter(|value| !value.is_empty())?;

    let payload: Value = serde_json::from_str(raw_stdin).ok()?;
    let adapter = ClaudeAdapter::new();
    if adapter.permission_request_capability()
        != Some(PermissionRequestCapability::ClaudeSynchronousHook)
    {
        return None;
    }
    let request = adapter.validate_permission_request(&payload).ok()?;
    let body = backend_request_body(pty_session_id, context.task_binding_id, request);
    exact_allow_response(send(&body))
}

fn backend_request_body(
    pty_session_id: &str,
    task_binding_id: Option<String>,
    request: StructuredPermissionRequest,
) -> Value {
    json!({
        "ptySessionId": pty_session_id,
        "taskBindingId": task_binding_id,
        "cliTool": "claude",
        "payload": {
            "hook_event_name": "PermissionRequest",
            "tool_use_id": request.tool_use_id,
            "tool_name": request.tool_name,
            "tool_input": request.tool_input,
        }
    })
}

fn exact_allow_response(response: PermissionResponse) -> Option<String> {
    if response.status != 200 {
        return None;
    }

    let expected = json!({
        "hookSpecificOutput": {
            "decision": { "behavior": "allow" }
        }
    });
    let actual: Value = serde_json::from_str(&response.body).ok()?;
    if actual != expected {
        return None;
    }
    serde_json::to_string(&expected).ok()
}
