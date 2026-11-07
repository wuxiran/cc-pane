//! `open_terminal_tab`: open a plain shell tab (`CliTool::None`) the user can see,
//! optionally submit one command into it, and hand the sessionId back so callers can
//! drive it with submit_to_session / get_session_output / wait_for_session / kill_session.
//!
//! Deliberately rides the launch_task pipeline (runtime resolution, birth anchors,
//! create_launch_session + provenance, task status, launch history, parent session,
//! `orchestrator-launch-task` event) instead of a parallel path. Only the CLI gate
//! differs: launch_task / dispatch_task keep rejecting `none` via `parse_launch_cli_tool`;
//! this tool never consults it because a plain shell is the whole point here.
use super::*;

/// Upper bound for the optional one-line command (well under SUBMIT_TEXT_MAX_BYTES).
pub(super) const OPEN_TERMINAL_COMMAND_MAX_BYTES: usize = 8 * 1024;
/// How long we wait for the shell prompt before giving up on sending `command`.
/// SSH handshakes are the slow case; the tab itself is already open by then.
pub(super) const SHELL_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Output must stay unchanged this long before a prompt is assumed (no DECSET 2004 seen).
pub(super) const SHELL_READY_QUIET: std::time::Duration = std::time::Duration::from_millis(500);
const SHELL_READY_POLL: std::time::Duration = std::time::Duration::from_millis(100);
const SHELL_READY_TAIL_LINES: usize = 5;

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub(super) struct McpOpenTerminalTabParams {
    /// 启动目录（绝对路径；本地须存在）。省略：调用方本地会话的 cwd，否则项目根（ssh/wsl 为远端项目目录）
    pub(super) cwd: Option<String>,
    /// 已注册项目路径。省略：包含 cwd 的已注册项目，否则调用方所在项目
    #[serde(rename = "projectPath")]
    pub(super) project_path: Option<String>,
    /// shell 就绪后提交的单行命令（可选，不能含换行/控制字符）
    pub(super) command: Option<String>,
    /// 标签标题，默认 cwd 目录名（ssh 为 "ssh <host>"）
    pub(super) title: Option<String>,
    /// local（默认）/ wsl / ssh；wsl/ssh 目标按项目所在工作空间的运行环境配置解析
    #[serde(rename = "runtimeKind")]
    pub(super) runtime_kind: Option<String>,
    /// 目标面板 ID（list_panes）
    #[serde(rename = "paneId")]
    pub(super) pane_id: Option<String>,
    /// 目标布局 ID
    #[serde(rename = "layoutId")]
    pub(super) layout_id: Option<String>,
    /// 目标布局名，不存在则新建
    #[serde(rename = "layoutName")]
    pub(super) layout_name: Option<String>,
    /// tab（默认，调用者窗格的新标签）/ beside（调用者旁边分屏）
    pub(super) placement: Option<String>,
}

/// `placement`: this tool defaults to `tab` (launch_task defaults to `beside`).
pub(super) fn parse_open_terminal_placement(
    placement: Option<&str>,
) -> std::result::Result<&'static str, String> {
    let raw = placement.map(str::trim).unwrap_or_default();
    match raw.to_ascii_lowercase().as_str() {
        "" | "tab" => Ok("tab"),
        "beside" => Ok("beside"),
        _ => Err(format!(
            "Unknown placement '{}'; expected tab or beside",
            raw
        )),
    }
}

/// `runtimeKind` defaults to local — unlike launch_task we do not inherit the
/// workspace's default environment, so a bare call always means "a shell on this machine".
pub(super) fn parse_open_terminal_runtime(
    runtime_kind: Option<&str>,
) -> std::result::Result<LaunchRuntimeKind, String> {
    match runtime_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => Ok(LaunchRuntimeKind::Local),
        Some(value) => parse_launch_runtime_kind(&value.to_ascii_lowercase()),
    }
}

