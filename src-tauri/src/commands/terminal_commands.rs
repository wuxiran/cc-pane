use crate::models::TerminalReplaySnapshot;
use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::terminal_service;
use crate::services::terminal_service::{KillReason, SessionOutput};
use crate::services::{
    BridgeStats, HistoryWatchManager, LaunchHistoryService, SessionRestoreService,
    SessionStatusInfo, ShellInfo, TerminalAdoptionSnapshot, TerminalBackendKind,
    TerminalBackendState, TerminalDaemonEventBridge, TerminalDaemonLifecycle, TerminalService,
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

/// daemon 掉线检测与重连，返回是否**确实完成了一次重连**（值得重试）。
///
/// 只在失败路径调用。判据不是错误文本（脆且随平台/语言变），而是一次健康探测：
///   健康 -> 刚才那次失败是业务错误，返回 false，原样把错误抛给调用方
///   不健康 -> 真掉线，重连并换掉 backend，返回 true
///
/// 重连本身带节流（见 `TerminalDaemonLifecycle::reconnect_throttled`），
/// daemon 起不来时不会每次操作都 spawn 一个进程。
fn recover_daemon_if_down(app_handle: &AppHandle, service: &TerminalBackendState) -> bool {
    if service.kind() != TerminalBackendKind::Daemon {
        return false;
    }
    // 还活着说明不是掉线，别动它
    if let Some(client) = service.daemon_client() {
        if client.health().is_ok() {
            return false;
        }
    }

    let Some(app_paths) = app_handle.try_state::<Arc<crate::utils::AppPaths>>() else {
        return false;
    };
    let Some(settings) = app_handle.try_state::<Arc<crate::services::SettingsService>>() else {
        return false;
    };
    let resource_dir = app_handle.path().resource_dir().ok();
    let config_path = settings.config_path().to_path_buf();

    match TerminalDaemonLifecycle::reconnect_throttled(
        app_paths.inner().as_ref(),
        resource_dir.as_deref(),
        &config_path,
    ) {
        Ok(client) => {
            service.try_enable_daemon(client);
            warn!("terminal daemon reconnected after outage");
            true
        }
        Err(error) => {
            warn!(error = %error, "terminal daemon reconnect failed");
            false
        }
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
    let backend = service.backend();
    let observation_request = request.clone();
    let create_backend = backend.clone();
    let retry_request = request.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || create_backend.create_session(request))
            .await
            .map_err(|e| AppError::from(e.to_string()))?;

    // daemon 掉线自愈：`connect_or_start` 只在 [boot] 期跑一次，daemon 中途死掉后
    // app 手里的 client 一直指着死地址，之后每次开终端都 `connection timed out`，
    // 不重启整个应用永远好不了。这里在失败路径上补一次重连 + 重试。
    //
    // 不靠错误文本判断掉线（脆）：失败后**探一次健康**——健康说明是业务错误，
    // 原样抛出；不健康才是真掉线，重连后重试一次。
    let result = match result {
        Err(error) if recover_daemon_if_down(&app_handle, &service) => {
            warn!(error = %error, "terminal daemon recovered; retrying session creation once");
            let retry_backend = service.backend();
            tauri::async_runtime::spawn_blocking(move || {
                retry_backend.create_session(retry_request)
            })
            .await
            .map_err(|e| AppError::from(e.to_string()))?
        }
        other => other,
    };
    let session_id = result?;

    // A claim-capable daemon must issue immutable birth evidence, and it must reach SQLite before
    // the session id is returned to the webview. Otherwise a crash in this window recreates the
    // original ambiguity: a live PTY with no trustworthy cross-instance join key.
    if backend.claims_supported() {
        let provenance_backend = backend.clone();
        let provenance_session_id = session_id.clone();
        let provenance = tauri::async_runtime::spawn_blocking(move || {
            provenance_backend.session_provenance(&provenance_session_id)
        })
        .await
        .map_err(|e| AppError::from(e.to_string()))??
        .ok_or_else(|| AppError::from("claim-capable daemon omitted session provenance"));
        let persist_result = provenance.and_then(|provenance| {
            session_restore_service
                .save_provenance(&provenance)
                .map_err(AppError::from)?;
            if let Some(observation) = cc_panes_core::models::SavedSession::from_creation(
                &observation_request,
                &provenance,
            ) {
                session_restore_service
                    .save_initial_observation(&observation)
                    .map_err(AppError::from)?;
            }
            Ok(())
        });
        if let Err(error) = persist_result {
            let cleanup_backend = backend.clone();
            let cleanup_session_id = session_id.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                cleanup_backend.kill_with_reason(&cleanup_session_id, KillReason::Unknown)
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
    use super::*;

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
