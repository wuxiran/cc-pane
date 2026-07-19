mod self_check;
mod server;
mod session_reaper;
mod ws_emitter;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::{
    events::NoopNotifier,
    services::{
        ExternalSkillRegistry, InProcessTerminalBackend, LaunchProfileService,
        ProjectCliHooksService, ProviderService, SettingsService, SharedMcpService,
        SshCredentialService, TerminalBackend, TerminalService, WorkspaceService,
    },
    utils::{simplify_path, AppPaths, APP_DIR_NAME},
};
use clap::Parser;
use tracing::info;

use crate::server::{generate_token, write_manifest, DaemonConfig};
use crate::ws_emitter::WsEmitter;

#[derive(Parser, Debug)]
#[command(name = "cc-panes-daemon", about = "CC-Panes local terminal daemon")]
struct Args {
    /// Host to bind. Defaults to loopback only.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    /// Port to listen on. Use 0 to let the OS choose an available port.
    #[arg(long, default_value_t = 0)]
    port: u16,

    /// Bearer token. A random token is generated when omitted.
    #[arg(long)]
    token: Option<String>,

    /// Directory where daemon-manifest.json is written.
    #[arg(long)]
    runtime_dir: Option<PathBuf>,

    /// Default working directory for local terminal sessions.
    #[arg(long, default_value = ".")]
    cwd: String,

    /// Data directory for cc-panes config/db.
    #[arg(long)]
    data_dir: Option<String>,

    /// Explicit path to config.toml. The app's config lives in its config dir
    /// (~/.cc-panes[-dev]/), which may differ from --data-dir when the user
    /// customizes the data directory; passing it explicitly keeps daemon-side
    /// settings reload (session TTL etc.) reading the same file the app writes.
    #[arg(long)]
    config_path: Option<PathBuf>,
}

struct DaemonPathResolution {
    default_data_dir: Option<String>,
    config_path: Option<PathBuf>,
    source: &'static str,
}

fn resolve_daemon_paths(explicit_data_dir: Option<&str>) -> DaemonPathResolution {
    if let Some(dir) = non_empty_path(explicit_data_dir) {
        let path = normalize_current_host_path(dir);
        let config_path = path.join("config.toml");
        return DaemonPathResolution {
            default_data_dir: Some(path.to_string_lossy().to_string()),
            config_path: config_path.exists().then_some(config_path),
            source: "cli",
        };
    }

    if let Some(dir) = non_empty_path(std::env::var("CCPANES_DAEMON_DATA_DIR").ok().as_deref()) {
        let path = normalize_current_host_path(dir);
        let config_path = path.join("config.toml");
        return DaemonPathResolution {
            default_data_dir: Some(path.to_string_lossy().to_string()),
            config_path: config_path.exists().then_some(config_path),
            source: "env",
        };
    }

    if let Some(path) = detect_windows_desktop_app_dir() {
        return DaemonPathResolution {
            config_path: Some(path.join("config.toml")),
            default_data_dir: Some(path.to_string_lossy().to_string()),
            source: "windows-desktop",
        };
    }

    DaemonPathResolution {
        default_data_dir: None,
        config_path: None,
        source: "app-default",
    }
}

fn resolve_data_dir(
    explicit_data_dir: Option<&str>,
    settings_data_dir: Option<String>,
    daemon_paths: &DaemonPathResolution,
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
    daemon_paths.default_data_dir.clone()
}

