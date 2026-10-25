use super::*;

#[cfg(unix)]
async fn fixture(
    body: &str,
    timeout: Duration,
) -> (
    CodexAppServer,
    mpsc::Receiver<CodexAppServerEvent>,
    tempfile::TempDir,
) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake-codex");
    std::fs::write(
        &script,
        format!("#!/usr/bin/env python3\nimport json,sys,time,os,subprocess\n{body}"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (mut client, events) = CodexAppServer::spawn(CodexAppServerOptions {
        cwd: dir.path().to_owned(),
        executable: Some(script),
        request_timeout: timeout.max(Duration::from_secs(10)),
        ..Default::default()
    })
    .await
    .unwrap();
    Arc::get_mut(&mut client.inner).unwrap().request_timeout = timeout;
    (client, events, dir)
}

#[cfg(unix)]
const HANDSHAKE: &str = r#"
hello=json.loads(sys.stdin.readline())
assert hello['method']=='initialize'
assert hello['params']['clientInfo']['name']=='cc-panes'
print(json.dumps({'id':hello['id'],'result':{'userAgent':'fixture'}}),flush=True)
assert json.loads(sys.stdin.readline())['method']=='initialized'
"#;

#[cfg(unix)]
#[tokio::test]
async fn transports_approval_and_error_ids_without_crossing_requests() {
    let (client, mut events, _dir) = fixture(&format!("{HANDSHAKE}\n{}", r#"
for line in sys.stdin:
    message=json.loads(line)
    if message.get('method')=='thread/start':
        print(json.dumps({'method':'thread/started','params':{'thread':{'id':'t'}}}),flush=True)
        print(json.dumps({'id':'approval-1','method':'item/commandExecution/requestApproval','params':{'threadId':'t'}}),flush=True)
        print(json.dumps({'id':message['id'],'result':{'thread':{'id':'t'}}}),flush=True)
    elif message.get('id')=='approval-1':
        assert message['result']['decision']=='decline'
        print(json.dumps({'method':'approval/received','params':{}}),flush=True)
    elif message.get('method')=='fail':
        print(json.dumps({'id':message['id'],'error':{'code':-32602,'message':'bad params'}}),flush=True)
"#), Duration::from_secs(3)).await;
    let thread = client.request("thread/start", json!({})).await.unwrap();
    assert_eq!(thread["thread"]["id"], "t");
    assert!(
        matches!(events.recv().await, Some(CodexAppServerEvent::Notification { method, .. }) if method=="thread/started")
    );
    assert!(
        matches!(events.recv().await, Some(CodexAppServerEvent::ServerRequest { id, .. }) if id=="approval-1")
    );
    client
        .respond(json!("approval-1"), json!({"decision":"decline"}))
        .await
        .unwrap();
    assert_eq!(
        client
            .respond(json!("approval-1"), json!({}))
            .await
            .unwrap_err()
            .code(),
        Some("CODEX_APP_SERVER_STALE_REQUEST")
    );
    let error = client.request("fail", json!({})).await.unwrap_err();
    assert_eq!(error.code(), Some("CODEX_APP_SERVER_RPC_ERROR"));
    assert!(error.message().contains("-32602"));
    client.shutdown().await.unwrap();
    while let Some(event) = events.recv().await {
        if let CodexAppServerEvent::Exited { code } = event {
            assert_eq!(code, Some(0));
            return;
        }
    }
    panic!("missing process exit");
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_does_not_poison_connection_or_leak_pending_requests() {
    let (mut client, _events, _dir) = fixture(
        &format!(
            "{HANDSHAKE}\n{}",
            r#"
pending=[]
for line in sys.stdin:
    message=json.loads(line)
    if message.get('method')=='echo':
        for late in pending:
            print(json.dumps({'id':late,'result':{'late':True}}),flush=True)
        pending=[]
        print(json.dumps({'id':message['id'],'result':message['params']}),flush=True)
    else:
        pending.append(message['id'])
"#
        ),
        Duration::from_secs(3),
    )
    .await;
    // Keep fixture startup tolerant of a loaded CI host; only the requests
    // under test use a short deadline. Closed receivers are pruned by the actor.
    Arc::get_mut(&mut client.inner).unwrap().request_timeout = Duration::from_millis(100);
    for _ in 0..3 {
        assert_eq!(
            client.request("never", json!({})).await.unwrap_err().code(),
            Some("CODEX_APP_SERVER_TIMEOUT")
        );
    }
    assert_eq!(
        client.request("echo", json!({"ok":true})).await.unwrap(),
        json!({"ok":true})
    );
    client.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn remotely_resolved_approval_cannot_be_answered_again() {
    let (client, mut events, _dir) = fixture(&format!("{HANDSHAKE}\n{}", r#"
sys.stdin.readline()
print(json.dumps({'id':41,'method':'item/fileChange/requestApproval','params':{'threadId':'t'}}),flush=True)
print(json.dumps({'method':'serverRequest/resolved','params':{'threadId':'t','requestId':41}}),flush=True)
for line in sys.stdin:
    message=json.loads(line)
    assert message.get('id')!=41
"#), Duration::from_secs(3)).await;
    client.notify("trigger", json!({})).await.unwrap();
    assert!(
        matches!(events.recv().await, Some(CodexAppServerEvent::ServerRequest { id, .. }) if id==41)
    );
    assert!(
        matches!(events.recv().await, Some(CodexAppServerEvent::Notification { method, .. }) if method=="serverRequest/resolved")
    );
    assert_eq!(
        client
            .respond(json!(41), json!({"decision":"accept"}))
            .await
            .unwrap_err()
            .code(),
        Some("CODEX_APP_SERVER_STALE_REQUEST")
    );
    client.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn malformed_frame_fails_pending_call_and_reaps_child() {
    let (client, mut events, _dir) = fixture(
        &format!(
            "{HANDSHAKE}\n{}",
            r#"
sys.stdin.readline()
print('not json',flush=True)
time.sleep(30)
"#
        ),
        Duration::from_secs(3),
    )
    .await;
    let error = client.request("trigger", json!({})).await.unwrap_err();
    assert_eq!(error.code(), Some("CODEX_APP_SERVER_PROTOCOL"));
    assert!(matches!(
        events.recv().await,
        Some(CodexAppServerEvent::ProtocolError { .. })
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap(),
        Some(CodexAppServerEvent::Exited { .. })
    ));
    assert_eq!(unsafe { libc::kill(client.pid() as i32, 0) }, -1);
}

#[cfg(unix)]
#[tokio::test]
async fn backpressure_is_explicit_and_never_silently_drops_final_event() {
    let (client, mut events, _dir) = fixture(
        &format!(
            "{HANDSHAKE}\n{}",
            r#"
sys.stdin.readline()
for i in range(400):
    print(json.dumps({'method':'item/agentMessage/delta','params':{'delta':'x'}}),flush=True)
time.sleep(30)
"#
        ),
        Duration::from_secs(3),
    )
    .await;
    assert!(client.request("flood", json!({})).await.is_err());
    let mut overflow = false;
    let mut exited = false;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
    {
        match event {
            CodexAppServerEvent::ProtocolError { message } => {
                overflow = message.contains("too slow")
            }
            CodexAppServerEvent::Exited { .. } => exited = true,
            _ => {}
        }
    }
    assert!(overflow && exited);
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_last_client_reaps_process_and_descendant_pipes() {
    let (client, mut events, _dir) = fixture(
        &format!(
            "{HANDSHAKE}\n{}",
            r#"
subprocess.Popen(['sleep','30'])
print(json.dumps({'method':'ready','params':{}}),flush=True)
time.sleep(30)
"#
        ),
        Duration::from_secs(3),
    )
    .await;
    assert!(matches!(
        events.recv().await,
        Some(CodexAppServerEvent::Notification { .. })
    ));
    let pid = client.pid();
    let retained = client.clone();
    drop(client);
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
    drop(retained);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap(),
        Some(CodexAppServerEvent::Exited { .. })
    ));
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
}

#[cfg(unix)]
#[tokio::test]
async fn natural_exit_preserves_status_and_reclaims_descendants_holding_stdout() {
    let (client, mut events, _dir) = fixture(
        &format!(
            "{HANDSHAKE}\n{}",
            r#"
sys.stdin.readline()
subprocess.Popen(['sleep','30'])
print(json.dumps({'method':'finished','params':{}}),flush=True)
sys.exit(7)
"#
        ),
        Duration::from_secs(3),
    )
    .await;
    client.notify("trigger", json!({})).await.unwrap();
    assert!(matches!(
        events.recv().await,
        Some(CodexAppServerEvent::Notification { .. })
    ));
    // The actor only discovers EOF after the descendant's inherited pipe is
    // closed. Killing the parent alone would leave this waiting for 30 seconds.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap(),
        Some(CodexAppServerEvent::Exited { code: Some(7) })
    );
    let (first, second) = tokio::join!(client.shutdown(), client.shutdown());
    first.unwrap();
    second.unwrap();
}

/// Explicit manual test: no thread or model turn is created, and credentials
/// are neither read nor logged. Requires the user's installed/logged-in Codex.
#[tokio::test]
#[ignore = "requires local Codex CLI; handshake and model list only"]
async fn native_codex_handshake_and_model_list() {
    let (client, _events) = CodexAppServer::spawn(CodexAppServerOptions::default())
        .await
        .unwrap();
    let result = client.request("model/list", json!({})).await.unwrap();
    assert!(result["data"]
        .as_array()
        .is_some_and(|models| !models.is_empty()));
    client.shutdown().await.unwrap();
}
