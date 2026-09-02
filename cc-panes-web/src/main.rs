mod routes;
mod state;
mod web_auth;
mod ws_emitter;
mod ws_handler;

use std::{net::SocketAddr, path::PathBuf, process::Command, sync::Arc};

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::{
    events::NoopNotifier,
    repository::{
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SessionIndexRepository,
        SpecRepository, TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        registry_from_providers, ComfyEventStream, DaemonTerminalBackend, FileSystemService,
        HistoryService, InProcessTerminalBackend, JournalService, LaunchHistoryService,
        LaunchProfileService, LayoutSnapshotService, McpConfigService, MediaJobWorker,
        MemoryService, PlanService, ProcessMonitorService, ProjectCliHooksService, ProjectService,
        ProviderService, QuickCommandService, RunnerService, SessionIndexService,
        SessionRestoreService, SettingsService, SharedMcpService, SkillService, SpecService,
        SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend,
        TerminalDaemonClient, TerminalService, TodoService, UsageStatsService, UserSkillService,
        WorkspaceService, WorktreeService,
    },
    utils::{simplify_path, AppPaths, APP_DIR_NAME},
};
use clap::Parser;
use tracing::{info, warn};

use crate::state::{AppState, TerminalOutputMode};
use crate::ws_emitter::WsEmitter;

#[derive(Parser, Debug)]
#[command(name = "cc-panes-web", about = "CC-Panes Web terminal server")]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Host address to bind. Defaults to 127.0.0.1 unless LAN access is enabled in settings.
    #[arg(long)]
    host: Option<String>,

    /// Default working directory for new terminal sessions
    #[arg(long, default_value = ".")]
    cwd: String,

    /// Default shell (auto-detect if not specified)
    #[arg(long)]
    shell: Option<String>,

    /// Data directory for cc-panes config/db. Defaults to the desktop dev/release data dir.
    #[arg(long)]
    data_dir: Option<String>,

    /// Connect terminal operations to an existing cc-panes-daemon manifest.
    #[arg(long, env = "CCPANES_TERMINAL_DAEMON_MANIFEST")]
    daemon_manifest: Option<String>,
}

struct WebPathResolution {
    default_data_dir: Option<String>,
    config_path: Option<PathBuf>,
    source: &'static str,
}

#[cfg(not(windows))]
fn bind_non_inheritable_listener(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let listener = std::net::TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(listener)
}

#[cfg(windows)]
fn bind_non_inheritable_listener(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};

    // Socket::new uses WSASocketW with OVERLAPPED and NO_HANDLE_INHERIT on Windows.
    let socket = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    socket.bind(&addr.into())?;
    socket.listen(128)?;
    socket.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(socket.into())
}

fn resolve_web_paths(explicit_data_dir: Option<&str>) -> WebPathResolution {
    if let Some(dir) = non_empty_path(explicit_data_dir) {
        let path = normalize_current_host_path(dir);
        let config_path = path.join("config.toml");
        return WebPathResolution {
            default_data_dir: Some(path.to_string_lossy().to_string()),
            config_path: Some(config_path),
            source: "cli",
        };
    }

    if let Some(dir) = non_empty_path(std::env::var("CCPANES_WEB_DATA_DIR").ok().as_deref()) {
        let path = normalize_current_host_path(dir);
        let config_path = path.join("config.toml");
        return WebPathResolution {
            default_data_dir: Some(path.to_string_lossy().to_string()),
            config_path: Some(config_path),
            source: "env",
        };
    }

    if let Some(path) = detect_windows_desktop_app_dir() {
        return WebPathResolution {
            config_path: Some(path.join("config.toml")),
            default_data_dir: Some(path.to_string_lossy().to_string()),
            source: "windows-desktop",
        };
    }

    WebPathResolution {
        default_data_dir: None,
        config_path: None,
        source: "app-default",
    }
}

fn resolve_data_dir(
    explicit_data_dir: Option<&str>,
    settings_data_dir: Option<String>,
    web_paths: &WebPathResolution,
) -> Option<String> {
    if let Some(dir) = non_empty_path(explicit_data_dir) {
        return Some(
            normalize_current_host_path(dir)
                .to_string_lossy()
                .to_string(),
        );
    }
    if let Some(dir) = non_empty_path(settings_data_dir.as_deref()) {
        return Some(
            normalize_current_host_path(dir)
                .to_string_lossy()
                .to_string(),
        );
    }
    web_paths.default_data_dir.clone()
}

