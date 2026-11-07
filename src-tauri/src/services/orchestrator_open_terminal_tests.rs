// open_terminal_tab tests. `include!`d into orchestrator_service::tests so the fakes and
// helpers there (wait_test_status, …) are in scope.
use open_terminal_tab::{
    build_open_terminal_event, default_open_terminal_title, looks_like_auth_prompt,
    normalize_open_terminal_command, open_terminal_create_request, parse_open_terminal_placement,
    parse_open_terminal_runtime, project_containing_path, submit_command_when_ready,
    validate_local_cwd, wait_for_shell_ready, OpenTerminalEventInput, ShellReadiness,
    OPEN_TERMINAL_COMMAND_MAX_BYTES,
};

/// Scriptable plain-shell backend: output tail, DECSET 2004 flag and exit status.
#[derive(Default)]
struct ShellReadyTestBackend {
    lines: Mutex<Vec<String>>,
    paste_ready: AtomicBool,
    exited: AtomicBool,
    submits: Mutex<Vec<(String, String)>>,
}

impl ShellReadyTestBackend {
    fn with_lines(lines: &[&str]) -> Self {
        let backend = Self::default();
        *backend.lines.lock().unwrap() = lines.iter().map(|line| line.to_string()).collect();
        backend
    }

    fn submits(&self) -> Vec<(String, String)> {
        self.submits.lock().unwrap().clone()
    }
}

impl TerminalBackend for ShellReadyTestBackend {
    fn create_session(
        &self,
        _request: CoreCreateSessionRequest,
    ) -> cc_panes_core::utils::AppResult<String> {
        Ok("shell-1".to_string())
    }

    fn write(&self, _session_id: &str, _data: &str) -> cc_panes_core::utils::AppResult<()> {
        Ok(())
    }

    fn submit_text_to_session(
        &self,
        session_id: &str,
        text: &str,
    ) -> cc_panes_core::utils::AppResult<()> {
        self.submits
            .lock()
            .unwrap()
            .push((session_id.to_string(), text.to_string()));
        Ok(())
    }

    fn is_paste_ready(&self, _session_id: &str) -> cc_panes_core::utils::AppResult<bool> {
        Ok(self.paste_ready.load(Ordering::SeqCst))
    }

    fn resize(
        &self,
        _session_id: &str,
        _cols: u16,
        _rows: u16,
    ) -> cc_panes_core::utils::AppResult<()> {
        Ok(())
    }

    fn kill(&self, _session_id: &str) -> cc_panes_core::utils::AppResult<()> {
        Ok(())
    }

    fn get_all_status(&self) -> cc_panes_core::utils::AppResult<Vec<SessionStatusInfo>> {
        Ok(Vec::new())
    }

    fn get_session_status(
        &self,
        session_id: &str,
    ) -> cc_panes_core::utils::AppResult<Option<SessionStatusInfo>> {
        let status = if self.exited.load(Ordering::SeqCst) {
            SessionStatus::Exited
        } else {
            SessionStatus::Idle
        };
        Ok(Some(wait_test_status(session_id, status)))
    }

    fn get_session_output(
        &self,
        session_id: &str,
        _lines: usize,
    ) -> cc_panes_core::utils::AppResult<cc_panes_core::services::terminal_service::SessionOutput>
    {
        Ok(cc_panes_core::services::terminal_service::SessionOutput {
            session_id: session_id.to_string(),
            lines: self.lines.lock().unwrap().clone(),
            exited: None,
            retained: None,
        })
    }

    fn get_session_replay_snapshot(
        &self,
        _session_id: &str,
    ) -> cc_panes_core::utils::AppResult<Option<cc_panes_core::models::TerminalReplaySnapshot>>
    {
        Ok(None)
    }
}

const READY_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);
const READY_TEST_QUIET: std::time::Duration = std::time::Duration::from_millis(50);

fn open_terminal_runtime(kind: LaunchRuntimeKind) -> ResolvedLaunchRuntime {
    ResolvedLaunchRuntime {
        kind,
        source: "explicit",
        notice: None,
        wsl: None,
        ssh: None,
    }
}