/// One line, no control characters. Absent stays absent; a blank string is a caller bug.
pub(super) fn normalize_open_terminal_command(
    command: Option<&str>,
) -> std::result::Result<Option<String>, String> {
    let Some(raw) = command else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("command 不能为空（不需要执行命令时省略该参数）".to_string());
    }
    if trimmed.len() > OPEN_TERMINAL_COMMAND_MAX_BYTES {
        return Err(format!(
            "command 不能超过 {} 字节",
            OPEN_TERMINAL_COMMAND_MAX_BYTES
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(
            "command 只能是单行文本，不能含换行或控制字符；多条命令请之后用 submit_to_session"
                .to_string(),
        );
    }
    Ok(Some(trimmed.to_string()))
}

fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Local cwd: absolute (shared rule with dispatch) and an existing directory.
pub(super) fn validate_local_cwd(cwd: &str) -> std::result::Result<String, String> {
    let cwd = resolve_dispatch_cwd(cwd, None)?;
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("cwd '{}' 不存在或不是目录", cwd));
    }
    Ok(cwd)
}

/// Longest registered project that contains `path` (same identity rules as registration).
pub(super) fn project_containing_path(projects: &[String], path: &str) -> Option<String> {
    let target = normalize_path(path).replace('\\', "/");
    let target = target.trim_end_matches('/');
    projects
        .iter()
        .filter_map(|project| {
            let key = normalize_path(project).replace('\\', "/");
            let key = key.trim_end_matches('/').to_string();
            let inside = target == key || target.starts_with(&format!("{key}/"));
            inside.then(|| (project.clone(), key.len()))
        })
        .max_by_key(|(_, len)| *len)
        .map(|(project, _)| project)
}

/// Tab title when the caller gives none: `ssh <host>` for SSH, else the cwd's basename.
pub(super) fn default_open_terminal_title(
    ssh: Option<&SshConnectionInfo>,
    launch_cwd: &str,
) -> String {
    if let Some(ssh) = ssh {
        return format!("ssh {}", ssh.host);
    }
    launch_cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or("Terminal")
        .to_string()
}

/// A prompt that is waiting for a secret or a confirmation, not for a command.
/// Typing the caller's command there would at best fail and at worst send it to a
/// remote server as a password — so these never count as "ready".
pub(super) fn looks_like_auth_prompt(line: &str) -> bool {
    let line = line.trim().to_ascii_lowercase();
    if line.contains("(yes/no") || line.contains("[y/n]") || line.contains("(y/n)") {
        return true;
    }
    line.ends_with(':')
        && [
            "password",
            "passphrase",
            "passcode",
            "verification code",
            "one-time",
            "otp",
            "pin",
        ]
        .iter()
        .any(|needle| line.contains(needle))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellReadiness {
    Ready,
    AwaitingAuth,
    Exited,
    TimedOut,
}

impl ShellReadiness {
    pub(super) fn reason(self) -> Option<&'static str> {
        match self {
            Self::Ready => None,
            Self::AwaitingAuth => Some(
                "shell 正在等待密码/确认输入，未发送 command；用户完成后用 submit_to_session 发送",
            ),
            Self::Exited => Some("shell 已退出，未发送 command"),
            Self::TimedOut => Some(
                "等待 shell 提示符超时，未发送 command；可用 get_session_output 查看后再 submit_to_session",
            ),
        }
    }
}

