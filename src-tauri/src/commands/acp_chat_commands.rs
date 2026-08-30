//! ACP chat commands.
//!
//! The engine registry lives here in Rust: the WebView selects an engine by
//! id and never supplies an executable path. Adapter package versions are
//! pinned — ACP is in its v1→v2 transition and `@latest` would let a remote
//! publish change our wire protocol mid-flight.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::services::{AcpChatService, AcpChatSnapshot, AcpLaunchSpec};
use crate::utils::{AppError, AppResult};
use cc_cli_adapters::{resolve_executable, rewrite_windows_npm_shim};
use cc_panes_core::models::DiffResult;
use cc_panes_core::repository::HistoryFileRepository;
use cc_panes_core::utils::orchestrator_manifest;
use cc_panes_core::utils::AppPaths;

struct AcpEngineSpec {
    id: &'static str,
    label: &'static str,
    /// Executable resolved through the standard CLI resolution chain.
    executable: &'static str,
    args: &'static [&'static str],
    /// What the user must install for this engine to become available.
    requirement: &'static str,
}

/// 用户自定义引擎（`<data>/agent-chats/engines.json`）：接任何 ACP agent 的
/// 零维护逃生阀——ACP 注册表 40+ 家，差别只剩启动命令，不值得硬编码成表。
/// 与内置同 id 时忽略自定义（内置的 pin 版本与说明是被验证过的）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomAcpEngine {
    id: String,
    label: String,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    requirement: Option<String>,
}

/// 内置 + 自定义合并后的统一形态。pub 是给 automation_service 复用引擎解析
/// 链（同一份注册表、同一条 npm shim 改写路径）。
#[derive(Debug, Clone)]
pub struct ResolvedEngine {
    pub id: String,
    pub label: String,
    pub executable: String,
    pub args: Vec<String>,
    pub requirement: String,
}

fn custom_engines_path(app_paths: &AppPaths) -> std::path::PathBuf {
    app_paths
        .data_dir()
        .join("agent-chats")
        .join("engines.json")
}

fn load_custom_engines(app_paths: &AppPaths) -> Vec<CustomAcpEngine> {
    let path = custom_engines_path(app_paths);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<CustomAcpEngine>>(&raw) {
        Ok(engines) => engines
            .into_iter()
            .filter(|engine| !engine.id.trim().is_empty() && !engine.executable.trim().is_empty())
            .collect(),
        Err(error) => {
            // 配置写坏不能让整个引擎列表消失——忽略并落日志。
            tracing::warn!(error = %error, path = %path.display(), "invalid agent-chats/engines.json");
            Vec::new()
        }
    }
}

fn resolved_engines(app_paths: &AppPaths) -> Vec<ResolvedEngine> {
    let mut engines: Vec<ResolvedEngine> = ACP_ENGINES
        .iter()
        .map(|engine| ResolvedEngine {
            id: engine.id.to_string(),
            label: engine.label.to_string(),
            executable: engine.executable.to_string(),
            args: engine.args.iter().map(|arg| arg.to_string()).collect(),
            requirement: engine.requirement.to_string(),
        })
        .collect();
    for custom in load_custom_engines(app_paths) {
        if engines.iter().any(|engine| engine.id == custom.id) {
            continue;
        }
        engines.push(ResolvedEngine {
            requirement: custom
                .requirement
                .unwrap_or_else(|| format!("custom engine: {}", custom.executable)),
            id: custom.id,
            label: custom.label,
            executable: custom.executable,
            args: custom.args,
        });
    }
    engines
}

// 引擎清单原则：只收 CC-Panes 用户环境里真实出现过的 CLI（适配器体系同款），
// 不搞启动表数量竞赛（docs/55 H6）。原生 ACP 的解析本地二进制即可用；
// 桥接型（npx 包）pin 版本防远端发布改协议。
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
    AcpEngineSpec {
        id: "gemini",
        label: "Gemini CLI",
        executable: "gemini",
        args: &["--acp"],
        requirement: "Google Gemini CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "qwen",
        label: "Qwen Code",
        executable: "qwen",
        args: &["--acp"],
        requirement: "Qwen Code CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "opencode",
        label: "OpenCode",
        executable: "opencode",
        args: &["acp"],
        requirement: "OpenCode CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "copilot",
        label: "GitHub Copilot",
        executable: "copilot",
        args: &["--acp", "--stdio"],
        requirement: "GitHub Copilot CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "cursor",
        label: "Cursor Agent",
        executable: "cursor-agent",
        args: &["acp"],
        requirement: "Cursor CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "kimi",
        label: "Kimi CLI",
        executable: "kimi",
        args: &["acp"],
        requirement: "Kimi CLI (native ACP)",
    },
    AcpEngineSpec {
        id: "pi",
        label: "Pi",
        executable: "npx",
        args: &["-y", "pi-acp@0.0.33"],
        requirement: "npm (npx) + configured Pi",
    },
    AcpEngineSpec {
        id: "openclaw",
        label: "OpenClaw",
        executable: "openclaw",
        args: &["acp"],
        requirement: "OpenClaw CLI (native ACP)",
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

pub fn engine_spec(app_paths: &AppPaths, engine_id: &str) -> AppResult<ResolvedEngine> {
    resolved_engines(app_paths)
        .into_iter()
        .find(|engine| engine.id == engine_id)
        .ok_or_else(|| {
            AppError::coded(
                "ACP_ENGINE_UNKNOWN",
                format!("Unknown ACP engine: {engine_id}"),
            )
        })
}

pub fn resolve_engine_launch(engine: &ResolvedEngine, cwd: &str) -> AppResult<AcpLaunchSpec> {
    let executable = resolve_executable(&engine.executable).map_err(|error| {
        AppError::coded(
            "ACP_ENGINE_UNAVAILABLE",
            format!(
                "{} is not available ({}): {error}",
                engine.label, engine.requirement
            ),
        )
    })?;
    let args = engine.args.clone();
    let (command, args) = rewrite_windows_npm_shim(executable.to_string_lossy().into_owned(), args);
    Ok(AcpLaunchSpec {
        engine_id: engine.id.clone(),
        command,
        args,
        cwd: cwd.to_string(),
        // 由 start 命令按 orchestrator 存活状态补充。
        mcp_servers: Vec::new(),
        resume_acp_session_id: None,
        auto_approve_permissions: false,
    })
}

#[tauri::command]
pub async fn list_acp_engines(
    app_paths: State<'_, Arc<AppPaths>>,
) -> AppResult<Vec<AcpEngineInfo>> {
    let app_paths = app_paths.inner().clone();
    // Executable resolution scans PATH and common install dirs; keep it off
    // the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let mut engines: Vec<AcpEngineInfo> = resolved_engines(&app_paths)
            .into_iter()
            .map(|engine| AcpEngineInfo {
                available: resolve_executable(&engine.executable).is_ok(),
                id: engine.id,
                label: engine.label,
                requirement: engine.requirement,
            })
            .collect();
        // 可用的排前面（清单变长后，装了的引擎不该被没装的挤出首屏）。
        // 稳定排序保住注册表内的既有次序。
        engines.sort_by_key(|engine| !engine.available);
        engines
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))
}

