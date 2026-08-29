//! ACP chat commands.
//!
//! The engine registry lives here in Rust: the WebView selects an engine by
//! id and never supplies an executable path. Adapter package versions are
//! pinned — ACP is in its v1→v2 transition and `@latest` would let a remote
//! publish change our wire protocol mid-flight.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::services::{AcpChatService, AcpChatSnapshot, AcpLaunchSpec};
use crate::utils::{AppError, AppResult};
use cc_cli_adapters::{resolve_executable, rewrite_windows_npm_shim};

struct AcpEngineSpec {
    id: &'static str,
    label: &'static str,
    /// Executable resolved through the standard CLI resolution chain.
    executable: &'static str,
    args: &'static [&'static str],
    /// What the user must install for this engine to become available.
    requirement: &'static str,
}

const ACP_ENGINES: &[AcpEngineSpec] = &[
    AcpEngineSpec {
        id: "claude",
        label: "Claude Code",
        executable: "npx",
        args: &["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
        requirement: "npm (npx) + logged-in Claude Code",
    },
    AcpEngineSpec {
        id: "codex",
        label: "Codex",
        executable: "npx",
        args: &["-y", "@agentclientprotocol/codex-acp@1.7.0"],
        requirement: "npm (npx) + logged-in Codex CLI",
    },
    AcpEngineSpec {
        id: "grok",
        label: "Grok Build",
        executable: "grok",
        args: &["agent", "stdio"],
        requirement: "xAI Grok CLI (native ACP)",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEngineInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub requirement: String,
}

fn engine_spec(engine_id: &str) -> AppResult<&'static AcpEngineSpec> {
    ACP_ENGINES
        .iter()
        .find(|engine| engine.id == engine_id)
        .ok_or_else(|| {
            AppError::coded(
                "ACP_ENGINE_UNKNOWN",
                format!("Unknown ACP engine: {engine_id}"),
            )
        })
}

fn resolve_engine_launch(engine: &AcpEngineSpec, cwd: &str) -> AppResult<AcpLaunchSpec> {
    let executable = resolve_executable(engine.executable).map_err(|error| {
        AppError::coded(
            "ACP_ENGINE_UNAVAILABLE",
            format!(
                "{} is not available ({}): {error}",
                engine.label, engine.requirement
            ),
        )
    })?;
    let args = engine.args.iter().map(|arg| arg.to_string()).collect();
    let (command, args) = rewrite_windows_npm_shim(executable.to_string_lossy().into_owned(), args);
    Ok(AcpLaunchSpec {
        engine_id: engine.id.to_string(),
        command,
        args,
        cwd: cwd.to_string(),
    })
}

#[tauri::command]
pub async fn list_acp_engines() -> AppResult<Vec<AcpEngineInfo>> {
    // Executable resolution scans PATH and common install dirs; keep it off
    // the async runtime.
    tauri::async_runtime::spawn_blocking(|| {
        ACP_ENGINES
            .iter()
            .map(|engine| AcpEngineInfo {
                id: engine.id.to_string(),
                label: engine.label.to_string(),
                available: resolve_executable(engine.executable).is_ok(),
                requirement: engine.requirement.to_string(),
            })
            .collect()
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn start_acp_chat(
    app: AppHandle,
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    engine_id: String,
    cwd: String,
) -> AppResult<AcpChatSnapshot> {
    let engine = engine_spec(&engine_id)?;
    let spec = tauri::async_runtime::spawn_blocking({
        let cwd = cwd.clone();
        move || resolve_engine_launch(engine, &cwd)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))??;
    service.start(app, chat_id, spec).await
}

#[tauri::command]
pub async fn prompt_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    message: String,
) -> AppResult<()> {
    service.prompt(&chat_id, message).await
}

#[tauri::command]
pub async fn cancel_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
) -> AppResult<()> {
    service.cancel(&chat_id).await
}

#[tauri::command]
pub async fn respond_acp_permission(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    request_key: String,
    option_id: Option<String>,
) -> AppResult<()> {
    service
        .respond_permission(&chat_id, request_key, option_id)
        .await
}

#[tauri::command]
pub async fn get_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
) -> AppResult<Option<AcpChatSnapshot>> {
    Ok(service.snapshot(&chat_id).await)
}

#[tauri::command]
pub async fn stop_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
) -> AppResult<()> {
    service.stop(&chat_id).await
}