/// Wait until the shell can take a command line. Ready = the shell announced
/// bracketed paste (DECSET 2004, how zsh/bash ≥5.1/fish signal a live line editor), or
/// its output has been non-empty and unchanged for `quiet` (daemon backends and ConPTY
/// never surface DECSET 2004). An auth prompt as the last line never counts as ready.
pub(super) async fn wait_for_shell_ready(
    terminal_backend: Arc<TerminalBackendState>,
    session_id: &str,
    timeout: std::time::Duration,
    quiet: std::time::Duration,
) -> ShellReadiness {
    let started_at = std::time::Instant::now();
    let mut last_snapshot: Option<Vec<String>> = None;
    let mut stable_since = started_at;
    let mut awaiting_auth = false;
    loop {
        let sid = session_id.to_string();
        let probe = backend_call_for_state(terminal_backend.clone(), move |backend| {
            let paste_ready = backend.is_paste_ready(&sid)?;
            let exited = backend
                .get_session_status(&sid)?
                .is_some_and(|info| info.status.is_terminal());
            let lines = backend
                .get_session_output(&sid, SHELL_READY_TAIL_LINES)
                .map(|output| output.lines)
                .unwrap_or_default();
            Ok((paste_ready, exited, lines))
        })
        .await;
        let now = std::time::Instant::now();
        match probe {
            Ok((_, true, _)) => return ShellReadiness::Exited,
            Ok((paste_ready, false, lines)) => {
                let last_line = lines
                    .iter()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .map(String::as_str);
                awaiting_auth = last_line.is_some_and(looks_like_auth_prompt);
                if !awaiting_auth {
                    if paste_ready {
                        return ShellReadiness::Ready;
                    }
                    if last_snapshot.as_ref() != Some(&lines) {
                        last_snapshot = Some(lines);
                        stable_since = now;
                    } else if last_line.is_some() && now.duration_since(stable_since) >= quiet {
                        return ShellReadiness::Ready;
                    }
                }
            }
            Err(error) => {
                debug!(session_id, err = %error, "open_terminal_tab readiness probe failed");
            }
        }
        let elapsed = now.duration_since(started_at);
        if elapsed >= timeout {
            return if awaiting_auth {
                ShellReadiness::AwaitingAuth
            } else {
                ShellReadiness::TimedOut
            };
        }
        tokio::time::sleep(std::cmp::min(
            SHELL_READY_POLL,
            timeout.saturating_sub(elapsed),
        ))
        .await;
    }
}

/// Wait for the prompt, then submit with the same mechanism as submit_to_session.
/// Returns whether the command went out and, if not, why.
pub(super) async fn submit_command_when_ready(
    terminal_backend: Arc<TerminalBackendState>,
    session_id: &str,
    command: &str,
    timeout: std::time::Duration,
    quiet: std::time::Duration,
) -> std::result::Result<(), String> {
    let readiness =
        wait_for_shell_ready(terminal_backend.clone(), session_id, timeout, quiet).await;
    if let Some(reason) = readiness.reason() {
        return Err(reason.to_string());
    }
    submit_text_to_session(terminal_backend.backend(), session_id, command)
        .await
        .map_err(|error| format!("发送 command 失败: {error}"))
}

/// Everything the frontend needs to place a normal `cliTool: "none"` terminal tab.
pub(super) struct OpenTerminalEventInput<'a> {
    pub(super) task_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) project_id: &'a str,
    pub(super) project_path: &'a str,
    pub(super) launch_cwd: &'a str,
    pub(super) context: &'a ProjectLaunchContext,
    pub(super) params: &'a McpOpenTerminalTabParams,
    pub(super) title: &'a str,
    pub(super) placement: &'static str,
    pub(super) anchors: &'a cc_panes_core::utils::BirthAnchors,
    pub(super) runtime: &'a ResolvedLaunchRuntime,
    pub(super) parent_session_id: Option<String>,
}

