mod routes;
mod state;
mod ws_emitter;
mod ws_handler;

use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::{
    events::NoopNotifier,
    services::{ProviderService, SettingsService, TerminalService},
    utils::AppPaths,
};
use clap::Parser;
use tracing::info;

use crate::state::AppState;
use crate::ws_emitter::WsEmitter;

#[derive(Parser, Debug)]
#[command(name = "cc-panes-web", about = "CC-Panes Web terminal server")]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Default working directory for new terminal sessions
    #[arg(long, default_value = ".")]
    cwd: String,

    /// Default shell (auto-detect if not specified)
    #[arg(long)]
    shell: Option<String>,

    /// Data directory for cc-panes config/db
    #[arg(long)]
    data_dir: Option<String>,
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

    // Initialize core services (headless mode)
    let data_dir = args.data_dir.unwrap_or_else(|| {
        dirs::home_dir()
            .map(|h| h.join(".cc-panes-web").to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp/.cc-panes-web".to_string())
    });

    let app_paths = Arc::new(AppPaths::new(Some(data_dir)));
    let settings_service = Arc::new(SettingsService::new());
    let provider_service = Arc::new(ProviderService::new(app_paths.providers_path()));
    let cli_registry = Arc::new(CliToolRegistry::new());

    let terminal_service = Arc::new(TerminalService::new(
        settings_service,
        provider_service,
        app_paths,
        cli_registry,
    ));

    // Set up event emitter for WebSocket routing
    let ws_emitter = Arc::new(WsEmitter::new());
    terminal_service.set_emitter(ws_emitter.clone());
    terminal_service.set_notifier(Arc::new(NoopNotifier));

    let state = AppState {
        terminal_service,
        ws_emitter,
        default_cwd: cwd_str.clone(),
    };

    let app = routes::build_router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    info!(addr, cwd = cwd_str, "CC-Panes Web starting");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}
