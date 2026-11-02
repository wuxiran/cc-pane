//! Framework-independent Codex App Server stdio client.
//!
//! This starts a private `codex app-server --stdio` process; it never attaches to
//! or restarts the desktop application's daemon. The protocol payloads remain
//! JSON so callers can opt into newer thread/turn methods without changing the
//! transport. Notifications and server requests are delivered in wire order.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};

use crate::utils::{AppError, AppResult};

mod process;
#[cfg(test)]
mod tests;
mod transport;

pub type CodexAppServerError = AppError;

/// Options must originate from trusted application configuration, never an
/// arbitrary executable path supplied by page content or an agent tool call.
#[derive(Debug, Clone)]
pub struct CodexAppServerOptions {
    pub cwd: PathBuf,
    pub executable: Option<PathBuf>,
    /// Normally `app-server --listen stdio://`; overridable for trusted test
    /// fixtures or a managed wrapper, not exposed to untrusted callers.
    pub arguments: Vec<String>,
    pub config_overrides: Vec<String>,
    pub env: HashMap<String, String>,
    pub request_timeout: Duration,
    pub client_name: String,
    pub client_version: String,
    pub experimental_api: bool,
}

impl Default for CodexAppServerOptions {
    fn default() -> Self {
        Self {
            cwd: PathBuf::from("."),
            executable: None,
            arguments: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
            config_overrides: Vec::new(),
            env: HashMap::new(),
            request_timeout: Duration::from_secs(30),
            client_name: "cc-panes".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            experimental_api: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexAppServerEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    ProtocolError {
        message: String,
    },
    Exited {
        code: Option<i32>,
    },
}

/// Clones share one process. Dropping the final clone closes stdin and reclaims
/// its process group/job; explicit shutdown waits for this cleanup to complete.
#[derive(Clone)]
pub struct CodexAppServer {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    commands: mpsc::Sender<transport::Command>,
    request_timeout: Duration,
    pid: u32,
    stop: watch::Sender<bool>,
    completion: watch::Receiver<Option<AppResult<()>>>,
}

impl CodexAppServer {
    pub async fn spawn(
        options: CodexAppServerOptions,
    ) -> AppResult<(Self, mpsc::Receiver<CodexAppServerEvent>)> {
        let (client, events) = transport::spawn(&options).await?;
        let result = client
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": options.client_name,
                        "title": "CC-Panes",
                        "version": options.client_version,
                    },
                    "capabilities": { "experimentalApi": options.experimental_api },
                }),
            )
            .await;
        if let Err(error) = result {
            let _ = client.shutdown().await;
            return Err(error);
        }
        if let Err(error) = client.notify("initialized", json!({})).await {
            let _ = client.shutdown().await;
            return Err(error);
        }
        Ok((client, events))
    }

    pub fn pid(&self) -> u32 {
        self.inner.pid
    }

    pub async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        self.exchange(transport::Operation::Request {
            method: method.to_owned(),
            params,
        })
        .await
    }

    pub async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        self.exchange(transport::Operation::Notify {
            method: method.to_owned(),
            params,
        })
        .await
        .map(|_| ())
    }

    /// Only outstanding server request IDs may be answered; duplicate or stale
    /// approval responses are rejected locally before anything reaches stdin.
    pub async fn respond(&self, id: Value, result: Value) -> AppResult<()> {
        self.exchange(transport::Operation::Response {
            id,
            result: Ok(result),
        })
        .await
        .map(|_| ())
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> AppResult<()> {
        self.exchange(transport::Operation::Response {
            id,
            result: Err(json!({ "code": code, "message": message })),
        })
        .await
        .map(|_| ())
    }

    pub async fn shutdown(&self) -> AppResult<()> {
        // Closing stdin is the documented stdio shutdown signal. The transport
        // grants a short grace period, then terminates the entire process tree.
        self.inner.stop.send_replace(true);
        let mut completion = self.inner.completion.clone();
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result;
            }
            if completion.changed().await.is_err() {
                return Err(closed());
            }
        }
    }

    async fn exchange(&self, operation: transport::Operation) -> AppResult<Value> {
        let (reply, response) = oneshot::channel();
        let timeout = self.inner.request_timeout;
        tokio::time::timeout(timeout, async {
            self.inner
                .commands
                .send(transport::Command::Operation(operation, reply))
                .await
                .map_err(|_| closed())?;
            response.await.map_err(|_| closed())?
        })
        .await
        .map_err(|_| {
            AppError::coded(
                "CODEX_APP_SERVER_TIMEOUT",
                "Codex App Server request timed out",
            )
        })?
    }
}

fn closed() -> AppError {
    AppError::coded(
        "CODEX_APP_SERVER_CLOSED",
        "Codex App Server connection is closed",
    )
}