pub(super) fn build_open_terminal_event(
    input: OpenTerminalEventInput<'_>,
) -> OrchestratorLaunchEvent {
    OrchestratorLaunchEvent {
        task_id: input.task_id.to_string(),
        session_id: input.session_id.to_string(),
        project_path: input.project_path.to_string(),
        launch_cwd: Some(input.launch_cwd.to_string()),
        project_id: input.project_id.to_string(),
        workspace_name: input.context.workspace_name.clone(),
        provider_id: None,
        model_id: None,
        provider_selection: Some(LaunchProviderSelection::None.as_str().to_string()),
        launch_profile_id: None,
        workspace_path: input.context.workspace_path.clone(),
        title: Some(input.title.to_string()),
        resume_id: None,
        pane_id: input.params.pane_id.clone(),
        layout_id: input.params.layout_id.clone(),
        layout_name: input.params.layout_name.clone(),
        tab_id: Some(input.anchors.tab_id.clone()),
        terminal_pane_id: Some(input.anchors.terminal_pane_id.clone()),
        cli_tool: Some(CliTool::None.as_id().to_string()),
        runtime_kind: input.runtime.kind.as_str().to_string(),
        runtime_source: input.runtime.source.to_string(),
        notice: input.runtime.notice.clone(),
        wsl: input.runtime.wsl.clone(),
        ssh: input.runtime.ssh.clone(),
        placement: Some(input.placement.to_string()),
        parent_session_id: input.parent_session_id,
    }
}

/// Plain shell session request: no prompt, provider, launch profile, YOLO or extra env.
pub(super) fn open_terminal_create_request(
    launch_id: &str,
    project_path: &str,
    launch_cwd: &str,
    anchors: &cc_panes_core::utils::BirthAnchors,
    runtime: &ResolvedLaunchRuntime,
    context: &ProjectLaunchContext,
) -> CoreCreateSessionRequest {
    let mut request = CoreCreateSessionRequest {
        launch_id: Some(launch_id.to_string()),
        project_path: project_path.to_string(),
        launch_cwd: Some(launch_cwd.to_string()),
        cols: 120,
        rows: 30,
        workspace_name: None,
        provider_id: None,
        model_id: None,
        provider_selection: LaunchProviderSelection::None,
        launch_profile_id: None,
        workspace_path: None,
        workspace_snapshot_id: None,
        origin_layout_id: None,
        origin_tab_id: Some(anchors.tab_id.clone()),
        origin_terminal_pane_id: Some(anchors.terminal_pane_id.clone()),
        expected_saved_session_id: None,
        launch_claude: false,
        cli_tool: CliTool::None,
        resume_id: None,
        skip_mcp: false,
        append_system_prompt: None,
        initial_prompt: None,
        yolo_mode: None,
        adapter_options: None,
        extra_env: None,
        ssh: runtime.ssh.clone(),
        wsl: runtime.wsl.clone(),
    };
    apply_project_launch_context_to_request(&mut request, context);
    // A plain shell takes no launch profile (frontend "terminal only" ignores it too).
    request.launch_profile_id = None;
    request
}

fn registered_project_paths(state: &AppState) -> Vec<String> {
    let mut paths: Vec<String> = state
        .project_service
        .list_projects()
        .unwrap_or_default()
        .into_iter()
        .map(|project| project.path)
        .collect();
    if let Ok(workspaces) = state.workspace_service.list_workspaces() {
        for workspace in workspaces {
            paths.extend(workspace.projects.into_iter().map(|project| project.path));
        }
    }
    paths
}

/// Project + requested cwd after applying the documented fallbacks.
struct OpenTerminalTarget {
    project_path: String,
    requested_cwd: Option<String>,
}

