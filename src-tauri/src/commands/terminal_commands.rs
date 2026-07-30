use crate::models::TerminalReplaySnapshot;
use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::terminal_service;
use crate::services::terminal_service::{KillReason, SessionOutput};
use crate::services::{
    BridgeStats, HistoryWatchManager, LaunchHistoryService, SessionRestoreService,
    SessionStatusInfo, ShellInfo, TerminalAdoptionSnapshot, TerminalBackend, TerminalBackendKind,
    TerminalBackendState, TerminalDaemonEventBridge, TerminalService,
};
use crate::utils::error::AppError;
use crate::utils::{validate_launch_cwd, validate_ssh_info, AppResult, LaunchRuntime};
use cc_cli_adapters::{CliToolInfo, CliToolRegistry};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{debug, warn};

/// WSL 启动安全网：orchestrator 绑定回环且 WSL 非 mirrored 网络时，
/// WSL 内 CLI 可能无法回连 MCP —— warn + 广播 terminal-launch-warning 供前端 toast 提示。
/// mirrored 网络下 WSL 内 127.0.0.1 直达宿主，回环绑定无影响，不提示。
fn warn_if_orchestrator_unreachable_from_wsl(app_handle: &AppHandle) {
    let Some(orchestrator) = app_handle.try_state::<Arc<crate::services::OrchestratorService>>()
    else {
        return;
    };
    let Some(bind) = orchestrator.bind_decision() else {
        return;
    };
    if bind.host != "127.0.0.1" || bind.wsl_mirrored == Some(true) {
        return;
    }
    warn!(
        "[orchestrator] WSL session launched while orchestrator is loopback-bound \
         (mode={}) and WSL networking is not mirrored; ccpanes MCP may be unreachable from WSL",
        bind.mode
    );
    let _ = app_handle.emit(
        "terminal-launch-warning",
        serde_json::json!({
            "kind": "orchestratorLoopbackWsl",
            "bindMode": bind.mode,
        }),
    );
}

fn is_idempotent_kill_error(error: &AppError) -> bool {
    // fix(H2) review: typed NotFound replaces fragile string-only not-found detection.
    matches!(error, AppError::NotFound(_))
        || error
            .to_string()
            .to_ascii_lowercase()
            .contains("already exited")
}

fn summarize_terminal_input(data: &str) -> serde_json::Value {
    let chars: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| ch.escape_default().to_string())
        .collect();
    let code_points: Vec<String> = data
        .chars()
        .take(24)
        .map(|ch| format!("{:x}", ch as u32))
        .collect();
    let bytes: Vec<String> = data
        .as_bytes()
        .iter()
        .take(32)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    serde_json::json!({
        "chars": chars,
        "charCount": data.chars().count(),
        "utf8Bytes": data.len(),
        "codePoints": code_points,
        "bytes": bytes,
        "truncated": data.chars().count() > 24 || data.len() > 32,
    })
}

fn persist_created_session_observation(
    backend: &dyn TerminalBackend,
    session_restore_service: &SessionRestoreService,
    request: &CreateSessionRequest,
    session_id: &str,
    reused_existing: bool,
) -> AppResult<()> {
    let provenance = backend
        .session_provenance(session_id)?
        .ok_or_else(|| AppError::from("claim-capable daemon omitted session provenance"))?;
    session_restore_service
        .save_provenance(&provenance)
        .map_err(AppError::from)?;
    if !reused_existing {
        if let Some(observation) =
            cc_panes_core::models::SavedSession::from_creation(request, &provenance)
        {
            session_restore_service
                .save_initial_observation(&observation)
                .map_err(AppError::from)?;
        }
    }
    Ok(())
}

fn cleanup_failed_session_persistence(
    backend: &dyn TerminalBackend,
    session_id: &str,
    reused_expected_session: bool,
) -> AppResult<()> {
    if reused_expected_session {
        backend.release_session(session_id)
    } else {
        backend.kill_with_reason(session_id, KillReason::Unknown)
    }
}

