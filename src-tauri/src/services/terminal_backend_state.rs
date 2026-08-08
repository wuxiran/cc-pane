use std::sync::{Arc, Mutex, RwLock};

use crate::models::{AuthMethod, CreateSessionRequest};
use crate::services::{
    DaemonTerminalBackend, InProcessTerminalBackend, SshMachineService, TerminalBackend,
    TerminalDaemonClient, TerminalDaemonControlLink, TerminalDaemonLifecycle, TerminalService,
};
use crate::utils::{AppPaths, AppResult};
use tauri::Manager;
use tracing::{info, warn};

#[derive(Clone)]
pub struct TerminalBackendState {
    inner: Arc<RwLock<TerminalBackendStateInner>>,
    /// Serializes the slow retire/start sequence without holding `inner` across I/O.
    daemon_upgrade_lock: Arc<Mutex<()>>,
}

struct TerminalBackendStateInner {
    backend: Arc<dyn TerminalBackend>,
    kind: TerminalBackendKind,
    /// daemon 模式下保留 client 供控制链路 / 客户端计数查询使用
    daemon_client: Option<TerminalDaemonClient>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalBackendKind {
    InProcess,
    Daemon,
}

pub struct CreatedTerminalSession {
    pub session_id: String,
    pub backend: Arc<dyn TerminalBackend>,
    pub reused_existing: bool,
    pub resolved_model_id: Option<String>,
}

struct RecoveredTerminalDaemon {
    client: TerminalDaemonClient,
    backend: Arc<dyn TerminalBackend>,
}

impl RecoveredTerminalDaemon {
    fn from_client(client: TerminalDaemonClient) -> Self {
        let backend = Arc::new(DaemonTerminalBackend::new(client.clone()));
        Self { client, backend }
    }
}

impl TerminalBackendState {
    pub fn new(backend: Arc<dyn TerminalBackend>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TerminalBackendStateInner {
                backend,
                kind: TerminalBackendKind::InProcess,
                daemon_client: None,
            })),
            daemon_upgrade_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn from_env_or_in_process(
        terminal_service: Arc<TerminalService>,
        app_paths: &AppPaths,
    ) -> Self {
        if let Some(client) = daemon_client_from_env(app_paths) {
            return Self {
                inner: Arc::new(RwLock::new(TerminalBackendStateInner {
                    backend: Arc::new(DaemonTerminalBackend::new(client.clone())),
                    kind: TerminalBackendKind::Daemon,
                    daemon_client: Some(client),
                })),
                daemon_upgrade_lock: Arc::new(Mutex::new(())),
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
        let backend = Arc::new(DaemonTerminalBackend::new(client.clone()));
        self.install_daemon_backend(client, backend);
    }

    fn install_daemon_backend(
        &self,
        client: TerminalDaemonClient,
        backend: Arc<dyn TerminalBackend>,
    ) {
        let mut inner = self
            .inner
            .write()
            .unwrap_or_else(|error| error.into_inner());
        inner.backend = backend;
        inner.kind = TerminalBackendKind::Daemon;
        inner.daemon_client = Some(client);
    }

    /// 创建会话，daemon 掉线时自动重连并重试一次。
    ///
    /// **所有创建入口都该走这里**，而不是各自 `backend().create_session()`。
    /// 实测教训：自愈最初只补在 Tauri 命令 `create_terminal_session` 上，
    /// 而 orchestrator（REST/MCP launch_task）与 Runner 各有自己的调用点，
    /// 于是 `ctl launch` 在 daemon 已死时依然 `connection timed out` ——
    /// 补在调用点就必然漏，必须落在共同层。
    ///
    /// 判据不是错误文本（脆且随平台/语言变），而是失败后探一次健康：
    /// 健康 = 业务错误原样抛出；不健康 = 真掉线，重连后用新 backend 重试。
    fn create_session_recovering(
        &self,
        request: CreateSessionRequest,
        recover_if_down: impl FnOnce(Option<&TerminalDaemonClient>) -> Option<RecoveredTerminalDaemon>,
        on_recovered: impl FnOnce(&TerminalDaemonClient),
    ) -> AppResult<CreatedTerminalSession> {
        let initial_backend = self.backend();
        match initial_backend.create_session_with_outcome(request.clone()) {
            Ok(outcome) => Ok(CreatedTerminalSession {
                session_id: outcome.session_id,
                backend: initial_backend,
                reused_existing: outcome.reused_existing,
                resolved_model_id: outcome.resolved_model_id,
            }),
            Err(error) if self.kind() != TerminalBackendKind::Daemon => Err(error),
            Err(error) => {
                let current_client = self.daemon_client();
                let Some(recovered) = recover_if_down(current_client.as_ref()) else {
                    return Err(error);
                };
                warn!(error = %error, "terminal daemon reconnected; retrying session creation once");
                self.install_daemon_backend(recovered.client.clone(), recovered.backend.clone());
                on_recovered(&recovered.client);
                let outcome = recovered.backend.create_session_with_outcome(request)?;
                Ok(CreatedTerminalSession {
                    session_id: outcome.session_id,
                    backend: recovered.backend,
                    reused_existing: outcome.reused_existing,
                    resolved_model_id: outcome.resolved_model_id,
                })
            }
        }
    }

    /// 统一的生产创建入口。daemon 健康时业务错误原样返回；掉线时只重连并重试一次。
    pub fn create_session_with_recovery(
        &self,
        app_handle: &tauri::AppHandle,
        request: CreateSessionRequest,
    ) -> AppResult<CreatedTerminalSession> {
        self.recheck_daemon_upgrade_before_create(app_handle);
        let ssh_password = load_ssh_connection_password(app_handle, &request)?;
        if let Some(client) = self.daemon_client() {
            sync_ssh_password(&client, ssh_password.as_ref())?;
        }
        let recovery_ssh_password = ssh_password.clone();
        self.create_session_recovering(
            request,
            |current_client| {
                if current_client.is_some_and(|client| client.health().is_ok()) {
                    return None;
                }

                let app_paths = app_handle.try_state::<Arc<crate::utils::AppPaths>>()?;
                let settings = app_handle.try_state::<Arc<crate::services::SettingsService>>()?;
                let resource_dir = app_handle.path().resource_dir().ok();
                let config_path = settings.config_path().to_path_buf();
                match TerminalDaemonLifecycle::reconnect_throttled(
                    app_paths.inner().as_ref(),
                    resource_dir.as_deref(),
                    &config_path,
                ) {
                    Ok(client) => Some(RecoveredTerminalDaemon::from_client(client)),
                    Err(error) => {
                        warn!(error = %error, "terminal daemon reconnect failed");
                        None
                    }
                }
            },
            |client| {
                if let Err(error) = sync_ssh_password(&client, recovery_ssh_password.as_ref()) {
                    warn!(error = %error, "failed to synchronize SSH password after daemon recovery");
                }
                if let Some(control_link) = app_handle.try_state::<Arc<TerminalDaemonControlLink>>()
                {
                    control_link.replace_client(client.clone());
                } else {
                    warn!("terminal daemon recovered before control link manager was available");
                }
            },
        )
    }

    fn recheck_daemon_upgrade_before_create(&self, app_handle: &tauri::AppHandle) {
        if self.kind() != TerminalBackendKind::Daemon {
            return;
        }
        // Tauri commands and orchestrator launches may create PTYs concurrently. Only one caller
        // may retire/start the shared daemon; after waiting, re-read the client so a follower checks
        // the replacement instead of shutting down the old daemon a second time.
        let _upgrade_guard = self
            .daemon_upgrade_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.kind() != TerminalBackendKind::Daemon {
            return;
        }
        let Some(current_client) = self.daemon_client() else {
            return;
        };
        let Some(app_paths) = app_handle.try_state::<Arc<crate::utils::AppPaths>>() else {
            return;
        };
        let Some(settings) = app_handle.try_state::<Arc<crate::services::SettingsService>>() else {
            return;
        };
        let control_link = app_handle.try_state::<Arc<TerminalDaemonControlLink>>();
        let current_desktop_connected = control_link
            .as_ref()
            .is_some_and(|link| link.is_connected());
        let resource_dir = app_handle.path().resource_dir().ok();
        match TerminalDaemonLifecycle::recheck_upgrade_before_create(
            app_paths.inner().as_ref(),
            resource_dir.as_deref(),
            settings.config_path(),
            &current_client,
            current_desktop_connected,
        ) {
            Ok(Some(replacement)) => {
                self.try_enable_daemon(replacement.clone());
                if let Some(control_link) = control_link {
                    control_link.replace_client(replacement);
                }
                info!("terminal daemon upgraded after sessions reached zero");
            }
            Ok(None) => {}
            Err(error) => {
                warn!(error = %error, "terminal daemon upgrade recheck failed; using current daemon");
            }
        }
    }

    /// daemon 模式下的 client（in-process 时为 None）
    pub fn daemon_client(&self) -> Option<TerminalDaemonClient> {
        self.inner
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .daemon_client
            .clone()
    }
}

fn load_ssh_connection_password(
    app_handle: &tauri::AppHandle,
    request: &CreateSessionRequest,
) -> AppResult<Option<(String, String)>> {
    let Some(ssh) = request.ssh.as_ref() else {
        return Ok(None);
    };
    if ssh.auth_method != Some(AuthMethod::Password) {
        return Ok(None);
    }
    let Some(machine_id) = ssh
        .machine_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let Some(machine_service) = app_handle.try_state::<Arc<SshMachineService>>() else {
        return Ok(None);
    };
    Ok(machine_service
        .load_connection_password(machine_id)?
        .map(|password| (machine_id.to_string(), password)))
}

fn sync_ssh_password(
    client: &TerminalDaemonClient,
    credentials: Option<&(String, String)>,
) -> AppResult<()> {
    if let Some((machine_id, password)) = credentials {
        client.set_temporary_ssh_password(machine_id, password)?;
    }
    Ok(())
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::models::{CliTool, CreateSessionRequest, TerminalReplaySnapshot};
    use crate::services::terminal_service::SessionOutput;
    use crate::services::{SessionStatusInfo, TerminalBackend};
    use crate::utils::{AppError, AppResult};
    use cc_panes_core::models::LaunchProviderSelection;

    use super::*;

    struct MockBackend;

    struct FailingBackend {
        calls: Arc<AtomicUsize>,
        message: &'static str,
    }

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

    impl TerminalBackend for FailingBackend {
        fn create_session(&self, _request: CreateSessionRequest) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(AppError::from(self.message))
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
                lines: Vec::new(),
            })
        }

        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            Ok(None)
        }
    }

    fn test_request() -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: None,
            project_path: "/tmp/project".to_string(),
            cols: 80,
            rows: 24,
            workspace_name: None,
            provider_id: None,
            model_id: None,
            provider_selection: LaunchProviderSelection::None,
            launch_profile_id: None,
            workspace_path: None,
            workspace_snapshot_id: None,
            origin_layout_id: None,
            origin_tab_id: None,
            origin_terminal_pane_id: None,
            expected_saved_session_id: None,
            launch_claude: false,
            cli_tool: CliTool::None,
            resume_id: None,
            skip_mcp: true,
            append_system_prompt: None,
            initial_prompt: None,
            yolo_mode: None,
            adapter_options: None,
            extra_env: None,
            ssh: None,
            wsl: None,
        }
    }

    fn daemon_state(backend: Arc<dyn TerminalBackend>) -> TerminalBackendState {
        TerminalBackendState {
            inner: Arc::new(RwLock::new(TerminalBackendStateInner {
                backend,
                kind: TerminalBackendKind::Daemon,
                daemon_client: Some(TerminalDaemonClient::new("127.0.0.1:1", "old-token")),
            })),
            daemon_upgrade_lock: Arc::new(Mutex::new(())),
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

    #[test]
    fn recovery_declined_returns_original_business_error() {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = daemon_state(Arc::new(FailingBackend {
            calls: calls.clone(),
            message: "business error",
        }));
        let recovery_checks = AtomicUsize::new(0);

        let error = state
            .create_session_recovering(
                test_request(),
                |_| {
                    recovery_checks.fetch_add(1, Ordering::SeqCst);
                    None
                },
                |_| {},
            )
            .err()
            .expect("business error must be preserved");

        assert!(error.to_string().contains("business error"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(recovery_checks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn outage_retries_once_and_returns_the_recovered_backend() {
        let first_calls = Arc::new(AtomicUsize::new(0));
        let state = daemon_state(Arc::new(FailingBackend {
            calls: first_calls.clone(),
            message: "daemon down",
        }));
        let recovered_backend: Arc<dyn TerminalBackend> = Arc::new(MockBackend);
        let expected_backend = recovered_backend.clone();
        let recovery_calls = AtomicUsize::new(0);

        let created = state
            .create_session_recovering(
                test_request(),
                |_| {
                    recovery_calls.fetch_add(1, Ordering::SeqCst);
                    Some(RecoveredTerminalDaemon {
                        client: TerminalDaemonClient::new("127.0.0.1:2", "new-token"),
                        backend: recovered_backend,
                    })
                },
                |_| {},
            )
            .expect("recovered session");

        assert_eq!(created.session_id, "mock-session");
        assert!(Arc::ptr_eq(&created.backend, &expected_backend));
        assert!(Arc::ptr_eq(&state.backend(), &expected_backend));
        assert_eq!(state.daemon_client().unwrap().addr(), "127.0.0.1:2");
        assert_eq!(first_calls.load(Ordering::SeqCst), 1);
        assert_eq!(recovery_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn recovered_backend_failure_is_not_retried_again() {
        let first_calls = Arc::new(AtomicUsize::new(0));
        let recovered_calls = Arc::new(AtomicUsize::new(0));
        let state = daemon_state(Arc::new(FailingBackend {
            calls: first_calls.clone(),
            message: "daemon down",
        }));
        let recovered_backend: Arc<dyn TerminalBackend> = Arc::new(FailingBackend {
            calls: recovered_calls.clone(),
            message: "retry failed",
        });
        let recovery_calls = AtomicUsize::new(0);
        let control_link_updates = AtomicUsize::new(0);

        let error = state
            .create_session_recovering(
                test_request(),
                |_| {
                    recovery_calls.fetch_add(1, Ordering::SeqCst);
                    Some(RecoveredTerminalDaemon {
                        client: TerminalDaemonClient::new("127.0.0.1:2", "new-token"),
                        backend: recovered_backend,
                    })
                },
                |_| {
                    control_link_updates.fetch_add(1, Ordering::SeqCst);
                },
            )
            .err()
            .expect("second failure must be returned");

        assert!(error.to_string().contains("retry failed"));
        assert_eq!(first_calls.load(Ordering::SeqCst), 1);
        assert_eq!(recovered_calls.load(Ordering::SeqCst), 1);
        assert_eq!(recovery_calls.load(Ordering::SeqCst), 1);
        assert_eq!(control_link_updates.load(Ordering::SeqCst), 1);
    }
}