impl McpToolHandler {
    /// Order: explicit projectPath → registered project containing a local cwd →
    /// caller's own project. cwd falls back to the caller's local launch cwd.
    fn resolve_open_terminal_target(
        &self,
        params: &McpOpenTerminalTabParams,
        runtime_kind: LaunchRuntimeKind,
        extensions: &Extensions,
    ) -> std::result::Result<OpenTerminalTarget, String> {
        let explicit_project = trimmed_non_empty(params.project_path.as_deref());
        let requested_cwd = trimmed_non_empty(params.cwd.as_deref()).map(str::to_string);
        if let Some(path) = explicit_project {
            if !is_project_registered(&self.state, path) {
                return Err(format!("项目路径 '{}' 未注册", path));
            }
        }
        let cwd_project = match (explicit_project, requested_cwd.as_deref(), runtime_kind) {
            (None, Some(cwd), LaunchRuntimeKind::Local) => {
                project_containing_path(&registered_project_paths(&self.state), cwd)
            }
            _ => None,
        };
        let caller = self.caller_launch_record(extensions);
        let caller_project = caller
            .as_ref()
            .map(|record| record.project_path.clone())
            .filter(|path| is_project_registered(&self.state, path));

        let project_path = explicit_project
            .map(str::to_string)
            .or(cwd_project)
            .or_else(|| caller_project.clone())
            .ok_or_else(|| {
                "无法确定项目：传 projectPath，或传位于已注册项目内的 cwd".to_string()
            })?;

        // The caller's own cwd only makes sense for a local shell in the caller's project,
        // and only when the caller itself ran locally (its cwd is a host path then).
        let requested_cwd = requested_cwd.or_else(|| {
            let caller = caller.as_ref()?;
            let same_project = caller_project
                .as_deref()
                .is_some_and(|path| registered_path_matches(path, &project_path));
            (runtime_kind == LaunchRuntimeKind::Local
                && same_project
                && caller.runtime_kind == "local")
                .then(|| caller.launch_cwd.clone())
                .flatten()
                .filter(|cwd| std::path::Path::new(cwd).is_dir())
        });
        Ok(OpenTerminalTarget {
            project_path,
            requested_cwd,
        })
    }

    pub(super) async fn open_terminal_tab_impl(
        &self,
        params: McpOpenTerminalTabParams,
        extensions: Extensions,
    ) -> String {
        let placement = match parse_open_terminal_placement(params.placement.as_deref()) {
            Ok(placement) => placement,
            Err(error) => return format!("错误: {}", error),
        };
        let runtime_kind = match parse_open_terminal_runtime(params.runtime_kind.as_deref()) {
            Ok(kind) => kind,
            Err(error) => return format!("错误: {}", error),
        };
        let command = match normalize_open_terminal_command(params.command.as_deref()) {
            Ok(command) => command,
            Err(error) => return format!("错误: {}", error),
        };
        let target = match self.resolve_open_terminal_target(&params, runtime_kind, &extensions) {
            Ok(target) => target,
            Err(error) => return format!("错误: {}", error),
        };
        let project_path = target.project_path;
        // 只记工具名、cwd 与是否带命令：命令文本是用户输入，与 submit_to_session 同样不落日志。
        info!(
            project = %project_path,
            cwd = ?target.requested_cwd,
            runtime = runtime_kind.as_str(),
            has_command = command.is_some(),
            placement,
            "mcp::open_terminal_tab"
        );

        let context = resolve_project_launch_context(
            &project_path,
            None,
            None,
            &self.state.workspace_service,
        );
        let runtime = match resolve_launch_runtime(
            &project_path,
            context.workspace_name.as_deref(),
            Some(CliTool::None.as_id()),
            Some(runtime_kind.as_str()),
            None,
            &self.state,
        ) {
            Ok(runtime) => runtime,
            Err(error) => return format!("错误: {}", error),
        };
        let launch_cwd = match resolve_runtime_launch_cwd(
            &project_path,
            target.requested_cwd.as_deref(),
            &runtime,
        ) {
            Ok(cwd) if runtime.kind == LaunchRuntimeKind::Local => match validate_local_cwd(&cwd) {
                Ok(cwd) => cwd,
                Err(error) => return format!("错误: {}", error),
            },
            Ok(cwd) => cwd,
            Err(error) => return format!("错误: {}", error),
        };
        let title = trimmed_non_empty(params.title.as_deref())
            .map(str::to_string)
            .unwrap_or_else(|| default_open_terminal_title(runtime.ssh.as_ref(), &launch_cwd));

        let task_id = uuid::Uuid::new_v4().to_string();
        let launch_id = format!("orch-{}", uuid::Uuid::new_v4());
        let birth_anchors = mint_birth_anchors();
        let request = open_terminal_create_request(
            &launch_id,
            &project_path,
            &launch_cwd,
            &birth_anchors,
            &runtime,
            &context,
        );
        let session_id = match create_launch_session(
            self.state.terminal_backend.clone(),
            Some(self.state.session_restore_service.clone()),
            Some(self.state.app_handle.clone()),
            request,
            None,
            PASTE_READY_WAIT_TIMEOUT,
        )
        .await
        {
            Ok((session_id, _)) => session_id,
            Err(error) => {
                error!(err = %error, "mcp::open_terminal_tab failed to create session");
                let notice = runtime
                    .notice
                    .as_deref()
                    .map(|notice| format!("{} ", notice))
                    .unwrap_or_default();
                return format!("错误: 创建会话失败: {}{}", notice, error);
            }
        };

        self.record_launching_task(&task_id, &session_id);
        self.record_open_terminal_history(
            &launch_id,
            &project_path,
            &session_id,
            &launch_cwd,
            &runtime,
            &context,
        );

        let parent_session_id =
            self.resolve_parent_session_from_caller(caller_launch_id_from_extensions(&extensions));
        let event = build_open_terminal_event(OpenTerminalEventInput {
            task_id: &task_id,
            session_id: &session_id,
            project_id: &launch_id,
            project_path: &project_path,
            launch_cwd: &launch_cwd,
            context: &context,
            params: &params,
            title: &title,
            placement,
            anchors: &birth_anchors,
            runtime: &runtime,
            parent_session_id,
        });
        let _ = self
            .state
            .app_handle
            .emit("orchestrator-launch-task", &event);

        let command_error = match command.as_deref() {
            Some(command) => submit_command_when_ready(
                self.state.terminal_backend.clone(),
                &session_id,
                command,
                SHELL_READY_TIMEOUT,
                SHELL_READY_QUIET,
            )
            .await
            .err(),
            None => None,
        };
        let command_sent = command.is_some() && command_error.is_none();
        if let Some(error) = command_error.as_deref() {
            warn!(session_id = %session_id, err = %error, "mcp::open_terminal_tab command not sent");
        }

        serde_json::json!({
            "success": true,
            "sessionId": session_id,
            "taskId": task_id,
            "launchId": launch_id,
            "tabId": birth_anchors.tab_id,
            "terminalPaneId": birth_anchors.terminal_pane_id,
            "paneId": params.pane_id,
            "placement": placement,
            "title": title,
            "cwd": launch_cwd,
            "projectPath": project_path,
            "runtimeKind": runtime.kind.as_str(),
            "commandSent": command_sent,
            "commandError": command_error,
            "notice": runtime.notice,
        })
        .to_string()
    }

