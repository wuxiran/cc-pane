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
        Database, HistoryRepository, ProjectRepository, RunnerRepository, SpecRepository,
        TaskBindingRepository, TodoRepository, UsageStatsRepository,
    },
    services::{
        DaemonTerminalBackend, FileSystemService, HistoryService, InProcessTerminalBackend,
        JournalService, LaunchHistoryService, LaunchProfileService, LayoutSnapshotService,
        McpConfigService, MemoryService, PlanService, ProcessMonitorService,
        ProjectCliHooksService, ProjectService, ProviderService, RunnerService,
        SessionRestoreService, SettingsService, SharedMcpService, SkillService, SpecService,
        SshCredentialService, SshMachineService, TaskBindingService, TerminalBackend,
        TerminalDaemonClient, TerminalService, TodoService, UsageStatsService, UserSkillService,
        WorkspaceService, WorktreeService,
    },
    utils::{AppPaths, APP_DIR_NAME},
};
use clap::Parser;
use tracing::info;

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

    // Resolve cwd to absolute path
    let cwd =
        std::fs::canonicalize(&args.cwd).unwrap_or_else(|_| std::path::PathBuf::from(&args.cwd));
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
    let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
    let project_service = Arc::new(ProjectService::new(project_repo));
    let todo_service = Arc::new(TodoService::new(todo_repo));
    let spec_service = Arc::new(SpecService::new(spec_repo, todo_service.clone()));
    let task_binding_service = Arc::new(TaskBindingService::new(task_binding_repo));
    let launch_history_service = Arc::new(LaunchHistoryService::new(history_repo));
    let layout_snapshot_service = Arc::new(LayoutSnapshotService::new(database.clone()));
    let session_restore_service = Arc::new(SessionRestoreService::new(database, app_paths.clone()));
    let history_service = Arc::new(HistoryService::new());
    let worktree_service = Arc::new(WorktreeService::new());
    let process_monitor_service = Arc::new(ProcessMonitorService::new());
    let runner_service = Arc::new(RunnerService::new(
        runner_repo,
        process_monitor_service.clone(),
    ));
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let filesystem_service = Arc::new(FileSystemService::new());
    let mcp_config_service = Arc::new(McpConfigService::new());
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
    let usage_stats_service = Arc::new(UsageStatsService::new(
        usage_stats_repo,
        launch_history_service.clone(),
    ));
    usage_stats_service.start_background_tasks();

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

    let state = AppState {
        terminal_backend: backend_state.backend,
        workspace_service,
        project_service,
        provider_service,
        settings_service,
        filesystem_service,
        todo_service,
        spec_service,
        task_binding_service,
        launch_history_service,
        layout_snapshot_service,
        launch_profile_service,
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
        ws_emitter,
        web_auth: Arc::new(web_auth::WebAuthStore::default()),
        default_cwd: cwd_str.clone(),
        output_mode: backend_state.output_mode,
    };

    let app = routes::build_router(state);

    let host = resolve_bind_host(args.host, &loaded_settings.web_access)?;
    let addr: SocketAddr = format!("{host}:{}", args.port).parse()?;
    info!(addr = %addr, cwd = cwd_str, "CC-Panes Web starting");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Listening on http://{}", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
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
