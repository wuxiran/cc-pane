use super::transport::{
    extension_ui_auto_cancel_response, parse_jsonl_record, response_from_payload,
};
use super::*;

fn managed_launch_spec_for_test(
    data_dir: &std::path::Path,
    session_id: &str,
    command: String,
    args: Vec<String>,
) -> (PiRpcLaunchSpec, std::path::PathBuf) {
    let state_dir = cc_cli_adapters::pi_managed_state_dir(data_dir, session_id);
    std::fs::create_dir_all(&state_dir).expect("create managed Pi state directory");
    std::fs::write(state_dir.join("state.json"), "test").expect("write managed Pi state");
    (
        PiRpcLaunchSpec {
            command,
            args,
            cwd: data_dir.to_string_lossy().into_owned(),
            env: HashMap::new(),
            env_remove: Vec::new(),
            managed_state_cleanup: Some(PiManagedStateCleanup::new(
                data_dir.to_path_buf(),
                session_id,
            )),
        },
        state_dir,
    )
}

#[cfg(windows)]
fn short_lived_command() -> (String, Vec<String>) {
    (
        "cmd".to_string(),
        vec!["/C".to_string(), "exit 0".to_string()],
    )
}

#[cfg(not(windows))]
fn short_lived_command() -> (String, Vec<String>) {
    (
        "/bin/sh".to_string(),
        vec!["-c".to_string(), "exit 0".to_string()],
    )
}

#[cfg(windows)]
fn long_running_command() -> (String, Vec<String>) {
    (
        "cmd".to_string(),
        vec!["/C".to_string(), "ping -n 30 127.0.0.1 > NUL".to_string()],
    )
}

#[cfg(not(windows))]
fn long_running_command() -> (String, Vec<String>) {
    (
        "/bin/sh".to_string(),
        vec!["-c".to_string(), "while :; do sleep 1; done".to_string()],
    )
}

#[cfg(windows)]
fn stdout_closed_long_running_command() -> (String, Vec<String>) {
    long_running_command()
}

#[cfg(not(windows))]
fn stdout_closed_long_running_command() -> (String, Vec<String>) {
    (
        "/bin/sh".to_string(),
        vec![
            "-c".to_string(),
            "exec 1>&-; while :; do sleep 1".to_string(),
        ],
    )
}

#[cfg(windows)]
fn marker_long_running_command() -> (String, Vec<String>) {
    (
        "cmd".to_string(),
        vec![
            "/C".to_string(),
            "echo started > started & ping -n 30 127.0.0.1 > NUL".to_string(),
        ],
    )
}

#[cfg(not(windows))]
fn marker_long_running_command() -> (String, Vec<String>) {
    (
        "/bin/sh".to_string(),
        vec![
            "-c".to_string(),
            "touch started; while :; do sleep 1; done".to_string(),
        ],
    )
}

async fn wait_for_path_state(path: &std::path::Path, expected_exists: bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if path.exists() == expected_exists {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("timed out waiting for managed Pi state path");
}

async fn wait_for_session_removal(service: &PiRpcService, rpc_session_id: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if service.snapshot(rpc_session_id).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("timed out waiting for finished Pi RPC session removal");
}

#[test]
fn jsonl_parser_uses_lf_and_tolerates_crlf() {
    let parsed = parse_jsonl_record(b"{\"type\":\"agent_settled\"}\r\n").unwrap();
    assert_eq!(parsed["type"], "agent_settled");

    // U+2028 remains part of the JSON string instead of becoming a record
    // separator, matching Pi's strict LF-only framing contract.
    let parsed = parse_jsonl_record("{\"text\":\"a\\u2028b\"}\n".as_bytes()).unwrap();
    assert_eq!(parsed["text"], "a\u{2028}b");
}

#[test]
fn response_parser_requires_id_and_command_for_correlation() {
    let response = response_from_payload(&serde_json::json!({
        "type": "response",
        "id": "request-1",
        "command": "get_state",
        "success": true,
        "data": {"sessionId": "pi-1"},
    }))
    .unwrap();
    assert_eq!(response.id, "request-1");
    assert_eq!(response.command, "get_state");
    assert!(response.success);

    assert!(response_from_payload(&serde_json::json!({
        "type": "response",
        "command": "get_state",
        "success": true,
    }))
    .is_none());
}

#[test]
fn extension_dialogs_are_cancelled_without_a_tui() {
    let response = extension_ui_auto_cancel_response(&serde_json::json!({
        "type": "extension_ui_request",
        "id": "dialog-1",
        "method": "confirm",
        "title": "Continue?",
    }))
    .unwrap();
    assert_eq!(response["type"], "extension_ui_response");
    assert_eq!(response["id"], "dialog-1");
    assert_eq!(response["cancelled"], true);

    assert!(extension_ui_auto_cancel_response(&serde_json::json!({
        "type": "extension_ui_request",
        "id": "notice-1",
        "method": "notify",
    }))
    .is_none());
}

#[tokio::test]
async fn spawn_failure_cleans_managed_pi_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (launch, state_dir) = managed_launch_spec_for_test(
        temp_dir.path(),
        "spawn-failure",
        "cc-panes-missing-pi-rpc-command".to_string(),
        Vec::new(),
    );

    let error = PiRpcService::new()
        .start(launch)
        .await
        .expect_err("missing command must fail");

    assert_eq!(error.code(), Some("PI_RPC_SPAWN_FAILED"));
    assert!(!state_dir.exists());
}