/// 创建终端会话
#[tauri::command]
pub async fn create_terminal_session(
    app_handle: AppHandle,
    service: State<'_, Arc<TerminalBackendState>>,
    launch_history_service: State<'_, Arc<LaunchHistoryService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
    session_restore_service: State<'_, Arc<SessionRestoreService>>,
    request: Option<CreateSessionRequest>,
) -> AppResult<String> {
    let request = request
        .ok_or_else(|| AppError::from("create_terminal_session requires a non-null request"))?;

    debug!(
        project_path = %request.project_path,
        ssh = request.ssh.is_some(),
        wsl = request.wsl.is_some(),
        "cmd::create_terminal_session"
    );

    if request.ssh.is_some() && request.wsl.is_some() {
        return Err(AppError::from(
            "SSH and WSL launch options cannot be combined",
        ));
    }

    if let Some(ref ssh_info) = request.ssh {
        validate_ssh_info(ssh_info)?;
    } else {
        let runtime = if request.wsl.is_some() {
            LaunchRuntime::Wsl
        } else {
            LaunchRuntime::Local
        };
        validate_launch_cwd(
            &request.project_path,
            request.workspace_path.as_deref(),
            runtime,
        )?;
    }

    // 安全网：orchestrator 只绑了回环时，WSL 内 CLI 无法回连宿主 MCP 端点。
    // 不阻断启动（终端本身可用），仅告警 + 通知前端提示用户调整绑定模式后重启。
    if request.wsl.is_some() {
        warn_if_orchestrator_unreachable_from_wsl(&app_handle);
    }

    let project_path = request.project_path.clone();
    let launch_binding = request
        .launch_id
        .clone()
        .map(|launch_id| (launch_id, request.effective_cli_tool().as_id().to_string()));
    let observation_request = request.clone();
    let recovery_handle = app_handle.clone();
    let recovery_state = (*service).clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        recovery_state.create_session_with_recovery(&recovery_handle, request)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?;
    let created = result?;
    let session_id = created.session_id;
    let backend = created.backend;
    let reused_existing = created.reused_existing;

    // A claim-capable daemon must issue immutable birth evidence, and it must reach SQLite before
    // the session id is returned to the webview. Otherwise a crash in this window recreates the
    // original ambiguity: a live PTY with no trustworthy cross-instance join key.
    if backend.claims_supported() {
        let persist_backend = backend.clone();
        let persist_service = (*session_restore_service).clone();
        let persist_session_id = session_id.clone();
        let persist_result = tauri::async_runtime::spawn_blocking(move || {
            persist_created_session_observation(
                persist_backend.as_ref(),
                persist_service.as_ref(),
                &observation_request,
                &persist_session_id,
                reused_existing,
            )
        })
        .await
        .map_err(|error| AppError::from(error.to_string()))
        .and_then(|result| result);
        if let Err(error) = persist_result {
            let cleanup_backend = backend.clone();
            let cleanup_session_id = session_id.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                cleanup_failed_session_persistence(
                    cleanup_backend.as_ref(),
                    &cleanup_session_id,
                    reused_existing,
                )
            })
            .await;
            return Err(error);
        }
    }

    if let Some((launch_id, cli_tool)) = launch_binding {
        let mut bound = false;
        for attempt in 0..10 {
            match launch_history_service.bind_pty_session(&launch_id, &session_id, &cli_tool) {
                Ok(Some(_)) => {
                    bound = true;
                    break;
                }
                Ok(None) if attempt < 9 => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(launch_id = %launch_id, session_id = %session_id, cli_tool = %cli_tool, error = %error, "failed to bind PTY to launch history");
                    break;
                }
            }
        }
        if !bound {
            warn!(launch_id = %launch_id, session_id = %session_id, cli_tool = %cli_tool, "launch history row was not available for exact PTY binding");
        }
    }

    if let Err(error) = history_watch_manager.on_session_created(&session_id, &project_path) {
        warn!(session_id = %session_id, error = %error, "failed to start local history watcher");
    }

    let status_backend = backend.clone();
    let status_session_id = session_id.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        status_backend.get_session_status(&status_session_id)
    })
    .await
    {
        Ok(Ok(status))
            if status
                .as_ref()
                .is_none_or(|value| value.status.is_terminal()) =>
        {
            history_watch_manager.on_session_ended(&session_id);
        }
        Ok(Err(error)) => {
            warn!(session_id = %session_id, error = %error, "failed to verify terminal status after creation");
        }
        Err(error) => {
            warn!(session_id = %session_id, error = %error, "terminal status verification task failed");
        }
        _ => {}
    }

    if service.kind() == TerminalBackendKind::Daemon {
        let bridge = app_handle.state::<Arc<TerminalDaemonEventBridge>>();
        bridge.start_session(session_id.clone(), backend);
    }

    Ok(session_id)
}