fn open_terminal_ssh(host: &str) -> SshConnectionInfo {
    SshConnectionInfo {
        host: host.to_string(),
        port: 22,
        user: None,
        remote_path: "/srv/app".to_string(),
        identity_file: None,
        machine_id: Some("machine-1".to_string()),
        auth_method: None,
    }
}

#[test]
fn open_terminal_placement_defaults_to_tab_and_rejects_unknown() {
    assert_eq!(parse_open_terminal_placement(None).unwrap(), "tab");
    assert_eq!(parse_open_terminal_placement(Some("  ")).unwrap(), "tab");
    assert_eq!(parse_open_terminal_placement(Some("TAB")).unwrap(), "tab");
    assert_eq!(
        parse_open_terminal_placement(Some("beside")).unwrap(),
        "beside"
    );
    for bad in ["silent", "background", "split"] {
        let error = parse_open_terminal_placement(Some(bad)).unwrap_err();
        assert!(error.contains("Unknown placement"), "{bad}: {error}");
    }
}

#[test]
fn open_terminal_runtime_defaults_to_local_and_rejects_unknown() {
    assert_eq!(
        parse_open_terminal_runtime(None).unwrap(),
        LaunchRuntimeKind::Local
    );
    assert_eq!(
        parse_open_terminal_runtime(Some("")).unwrap(),
        LaunchRuntimeKind::Local
    );
    assert_eq!(
        parse_open_terminal_runtime(Some("SSH")).unwrap(),
        LaunchRuntimeKind::Ssh
    );
    assert_eq!(
        parse_open_terminal_runtime(Some("wsl")).unwrap(),
        LaunchRuntimeKind::Wsl
    );
    let error = parse_open_terminal_runtime(Some("docker")).unwrap_err();
    assert!(error.contains("Unknown runtimeKind"), "{error}");
}

#[test]
fn open_terminal_command_must_be_one_non_empty_line() {
    assert_eq!(normalize_open_terminal_command(None).unwrap(), None);
    assert_eq!(
        normalize_open_terminal_command(Some("  ssh heze  "))
            .unwrap()
            .as_deref(),
        Some("ssh heze")
    );
    assert!(normalize_open_terminal_command(Some("   ")).is_err());
    assert!(normalize_open_terminal_command(Some("ls\nrm -rf x")).is_err());
    assert!(
        normalize_open_terminal_command(Some("ls\r"))
            .unwrap()
            .is_some(),
        "trailing CR is trimmed"
    );
    assert!(normalize_open_terminal_command(Some("echo \u{1b}[31m")).is_err());
    let long = "a".repeat(OPEN_TERMINAL_COMMAND_MAX_BYTES + 1);
    assert!(normalize_open_terminal_command(Some(&long)).is_err());
}

#[test]
fn open_terminal_local_cwd_must_be_an_existing_absolute_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let dir_path = dir.path().to_string_lossy().to_string();
    assert_eq!(validate_local_cwd(&dir_path).unwrap(), dir_path);

    assert!(validate_local_cwd("relative/dir")
        .unwrap_err()
        .contains("absolute"));
    let missing = dir.path().join("missing").to_string_lossy().to_string();
    assert!(validate_local_cwd(&missing).unwrap_err().contains("不存在"));
    let file = dir.path().join("file.txt");
    std::fs::write(&file, "x").expect("write file");
    assert!(validate_local_cwd(&file.to_string_lossy()).is_err());
}

#[test]
fn open_terminal_project_lookup_picks_longest_containing_project() {
    let projects = vec![
        "/work/repo".to_string(),
        "/work/repo/sub".to_string(),
        "/work/other".to_string(),
    ];
    assert_eq!(
        project_containing_path(&projects, "/work/repo/sub/src").as_deref(),
        Some("/work/repo/sub")
    );
    assert_eq!(
        project_containing_path(&projects, "/work/repo").as_deref(),
        Some("/work/repo")
    );
    // Name prefix is not path containment.
    assert_eq!(project_containing_path(&projects, "/work/repository"), None);
    assert_eq!(project_containing_path(&projects, "/tmp"), None);
}

