mod server;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::{
    events::{NoopEmitter, NoopNotifier},
    services::{
        InProcessTerminalBackend, ProjectCliHooksService, ProviderService, SettingsService,
        SshCredentialService, TerminalBackend, TerminalService,
    },
    utils::AppPaths,
};
use clap::Parser;
use tracing::info;

use crate::server::{generate_token, write_manifest, DaemonConfig};

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

    let cwd =
        std::fs::canonicalize(&args.cwd).unwrap_or_else(|_| std::path::PathBuf::from(&args.cwd));
    let cwd_str = cwd.to_string_lossy().to_string();

    let data_dir = args.data_dir.unwrap_or_else(|| {
        dirs::home_dir()
            .map(|home| home.join(".cc-panes-daemon").to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp/.cc-panes-daemon".to_string())
    });
    let terminal_backend = create_terminal_backend(data_dir);
    let config = DaemonConfig::new(token, local_addr, terminal_backend, cwd_str.clone());
    let shutdown_rx = config.shutdown_signal();

    if let Some(runtime_dir) = args.runtime_dir {
        let manifest = write_manifest(&runtime_dir, &config)?;
        info!(path = %manifest.display(), "daemon manifest written");
    }

    info!(addr = %local_addr, cwd = cwd_str, "CC-Panes daemon listening");
    axum::serve(listener, server::router(config))
        .with_graceful_shutdown(server::wait_for_shutdown(shutdown_rx))
        .await?;
    Ok(())
}

fn create_terminal_backend(data_dir: String) -> Arc<dyn TerminalBackend> {
    let app_paths = Arc::new(AppPaths::new(Some(data_dir)));
    let settings_service = Arc::new(SettingsService::new());
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let cli_registry = Arc::new(CliToolRegistry::new());
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
    terminal_service.set_emitter(Arc::new(NoopEmitter));
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
        }
    }
}
