use std::sync::{Arc, RwLock};

use crate::services::{
    DaemonTerminalBackend, InProcessTerminalBackend, TerminalBackend, TerminalDaemonClient,
    TerminalService,
};
use crate::utils::AppPaths;
use tracing::{info, warn};

#[derive(Clone)]
pub struct TerminalBackendState {
    inner: Arc<RwLock<TerminalBackendStateInner>>,
}

struct TerminalBackendStateInner {
    backend: Arc<dyn TerminalBackend>,
    kind: TerminalBackendKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalBackendKind {
    InProcess,
    Daemon,
}

impl TerminalBackendState {
    pub fn new(backend: Arc<dyn TerminalBackend>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TerminalBackendStateInner {
                backend,
                kind: TerminalBackendKind::InProcess,
            })),
        }
    }

    pub fn from_env_or_in_process(
        terminal_service: Arc<TerminalService>,
        app_paths: &AppPaths,
    ) -> Self {
        if let Some(client) = daemon_client_from_env(app_paths) {
            return Self {
                inner: Arc::new(RwLock::new(TerminalBackendStateInner {
                    backend: Arc::new(DaemonTerminalBackend::new(client)),
                    kind: TerminalBackendKind::Daemon,
                })),
            };
        }

        Self::new(Arc::new(InProcessTerminalBackend::new(terminal_service)))
    }

    pub fn backend(&self) -> Arc<dyn TerminalBackend> {
        self.inner
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .backend
            .clone()
    }

    pub fn kind(&self) -> TerminalBackendKind {
        self.inner
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .kind
    }

    pub fn try_enable_daemon(&self, client: TerminalDaemonClient) {
        let mut inner = self
            .inner
            .write()
            .unwrap_or_else(|error| error.into_inner());
        inner.backend = Arc::new(DaemonTerminalBackend::new(client));
        inner.kind = TerminalBackendKind::Daemon;
    }
}

fn daemon_client_from_env(app_paths: &AppPaths) -> Option<TerminalDaemonClient> {
    let explicit_manifest = std::env::var("CCPANES_TERMINAL_DAEMON_MANIFEST")
        .ok()
        .filter(|path| !path.trim().is_empty());
    let manifest_path = match explicit_manifest {
        Some(path) => std::path::PathBuf::from(path),
        None if terminal_daemon_enabled() => app_paths.runtime_dir().join("daemon-manifest.json"),
        None => return None,
    };

    match TerminalDaemonClient::from_manifest_path(&manifest_path) {
        Ok(client) => {
            if let Err(error) = client.health() {
                warn!(
                    manifest = %manifest_path.display(),
                    error = %error,
                    "terminal daemon manifest found but health probe failed; using in-process backend"
                );
                return None;
            }
            if let Err(error) = client.status() {
                warn!(
                    manifest = %manifest_path.display(),
                    error = %error,
                    "terminal daemon manifest found but status probe failed; using in-process backend"
                );
                return None;
            }
            info!(
                manifest = %manifest_path.display(),
                "using terminal daemon backend"
            );
            Some(client)
        }
        Err(error) => {
            warn!(
                manifest = %manifest_path.display(),
                error = %error,
                "terminal daemon manifest not usable; using in-process backend"
            );
            None
        }
    }
}

fn terminal_daemon_enabled() -> bool {
    std::env::var("CCPANES_TERMINAL_DAEMON")
        .ok()
        .is_some_and(|value| is_truthy_daemon_flag(&value))
}

fn is_truthy_daemon_flag(value: &str) -> bool {
    matches!(value, "1" | "true" | "TRUE" | "yes" | "YES")
}

#[cfg(test)]
mod tests {
    use crate::models::{CreateSessionRequest, TerminalReplaySnapshot};
    use crate::services::terminal_service::SessionOutput;
    use crate::services::{SessionStatusInfo, TerminalBackend};
    use crate::utils::AppResult;

    use super::*;

    struct MockBackend;

    impl TerminalBackend for MockBackend {
        fn create_session(&self, _request: CreateSessionRequest) -> AppResult<String> {
            Ok("mock-session".to_string())
        }

        fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
            Ok(())
        }

        fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
            Ok(())
        }

        fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
            Ok(())
        }

        fn kill(&self, _session_id: &str) -> AppResult<()> {
            Ok(())
        }

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            Ok(Vec::new())
        }

        fn get_session_status(&self, _session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            Ok(None)
        }

        fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
            Ok(SessionOutput {
                session_id: session_id.to_string(),
                lines: vec!["ready".to_string()],
            })
        }

        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            Ok(None)
        }
    }

    #[test]
    fn terminal_backend_state_preserves_backend_trait_object() {
        let state = TerminalBackendState::new(Arc::new(MockBackend));

        let output = state
            .backend()
            .get_session_output("session-1", 10)
            .expect("output");

        assert_eq!(output.session_id, "session-1");
        assert_eq!(output.lines, vec!["ready"]);
    }

    #[test]
    fn daemon_flag_parser_accepts_only_explicit_truthy_values() {
        assert!(is_truthy_daemon_flag("1"));
        assert!(is_truthy_daemon_flag("true"));
        assert!(is_truthy_daemon_flag("TRUE"));
        assert!(is_truthy_daemon_flag("yes"));
        assert!(is_truthy_daemon_flag("YES"));
        assert!(!is_truthy_daemon_flag("0"));
        assert!(!is_truthy_daemon_flag("false"));
        assert!(!is_truthy_daemon_flag(""));
    }

    #[test]
    fn terminal_backend_state_can_switch_to_daemon_backend() {
        let state = TerminalBackendState::new(Arc::new(MockBackend));
        assert_eq!(state.kind(), TerminalBackendKind::InProcess);

        state.try_enable_daemon(TerminalDaemonClient::new("127.0.0.1:1", "token"));

        assert_eq!(state.kind(), TerminalBackendKind::Daemon);
    }
}
