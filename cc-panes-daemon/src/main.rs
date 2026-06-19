mod server;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

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
    let config = DaemonConfig::new(token, local_addr);
    let shutdown_rx = config.shutdown_signal();

    if let Some(runtime_dir) = args.runtime_dir {
        let manifest = write_manifest(&runtime_dir, &config)?;
        info!(path = %manifest.display(), "daemon manifest written");
    }

    info!(addr = %local_addr, "CC-Panes daemon listening");
    axum::serve(listener, server::router(config))
        .with_graceful_shutdown(server::wait_for_shutdown(shutdown_rx))
        .await?;
    Ok(())
}

impl Default for Args {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            token: None,
            runtime_dir: None,
        }
    }
}
