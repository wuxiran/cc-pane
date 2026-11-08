//! Native Codex thread/turn sessions behind the same Agent Chat facade.
use super::*;
use crate::commands::turn_checkpoint_commands::run_checkpoint_job;
use cc_panes_core::services::codex_app_server::{
    CodexAppServer, CodexAppServerEvent, CodexAppServerOptions,
};
mod approvals;
mod history;
mod protocol;
mod runtime;
#[cfg(test)]
mod tests;

pub(super) const ENGINE: &str = "codex-app-server";
pub(super) type EventSink = Arc<dyn Fn(AcpChatEvent) + Send + Sync>;
struct ActiveTurn {
    run_id: String,
    checkpoint_id: String,
    turn_id: Option<String>,
    cancelled: bool,
    done: Option<oneshot::Sender<AppResult<String>>>,
}

pub(super) struct Session {
    chat_id: String,
    client: CodexAppServer,
    snapshot: RwLock<AcpChatSnapshot>,
    control: Mutex<()>,
    active: std::sync::Mutex<Option<ActiveTurn>>,
    journal: journal::RunJournal,
    checkpoints: Arc<cc_panes_core::services::TurnCheckpointService>,
    cwd: PathBuf,
    chats_dir: PathBuf,
    sink: EventSink,
    notifier: Arc<std::sync::RwLock<Option<AcpTurnNotifier>>>,
    models: RwLock<Vec<Value>>,
    selections: RwLock<Selections>,
    stream: std::sync::Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, approvals::PendingRequest>>,
    response_gate: Mutex<bool>,
    instance_id: String,
}
#[derive(Default)]
struct Selections {
    model: String,
    effort: String,
    mode: String,
}

impl AcpChatService {
    pub(super) async fn start_native(
        &self,
        app: AppHandle,
        chat_id: &str,
        spec: AcpLaunchSpec,
    ) -> AppResult<AcpChatSnapshot> {
        let tap = self.event_tap();
        let sink: EventSink = Arc::new(move |event| {
            tap_event(&tap, &event);
            if crate::webview_reliability::webview_emits_allowed() {
                if let Err(error) = app.emit(ACP_CHAT_EVENT, event) {
                    tracing::debug!(%error, "Native Agent event delivery failed");
                }
            }
        });
        self.start_native_inner(chat_id, spec, sink).await
    }

    #[cfg(test)]
    pub(super) async fn start_native_with(
        &self,
        chat_id: &str,
        spec: AcpLaunchSpec,
        sink: EventSink,
    ) -> AppResult<AcpChatSnapshot> {
        let _lifecycle = self.lock_chat_lifecycle(chat_id).await;
        self.start_native_inner(chat_id, spec, sink).await
    }

    async fn start_native_inner(
        &self,
        chat_id: &str,
        spec: AcpLaunchSpec,
        sink: EventSink,
    ) -> AppResult<AcpChatSnapshot> {
        let mut spec = spec;
        let cwd = dunce::canonicalize(&spec.cwd)
            .map_err(|error| AppError::from(format!("Invalid native Codex directory: {error}")))?;
        if !cwd.is_dir() {
            return Err(AppError::from("Native Codex directory is not a folder"));
        }
        spec.cwd = cwd.to_string_lossy().into_owned();
        self.stop_locked(chat_id).await?;
        let (client, events) = CodexAppServer::spawn(self.native_options(&spec)).await?;
        let session = Arc::new(Session::new(self, chat_id, &spec, client, sink));
        self.native_sessions
            .write()
            .await
            .insert(chat_id.into(), session.clone());
        tokio::spawn(Session::read_events(session.clone(), events));
        session.emit_state().await;
        match session.handshake(&spec).await {
            Ok(snapshot) => {
                self.write_chat_meta(
                    snapshot.acp_session_id.as_deref().unwrap_or_default(),
                    ENGINE,
                    &spec.cwd,
                    None,
                );
                Ok(snapshot)
            }
            Err(error) => {
                let detail = error.to_string();
                let _ = session.stop(Some(detail.clone())).await;
                let mut sessions = self.native_sessions.write().await;
                if sessions
                    .get(chat_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    sessions.remove(chat_id);
                }
                Err(AppError::coded("CODEX_NATIVE_START_FAILED", detail))
            }
        }
    }

    fn native_options(&self, spec: &AcpLaunchSpec) -> CodexAppServerOptions {
        let mut options = CodexAppServerOptions {
            cwd: PathBuf::from(&spec.cwd),
            executable: Some(PathBuf::from(&spec.command)),
            arguments: spec.args.clone(),
            experimental_api: true,
            request_timeout: Duration::from_secs(30),
            ..Default::default()
        };
        if let Some(ctl) = self.ctl_env_path() {
            options
                .env
                .insert(cc_panes_core::services::SESSION_CTL_ENV_KEY.into(), ctl);
        }
        options
    }

