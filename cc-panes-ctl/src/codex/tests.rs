use super::*;
use clap::Parser;

#[test]
fn model_text_cannot_execute_terminal_escape_sequences() {
    assert_eq!(
        terminal_text("你好\n\t\x1b]52;c;evil\x07\r\x7f\u{009b}31m"),
        "你好\n\t]52;c;evil31m"
    );
}

#[tokio::test]
async fn waiting_for_user_does_not_hide_remote_completion_or_resolved_request() {
    let (sender, mut events) = mpsc::channel(4);
    sender
        .send(CodexAppServerEvent::Notification {
            method: "turn/completed".into(),
            params: json!({"threadId":"thread","turn":{"id":"turn","status":"completed"}}),
        })
        .await
        .unwrap();
    let mut output = TurnOutput::new("thread", "turn", false);
    let reply = std::future::pending::<(Option<Value>, bool)>();
    assert!(matches!(
        output
            .wait_for_answer(&json!(7), &mut events, reply)
            .await
            .unwrap(),
        ApprovalOutcome::Completed(Ok(()))
    ));
    sender
        .send(CodexAppServerEvent::Notification {
            method: "serverRequest/resolved".into(),
            params: json!({"threadId":"thread","requestId":7}),
        })
        .await
        .unwrap();
    let result = output
        .wait_for_answer(
            &json!(7),
            &mut events,
            std::future::pending::<(Option<Value>, bool)>(),
        )
        .await;
    assert!(matches!(result, Err(CliExit { code: 4, .. })));
}

#[test]
fn codex_cli_accepts_both_transports_without_changing_old_launch() {
    assert!(crate::cli::Cli::try_parse_from(["ctl", "--json", "codex", "models"]).is_ok());
    assert!(crate::cli::Cli::try_parse_from([
        "ctl", "codex", "run", "task", "--resume", "thread", "--fork", "thread"
    ])
    .is_err());
    assert!(
        crate::cli::Cli::try_parse_from(["ctl", "codex", "run", "task", "--timeout", "0"]).is_err()
    );
    assert!(crate::cli::Cli::try_parse_from([
        "ctl", "launch", "project", "--cli", "codex", "--prompt", "task"
    ])
    .is_ok());
}

fn args() -> RunArgs {
    RunArgs {
        prompt: "task".into(),
        cwd: ".".into(),
        resume: None,
        fork: None,
        model: None,
        sandbox: Sandbox::ReadOnly,
        timeout: 60,
    }
}

#[test]
fn resume_and_fork_keep_native_identity_and_explicit_sandbox() {
    let mut args = args();
    args.resume = Some("thread-a".into());
    args.model = Some("configured-model".into());
    let (method, params) = thread_request(&args, std::path::Path::new("/project"));
    assert_eq!(method, "thread/resume");
    assert_eq!(params["threadId"], "thread-a");
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["approvalPolicy"], "on-request");
    assert_eq!(params["model"], "configured-model");
    args.resume = None;
    args.fork = Some("thread-b".into());
    assert_eq!(
        thread_request(&args, std::path::Path::new("/project")).0,
        "thread/fork"
    );
}

#[test]
fn completion_must_match_the_current_thread_and_turn() {
    let mut output = TurnOutput::new("thread-a", "turn-a", false);
    for (thread, turn) in [("thread-b", "turn-a"), ("thread-a", "turn-b")] {
        assert!(output
            .notification(
                "turn/completed",
                &json!({"threadId":thread,"turn":{"id":turn,"status":"completed"}})
            )
            .unwrap()
            .is_none());
    }
    assert!(output
        .notification(
            "turn/completed",
            &json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed"}})
        )
        .unwrap()
        .unwrap()
        .is_ok());
}

#[test]
fn failed_or_interrupted_turn_never_reports_success() {
    let mut output = TurnOutput::new("thread", "turn", false);
    for (status, code) in [("failed", 2), ("interrupted", 130), ("unknown", 2)] {
        let result = output
            .notification(
                "turn/completed",
                &json!({"threadId":"thread","turn":{"id":"turn","status":status}}),
            )
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().code, code);
    }
    output.denied = true;
    assert_eq!(
        output
            .notification(
                "turn/completed",
                &json!({"threadId":"thread","turn":{"id":"turn","status":"completed"}})
            )
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        4
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_cli_runs_real_transport_and_declines_unattended_approvals() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture-codex");
    std::fs::write(&script, r#"#!/usr/bin/env python3
import json,sys
def send(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if method=='initialize': send({'id':message['id'],'result':{'userAgent':'fixture'}})
    elif method=='initialized': pass
    elif method=='thread/fork':
        assert message['params']['threadId']=='parent-thread'
        assert message['params']['sandbox']=='read-only'
        send({'id':message['id'],'result':{'thread':{'id':'child-thread'}}})
    elif method=='turn/start':
        assert message['params']['threadId']=='child-thread'
        assert message['params']['input'][0]['text']=='task'
        send({'method':'item/agentMessage/delta','params':{'threadId':'child-thread','turnId':'turn-a','itemId':'answer','delta':'Ready'}})
        send({'id':message['id'],'result':{'turn':{'id':'turn-a'}}})
        send({'id':'approval','method':'item/commandExecution/requestApproval','params':{'threadId':'child-thread','turnId':'turn-a','command':'dangerous action'}})
    elif message.get('id')=='approval':
        assert message['result']['decision']=='decline'
        send({'method':'turn/completed','params':{'threadId':'child-thread','turn':{'id':'turn-a','status':'completed'}}})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (client, mut events) = CodexAppServer::spawn(CodexAppServerOptions {
        cwd: dir.path().to_owned(),
        executable: Some(script),
        request_timeout: Duration::from_secs(3),
        ..Default::default()
    })
    .await
    .unwrap();
    let mut args = args();
    args.fork = Some("parent-thread".into());
    let active = std::sync::Mutex::new(None);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        run_turn(&client, &mut events, &args, dir.path(), true, &active),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, 4);
    assert_eq!(
        *active.lock().unwrap(),
        Some(("child-thread".into(), "turn-a".into()))
    );
    client.shutdown().await.unwrap();
}