#[test]
fn open_terminal_default_title_uses_cwd_basename_or_ssh_host() {
    assert_eq!(default_open_terminal_title(None, "/work/repo/"), "repo");
    assert_eq!(default_open_terminal_title(None, r"C:\work\repo"), "repo");
    assert_eq!(default_open_terminal_title(None, "/"), "Terminal");
    let ssh = open_terminal_ssh("heze");
    assert_eq!(
        default_open_terminal_title(Some(&ssh), "/srv/app"),
        "ssh heze"
    );
}

#[test]
fn open_terminal_auth_prompts_are_not_ready_prompts() {
    for line in [
        "user@heze's password:",
        "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
        "[sudo] password for me:",
        "Verification code:",
    ] {
        assert!(looks_like_auth_prompt(line), "{line}");
    }
    for line in [
        "me@host ~/repo %",
        "$",
        "➜  repo git:(main)",
        "Last login: Mon",
    ] {
        assert!(!looks_like_auth_prompt(line), "{line}");
    }
}

#[test]
fn open_terminal_create_request_is_a_plain_shell_without_profile_or_prompt() {
    let anchors = mint_birth_anchors();
    let context = ProjectLaunchContext {
        workspace_name: Some("ws".to_string()),
        workspace_path: Some("/work".to_string()),
        launch_profile_id: Some("profile-yolo".to_string()),
    };
    let request = open_terminal_create_request(
        "orch-1",
        "/work/repo",
        "/work/repo/sub",
        &anchors,
        &open_terminal_runtime(LaunchRuntimeKind::Local),
        &context,
    );
    assert_eq!(request.cli_tool, CliTool::None);
    assert!(!request.launch_claude);
    assert_eq!(
        request.launch_profile_id, None,
        "plain shell takes no launch profile"
    );
    assert_eq!(request.provider_selection, LaunchProviderSelection::None);
    assert!(request.initial_prompt.is_none() && request.resume_id.is_none());
    assert!(request.yolo_mode.is_none() && request.extra_env.is_none());
    assert_eq!(request.workspace_name.as_deref(), Some("ws"));
    assert_eq!(request.launch_cwd.as_deref(), Some("/work/repo/sub"));
    assert_eq!(
        request.origin_tab_id.as_deref(),
        Some(anchors.tab_id.as_str())
    );
    assert_eq!(
        request.origin_terminal_pane_id.as_deref(),
        Some(anchors.terminal_pane_id.as_str())
    );

    // The bypass is local to this tool: launch_task / dispatch_task still refuse `none`.
    let registry = CliToolRegistry::with_builtin_adapters();
    assert!(parse_launch_cli_tool(&registry, Some("none")).is_err());
}

#[test]
fn open_terminal_event_is_a_none_cli_tab_with_birth_anchors_and_placement() {
    let anchors = mint_birth_anchors();
    let context = ProjectLaunchContext {
        workspace_name: Some("ws".to_string()),
        workspace_path: None,
        launch_profile_id: Some("ignored".to_string()),
    };
    let params = McpOpenTerminalTabParams {
        pane_id: Some("pane-1".to_string()),
        layout_id: Some("layout-1".to_string()),
        ..Default::default()
    };
    let mut runtime = open_terminal_runtime(LaunchRuntimeKind::Ssh);
    runtime.ssh = Some(open_terminal_ssh("heze"));
    let event = build_open_terminal_event(OpenTerminalEventInput {
        task_id: "task-1",
        session_id: "shell-1",
        project_id: "orch-1",
        project_path: "/work/repo",
        launch_cwd: "/srv/app",
        context: &context,
        params: &params,
        title: "ssh heze",
        placement: "tab",
        anchors: &anchors,
        runtime: &runtime,
        parent_session_id: Some("caller-session".to_string()),
    });
    let json = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(json["cliTool"], "none");
    assert_eq!(json["placement"], "tab");
    assert_eq!(json["sessionId"], "shell-1");
    assert_eq!(json["tabId"], anchors.tab_id.as_str());
    assert_eq!(json["terminalPaneId"], anchors.terminal_pane_id.as_str());
    assert_eq!(json["paneId"], "pane-1");
    assert_eq!(json["layoutId"], "layout-1");
    assert_eq!(json["title"], "ssh heze");
    assert_eq!(json["launchCwd"], "/srv/app");
    assert_eq!(json["runtimeKind"], "ssh");
    assert_eq!(json["ssh"]["host"], "heze");
    assert_eq!(json["providerSelection"], "none");
    assert_eq!(json["parentSessionId"], "caller-session");
    assert!(json.get("launchProfileId").is_none());
    assert!(json["resumeId"].is_null());
}

