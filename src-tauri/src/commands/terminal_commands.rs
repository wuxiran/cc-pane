use crate::models::TerminalReplaySnapshot;
use crate::models::{CreateSessionRequest, ResizeRequest};
use crate::services::terminal_service;
use crate::services::terminal_service::SessionOutput;
use crate::services::{
    SessionStatusInfo, ShellInfo, TerminalBackendKind, TerminalBackendState,
    TerminalDaemonEventBridge, TerminalService,
};
use crate::utils::error::AppError;
use crate::utils::{validate_path, validate_ssh_info, AppResult};
use cc_cli_adapters::{CliToolInfo, CliToolRegistry};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tracing::debug;

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

/// 创建终端会话
#[tauri::command]
pub async fn create_terminal_session(
    app_handle: AppHandle,
    service: State<'_, Arc<TerminalBackendState>>,
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
        validate_path(&request.project_path)?;
        if let Some(ref ws_path) = request.workspace_path {
            validate_path(ws_path)?;
        }
    }

    let backend = service.backend();
    let create_backend = backend.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || create_backend.create_session(request))
            .await
            .map_err(|e| AppError::from(e.to_string()))?;
    let session_id = result?;

    if service.kind() == TerminalBackendKind::Daemon {
        let bridge = app_handle.state::<Arc<TerminalDaemonEventBridge>>();
        bridge.start_session(session_id.clone(), backend);
    }

    Ok(session_id)
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

/// 关闭终端会话（async + spawn_blocking 防止阻塞主线程）
#[tauri::command]
pub async fn kill_terminal(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::kill_terminal");
    let backend = service.backend();
    let result = tauri::async_runtime::spawn_blocking(move || backend.kill(&session_id))
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    result
}

/// 幂等关闭终端会话：不存在或已退出都视为成功。
#[tauri::command]
pub async fn kill_terminal_idempotent(
    service: State<'_, Arc<TerminalBackendState>>,
    session_id: String,
) -> AppResult<()> {
    debug!(session_id = %session_id, "cmd::kill_terminal_idempotent");
    let backend = service.backend();
    let sid = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || backend.kill(&sid))
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    match result {
        Ok(()) => Ok(()),
        Err(error) if is_idempotent_kill_error(&error) => Ok(()),
        Err(error) => Err(AppError::from(error.to_string())),
    }
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
) -> AppResult<Vec<SessionStatusInfo>> {
    service.backend().get_all_status()
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

/// 检测开发环境（Node.js + CLI 工具，所有子进程调用均带 5s 超时）
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

        serde_json::json!({
            "node": { "installed": node_installed, "version": node_version },
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
    session_id: String,
) -> AppResult<Option<TerminalReplaySnapshot>> {
    debug!(session_id = %session_id, "cmd::get_terminal_replay_snapshot");
    let backend = service.backend();
    let snapshot = backend.get_session_replay_snapshot(&session_id)?;

    if let Some(snapshot) = snapshot
        .as_ref()
        .filter(|_| service.kind() == TerminalBackendKind::Daemon)
    {
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
