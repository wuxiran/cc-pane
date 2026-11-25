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

mod launch;

struct AcpEngineSpec {
    id: &'static str,
    label: &'static str,
    /// Executable resolved through the standard CLI resolution chain.
    executable: &'static str,
    args: &'static [&'static str],
    /// What the user must install for this engine to become available.
    requirement: &'static str,
    /// Extra environment variables the adapter needs (e.g. Muse's ACP opt-in).
    env: &'static [(&'static str, &'static str)],
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
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
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
    pub env: Vec<(String, String)>,
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
            env: engine
                .env
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
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
            env: custom.env.into_iter().collect(),
        });
    }
    engines
}

// 引擎清单原则：只收 CC-Panes 用户环境里真实出现过的 CLI（适配器体系同款），
// 不搞启动表数量竞赛（docs/55 H6）。原生 ACP 的解析本地二进制即可用；
// 桥接型（npx 包）pin 版本防远端发布改协议。
const ACP_ENGINES: &[AcpEngineSpec] = &[
    AcpEngineSpec {
        // 引擎列表里唯一的「Codex」：原生 App Server 优先，起不来自动改走下面的
        // `codex`（ACP 桥）。id 兼容决策见 acp_chat_commands/launch.rs 文件头。
        id: "codex-app-server",
        label: "Codex",
        executable: "codex",
        args: &["app-server", "--listen", "stdio://"],
        requirement: "Logged-in Codex CLI",
        env: &[],
    },
    AcpEngineSpec {
        id: "claude",
        label: "Claude Code",
        executable: "npx",
        args: &["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
        requirement: "npm (npx) + logged-in Claude Code",
        env: &[],
    },
    AcpEngineSpec {
        id: "codex",
        label: "Codex (ACP)",
        executable: "npx",
        args: &["-y", "@agentclientprotocol/codex-acp@2.2.2"],
        requirement: "npm (npx) + logged-in Codex CLI",
        env: &[],
    },
    AcpEngineSpec {
        id: "grok",
        label: "Grok Build",
        executable: "grok",
        args: &["agent", "stdio"],
        requirement: "xAI Grok CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "gemini",
        label: "Gemini CLI",
        executable: "gemini",
        args: &["--acp"],
        requirement: "Google Gemini CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "qwen",
        label: "Qwen Code",
        executable: "qwen",
        args: &["--acp"],
        requirement: "Qwen Code CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "opencode",
        label: "OpenCode",
        executable: "opencode",
        args: &["acp"],
        requirement: "OpenCode CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "copilot",
        label: "GitHub Copilot",
        executable: "copilot",
        args: &["--acp", "--stdio"],
        requirement: "GitHub Copilot CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "cursor",
        label: "Cursor Agent",
        executable: "cursor-agent",
        args: &["acp"],
        requirement: "Cursor CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "kimi",
        label: "Kimi CLI",
        executable: "kimi",
        args: &["acp"],
        requirement: "Kimi CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "pi",
        label: "Pi",
        executable: "npx",
        args: &["-y", "pi-acp@0.0.33"],
        requirement: "npm (npx) + configured Pi",
        env: &[],
    },
    AcpEngineSpec {
        id: "jcode",
        label: "Jcode",
        executable: "jcode",
        args: &["acp"],
        requirement: "Jcode CLI (native ACP)",
        env: &[],
    },
    AcpEngineSpec {
        id: "kiro",
        label: "Kiro",
        executable: "kiro-cli",
        // V3 引擎才说 ACP；`--auth-method=cli` 让访问令牌留在 Kiro 自己手里（同 T3 Code）。
        args: &["acp", "--agent-engine=v3", "--auth-method=cli"],
        requirement: "Kiro CLI (curl -fsSL https://cli.kiro.dev/install | bash; kiro-cli login)",
        env: &[],
    },
    AcpEngineSpec {
        id: "fx",
        label: "fx",
        executable: "fx",
        args: &["acp"],
        requirement: "fx >= 0.0.13 (curl -fsSL https://fx.sh/setup.sh | bash; fx login)",
        env: &[],
    },
    AcpEngineSpec {
        id: "muse",
        label: "Muse Code",
        executable: "muse",
        args: &["acp"],
        requirement: "Meta Muse Code CLI (muse login)",
        // Muse 的 ACP 仍是实验开关（ACP 官方注册表条目同样注入它）。
        env: &[("MUSE_EXPERIMENTAL_ACP", "on")],
    },
    // `agy acp`：官方文档 antigravity.google/docs/cli/acp 的原生 ACP 服务端
    // （stdin/stdout JSON-RPC，复用交互 agy 的登录态，未登录时 `agy acp --login`）。
    AcpEngineSpec {
        id: "antigravity",
        label: "Antigravity",
        executable: "agy",
        args: &["acp"],
        requirement: "Antigravity CLI (native ACP, signed in)",
        env: &[],
    },
    AcpEngineSpec {
        id: "openclaw",
        label: "OpenClaw",
        executable: "openclaw",
        args: &["acp"],
        requirement: "OpenClaw CLI (native ACP)",
        env: &[],
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEngineInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub requirement: String,
    /// 可接收哪个 CLI 的运行配置（`codex` / `claude`）；缺失 = 此引擎不支持运行配置。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_profile_cli: Option<String>,
}

/// 内置引擎 id（ACP 注册表测试用它校验「内置别名」都指向真实引擎）。
#[cfg(test)]
pub(crate) fn built_in_engine_ids() -> impl Iterator<Item = &'static str> {
    ACP_ENGINES.iter().map(|engine| engine.id)
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
        fork_acp_session_id: None,
        auto_approve_kinds: Vec::new(),
        remote: None,
        env: engine.env.clone(),
        env_remove: Vec::new(),
        launch_profile_id: None,
        transport_fallback: None,
    })
}

