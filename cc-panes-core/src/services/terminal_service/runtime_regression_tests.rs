use super::tests::{install_recording_session, terminal_service_for_test};
use super::*;

#[test]
fn issue64_output_proof_requires_wait_and_readable_final_archive() {
    let (service, _dir) = terminal_service_for_test();
    install_recording_session(&service, "proof", Arc::new(Mutex::new(Vec::new())));
    service.apply_hook_status("proof", SessionStatus::Exited);
    let output = service.get_session_output("proof", 0).unwrap();
    assert_eq!(output.exited, Some(false));
    assert_eq!(output.retained, Some(false));
    let buffer = {
        let sessions = service.sessions.lock().unwrap();
        let session = sessions.get("proof").unwrap();
        *session.exit_code.lock().unwrap() = Some(7); // the real waiter's result slot
        session.output_buffer.clone()
    };
    buffer.lock().unwrap().push("kept in memory");
    let output = service.get_session_output("proof", 0).unwrap();
    assert_eq!(output.exited, Some(true));
    assert_eq!(output.retained, Some(false));
    output_archive::persist(&service.app_paths, "proof", &["final".into()], Some(7)).unwrap();
    let output = service.get_session_output("proof", 0).unwrap();
    assert_eq!((output.exited, output.retained), (Some(true), Some(true)));
    service.sessions.lock().unwrap().remove("proof");
    let output = service.get_session_output("proof", 1).unwrap();
    assert_eq!(output.lines, ["final"]);
    assert_eq!((output.exited, output.retained), (Some(true), Some(true)));
    // A late kill snapshot cannot overwrite the final waiter snapshot.
    output_archive::persist(&service.app_paths, "proof", &["older".into()], None).unwrap();
    assert_eq!(
        service.get_session_output("proof", 1).unwrap().lines,
        ["final"]
    );
}

#[test]
fn issue64_unreadable_archive_does_not_hide_memory_output() {
    let (service, _dir) = terminal_service_for_test();
    install_recording_session(&service, "broken", Arc::new(Mutex::new(Vec::new())));
    service
        .sessions
        .lock()
        .unwrap()
        .get("broken")
        .unwrap()
        .output_buffer
        .lock()
        .unwrap()
        .push("memory tail");
    let archive = service.app_paths.data_dir().join("terminal-output");
    std::fs::create_dir_all(&archive).unwrap();
    std::fs::write(archive.join("broken.output"), b"invalid json").unwrap();
    let output = service.get_session_output("broken", 1).unwrap();
    assert_eq!(output.lines, ["memory tail"]);
    assert_eq!(output.retained, Some(false));
    service.sessions.lock().unwrap().remove("broken");
    assert!(service.get_session_output("broken", 1).is_err());
}

#[test]
fn issue64_legacy_output_and_old_daemon_never_imply_exit() {
    let old: SessionOutput =
        serde_json::from_str(r#"{"sessionId":"old","lines":["tail"]}"#).unwrap();
    assert_eq!((old.exited, old.retained), (None, None));
    let (service, _dir) = terminal_service_for_test();
    crate::services::write_session_output(&service.app_paths, "old", &["tail".into()]).unwrap();
    let output = service.get_session_output("old", 0).unwrap();
    assert_eq!((output.exited, output.retained), (None, Some(true)));
}

#[test]
fn issue64_daemon_osc_permission_survives_redraw_until_input_or_hook() {
    let (service, _dir) = terminal_service_for_test();
    install_recording_session(&service, "osc", Arc::new(Mutex::new(Vec::new())));
    let (status, hook) = {
        let sessions = service.sessions.lock().unwrap();
        let session = sessions.get("osc").unwrap();
        (session.status.clone(), session.hook_updated_at.clone())
    };
    let machine = osc_fallback_state_machine(
        status.clone(),
        hook.clone(),
        Arc::new(crate::events::NoopNotifier),
    );
    let mut detector = osc_state_detect::OscStateDetector::new();
    for fragment in ["\x1b]777;notify;CCPanes;codex;waiting-", "input\x07"] {
        detector.process(fragment.as_bytes(), |signal| {
            apply_osc_signal(&machine, "osc", signal)
        });
    }
    assert_eq!(*status.lock().unwrap(), SessionStatus::WaitingInput);
    *hook.lock().unwrap() = Some(Instant::now() - Duration::from_secs(5100));
    assert_eq!(
        update_pty_status(&status, &hook, false, SessionStatus::Active, Instant::now()).0,
        SessionStatus::WaitingInput
    );
    // Focus reports and terminal replies are not permission answers.
    service.note_user_input("osc", "\x1b[I");
    assert_eq!(*status.lock().unwrap(), SessionStatus::WaitingInput);
    service.write("osc", "\r").unwrap();
    assert_eq!(*status.lock().unwrap(), SessionStatus::Active);
    service.apply_hook_status("osc", SessionStatus::WaitingInput);
    service.apply_hook_status("osc", SessionStatus::ToolRunning);
    assert_eq!(*status.lock().unwrap(), SessionStatus::ToolRunning);
}

#[test]
fn issue64_slash_detection_rejects_multiline_paths_and_control_sequences() {
    for text in [
        "/clear",
        "/compact keep API details",
        "/model opus",
        "/project:review",
    ] {
        assert!(is_native_slash_command(text));
    }
    for text in [
        "/",
        "/tmp/repo",
        "/compact\nmore",
        "/clear\r",
        "/clear\x1b[A",
        " /clear",
    ] {
        assert!(!is_native_slash_command(text));
    }
}

#[test]
fn issue64_pi_cwd_override_does_not_rewrite_workspace_identity() {
    let (service, dir) = super::tests::pi_rpc_test_service();
    let project = dir.path().join("project");
    let workspace = dir.path().join("workspace");
    let override_dir = dir.path().join("override");
    for path in [&project, &workspace, &override_dir] {
        std::fs::create_dir(path).unwrap();
    }
    let mut request = super::tests::pi_rpc_request(&project);
    request.workspace_path = Some(workspace.to_string_lossy().into_owned());
    assert_eq!(
        service.build_pi_rpc_launch_spec(&request).unwrap().cwd,
        workspace.to_string_lossy()
    );
    request.launch_cwd = Some(override_dir.to_string_lossy().into_owned());
    assert_eq!(
        service.build_pi_rpc_launch_spec(&request).unwrap().cwd,
        override_dir.to_string_lossy()
    );
    assert_eq!(request.project_path, project.to_string_lossy());
    assert_eq!(request.workspace_path.as_deref(), workspace.to_str());
    request.launch_cwd = Some(dir.path().join("missing").to_string_lossy().into_owned());
    assert!(service.build_pi_rpc_launch_spec(&request).is_err());
}