fn non_empty_path(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_current_host_path(path: &str) -> PathBuf {
    // Only translate a Windows-style path (C:\...) into a WSL mount path
    // (/mnt/c/...) when we are actually running inside WSL. On native Windows
    // the incoming path is already correct and must be preserved verbatim —
    // converting it to /mnt/c/... would point at a non-existent location.
    if running_under_wsl() {
        if let Some(wsl_path) = windows_path_to_wsl_path(path) {
            return wsl_path;
        }
    }
    PathBuf::from(path)
}

fn detect_windows_desktop_app_dir() -> Option<PathBuf> {
    if !running_under_wsl() {
        return None;
    }

    let mut candidates = Vec::new();
    if let Some(profile) = windows_user_profile_from_cmd() {
        if let Some(path) = windows_path_to_wsl_path(&profile) {
            candidates.push(path.join(APP_DIR_NAME));
        }
    }
    if let Ok(user) = std::env::var("USER") {
        candidates.push(PathBuf::from("/mnt/c/Users").join(user).join(APP_DIR_NAME));
    }

    candidates
        .into_iter()
        .find(|path| path.join("workspaces").exists() || path.join("config.toml").exists())
}

fn running_under_wsl() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let release = release.to_ascii_lowercase();
            release.contains("microsoft") || release.contains("wsl")
        })
        .unwrap_or(false)
}