/// 获取 daemon 事件 bridge 的连接模式与重试统计。
#[tauri::command]
pub fn get_bridge_stats(
    bridge: State<'_, Arc<TerminalDaemonEventBridge>>,
) -> AppResult<BridgeStats> {
    Ok(bridge.stats())
}

/// 向终端写入数据
#[tauri::command]
pub fn write_terminal(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    debug!(
        session_id = %session_id,
        input = %summarize_terminal_input(&data),
        "terminal-input.trace tauri.write_terminal"
    );
    service.backend().write(&session_id, &data)
}

/// 调整终端大小
#[tauri::command]
pub fn resize_terminal(
    service: State<'_, Arc<TerminalBackendState>>,
    request: ResizeRequest,
) -> AppResult<()> {
    debug!(session_id = %request.session_id, "cmd::resize_terminal");
    service
        .backend()
        .resize(&request.session_id, request.cols, request.rows)
}

/// 前端未标注来源时默认 user-close：kill_terminal 的既有调用方
/// （关标签/关面板/快捷键）全部是用户操作。
fn resolve_kill_reason(reason: Option<String>) -> KillReason {
    match reason {
        Some(value) => KillReason::parse(Some(value.as_str())),
        None => KillReason::UserClose,
    }
}

/// 关闭终端会话（async + spawn_blocking 防止阻塞主线程）
#[tauri::command]
pub async fn kill_terminal(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    reason: Option<String>,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::kill_terminal");
    let backend = service.backend();
    let kill_reason = resolve_kill_reason(reason);
    let result = tauri::async_runtime::spawn_blocking(move || {
        backend.kill_with_reason(&session_id, kill_reason)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?;
    result
}

/// 幂等关闭终端会话：不存在或已退出都视为成功。
#[tauri::command]
pub async fn kill_terminal_idempotent(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    reason: Option<String>,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::kill_terminal_idempotent");
    let backend = service.backend();
    let sid = session_id.clone();
    let kill_reason = resolve_kill_reason(reason);
    let result =
        tauri::async_runtime::spawn_blocking(move || backend.kill_with_reason(&sid, kill_reason))
            .await
            .map_err(|e| AppError::from(e.to_string()))?;
    match result {
        Ok(()) => Ok(()),
        Err(error) if is_idempotent_kill_error(&error) => Ok(()),
        Err(error) => Err(AppError::from(error.to_string())),
    }
}

/// 终端后端客户端信息：孤儿会话对账据此判断是否可以安全 sweep。
/// in-process 时会话为本实例独占（desktopClientCount 无意义）；
/// daemon 模式下 count 缺失（旧 daemon 无控制 WS）时调用方应 fail-closed。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBackendClientInfo {
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_client_count: Option<usize>,
    pub claims_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

#[tauri::command]
pub async fn get_terminal_daemon_client_info(
    service: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<TerminalBackendClientInfo> {
    let Some(client) = service.daemon_client() else {
        return Ok(TerminalBackendClientInfo {
            mode: "in-process",
            desktop_client_count: None,
            claims_supported: false,
            daemon_generation: None,
            instance_id: None,
        });
    };
    let status = tauri::async_runtime::spawn_blocking(move || client.status())
        .await
        .map_err(|e| AppError::from(e.to_string()))??;
    Ok(TerminalBackendClientInfo {
        mode: "daemon",
        desktop_client_count: status.desktop_client_count,
        claims_supported: status.claims_supported.unwrap_or(false),
        daemon_generation: Some(status.started_at),
        instance_id: Some(cc_panes_core::services::app_instance_id().to_string()),
    })
}

#[tauri::command]
pub async fn get_terminal_adoption_snapshot(
    service: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<TerminalAdoptionSnapshot> {
    let backend = service.backend();
    tauri::async_runtime::spawn_blocking(move || backend.adoption_snapshot())
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

async fn release_adoption_claim_best_effort(
    backend: Arc<dyn crate::services::TerminalBackend>,
    session_id: String,
) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || backend.release_session(&session_id)).await;
}

#[tauri::command]
pub async fn adopt_terminal_session(
    service: State<'_, Arc<TerminalBackendState>>,
    session_restore_service: State<'_, Arc<SessionRestoreService>>,
    session_id: String,
) -> AppResult<bool> {
    let backend = service.backend();
    let adopt_backend = backend.clone();
    let sid = session_id.clone();
    let granted = tauri::async_runtime::spawn_blocking(move || adopt_backend.adopt_session(&sid))
        .await
        .map_err(|e| AppError::from(e.to_string()))??;
    if !granted || !backend.claims_supported() {
        return Ok(granted);
    }

    let snapshot_backend = backend.clone();
    let snapshot_result =
        tauri::async_runtime::spawn_blocking(move || snapshot_backend.adoption_snapshot())
            .await
            .map_err(|e| AppError::from(e.to_string()))
            .and_then(|result| result);
    let snapshot = match snapshot_result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            release_adoption_claim_best_effort(backend, session_id).await;
            return Err(error);
        }
    };
    let Some(owner) = snapshot.owner_instance_id else {
        release_adoption_claim_best_effort(backend, session_id).await;
        return Err(AppError::from(
            "daemon claim snapshot omitted owner instance id",
        ));
    };
    if let Err(error) = session_restore_service.transfer_observation_owner(&session_id, &owner) {
        release_adoption_claim_best_effort(backend, session_id).await;
        return Err(AppError::from(error));
    }
    Ok(true)
}

#[tauri::command]
pub async fn release_terminal_session(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
) -> AppResult<()> {
    let backend = service.backend();
    tauri::async_runtime::spawn_blocking(move || backend.release_session(&session_id))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

/// 提交文本到会话：先写文本，短暂等待后单独发送 Enter。
#[tauri::command]
pub async fn submit_to_session(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, text_len = text.len(), "cmd::submit_to_session");
    let backend = service.backend();
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || backend.submit_text_to_session(&sid, &text))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
}