/// CC-Panes 自己的 orchestrator MCP（http 形态）。orchestrator 未运行时返回
/// 空——chat 照常可用，只是 agent 拿不到 ccpanes 工具面。
pub fn ccpanes_mcp_servers(app_paths: &AppPaths) -> Vec<Value> {
    match orchestrator_manifest::read_endpoint(app_paths.data_dir()) {
        Some((port, token)) => vec![json!({
            "type": "http",
            "name": "ccpanes",
            "url": format!("http://127.0.0.1:{port}/mcp?token={token}"),
            "headers": [],
        })],
        None => Vec::new(),
    }
}

#[tauri::command]
pub async fn start_acp_chat(
    app: AppHandle,
    service: State<'_, Arc<AcpChatService>>,
    app_paths: State<'_, Arc<AppPaths>>,
    chat_id: String,
    engine_id: String,
    cwd: String,
    resume_acp_session_id: Option<String>,
) -> AppResult<AcpChatSnapshot> {
    let engine = engine_spec(&app_paths, &engine_id)?;
    let mcp_servers = ccpanes_mcp_servers(&app_paths);
    let mut spec = tauri::async_runtime::spawn_blocking({
        let cwd = cwd.clone();
        move || resolve_engine_launch(&engine, &cwd)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))??;
    spec.mcp_servers = mcp_servers;
    spec.resume_acp_session_id = resume_acp_session_id;
    service.start(app, chat_id, spec).await
}

#[tauri::command]
pub async fn prompt_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    blocks: Vec<Value>,
) -> AppResult<()> {
    service.prompt(&chat_id, blocks).await
}

#[tauri::command]
pub async fn list_acp_chat_history(
    service: State<'_, Arc<AcpChatService>>,
) -> AppResult<Vec<Value>> {
    Ok(service.list_chat_history())
}

const IMAGE_ATTACHMENT_MAX_BYTES: u64 = 10 * 1024 * 1024;

fn image_mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// 读取本地图片为 base64（Chat 附件按钮用）。扩展名白名单 + 10MB 上限。
#[tauri::command]
pub async fn read_acp_image_attachment(
    path: String,
) -> AppResult<cc_panes_core::models::filesystem::ImageFileContent> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let file_path = std::path::Path::new(&path);
        let mime = file_path
            .extension()
            .and_then(|extension| extension.to_str())
            .and_then(image_mime_for_extension)
            .ok_or_else(|| {
                AppError::coded("ACP_ATTACHMENT_UNSUPPORTED", "Unsupported image type")
            })?;
        let metadata = std::fs::metadata(file_path)
            .map_err(|error| AppError::from(format!("Unable to read image: {error}")))?;
        if metadata.len() > IMAGE_ATTACHMENT_MAX_BYTES {
            return Err(AppError::coded(
                "ACP_ATTACHMENT_TOO_LARGE",
                "Image exceeds the 10MB attachment limit",
            ));
        }
        let bytes = std::fs::read(file_path)
            .map_err(|error| AppError::from(format!("Unable to read image: {error}")))?;
        Ok(cc_panes_core::models::filesystem::ImageFileContent {
            path: path.clone(),
            data_base64: STANDARD.encode(&bytes),
            mime_type: mime.to_string(),
            size: metadata.len(),
        })
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

/// 两段文本的行级 diff（复用 Local History 的 diff 引擎，含行内变更与
/// 大文件保护）。ACP 工具卡的 diff 块用它换掉整段叠色渲染。
#[tauri::command]
pub async fn compute_text_diff(old_text: String, new_text: String) -> AppResult<DiffResult> {
    tauri::async_runtime::spawn_blocking(move || {
        HistoryFileRepository::compute_diff(&old_text, &new_text)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))
}

#[tauri::command]
pub async fn cancel_acp_chat(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
) -> AppResult<()> {
    service.cancel(&chat_id).await
}

#[tauri::command]
pub async fn set_acp_chat_mode(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    mode_id: String,
) -> AppResult<()> {
    service.set_mode(&chat_id, mode_id).await
}

#[tauri::command]
pub async fn set_acp_chat_model(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    model_id: String,
) -> AppResult<()> {
    service.set_model(&chat_id, model_id).await
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