/// 把本机启动描述改写成「在 SSH 机器上跑」：远端解析绝对 cwd，再用 ssh 包住引擎命令。
/// 远端会话不注入 MCP（本机 orchestrator 地址对方连不到）。
async fn remote_engine_launch(
    engine: &ResolvedEngine,
    machine: &cc_panes_core::models::ssh_machine::SshMachine,
    remote_os: Option<&str>,
    cwd: &str,
) -> AppResult<AcpLaunchSpec> {
    use crate::services::acp_remote as remote;
    let target = remote::remote_target(machine, remote_os)
        .map_err(|message| AppError::coded("ACP_REMOTE_UNSUPPORTED", message))?;
    let absolute_cwd = remote::resolve_remote_cwd(&target, cwd)
        .await
        .map_err(|message| AppError::coded("ACP_REMOTE_CWD_INVALID", message))?;
    // 引擎声明的 env（如 Muse 的 MUSE_EXPERIMENTAL_ACP）设在本机 ssh 进程上到不了远端，
    // POSIX 远端改用 `env K=V <exe> ...` 包一层；Windows 远端（cmd）暂不支持，原样启动。
    let (executable, args) = if engine.env.is_empty() || target.windows {
        (engine.executable.clone(), engine.args.clone())
    } else {
        let mut args: Vec<String> = engine
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        args.push(engine.executable.clone());
        args.extend(engine.args.iter().cloned());
        ("env".to_string(), args)
    };
    let script = remote::launch_script(&target, &absolute_cwd, &executable, &args);
    let mut args = target.ssh_args.clone();
    args.push(script);
    Ok(AcpLaunchSpec {
        engine_id: engine.id.clone(),
        command: "ssh".to_string(),
        args,
        cwd: absolute_cwd,
        mcp_servers: Vec::new(),
        resume_acp_session_id: None,
        fork_acp_session_id: None,
        auto_approve_kinds: Vec::new(),
        remote: Some(target),
        // 已在远端脚本里处理，本机 ssh 进程不需要。
        env: Vec::new(),
        env_remove: Vec::new(),
        launch_profile_id: None,
        transport_fallback: None,
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
            // `codex`（ACP 桥）并进「Codex」，不单独列出；按 id 启动仍然有效。
            .filter(|engine| !launch::is_hidden_engine(&engine.id))
            .map(|engine| AcpEngineInfo {
                available: resolve_executable(&engine.executable).is_ok(),
                launch_profile_cli: launch::launch_profile_cli(&engine.id)
                    .map(|cli| cli.as_id().to_string()),
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
#[allow(clippy::too_many_arguments)]
pub async fn start_acp_chat(
    app: AppHandle,
    service: State<'_, Arc<AcpChatService>>,
    app_paths: State<'_, Arc<AppPaths>>,
    machines: State<'_, Arc<cc_panes_core::services::SshMachineService>>,
    terminal_service: State<'_, Arc<cc_panes_core::services::TerminalService>>,
    settings: State<'_, Arc<cc_panes_core::services::SettingsService>>,
    chat_id: String,
    engine_id: String,
    cwd: String,
    resume_acp_session_id: Option<String>,
    auto_approve_kinds: Option<Vec<String>>,
    machine_id: Option<String>,
    remote_os: Option<String>,
    launch_profile_id: Option<String>,
) -> AppResult<AcpChatSnapshot> {
    let machine_id = machine_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let resume_meta = resume_acp_session_id
        .as_deref()
        .map(|id| service.chat_launch_meta(id))
        .unwrap_or_default();
    // 未显式传入时，续接沿用会话启动时的运行配置；空串 = 明确选「系统默认」。
    let profile_id = launch::effective_profile_id(
        launch_profile_id.as_deref(),
        resume_meta.launch_profile_id.as_deref(),
    );
    let overlay = match profile_id.as_deref() {
        None => None,
        Some(_) if machine_id.is_some() => {
            // 远程会话不支持运行配置：登录账号目录在本机、密钥只该进本机子进程环境，
            // 经 ssh 的 `env K=V` 包装会把密钥摆在对方机器的进程参数里。
            return Err(AppError::coded(
                "ACP_PROFILE_REMOTE_UNSUPPORTED",
                "Launch profiles are not supported for remote Agent Chat sessions",
            ));
        }
        Some(id) => {
            let cli = launch::launch_profile_cli(&engine_id).ok_or_else(|| {
                AppError::coded(
                    "ACP_PROFILE_UNSUPPORTED",
                    format!("Engine '{engine_id}' does not support launch profiles"),
                )
            })?;
            let terminal_service = terminal_service.inner().clone();
            let id = id.to_string();
            Some(
                tauri::async_runtime::spawn_blocking(move || {
                    terminal_service.build_agent_chat_launch_overlay(cli, &id)
                })
                .await
                .map_err(|error| AppError::from(error.to_string()))??,
            )
        }
    };
    let request = StartRequest {
        chat_id,
        cwd,
        machine_id,
        remote_os,
        resume_acp_session_id,
        auto_approve_kinds: auto_approve_kinds.unwrap_or_default(),
        overlay,
    };
    let snapshot = if engine_id == launch::CODEX_ENGINE {
        let route = launch::RouteInput {
            resume_engine: request
                .resume_acp_session_id
                .as_ref()
                .and(resume_meta.engine_id.as_deref()),
            force_acp: settings.get_settings().agent_chat.codex_force_acp,
            remote: request.machine_id.is_some(),
            known_unsupported: false,
        };
        start_codex(&app, &service, &app_paths, &machines, request, route).await?
    } else {
        let engine = engine_spec(&app_paths, &engine_id)?;
        start_engine(
            &app, &service, &app_paths, &machines, &request, engine, None,
        )
        .await?
    };
    if let Some(session_id) = snapshot.acp_session_id.as_deref() {
        service.note_launch_profile(session_id, snapshot.launch_profile_id.as_deref());
    }
    Ok(snapshot)
}

/// 一次 Agent Chat 启动的引擎无关部分（传输路由时可能用两个引擎各试一次）。
struct StartRequest {
    chat_id: String,
    cwd: String,
    machine_id: Option<String>,
    remote_os: Option<String>,
    resume_acp_session_id: Option<String>,
    auto_approve_kinds: Vec<String>,
    overlay: Option<cc_panes_core::services::AgentChatLaunchOverlay>,
}

/// 「Codex」：原生 App Server 优先，起不来自动改走 ACP 桥（见 launch.rs 文件头）。
async fn start_codex(
    app: &AppHandle,
    service: &Arc<AcpChatService>,
    app_paths: &AppPaths,
    machines: &cc_panes_core::services::SshMachineService,
    request: StartRequest,
    mut route: launch::RouteInput<'_>,
) -> AppResult<AcpChatSnapshot> {
    let native = engine_spec(app_paths, launch::CODEX_ENGINE)?;
    let identity = if route.remote {
        None
    } else {
        let executable = native.executable.clone();
        tauri::async_runtime::spawn_blocking(move || {
            resolve_executable(&executable)
                .ok()
                .and_then(|path| launch::binary_identity(&path))
        })
        .await
        .map_err(|error| AppError::from(error.to_string()))?
    };
    route.known_unsupported = launch::known_unsupported(identity.as_ref());
    let fallback = match launch::plan_codex_route(route) {
        launch::CodexRoute::Acp(reason) => reason,
        launch::CodexRoute::Native => {
            match start_engine(app, service, app_paths, machines, &request, native, None).await {
                Ok(snapshot) => {
                    launch::remember_outcome(identity.as_ref(), None);
                    return Ok(snapshot);
                }
                Err(error) if launch::is_app_server_unavailable(&error) => {
                    tracing::warn!(error = %error, "Codex App Server unavailable; falling back to ACP compatibility mode");
                    launch::remember_outcome(identity.as_ref(), Some(&error));
                    Some(launch::FallbackReason::StartFailed)
                }
                Err(error) => return Err(error),
            }
        }
    };
    let acp = engine_spec(app_paths, launch::CODEX_ACP_ENGINE)?;
    start_engine(
        app,
        service,
        app_paths,
        machines,
        &request,
        acp,
        fallback.map(launch::FallbackReason::as_str),
    )
    .await
}

async fn start_engine(
    app: &AppHandle,
    service: &Arc<AcpChatService>,
    app_paths: &AppPaths,
    machines: &cc_panes_core::services::SshMachineService,
    request: &StartRequest,
    mut engine: ResolvedEngine,
    transport_fallback: Option<&str>,
) -> AppResult<AcpChatSnapshot> {
    let env_remove = request
        .overlay
        .as_ref()
        .map(|overlay| launch::apply_overlay(&mut engine, overlay))
        .unwrap_or_default();
    let mut spec = match request.machine_id.as_deref() {
        Some(machine_id) => {
            let machine = machines.get(machine_id).ok_or_else(|| {
                AppError::coded(
                    "ACP_REMOTE_UNSUPPORTED",
                    format!("SSH machine '{machine_id}' not found"),
                )
            })?;
            remote_engine_launch(
                &engine,
                &machine,
                request.remote_os.as_deref(),
                &request.cwd,
            )
            .await?
        }
        None => {
            let mcp_servers = ccpanes_mcp_servers(app_paths);
            let mut spec = tauri::async_runtime::spawn_blocking({
                let cwd = request.cwd.clone();
                move || resolve_engine_launch(&engine, &cwd)
            })
            .await
            .map_err(|error| AppError::from(error.to_string()))??;
            spec.mcp_servers = mcp_servers;
            spec
        }
    };
    spec.resume_acp_session_id = request.resume_acp_session_id.clone();
    // 交互式 chat 的按类自动放行（用户在权限下拉里勾选；与 Automations 同一条
    // 会话级通道，命中的权限请求不再弹卡）。
    spec.auto_approve_kinds = request.auto_approve_kinds.clone();
    spec.env_remove = env_remove;
    spec.launch_profile_id = request
        .overlay
        .as_ref()
        .map(|overlay| overlay.profile_id.clone());
    spec.transport_fallback = transport_fallback.map(str::to_string);
    service
        .start(app.clone(), request.chat_id.clone(), spec)
        .await
}

#[tauri::command]
pub async fn rename_acp_chat_history(
    service: State<'_, Arc<AcpChatService>>,
    acp_session_id: String,
    title: String,
) -> AppResult<()> {
    service.rename_chat_history(&acp_session_id, &title)
}

#[tauri::command]
pub async fn delete_acp_chat_history(
    service: State<'_, Arc<AcpChatService>>,
    acp_session_id: String,
) -> AppResult<()> {
    service.delete_chat_history(&acp_session_id)
}

/// 保存会话的渲染层转写（非 loadSession 引擎续接时的只读兜底，docs/94 §8）。
#[tauri::command]
pub async fn save_acp_chat_transcript(
    service: State<'_, Arc<AcpChatService>>,
    acp_session_id: String,
    items: Vec<Value>,
    inherited: Option<Vec<Value>>,
    engines: Option<Vec<String>>,
) -> AppResult<()> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // inherited / engines 只在换引擎交接时传（替换继承段 + 记录引擎序列）。
        service.save_chat_transcript_with(&acp_session_id, items, inherited, engines)
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
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

/// `session/set_config_option`：`value` 原样透传（select 类是字符串，其他类型由
/// agent 在 `configOptions` 里声明）。
#[tauri::command]
pub async fn set_acp_chat_config_option(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    config_id: String,
    value: serde_json::Value,
) -> AppResult<()> {
    service.set_config_option(&chat_id, config_id, value).await
}

#[tauri::command]
pub async fn set_acp_chat_auto_approve(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    kinds: Vec<String>,
) -> AppResult<()> {
    service.set_auto_approve(&chat_id, kinds).await
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
pub async fn respond_acp_elicitation(
    service: State<'_, Arc<AcpChatService>>,
    chat_id: String,
    request_key: String,
    response: serde_json::Value,
) -> AppResult<()> {
    service
        .respond_elicitation(&chat_id, request_key, response)
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

/// Fork uses a new adapter and session/fork. Loading the parent's ID would let
/// both tabs append to the same conversation, so there is no resume fallback.
#[tauri::command]
pub async fn fork_acp_chat(
    app: AppHandle,
    service: State<'_, Arc<AcpChatService>>,
    app_paths: State<'_, Arc<AppPaths>>,
    terminal_service: State<'_, Arc<cc_panes_core::services::TerminalService>>,
    source_chat_id: String,
    chat_id: String,
    cwd: String,
) -> AppResult<AcpChatSnapshot> {
    if source_chat_id == chat_id || service.snapshot(&chat_id).await.is_some() {
        return Err(AppError::coded(
            "ACP_FORK_TARGET_EXISTS",
            "Fork requires a new chat ID",
        ));
    }
    let source = service
        .snapshot(&source_chat_id)
        .await
        .ok_or_else(|| AppError::from("Source chat is unavailable"))?;
    if !matches!(source.phase, crate::services::AcpChatPhase::Ready) {
        return Err(AppError::from(
            "Wait for the source chat to finish its turn before forking",
        ));
    }
    let session_id = source
        .acp_session_id
        .ok_or_else(|| AppError::from("Source conversation has no session ID"))?;
    let mut engine = engine_spec(&app_paths, &source.engine_id)?;
    // 分叉沿用源会话的运行配置（同一个供应商 / 账号才找得到被分叉的线程）。
    let profile_id = source.launch_profile_id.clone();
    let cli = launch::launch_profile_cli(&source.engine_id);
    let terminal_service = terminal_service.inner().clone();
    let (mut spec, env_remove) = tauri::async_runtime::spawn_blocking(move || {
        let env_remove = match (profile_id.as_deref(), cli) {
            (Some(id), Some(cli)) => {
                let overlay = terminal_service.build_agent_chat_launch_overlay(cli, id)?;
                launch::apply_overlay(&mut engine, &overlay)
            }
            _ => Vec::new(),
        };
        resolve_engine_launch(&engine, &cwd).map(|spec| (spec, env_remove))
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))??;
    spec.env_remove = env_remove;
    spec.launch_profile_id = source.launch_profile_id.clone();
    spec.mcp_servers = ccpanes_mcp_servers(&app_paths);
    spec.fork_acp_session_id = Some(session_id);
    spec.auto_approve_kinds = source.auto_approve_kinds;
    service.start(app, chat_id, spec).await
}