/// 获取所有终端状态
#[tauri::command]
pub fn get_all_terminal_status(
    service: State<'_, Arc<TerminalBackendState>>,
    orchestrator: State<'_, Arc<crate::services::OrchestratorService>>,
) -> AppResult<Vec<SessionStatusInfo>> {
    let mut statuses = service.backend().get_all_status()?;
    orchestrator.adjust_terminal_statuses_for_query(&mut statuses);
    Ok(statuses)
}

/// 获取可用 Shell 列表
#[tauri::command]
pub fn get_available_shells(service: State<'_, Arc<TerminalService>>) -> AppResult<Vec<ShellInfo>> {
    Ok(service.get_available_shells())
}

/// 获取 Windows Build Number（用于 xterm.js windowsPty 配置）
#[tauri::command]
pub fn get_windows_build_number() -> AppResult<u32> {
    Ok(terminal_service::get_windows_build_number())
}

/// 检测开发环境（Node.js + Git + WSL + CLI 工具，所有子进程调用均带 5s 超时）
/// async + spawn_blocking 防止阻塞 IPC 线程
#[tauri::command]
pub async fn check_environment(
    registry: State<'_, Arc<CliToolRegistry>>,
) -> AppResult<serde_json::Value> {
    let registry = registry.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let node_path = which::which("node").ok();
        let node_installed = node_path.is_some();
        let node_version = node_path.and_then(|path| {
            cc_cli_adapters::run_with_timeout(
                &path,
                &["--version".to_string()],
                std::time::Duration::from_secs(5),
            )
        });

        let cli_tools = registry.detect_all();
        let git_path = which::which("git").ok();
        let git_installed = git_path.is_some();
        let git_version = git_path.and_then(|path| {
            cc_cli_adapters::run_with_timeout(
                &path,
                &["--version".to_string()],
                std::time::Duration::from_secs(5),
            )
        });
        let wsl_applicable = cfg!(target_os = "windows");
        let wsl_path = if wsl_applicable {
            which::which("wsl.exe")
                .or_else(|_| which::which("wsl"))
                .ok()
        } else {
            None
        };
        let wsl_installed = wsl_path.is_some();

        serde_json::json!({
            "node": { "installed": node_installed, "version": node_version },
            "git": { "installed": git_installed, "version": git_version },
            "wsl": { "installed": wsl_installed, "version": null, "applicable": wsl_applicable },
            "cliTools": cli_tools
        })
    })
    .await
    .map_err(|e| AppError::from(format!("Environment check failed: {}", e)))?;
    Ok(result)
}

/// 列出所有已注册的 CLI 工具（含实时检测状态）
/// async + spawn_blocking 防止阻塞 IPC 线程
#[tauri::command]
pub async fn list_cli_tools(
    registry: State<'_, Arc<CliToolRegistry>>,
) -> AppResult<Vec<CliToolInfo>> {
    let registry = registry.inner().clone();
    let tools = tauri::async_runtime::spawn_blocking(move || registry.detect_all())
        .await
        .map_err(|e| AppError::from(format!("List CLI tools failed: {}", e)))?;
    Ok(tools)
}