fn windows_user_profile_from_cmd() -> Option<String> {
    let output = Command::new("cmd.exe")
        .args(["/C", "echo %USERPROFILE%"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let profile = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!profile.is_empty() && !profile.contains('%')).then_some(profile)
}

fn windows_path_to_wsl_path(path: &str) -> Option<PathBuf> {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    let rest = normalized[2..].trim_start_matches('/');
    Some(PathBuf::from(format!("/mnt/{drive}/{rest}")))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cc_panes_web=info,cc_panes_core=info".into()),
        )
        .init();

    let args = Args::parse();

    // Resolve cwd to absolute path；剥掉 Windows `\\?\` verbatim 前缀：该值会作为
    // default_cwd 回落给缺少 project_path 的会话（routes/terminal.rs），带前缀会让
    // cmd.exe 把 CLI 启到 C:\Windows。详见 docs/35-unc-path-contamination.md。
    let cwd = simplify_path(
        std::fs::canonicalize(&args.cwd).unwrap_or_else(|_| std::path::PathBuf::from(&args.cwd)),
    );
    let cwd_str = cwd.to_string_lossy().to_string();

    let web_paths = resolve_web_paths(args.data_dir.as_deref());
    let settings_service = Arc::new(match &web_paths.config_path {
        Some(path) => SettingsService::new_with_config_path(path.clone()),
        None => SettingsService::new(),
    });
    let loaded_settings = settings_service.get_settings();
    let settings_data_dir = loaded_settings.general.data_dir.clone();
    let data_dir = resolve_data_dir(args.data_dir.as_deref(), settings_data_dir, &web_paths);
    let app_paths = Arc::new(AppPaths::new(data_dir));
    info!(
        data_dir = %app_paths.data_dir().display(),
        source = web_paths.source,
        "CC-Panes Web data directory resolved"
    );
    let database = Arc::new(
        Database::new(app_paths.database_path())
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
    );
    let project_repo = Arc::new(ProjectRepository::new(database.clone()));
    let todo_repo = Arc::new(TodoRepository::new(database.clone()));
    let spec_repo = Arc::new(SpecRepository::new(database.clone()));
    let task_binding_repo = Arc::new(TaskBindingRepository::new(database.clone()));
    let history_repo = Arc::new(HistoryRepository::new(database.clone()));
    let runner_repo = Arc::new(RunnerRepository::new(database.clone()));
    let usage_stats_repo = Arc::new(UsageStatsRepository::new(database.clone()));
    let session_index_repo = Arc::new(SessionIndexRepository::new(database.clone()));
    let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
    let project_service = Arc::new(ProjectService::new(project_repo));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let spec_service = Arc::new(SpecService::new(spec_repo, todo_service.clone()));
    let task_binding_service = Arc::new(TaskBindingService::new(task_binding_repo));
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let media_service = Arc::new(cc_panes_core::services::MediaService::with_media_root(
        Arc::new(cc_panes_core::repository::MediaRepository::new(
            database.clone(),
        )),
        app_paths.media_dir(),
    ));
    media_service.set_workspace_service(workspace_service.clone());
    let layout_snapshot_service = Arc::new(LayoutSnapshotService::new(database.clone()));
    let session_restore_service = Arc::new(SessionRestoreService::new(
        database.clone(),
        app_paths.clone(),
    ));
    let history_service = Arc::new(HistoryService::new());
    history_service.set_protected_roots(vec![app_paths.data_dir().to_path_buf()]);
    let worktree_service = Arc::new(WorktreeService::new());
    let process_monitor_service = Arc::new(ProcessMonitorService::new());
    let runner_service = Arc::new(RunnerService::new(
        runner_repo,
        process_monitor_service.clone(),
    ));
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let filesystem_service = Arc::new(FileSystemService::new());
    let mcp_config_service = Arc::new(McpConfigService::with_paths(app_paths.clone()));
    let shared_mcp_service = Arc::new(SharedMcpService::new(&app_paths));
    let skill_service = Arc::new(SkillService::new());
    let plan_service = Arc::new(PlanService::new());
    let cli_registry = Arc::new(CliToolRegistry::with_builtin_adapters());
    let project_cli_hooks_service = Arc::new(ProjectCliHooksService::new(cli_registry.clone()));
    let journal_service = Arc::new(JournalService::new(app_paths.workspaces_dir()));
    let ssh_credential_service = Arc::new(SshCredentialService::new());
    let ssh_machine_service = Arc::new(SshMachineService::new(
        app_paths.data_dir().join("ssh-machines.json"),
        ssh_credential_service.clone(),
    ));
    let external_skill_registry = Arc::new(cc_panes_core::services::ExternalSkillRegistry::new(
        cli_registry.clone(),
    ));
    let launch_profile_service = Arc::new(LaunchProfileService::new_with_external_skill_registry(
        app_paths.launch_profiles_path(),
        external_skill_registry.clone(),
    ));
    let quick_command_service = Arc::new(QuickCommandService::new(app_paths.quick_commands_path()));
    let memory_service = Arc::new(
        MemoryService::new(app_paths.data_dir().join("memory.db")).unwrap_or_else(|error| {
            tracing::error!(
                "MemoryService init failed: {}, using in-memory fallback",
                error
            );
            MemoryService::new_memory().expect("MemoryService fallback failed")
        }),
    );
    let user_skill_service = Arc::new(UserSkillService::new(app_paths.user_skills_dir()));
    let usage_stats_service = Arc::new(UsageStatsService::new_with_provider_and_settings(
        usage_stats_repo,
        launch_history_service.clone(),
        provider_service.clone(),
        settings_service.clone(),
    ));
    usage_stats_service.start_background_tasks();
    let session_index_service = Arc::new(SessionIndexService::new_with_settings(
        session_index_repo,
        launch_history_service.clone(),
        workspace_service.clone(),
        settings_service.clone(),
    ));
    session_index_service.start_background_tasks();

    let ws_emitter = Arc::new(WsEmitter::new());
    let backend_config = BackendConfig {
        app_paths: app_paths.clone(),
        settings_service: settings_service.clone(),
        provider_service: provider_service.clone(),
        spec_service: spec_service.clone(),
        workspace_service: workspace_service.clone(),
        shared_mcp_service: shared_mcp_service.clone(),
        launch_profile_service: launch_profile_service.clone(),
        ssh_credential_service,
        cli_registry: cli_registry.clone(),
        daemon_manifest: args.daemon_manifest,
    };
    let backend_state = create_terminal_backend(backend_config, ws_emitter.clone())?;

    // 留一份 backend 句柄给优雅关闭路径：收到 Ctrl-C / SIGTERM 时先把本进程持有的
    // PTY 子进程收干净，再退出。这是**协作式快路径**；父进程（CC-Panes）另有
    // OS 级 job/进程组兜底（src-tauri/src/services/process_guard.rs），
    // 覆盖本进程来不及响应信号的异常路径。两者是互补而非重复。
    let shutdown_backend = backend_state.backend.clone();

    let media_worker_service = media_service.clone();
    let (media_worker_registry, skipped_media_providers) =
        registry_from_providers(provider_service.list_providers());
    for diagnostic in skipped_media_providers {
        warn!(diagnostic, "[media] provider was not registered");
    }

    // Keep a handle for the media event stream after the state struct moves
    // its own clone into the router.
    let media_event_emitter = ws_emitter.clone();
    let state = AppState {
        terminal_backend: backend_state.backend,
        workspace_service,
        project_service,
        provider_service: provider_service.clone(),
        settings_service,
        filesystem_service,
        todo_service,
        spec_service,
        task_binding_service,
        launch_history_service,
        media_service,
        layout_snapshot_service,
        launch_profile_service,
        quick_command_service,
        memory_service,
        ssh_machine_service,
        session_restore_service,
        history_service,
        worktree_service,
        runner_service,
        process_monitor_service,
        project_cli_hooks_service,
        journal_service,
        cli_registry,
        mcp_config_service,
        shared_mcp_service,
        skill_service,
        plan_service,
        external_skill_registry,
        user_skill_service,
        usage_stats_service,
        session_index_service,
        ws_emitter: ws_emitter.clone(),
        web_auth: Arc::new(web_auth::WebAuthStore::default()),
        default_cwd: cwd_str.clone(),
        output_mode: backend_state.output_mode,
    };

    let app = routes::build_router(state);

    // Keep media execution alive independently of HTTP request handling. The
    // Canvas polls the same durable run records, so a browser reconnect does
    // not lose a queued or in-flight generation.
    let media_event_service = media_worker_service.clone();
    let media_worker = Arc::new(
        MediaJobWorker::new(
            media_worker_service,
            media_worker_registry,
            format!("web-{}", std::process::id()),
        )
        .with_provider_service(provider_service.clone()),
    );
    let media_event_emitter = media_event_emitter.clone();
    tokio::spawn(async move {
        let mut poll_ticker = tokio::time::interval(std::time::Duration::from_secs(2));
        let mut event_ticker = tokio::time::interval(std::time::Duration::from_millis(100));
        let mut comfy_streams: std::collections::HashMap<String, ComfyEventStream> =
            std::collections::HashMap::new();
        loop {
            tokio::select! {
                _ = event_ticker.tick() => {
                    for (provider_id, adapter) in media_worker.comfy_adapters() {
                        if !comfy_streams.contains_key(&provider_id) {
                            match tokio::time::timeout(
                                std::time::Duration::from_millis(500),
                                adapter.connect_events(),
                            )
                            .await
                            {
                                Ok(Ok(stream)) => {
                                    comfy_streams.insert(provider_id.clone(), stream);
                                }
                                Ok(Err(error)) => {
                                    warn!(provider_id, error = %error, "[media] ComfyUI websocket unavailable; history polling remains active");
                                }
                                Err(_) => {}
                            }
                        }
                        let Some(stream) = comfy_streams.get_mut(&provider_id) else {
                            continue;
                        };
                        match tokio::time::timeout(
                            std::time::Duration::from_millis(20),
                            stream.next_event(),
                        )
                        .await
                        {
                            Ok(Ok(Some(event))) => {
                                match media_worker.apply_comfy_event(&provider_id, &event) {
                                    Ok(Some(run)) => {
                                        let workspace_id = media_event_service
                                            .get_node(&run.node_id)
                                            .ok()
                                            .flatten()
                                            .map(|node| node.workspace_id);
                                        media_event_emitter.publish_media_job_changed(serde_json::json!({
                                            "type": "media-job-changed",
                                            "workspaceId": workspace_id,
                                            "runId": run.id.clone(),
                                            "nodeId": run.node_id.clone(),
                                            "status": run.status,
                                            "progress": run.progress,
                                            "assetIds": run.output_asset_ids.clone(),
                                            "errorCode": run.error_code.clone(),
                                            "errorMessage": run.error_message.clone(),
                                        }));
                                    }
                                    Ok(None) => {}
                                    Err(error) => warn!(provider_id, error = %error, "[media] failed to apply ComfyUI event"),
                                }
                            }
                            Ok(Ok(None)) | Ok(Err(_)) => {
                                comfy_streams.remove(&provider_id);
                            }
                            Err(_) => {}
                        }
                    }
                }
                _ = poll_ticker.tick() => {
                    match media_worker.run_batch().await {
                        Ok(runs) => {
                            for run in runs {
                            let workspace_id = media_event_service
                                .get_node(&run.node_id)
                                .ok()
                                .flatten()
                                .map(|node| node.workspace_id);
                            media_event_emitter.publish_media_job_changed(serde_json::json!({
                                "type": "media-job-changed",
                                "workspaceId": workspace_id,
                                "runId": run.id.clone(),
                                "nodeId": run.node_id.clone(),
                                "status": run.status,
                                "progress": run.progress,
                                "assetIds": run.output_asset_ids.clone(),
                                "errorCode": run.error_code.clone(),
                                "errorMessage": run.error_message.clone(),
                            }));
                            info!(
                                run_id = %run.id,
                                status = %run.status,
                                "[media] worker completed an iteration"
                            );
                            }
                        }
                        Err(error) => warn!(error = %error, "[media] worker iteration failed"),
                    }
                }
            }
        }
    });

    let host = resolve_bind_host(args.host, &loaded_settings.web_access)?;
    let addr: SocketAddr = format!("{host}:{}", args.port).parse()?;
    info!(addr = %addr, cwd = cwd_str, "CC-Panes Web starting");

    let listener = bind_non_inheritable_listener(addr)?;
    info!("Listening on http://{}", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    // 协作式清理：把本进程派生的 PTY 全部收掉，否则它们会比 server 活得久
    // ——远程终端里的 CLI 会变成孤儿，端口与工作目录都不释放。
    //
    // 走 trait 的 get_all_status + kill 而不是具体类型的 cleanup_all()：
    // `AppState.terminal_backend` 是 `Arc<dyn TerminalBackend>`，而 `cleanup_all`
    // 只存在于 TerminalService 上。**daemon 模式下这一点尤其重要**——那时后端是
    // 远端 daemon 的代理，本进程地址空间里根本没有 TerminalService
    // （CLAUDE.md 记着这条：daemon 模式下 app 侧 sessions 恒为空）。
    // 按 trait 逐个 kill 才能在两种后端下都成立。
    info!("CC-Panes Web shutting down; cleaning up terminal sessions");
    match shutdown_backend.get_all_status() {
        Ok(sessions) => {
            for session in sessions {
                if let Err(error) = shutdown_backend.kill(&session.session_id) {
                    tracing::warn!(
                        session_id = %session.session_id,
                        %error,
                        "failed to clean up terminal session on shutdown"
                    );
                }
            }
        }
        Err(error) => {
            tracing::warn!(%error, "failed to enumerate sessions for shutdown cleanup");
        }
    }
    Ok(())
}

/// 收到 Ctrl-C（全平台）或 SIGTERM（Unix）时 resolve。
///
/// Windows 上父进程走的是 `TerminateJobObject`（Win32 没有跨进程的优雅退出原语），
/// 本函数那条路径不会被触发——那里靠父进程的 Job 兜底。这里主要覆盖 Unix
/// 以及用户手动 Ctrl-C 的场景。
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install Ctrl-C handler");
            // 装不上处理器时不能立即返回：那等于"启动即关闭"。
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// 决定监听地址。安全约束：非回环绑定必须已启用认证并配置密码——
/// 无论来自设置（allow_lan）还是显式 `--host`，后者此前可绕过校验（硬失败而非静默回退，
/// 避免"以为暴露成功/实际没暴露"的认知错位）。
fn resolve_bind_host(
    explicit: Option<String>,
    web_access: &cc_panes_core::models::settings::WebAccessSettings,
) -> anyhow::Result<String> {
    let is_loopback = |host: &str| matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost");
    match explicit {
        None => {
            if web_access.allow_lan && web_access.auth_required() {
                Ok("0.0.0.0".to_string())
            } else {
                Ok("127.0.0.1".to_string())
            }
        }
        Some(host) if is_loopback(host.trim()) => Ok(host),
        Some(host) => {
            if web_access.auth_required() {
                Ok(host)
            } else {
                anyhow::bail!(
                    "refusing to bind non-loopback host '{host}': web password is not configured. \
                     Enable authentication and set a password in desktop settings, or remove --host."
                )
            }
        }
    }
}

struct BackendConfig {
    app_paths: Arc<AppPaths>,
    settings_service: Arc<SettingsService>,
    provider_service: Arc<ProviderService>,
    spec_service: Arc<SpecService>,
    workspace_service: Arc<WorkspaceService>,
    shared_mcp_service: Arc<SharedMcpService>,
    launch_profile_service: Arc<LaunchProfileService>,
    ssh_credential_service: Arc<SshCredentialService>,
    cli_registry: Arc<CliToolRegistry>,
    daemon_manifest: Option<String>,
}

struct BackendState {
    backend: Arc<dyn TerminalBackend>,
    output_mode: TerminalOutputMode,
}

fn create_terminal_backend(
    config: BackendConfig,
    ws_emitter: Arc<WsEmitter>,
) -> anyhow::Result<BackendState> {
    if let Some(manifest_path) = config.daemon_manifest {
        let client = TerminalDaemonClient::from_manifest_path(&manifest_path)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        client
            .health()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        client
            .status()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        info!(
            manifest = manifest_path,
            "using cc-panes daemon terminal backend"
        );
        return Ok(BackendState {
            backend: Arc::new(DaemonTerminalBackend::new(client)),
            output_mode: TerminalOutputMode::Polling,
        });
    }

    let terminal_service = create_in_process_terminal_service(config, ws_emitter);
    Ok(BackendState {
        backend: Arc::new(InProcessTerminalBackend::new(terminal_service)),
        output_mode: TerminalOutputMode::Emitter,
    })
}

fn create_in_process_terminal_service(
    config: BackendConfig,
    ws_emitter: Arc<WsEmitter>,
) -> Arc<TerminalService> {
    let project_cli_hooks_service =
        Arc::new(ProjectCliHooksService::new(config.cli_registry.clone()));

    let terminal_service = Arc::new(TerminalService::new(
        config.settings_service,
        config.provider_service,
        config.app_paths,
        config.cli_registry,
        project_cli_hooks_service,
        config.ssh_credential_service,
    ));
    terminal_service.set_spec_service(config.spec_service);
    terminal_service.set_workspace_service(config.workspace_service);
    terminal_service.set_shared_mcp_service(config.shared_mcp_service);
    terminal_service.set_launch_profile_service(config.launch_profile_service);
    terminal_service.set_emitter(ws_emitter);
    terminal_service.set_notifier(Arc::new(NoopNotifier));
    terminal_service
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_dir(name: &str) -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_millis();
        let path = std::env::temp_dir().join(format!("cc-panes-web-{name}-{millis}"));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path.to_string_lossy().to_string()
    }

    fn test_backend_config(name: &str, daemon_manifest: Option<String>) -> BackendConfig {
        let root = test_dir(name);
        let app_paths = Arc::new(AppPaths::new(Some(root.clone())));
        let cli_registry = Arc::new(CliToolRegistry::new());
        let external_skill_registry = Arc::new(
            cc_panes_core::services::ExternalSkillRegistry::new(cli_registry.clone()),
        );
        let db = Arc::new(Database::new_fallback().expect("db"));
        let todo_service = Arc::new(TodoService::new(Arc::new(TodoRepository::new(db.clone()))));
        BackendConfig {
            app_paths: app_paths.clone(),
            settings_service: Arc::new(SettingsService::new()),
            provider_service: Arc::new(ProviderService::new(
                std::path::Path::new(&root).join("providers.json"),
            )),
            spec_service: Arc::new(SpecService::new(
                Arc::new(SpecRepository::new(db)),
                todo_service,
            )),
            workspace_service: Arc::new(WorkspaceService::new(app_paths.workspaces_dir())),
            shared_mcp_service: Arc::new(SharedMcpService::new(&app_paths)),
            launch_profile_service: Arc::new(
                LaunchProfileService::new_with_external_skill_registry(
                    app_paths.launch_profiles_path(),
                    external_skill_registry,
                ),
            ),
            ssh_credential_service: Arc::new(SshCredentialService::new_memory()),
            cli_registry,
            daemon_manifest,
        }
    }

    fn web_access_with_password(
        allow_lan: bool,
    ) -> cc_panes_core::models::settings::WebAccessSettings {
        let mut settings = cc_panes_core::models::settings::WebAccessSettings {
            allow_lan,
            auth_enabled: true,
            ..Default::default()
        };
        settings
            .set_password("test-password")
            .expect("set password");
        settings
    }

    #[test]
    fn resolve_bind_host_defaults_follow_settings() {
        let no_auth = cc_panes_core::models::settings::WebAccessSettings::default();
        assert_eq!(
            resolve_bind_host(None, &no_auth).expect("resolve"),
            "127.0.0.1"
        );
        assert_eq!(
            resolve_bind_host(None, &web_access_with_password(true)).expect("resolve"),
            "0.0.0.0"
        );
    }

    #[test]
    fn resolve_bind_host_allows_explicit_loopback_without_auth() {
        let no_auth = cc_panes_core::models::settings::WebAccessSettings::default();
        assert_eq!(
            resolve_bind_host(Some("127.0.0.1".to_string()), &no_auth).expect("resolve"),
            "127.0.0.1"
        );
    }

    #[test]
    fn resolve_bind_host_rejects_explicit_non_loopback_without_auth() {
        let no_auth = cc_panes_core::models::settings::WebAccessSettings::default();
        let error = resolve_bind_host(Some("0.0.0.0".to_string()), &no_auth)
            .expect_err("must refuse non-loopback bind without password");
        assert!(error.to_string().contains("web password is not configured"));
    }

    #[test]
    fn resolve_bind_host_allows_explicit_non_loopback_with_auth() {
        assert_eq!(
            resolve_bind_host(
                Some("0.0.0.0".to_string()),
                &web_access_with_password(false)
            )
            .expect("resolve"),
            "0.0.0.0"
        );
    }

    #[test]
    fn explicit_data_dir_owns_config_path_even_when_missing() {
        let root = test_dir("explicit-data-dir");
        let paths = resolve_web_paths(Some(&root));
        let root_path = PathBuf::from(&root);

        assert_eq!(paths.default_data_dir, Some(root));
        assert_eq!(paths.config_path, Some(root_path.join("config.toml")));
        assert_eq!(paths.source, "cli");
    }

    fn json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn spawn_daemon_probe_server() -> (SocketAddr, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let responses = [
                json_response("200 OK", r#"{"status":"ok"}"#),
                json_response(
                    "200 OK",
                    r#"{"status":"ok","version":"0.1.0","pid":7,"addr":"127.0.0.1:1","startedAt":10,"sessionCount":0}"#,
                ),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept client");
                let mut request_bytes = Vec::new();
                let mut chunk = [0_u8; 1024];
                loop {
                    let n = stream.read(&mut chunk).expect("read request");
                    if n == 0 {
                        break;
                    }
                    request_bytes.extend_from_slice(&chunk[..n]);
                    if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                tx.send(String::from_utf8(request_bytes).expect("request utf8"))
                    .ok();
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });
        (addr, rx)
    }

    #[test]
    fn default_backend_uses_in_process_output_emitter() {
        let state = create_terminal_backend(
            test_backend_config("in-process", None),
            Arc::new(WsEmitter::new()),
        )
        .expect("backend state");

        assert_eq!(state.output_mode, TerminalOutputMode::Emitter);
    }

    #[test]
    fn daemon_manifest_backend_uses_polling_output_and_probes_daemon() {
        let (addr, rx) = spawn_daemon_probe_server();
        let runtime_dir = test_dir("daemon");
        let manifest_path = std::path::Path::new(&runtime_dir).join("daemon-manifest.json");
        std::fs::write(
            &manifest_path,
            format!(r#"{{"addr":"{addr}","token":"secret","pid":42,"startedAt":100}}"#),
        )
        .expect("write manifest");

        let state = create_terminal_backend(
            test_backend_config(
                "daemon-paths",
                Some(manifest_path.to_string_lossy().to_string()),
            ),
            Arc::new(WsEmitter::new()),
        )
        .expect("backend state");

        assert_eq!(state.output_mode, TerminalOutputMode::Polling);
        let health = rx.recv().expect("health request");
        assert!(health.starts_with("GET /api/health HTTP/1.1"));
        assert!(!health.contains("Authorization: Bearer"));
        let status = rx.recv().expect("status request");
        assert!(status.starts_with("GET /api/daemon/status HTTP/1.1"));
        assert!(status.contains("Authorization: Bearer secret"));
    }
}