    /// Same launch_history row the frontend writes for a "terminal only" tab (cliTool none),
    /// keyed by the launch id so the shell can be found as a caller later.
    fn record_open_terminal_history(
        &self,
        launch_id: &str,
        project_path: &str,
        session_id: &str,
        launch_cwd: &str,
        runtime: &ResolvedLaunchRuntime,
        context: &ProjectLaunchContext,
    ) {
        if let Err(error) = self
            .state
            .history_watch_manager
            .on_session_created(session_id, project_path)
        {
            warn!(session_id, err = %error, "mcp::open_terminal_tab failed to start local history watcher");
        }
        let project_name = std::path::Path::new(project_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(project_path);
        let wsl_distro = runtime.wsl.as_ref().and_then(|wsl| wsl.distro.as_deref());
        if let Err(error) = self.state.launch_history_service.add_with_pty_session(
            launch_id,
            project_name,
            project_path,
            session_id,
            CliTool::None.as_id(),
            runtime.kind.as_str(),
            wsl_distro,
            context.workspace_name.as_deref(),
            context.workspace_path.as_deref(),
            Some(launch_cwd),
            None,
            None,
            Some(LaunchProviderSelection::None.as_str()),
            None,
            None,
        ) {
            warn!(launch_id, err = %error, "mcp::open_terminal_tab failed to insert launch_history");
        }
    }
}