/// 读取终端会话的最近输出（纯文本，ANSI 已剥离）
#[tauri::command]
pub fn get_terminal_output(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    lines: Option<usize>,
) -> AppResult<SessionOutput> {
    debug!(session_id = %session_id, "cmd::get_terminal_output");
    service
        .backend()
        .get_session_output(&session_id, lines.unwrap_or(0))
}

/// 读取终端会话最近 N 行输出。
#[tauri::command]
pub fn get_terminal_recent_output(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
    lines: Option<usize>,
) -> AppResult<SessionOutput> {
    debug!(session_id = %session_id, "cmd::get_terminal_recent_output");
    service
        .backend()
        .get_session_output(&session_id, lines.unwrap_or(0))
}

/// 获取 attach-existing 所需的原始 VT replay 快照
#[tauri::command]
pub fn get_terminal_replay_snapshot(
    app_handle: AppHandle,
    service: State<'_, Arc<TerminalBackendState>>,
    launch_history_service: State<'_, Arc<LaunchHistoryService>>,
    history_watch_manager: State<'_, Arc<HistoryWatchManager>>,
    session_id: String,
) -> AppResult<Option<TerminalReplaySnapshot>> {
    debug!(session_id = %session_id, "cmd::get_terminal_replay_snapshot");
    let backend = service.backend();
    let snapshot = backend.get_session_replay_snapshot(&session_id)?;

    if let Some(snapshot) = snapshot
        .as_ref()
        .filter(|_| service.kind() == TerminalBackendKind::Daemon)
    {
        if let Ok(Some(record)) = launch_history_service.find_by_pty_session_id(&session_id) {
            if let Err(error) =
                history_watch_manager.on_session_created(&session_id, &record.project_path)
            {
                warn!(session_id = %session_id, error = %error, "failed to restore local history watcher");
            }
        }
        let bridge = app_handle.state::<Arc<TerminalDaemonEventBridge>>();
        bridge.start_session_after_replay(session_id, backend, snapshot);
    }

    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use cc_panes_core::models::{SavedSession, TerminalBufferMode, TerminalSessionProvenance};
    use cc_panes_core::repository::Database;
    use cc_panes_core::utils::AppPaths;

    use super::*;

    struct PersistenceTestBackend {
        provenance: TerminalSessionProvenance,
        kills: Mutex<Vec<String>>,
        releases: Mutex<Vec<String>>,
    }

    impl TerminalBackend for PersistenceTestBackend {
        fn create_session(&self, _request: CreateSessionRequest) -> AppResult<String> {
            unreachable!("persistence tests do not create PTYs")
        }

        fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
            Ok(())
        }

        fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
            Ok(())
        }

        fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
            Ok(())
        }

        fn kill(&self, session_id: &str) -> AppResult<()> {
            self.kills.lock().unwrap().push(session_id.to_string());
            Ok(())
        }

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            Ok(Vec::new())
        }

        fn get_session_status(&self, _session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            Ok(None)
        }

        fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
            Ok(SessionOutput {
                session_id: session_id.to_string(),
                lines: Vec::new(),
            })
        }

        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            Ok(Some(TerminalReplaySnapshot {
                data: String::new(),
                buffer_mode: TerminalBufferMode::Normal,
            }))
        }

        fn release_session(&self, session_id: &str) -> AppResult<()> {
            self.releases.lock().unwrap().push(session_id.to_string());
            Ok(())
        }

        fn claims_supported(&self) -> bool {
            true
        }

        fn session_provenance(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalSessionProvenance>> {
            Ok(Some(self.provenance.clone()))
        }
    }

    fn persistence_test_backend() -> PersistenceTestBackend {
        PersistenceTestBackend {
            provenance: TerminalSessionProvenance {
                session_id: "session-1".to_string(),
                daemon_generation: 42,
                birth_nonce: "birth-1".to_string(),
                origin_instance_id: Some("instance-old".to_string()),
                origin_layout_id: Some("layout-origin".to_string()),
                origin_tab_id: Some("tab-origin".to_string()),
                origin_terminal_pane_id: Some("leaf-origin".to_string()),
                project_path: "/repo".to_string(),
                runtime_kind: "local".to_string(),
                cli_tool: "codex".to_string(),
                resume_id: Some("resume-1".to_string()),
                created_at_ms: 1,
            },
            kills: Mutex::new(Vec::new()),
            releases: Mutex::new(Vec::new()),
        }
    }

    fn persistence_test_request(expected_saved_session_id: Option<&str>) -> CreateSessionRequest {
        serde_json::from_value(serde_json::json!({
            "projectPath": "/repo",
            "cols": 80,
            "rows": 24,
            "cliTool": "codex",
            "resumeId": "resume-1",
            "originLayoutId": "layout-current",
            "originTabId": "tab-current",
            "originTerminalPaneId": "leaf-current",
            "expectedSavedSessionId": expected_saved_session_id,
        }))
        .expect("create request")
    }

    fn persistence_test_service() -> SessionRestoreService {
        let database = Arc::new(Database::new_fallback().expect("database"));
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let app_paths = Arc::new(AppPaths::new(Some(
            std::env::temp_dir()
                .join(format!("cc-panes-terminal-command-{suffix}"))
                .to_string_lossy()
                .to_string(),
        )));
        SessionRestoreService::new(database, app_paths)
    }

    #[test]
    fn reused_session_keeps_its_existing_mutable_layout_observation() {
        let backend = persistence_test_backend();
        let service = persistence_test_service();
        let original_request = persistence_test_request(None);
        let original = SavedSession::from_creation(&original_request, &backend.provenance)
            .expect("original observation");
        service
            .save_initial_observation(&original)
            .expect("save original observation");

        let restore_request = persistence_test_request(Some("session-1"));
        persist_created_session_observation(
            &backend,
            &service,
            &restore_request,
            "session-1",
            true,
        )
        .expect("persist reused session");

        let saved = service
            .load_sessions()
            .expect("load sessions")
            .into_iter()
            .find(|session| session.session_id == "session-1")
            .expect("saved session");
        assert_eq!(saved.layout_id.as_deref(), Some("layout-origin"));
        assert_eq!(saved.tab_id, "tab-origin");
        assert_eq!(saved.terminal_pane_id.as_deref(), Some("leaf-origin"));
    }

    #[test]
    fn reused_session_persistence_cleanup_releases_without_killing_pty() {
        let backend = persistence_test_backend();

        cleanup_failed_session_persistence(&backend, "session-1", true)
            .expect("release reused session");

        assert_eq!(
            backend.releases.lock().unwrap().as_slice(),
            &["session-1".to_string()]
        );
        assert!(backend.kills.lock().unwrap().is_empty());
    }

    #[test]
    fn kill_terminal_idempotent_treats_missing_session_as_success() {
        let error = AppError::NotFound("Session not found: missing".into());

        assert!(is_idempotent_kill_error(&error));
    }

    #[test]
    fn kill_terminal_idempotent_treats_already_exited_as_success() {
        let error = AppError::from("process already exited");

        assert!(is_idempotent_kill_error(&error));
    }

    #[test]
    fn kill_terminal_idempotent_rejects_other_errors() {
        let error = AppError::from("permission denied");

        assert!(!is_idempotent_kill_error(&error));
    }

    #[test]
    fn summarize_terminal_input_escapes_carriage_return() {
        let summary = summarize_terminal_input("\r");

        assert_eq!(summary["chars"][0], "\\r");
        assert_eq!(summary["codePoints"][0], "d");
        assert_eq!(summary["charCount"], 1);
        assert_eq!(summary["utf8Bytes"], 1);
        assert_eq!(summary["truncated"], false);
    }

    #[test]
    fn summarize_terminal_input_truncates_long_input() {
        let input = "a".repeat(30);
        let summary = summarize_terminal_input(&input);

        assert_eq!(summary["chars"].as_array().unwrap().len(), 24);
        assert_eq!(summary["bytes"].as_array().unwrap().len(), 30);
        assert_eq!(summary["charCount"], 30);
        assert_eq!(summary["truncated"], true);
    }

    #[test]
    fn summarize_terminal_input_flags_truncation_on_wide_utf8() {
        // 12 个中文字符 = 36 字节，超出 32 字节展示上限即视为截断
        let input = "好".repeat(12);
        let summary = summarize_terminal_input(&input);

        assert_eq!(summary["charCount"], 12);
        assert_eq!(summary["utf8Bytes"], 36);
        assert_eq!(summary["bytes"].as_array().unwrap().len(), 32);
        assert_eq!(summary["truncated"], true);
    }
}