#[test]
fn open_terminal_tab_is_on_the_core_surface_with_optional_params() {
    let router = McpToolHandler::tool_router();
    let route = router
        .map
        .get("open_terminal_tab")
        .expect("open_terminal_tab route");
    assert!(CORE_MCP_TOOLS.contains(&"open_terminal_tab"));
    let schema = &route.attr.input_schema;
    for field in [
        "cwd",
        "projectPath",
        "command",
        "title",
        "runtimeKind",
        "paneId",
        "layoutId",
        "layoutName",
        "placement",
    ] {
        assert!(schema["properties"][field].is_object(), "missing {field}");
    }
    let required = schema
        .get("required")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    assert_eq!(required, 0, "every open_terminal_tab parameter is optional");
}

#[tokio::test]
async fn shell_ready_when_bracketed_paste_is_announced_and_command_is_submitted() {
    let backend = Arc::new(ShellReadyTestBackend::default());
    backend.paste_ready.store(true, Ordering::SeqCst);
    let state = Arc::new(TerminalBackendState::new(backend.clone()));
    submit_command_when_ready(
        state,
        "shell-1",
        "ssh heze",
        READY_TEST_TIMEOUT,
        READY_TEST_QUIET,
    )
    .await
    .expect("command sent");
    assert_eq!(
        backend.submits(),
        vec![("shell-1".to_string(), "ssh heze".to_string())]
    );
}

#[tokio::test]
async fn shell_ready_after_quiet_prompt_without_bracketed_paste() {
    let backend = Arc::new(ShellReadyTestBackend::with_lines(&[
        "Last login: Mon",
        "me@host ~ $",
    ]));
    let state = Arc::new(TerminalBackendState::new(backend.clone()));
    assert_eq!(
        wait_for_shell_ready(state, "shell-1", READY_TEST_TIMEOUT, READY_TEST_QUIET).await,
        ShellReadiness::Ready
    );
}

#[tokio::test]
async fn shell_never_ready_on_auth_prompt_and_command_is_withheld() {
    let backend = Arc::new(ShellReadyTestBackend::with_lines(&["me@heze's password:"]));
    // Even a DECSET 2004 from somewhere upstream must not override a visible password prompt.
    backend.paste_ready.store(true, Ordering::SeqCst);
    let state = Arc::new(TerminalBackendState::new(backend.clone()));
    let error =
        submit_command_when_ready(state, "shell-1", "ls", READY_TEST_TIMEOUT, READY_TEST_QUIET)
            .await
            .expect_err("must not type into a password prompt");
    assert!(error.contains("密码"), "{error}");
    assert!(backend.submits().is_empty());
}

#[tokio::test]
async fn shell_without_any_output_times_out_and_command_is_withheld() {
    let backend = Arc::new(ShellReadyTestBackend::default());
    let state = Arc::new(TerminalBackendState::new(backend.clone()));
    assert_eq!(
        wait_for_shell_ready(
            state.clone(),
            "shell-1",
            READY_TEST_TIMEOUT,
            READY_TEST_QUIET
        )
        .await,
        ShellReadiness::TimedOut
    );
    assert!(submit_command_when_ready(
        state,
        "shell-1",
        "ls",
        READY_TEST_TIMEOUT,
        READY_TEST_QUIET
    )
    .await
    .is_err());
    assert!(backend.submits().is_empty());
}

#[tokio::test]
async fn shell_exit_stops_the_wait_without_submitting() {
    let backend = Arc::new(ShellReadyTestBackend::with_lines(&["$"]));
    backend.exited.store(true, Ordering::SeqCst);
    let state = Arc::new(TerminalBackendState::new(backend.clone()));
    assert_eq!(
        wait_for_shell_ready(state, "shell-1", READY_TEST_TIMEOUT, READY_TEST_QUIET).await,
        ShellReadiness::Exited
    );
    assert!(backend.submits().is_empty());
}
