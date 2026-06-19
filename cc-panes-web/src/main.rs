mod routes;
mod state;
mod ws_emitter;
mod ws_handler;

use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::{
    events::NoopNotifier,
    services::{
        DaemonTerminalBackend, InProcessTerminalBackend, ProjectCliHooksService, ProviderService,
        SettingsService, SshCredentialService, TerminalBackend, TerminalDaemonClient,
        TerminalService,
    },
    utils::AppPaths,
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

    /// Default working directory for new terminal sessions
    #[arg(long, default_value = ".")]
    cwd: String,

    /// Default shell (auto-detect if not specified)
    #[arg(long)]
    shell: Option<String>,

    /// Data directory for cc-panes config/db
    #[arg(long)]
    data_dir: Option<String>,

    /// Connect terminal operations to an existing cc-panes-daemon manifest.
    #[arg(long, env = "CCPANES_TERMINAL_DAEMON_MANIFEST")]
    daemon_manifest: Option<String>,
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

    let data_dir = args.data_dir.unwrap_or_else(|| {
        dirs::home_dir()
            .map(|h| h.join(".cc-panes-web").to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp/.cc-panes-web".to_string())
    });
    let ws_emitter = Arc::new(WsEmitter::new());
    let backend_config = BackendConfig {
        data_dir,
        daemon_manifest: args.daemon_manifest,
    };
    let backend_state = create_terminal_backend(backend_config, ws_emitter.clone())?;

    let state = AppState {
        terminal_backend: backend_state.backend,
        ws_emitter,
        default_cwd: cwd_str.clone(),
        output_mode: backend_state.output_mode,
    };

    let app = routes::build_router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    info!(addr, cwd = cwd_str, "CC-Panes Web starting");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}

struct BackendConfig {
    data_dir: String,
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

    let terminal_service = create_in_process_terminal_service(config.data_dir, ws_emitter);
    Ok(BackendState {
        backend: Arc::new(InProcessTerminalBackend::new(terminal_service)),
        output_mode: TerminalOutputMode::Emitter,
    })
}

fn create_in_process_terminal_service(
    data_dir: String,
    ws_emitter: Arc<WsEmitter>,
) -> Arc<TerminalService> {
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
            BackendConfig {
                data_dir: test_dir("in-process"),
                daemon_manifest: None,
            },
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
            BackendConfig {
                data_dir: test_dir("daemon-data"),
                daemon_manifest: Some(manifest_path.to_string_lossy().to_string()),
            },
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