#[tokio::test]
async fn stdout_end_cleans_managed_pi_state_after_process_exit() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = short_lived_command();
    let (launch, state_dir) =
        managed_launch_spec_for_test(temp_dir.path(), "stdout-end", command, args);
    let service = PiRpcService::new();

    let snapshot = service
        .start(launch)
        .await
        .expect("start short-lived process");
    wait_for_path_state(&state_dir, false).await;

    assert_eq!(
        service
            .snapshot(&snapshot.rpc_session_id)
            .await
            .expect("snapshot after process exit")
            .phase,
        PiRpcSessionPhase::Exited
    );
}

#[tokio::test]
async fn stop_cleans_managed_pi_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = long_running_command();
    let (launch, state_dir) =
        managed_launch_spec_for_test(temp_dir.path(), "stop-cleanup", command, args);
    let service = PiRpcService::new();

    let snapshot = service
        .start(launch)
        .await
        .expect("start long-lived process");
    let stopped = service
        .stop(&snapshot.rpc_session_id)
        .await
        .expect("stop process");

    assert_eq!(stopped.phase, PiRpcSessionPhase::Exited);
    wait_for_path_state(&state_dir, false).await;
}

#[tokio::test]
async fn finished_sessions_are_reaped_after_retention() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = long_running_command();
    let (launch, _) =
        managed_launch_spec_for_test(temp_dir.path(), "finished-session-reap", command, args);
    let service = PiRpcService::with_finished_session_retention(Duration::from_millis(10));

    let snapshot = service
        .start(launch)
        .await
        .expect("start long-lived process");
    service
        .stop(&snapshot.rpc_session_id)
        .await
        .expect("stop process");

    wait_for_session_removal(&service, &snapshot.rpc_session_id).await;
}

#[tokio::test]
async fn stdout_closure_does_not_clean_state_while_process_is_running() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = stdout_closed_long_running_command();
    let (launch, state_dir) =
        managed_launch_spec_for_test(temp_dir.path(), "stdout-before-exit", command, args);
    let service = PiRpcService::new();

    let snapshot = service
        .start(launch)
        .await
        .expect("start long-lived process");
    let premature_cleanup = tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            if !state_dir.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(
        premature_cleanup.is_err(),
        "managed state was cleaned before the process ended"
    );

    service
        .stop(&snapshot.rpc_session_id)
        .await
        .expect("stop long-lived process");
    wait_for_path_state(&state_dir, false).await;
}

#[tokio::test]
async fn cancellation_before_session_registration_cleans_managed_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = marker_long_running_command();
    let (launch, state_dir) =
        managed_launch_spec_for_test(temp_dir.path(), "cancel-before-registration", command, args);
    let service = PiRpcService::new();
    let session_lock = service.sessions.write().await;
    let start_service = service.clone();
    let start_task = tokio::spawn(async move { start_service.start(launch).await });

    let started_marker = temp_dir.path().join("started");
    wait_for_path_state(&started_marker, true).await;
    start_task.abort();
    assert!(start_task.await.is_err());
    drop(session_lock);

    wait_for_path_state(&state_dir, false).await;
}

#[tokio::test]
async fn cleanup_all_stops_and_cleans_managed_pi_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let (command, args) = long_running_command();
    let (launch, state_dir) =
        managed_launch_spec_for_test(temp_dir.path(), "service-cleanup", command, args);
    let service = PiRpcService::new();

    service
        .start(launch)
        .await
        .expect("start long-lived process");
    service.cleanup_all().await;

    wait_for_path_state(&state_dir, false).await;
}