fn non_empty_path(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_current_host_path(path: &str) -> PathBuf {
    normalize_host_path(path, running_under_wsl())
}

/// 只有真的在 WSL 里跑时才把 Windows 路径翻译成 `/mnt/c/...`。
/// daemon 作为 `cc-panes-daemon.exe` 跑在原生 Windows 上时必须保持 `C:\...` 原样，
/// 否则 `AppPaths.data_dir()` 变成 `/mnt/c/...`，后续 `join("wsl-launch")` 用 `\`
/// 拼出混合分隔符路径，wslpath 翻译失败（WSL codex 启动 500）。
fn normalize_host_path(path: &str, under_wsl: bool) -> PathBuf {
    if under_wsl {
        windows_path_to_wsl_path(path).unwrap_or_else(|| PathBuf::from(path))
    } else {
        PathBuf::from(path)
    }
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
    let output = std::process::Command::new("cmd.exe")
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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cc_panes_daemon=info".into()),
        )
        .init();

    let args = Args::parse();
    let token = args.token.unwrap_or_else(generate_token);
    let addr = SocketAddr::new(args.host, args.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    // 剥掉 Windows `\\?\` verbatim 前缀：该值会作为 default_cwd 回落给缺少
    // project_path 的会话（server.rs 的 spawn 路径），带前缀会让 cmd.exe 把 CLI
    // 启到 C:\Windows。详见 docs/35-unc-path-contamination.md。
    let cwd = simplify_path(
        std::fs::canonicalize(&args.cwd).unwrap_or_else(|_| std::path::PathBuf::from(&args.cwd)),
    );
    let cwd_str = cwd.to_string_lossy().to_string();

    let daemon_paths = resolve_daemon_paths(args.data_dir.as_deref());
    // --config-path（app 显式传入，保证与 app 写的是同一份文件）优先，
    // 否则回退到 data_dir 推导；settings_service 同时供 backend 与 reaper 使用。
    let settings_service = Arc::new(
        match args
            .config_path
            .as_ref()
            .or(daemon_paths.config_path.as_ref())
        {
            Some(path) => SettingsService::new_with_config_path(path.clone()),
            None => SettingsService::new(),
        },
    );
    let ws_emitter = Arc::new(WsEmitter::new());
    let terminal_backend = create_terminal_backend(
        args.data_dir.as_deref(),
        daemon_paths,
        ws_emitter.clone(),
        settings_service.clone(),
    );
    let config = DaemonConfig::new(
        token,
        local_addr,
        terminal_backend,
        ws_emitter,
        cwd_str.clone(),
    );
    let shutdown_rx = config.shutdown_signal();

    if let Some(runtime_dir) = args.runtime_dir {
        let manifest = write_manifest(&runtime_dir, &config)?;
        info!(path = %manifest.display(), "daemon manifest written");
        // 周期自检：被新 daemon 取代即优雅退出，manifest 丢失则自愈重写。
        self_check::spawn_manifest_self_check(runtime_dir, config.clone());
    }
    // 孤儿会话回收：无人查看超过 TTL（设置可调，0=禁用）的会话按 FIFO 回收。
    session_reaper::spawn_session_reaper(config.clone(), settings_service);

    info!(addr = %local_addr, cwd = cwd_str, "CC-Panes daemon listening");
    axum::serve(listener, server::router(config))
        .with_graceful_shutdown(server::wait_for_shutdown(shutdown_rx))
        .await?;
    Ok(())
}

fn create_terminal_backend(
    explicit_data_dir: Option<&str>,
    daemon_paths: DaemonPathResolution,
    ws_emitter: Arc<WsEmitter>,
    settings_service: Arc<SettingsService>,
) -> Arc<dyn TerminalBackend> {
    let settings_data_dir = settings_service.get_settings().general.data_dir;
    let data_dir = resolve_data_dir(explicit_data_dir, settings_data_dir, &daemon_paths);
    let app_paths = Arc::new(AppPaths::new(data_dir));
    info!(
        data_dir = %app_paths.data_dir().display(),
        source = daemon_paths.source,
        "CC-Panes daemon data directory resolved"
    );
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let cli_registry = Arc::new(CliToolRegistry::with_builtin_adapters());
    let external_skill_registry = Arc::new(ExternalSkillRegistry::new(cli_registry.clone()));
    let launch_profile_service = Arc::new(LaunchProfileService::new_with_external_skill_registry(
        app_paths.launch_profiles_path(),
        external_skill_registry,
    ));
    let workspace_service = Arc::new(WorkspaceService::new(app_paths.workspaces_dir()));
    let shared_mcp_service = Arc::new(SharedMcpService::new(&app_paths));
    let project_cli_hooks_service = Arc::new(ProjectCliHooksService::new(cli_registry.clone()));
    let ssh_credential_service = Arc::new(SshCredentialService::new());

    let terminal_service = Arc::new(TerminalService::new(
        settings_service,
        provider_service,
        app_paths,
        cli_registry,
        project_cli_hooks_service,
        ssh_credential_service,
    ));
    terminal_service.set_workspace_service(workspace_service);
    terminal_service.set_shared_mcp_service(shared_mcp_service);
    terminal_service.set_launch_profile_service(launch_profile_service);
    terminal_service.set_emitter(ws_emitter);
    terminal_service.set_notifier(Arc::new(NoopNotifier));

    Arc::new(InProcessTerminalBackend::new(terminal_service))
}

impl Default for Args {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            token: None,
            runtime_dir: None,
            cwd: ".".to_string(),
            data_dir: None,
            config_path: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_windows_keeps_path_verbatim() {
        // 原生 Windows daemon：不翻译，保持 C:\... 原样。
        assert_eq!(
            normalize_host_path(r"C:\Users\x\.cc-panes", false),
            PathBuf::from(r"C:\Users\x\.cc-panes")
        );
    }

    #[test]
    fn under_wsl_translates_to_mnt() {
        // WSL 内 daemon：Windows 路径翻译成 /mnt/c/...。
        assert_eq!(
            normalize_host_path(r"C:\Users\x\.cc-panes", true),
            PathBuf::from("/mnt/c/Users/x/.cc-panes")
        );
    }

    #[test]
    fn under_wsl_non_windows_path_kept() {
        // WSL 内已是 posix 路径：保持原样。
        assert_eq!(
            normalize_host_path("/home/x/.cc-panes", true),
            PathBuf::from("/home/x/.cc-panes")
        );
    }
}