    pub(super) async fn native_session(&self, chat_id: &str) -> Option<Arc<Session>> {
        self.native_sessions
            .read()
            .await
            .get(chat_id.trim())
            .cloned()
    }
}

impl Session {
    fn new(
        service: &AcpChatService,
        chat_id: &str,
        spec: &AcpLaunchSpec,
        client: CodexAppServer,
        sink: EventSink,
    ) -> Self {
        let snapshot = AcpChatSnapshot {
            chat_id: chat_id.into(),
            engine_id: ENGINE.into(),
            phase: AcpChatPhase::Starting,
            acp_session_id: None,
            codex_thread_id: None,
            agent_capabilities: None,
            protocol_version: None,
            modes: None,
            models: None,
            config_options: None,
            auto_approve_kinds: spec.auto_approve_kinds.clone(),
            exit_code: None,
            error: None,
        };
        Self {
            chat_id: chat_id.into(),
            client,
            snapshot: RwLock::new(snapshot),
            control: Mutex::new(()),
            active: std::sync::Mutex::new(None),
            journal: service.journal.clone(),
            checkpoints: service.checkpoints.clone(),
            cwd: PathBuf::from(&spec.cwd),
            chats_dir: service.chats_dir.clone(),
            sink,
            notifier: service.turn_notifier.clone(),
            models: RwLock::new(Vec::new()),
            selections: RwLock::new(Selections {
                mode: "workspace-write".into(),
                ..Default::default()
            }),
            stream: std::sync::Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            response_gate: Mutex::new(false),
            instance_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub(super) async fn snapshot(&self) -> AcpChatSnapshot {
        self.snapshot.read().await.clone()
    }
    async fn thread_id(&self) -> AppResult<String> {
        self.snapshot
            .read()
            .await
            .codex_thread_id
            .clone()
            .ok_or_else(|| AppError::from("Native Codex thread is not ready"))
    }
    fn emit(&self, kind: &str, payload: Value) {
        if let Some(active) = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            self.journal.event(&active.run_id, kind, &payload);
        }
        (self.sink)(AcpChatEvent {
            chat_id: self.chat_id.clone(),
            kind: kind.into(),
            payload,
        });
    }
    pub(in crate::services::acp_chat_service) fn emit_external(&self, kind: &str, payload: Value) {
        self.emit(kind, payload);
    }
    async fn emit_state(&self) {
        self.emit(
            "state",
            serde_json::to_value(self.snapshot().await).unwrap_or(Value::Null),
        );
    }
    async fn emit_update(&self, update: Value) {
        if let Ok(thread) = self.thread_id().await {
            self.emit("update", protocol::update(&thread, update));
        }
    }

    async fn handshake(&self, spec: &AcpLaunchSpec) -> AppResult<AcpChatSnapshot> {
        let mut params = json!({"cwd":spec.cwd,"sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"user","config":protocol::mcp_config(&spec.mcp_servers)});
        let method = if let Some(id) = &spec.fork_acp_session_id {
            params["threadId"] = json!(id);
            "thread/fork"
        } else if let Some(id) = &spec.resume_acp_session_id {
            params["threadId"] = json!(id);
            "thread/resume"
        } else {
            "thread/start"
        };
        let response = self.client.request(method, params).await?;
        let id = self.validate_thread(&response, spec)?;
        {
            let mut snapshot = self.snapshot.write().await;
            snapshot.acp_session_id = Some(id.clone()); // Compatibility identity for existing history and fork APIs.
            snapshot.codex_thread_id = Some(id);
            snapshot.agent_capabilities = Some(
                json!({"loadSession":true,"promptCapabilities":{"image":true},"sessionCapabilities":{"fork":{}},"_meta":{"protocol":"codex-app-server"}}),
            );
        }
        self.load_models().await?;
        {
            let mut options = self.selections.write().await;
            options.model = response["model"].as_str().unwrap_or_default().into();
            options.effort = response["reasoningEffort"]
                .as_str()
                .unwrap_or_default()
                .into();
        }
        self.refresh_options().await;
        if method != "thread/start" {
            self.replay(&response).await?;
        }
        let mut snapshot = self.snapshot.write().await;
        if snapshot.phase != AcpChatPhase::Starting {
            return Err(AppError::from("Codex exited during startup"));
        }
        snapshot.phase = AcpChatPhase::Ready;
        drop(snapshot);
        self.emit_state().await;
        Ok(self.snapshot().await)
    }

    fn validate_thread(&self, response: &Value, spec: &AcpLaunchSpec) -> AppResult<String> {
        let id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppError::from("Codex App Server returned no thread identity"))?
            .to_string();
        let returned_cwd = response["cwd"]
            .as_str()
            .ok_or_else(|| AppError::from("Codex returned no working directory"))?;
        let actual =
            dunce::canonicalize(returned_cwd).map_err(|error| AppError::from(error.to_string()))?;
        let expected =
            dunce::canonicalize(&spec.cwd).map_err(|error| AppError::from(error.to_string()))?;
        if actual != expected {
            return Err(AppError::from(
                "Codex started in a different working directory",
            ));
        }
        if spec.fork_acp_session_id.as_deref() == Some(id.as_str()) {
            return Err(AppError::from(
                "Codex fork returned the original thread identity",
            ));
        }
        if response
            .pointer("/thread/status/type")
            .and_then(Value::as_str)
            == Some("active")
        {
            return Err(AppError::from(
                "The Codex thread is already active; wait before resuming it",
            ));
        }
        Ok(id)
    }

    async fn load_models(&self) -> AppResult<()> {
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..20 {
            let response = self
                .client
                .request("model/list", json!({"limit":100,"cursor":cursor}))
                .await?;
            models.extend(
                response["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|entry| entry["hidden"] != true)
                    .cloned(),
            );
            cursor = response["nextCursor"].clone();
            if cursor.is_null() {
                *self.models.write().await = models;
                return Ok(());
            }
        }
        Err(AppError::from("Codex model list exceeded pagination limit"))
    }
    async fn refresh_options(&self) {
        let models = self.models.read().await;
        let options = self.selections.read().await;
        let config =
            protocol::config_options(&models, &options.model, &options.effort, &options.mode);
        apply_config_options(&mut *self.snapshot.write().await, config);
    }
    pub(super) async fn set_option(&self, key: &str, value: Value) -> AppResult<()> {
        let _control = self.control.lock().await;
        if self.snapshot.read().await.phase != AcpChatPhase::Ready {
            return Err(AppError::from(
                "Wait for the current Codex turn before changing settings",
            ));
        }
        let value = value
            .as_str()
            .ok_or_else(|| AppError::from("Configuration value must be a string"))?;
        let models = self.models.read().await;
        let mut options = self.selections.write().await;
        match key {
            "model" => {
                let model = models
                    .iter()
                    .find(|entry| entry["model"] == value)
                    .ok_or_else(|| {
                        AppError::from("Model is not advertised by this Codex server")
                    })?;
                options.model = value.into();
                options.effort = model["defaultReasoningEffort"]
                    .as_str()
                    .unwrap_or_default()
                    .into();
            }
            "mode" => {
                protocol::mode_policy(value)?;
                options.mode = value.into();
            }
            "reasoning_effort" => {
                let allowed = models
                    .iter()
                    .find(|entry| entry["model"] == options.model)
                    .and_then(|entry| entry["supportedReasoningEfforts"].as_array())
                    .is_some_and(|efforts| {
                        efforts
                            .iter()
                            .any(|entry| entry["reasoningEffort"] == value)
                    });
                if !allowed {
                    return Err(AppError::from(
                        "Reasoning effort is not advertised for the selected model",
                    ));
                }
                options.effort = value.into();
            }
            _ => return Err(AppError::from("Unknown native Codex configuration option")),
        }
        drop(options);
        drop(models);
        self.refresh_options().await;
        self.emit_state().await;
        Ok(())
    }
    pub(super) async fn set_auto_approve(&self, kinds: Vec<String>) -> AppResult<()> {
        self.snapshot.write().await.auto_approve_kinds = kinds
            .into_iter()
            .map(|kind| kind.trim().to_string())
            .filter(|kind| !kind.is_empty())
            .collect();
        self.emit_state().await;
        Ok(())
    }

    async fn read_events(
        session: Arc<Self>,
        mut events: tokio::sync::mpsc::Receiver<CodexAppServerEvent>,
    ) {
        while let Some(event) = events.recv().await {
            match event {
                CodexAppServerEvent::Notification { method, params } => {
                    if let Err(error) = session.notification(&method, params).await {
                        session.emit("notification",json!({"method":"ccpanes/native-error","params":{"error":error.to_string()}}));
                    }
                }
                CodexAppServerEvent::ServerRequest { id, method, params } => {
                    if let Err(error) = session.server_request(id.clone(), &method, params).await {
                        let _ = session
                            .client
                            .respond_error(id, -32603, &error.to_string())
                            .await;
                    }
                }
                CodexAppServerEvent::ProtocolError { message } => {
                    session.emit(
                        "notification",
                        json!({"method":"ccpanes/native-error","params":{"error":message}}),
                    );
                }
                CodexAppServerEvent::Exited { code } => {
                    let _control = session.control.lock().await;
                    if matches!(
                        session.snapshot.read().await.phase,
                        AcpChatPhase::Exited | AcpChatPhase::Failed
                    ) {
                        break;
                    }
                    session
                        .finish_turn("interrupted", Some("Codex App Server exited".into()), true)
                        .await;
                    let mut snapshot = session.snapshot.write().await;
                    if snapshot.phase != AcpChatPhase::Failed {
                        snapshot.phase = AcpChatPhase::Exited;
                    }
                    snapshot.exit_code = code;
                    drop(snapshot);
                    session.emit_state().await;
                    break;
                }
            }
        }
    }
}
