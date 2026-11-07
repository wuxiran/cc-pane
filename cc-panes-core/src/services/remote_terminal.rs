//! 远程设备上的终端会话（docs/111-multi-device.md 阶段 3）。
//!
//! 对端 cc-panes-web 的会话 API 与 cc-panes-daemon 同构（`/api/sessions*`、`/ws/{id}`，
//! WS 消息同为 output/exit/killed/desync），所以远程会话直接复用
//! `DaemonTerminalBackend` + 桌面端现有的 daemon 事件桥，只是地址换成设备的
//! 端口转发、令牌换成设备令牌。
//!
//! - `DeviceTerminalBackend`：某台设备的会话后端；每次调用解析设备端点，SSH 隧道重建
//!   （本地端口变化）或令牌更新后自动换用新的 client。
//! - `RemoteSessionRouter`：会话 id → 设备的登记表，落盘（`remote-sessions.json`），
//!   应用重启后已打开的远程标签仍能重连。
//! - `RoutingTerminalBackend`：对调用方透明——登记过的会话走设备，其余走本地后端。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use crate::models::{
    CreateSessionRequest, StoreCheckpointOutcome, TerminalCheckpoint, TerminalRecoverySnapshot,
    TerminalReplaySnapshot, TerminalSessionProvenance,
};
use crate::models::{ResourcePolicyStatus, SessionResourcePolicy};
use crate::services::terminal_output_flow::OutputFlowDiagnostics;
use crate::services::terminal_service::{KillReason, SessionOutput, SessionStatus};
use crate::services::{
    AutomaticWriteAuthority, CreateSessionOutcome, DaemonTerminalBackend, DeviceService,
    SessionPublisher, SessionStatusInfo, TerminalAdoptionSnapshot, TerminalBackend,
    TerminalDaemonClient, TerminalLinkContext,
};
use crate::utils::atomic_file::write_atomic;
use crate::utils::error::AppError;
use crate::utils::AppResult;

pub const REMOTE_SESSIONS_FILE: &str = "remote-sessions.json";

/// 某台设备上的会话后端。
pub struct DeviceTerminalBackend {
    device_id: String,
    devices: Arc<DeviceService>,
    current: Mutex<Option<(String, String, Arc<DaemonTerminalBackend>)>>,
    /// 最近一次拿到的会话状态。事件桥会定期按会话查状态，这里顺手记下，
    /// 让全局状态查询（`get_all_status`）不必为远程会话打网络。
    last_status: Mutex<HashMap<String, SessionStatusInfo>>,
}

impl DeviceTerminalBackend {
    pub fn new(device_id: impl Into<String>, devices: Arc<DeviceService>) -> Self {
        Self {
            device_id: device_id.into(),
            devices,
            current: Mutex::new(None),
            last_status: Mutex::new(HashMap::new()),
        }
    }

    pub fn cached_status(&self, session_id: &str) -> Option<SessionStatusInfo> {
        self.last_status
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(session_id)
            .cloned()
    }

    fn remember_status(&self, session_id: &str, status: &Option<SessionStatusInfo>) {
        let mut cache = self
            .last_status
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        match status {
            Some(status) => {
                cache.insert(session_id.to_string(), status.clone());
            }
            None => {
                cache.remove(session_id);
            }
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    fn inner(&self) -> AppResult<Arc<DaemonTerminalBackend>> {
        let endpoint = self
            .devices
            .endpoint(&self.device_id)
            .map_err(|error| AppError::from(format!("{error:#}")))?;
        let addr = endpoint
            .base_url
            .strip_prefix("http://")
            .ok_or_else(|| {
                AppError::from(
                    "Remote terminals need an http:// device address (use the Tailscale IP or an SSH device)",
                )
            })?
            .trim_end_matches('/')
            .to_string();
        let token = endpoint
            .token
            .ok_or_else(|| AppError::from("This device has no access token yet"))?;
        let mut current = self.current.lock().unwrap_or_else(|err| err.into_inner());
        if let Some((cached_addr, cached_token, backend)) = current.as_ref() {
            if *cached_addr == addr && *cached_token == token {
                return Ok(backend.clone());
            }
        }
        let backend = Arc::new(DaemonTerminalBackend::new(TerminalDaemonClient::new(
            addr.clone(),
            token.clone(),
        )));
        *current = Some((addr, token, backend.clone()));
        Ok(backend)
    }

    /// 网络错误后调用：丢掉隧道和 client，下次重建。
    pub fn reset(&self) {
        self.devices.drop_forward(&self.device_id);
        *self.current.lock().unwrap_or_else(|err| err.into_inner()) = None;
    }

    fn with<T>(&self, call: impl Fn(&DaemonTerminalBackend) -> AppResult<T>) -> AppResult<T> {
        let backend = self.inner()?;
        match call(&backend) {
            Err(error) if is_transport_error(&error) => {
                // 隧道可能挂在已断开的 SSH 会话上：重建一次再试。
                self.reset();
                call(self.inner()?.as_ref())
            }
            other => other,
        }
    }
}

fn is_transport_error(error: &AppError) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    [
        "connection refused",
        "connection reset",
        "broken pipe",
        "timed out",
        "unexpected eof",
        "os error",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

impl TerminalBackend for DeviceTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        // 创建不重试：失败时无法确定对端是否已经起了进程。
        self.inner()?.create_session(request)
    }
    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        self.inner()?.create_session_with_outcome(request)
    }
    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.with(|backend| backend.write(session_id, data))
    }
    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.with(|backend| backend.write_reply(session_id, data))
    }
    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.with(|backend| backend.submit_text_to_session(session_id, text))
    }
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.with(|backend| backend.resize(session_id, cols, rows))
    }
    fn kill(&self, session_id: &str) -> AppResult<()> {
        self.with(|backend| backend.kill(session_id))
    }
    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        self.with(|backend| backend.kill_with_reason(session_id, reason))
    }
    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        self.with(|backend| backend.get_all_status())
    }
    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        let status = self.with(|backend| backend.get_session_status(session_id))?;
        self.remember_status(session_id, &status);
        Ok(status)
    }
    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        self.with(|backend| backend.get_session_output(session_id, lines))
    }
    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        self.with(|backend| backend.get_session_replay_snapshot(session_id))
    }
    fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        self.with(|backend| backend.get_session_recovery_snapshot(session_id))
    }
    fn event_stream_url(&self, session_id: &str) -> Option<String> {
        self.inner().ok()?.event_stream_url(session_id)
    }
}

/// 会话 id → 设备 id 登记表。
pub struct RemoteSessionRouter {
    path: PathBuf,
    devices: Arc<DeviceService>,
    sessions: RwLock<HashMap<String, String>>,
    backends: Mutex<HashMap<String, Arc<DeviceTerminalBackend>>>,
}

impl RemoteSessionRouter {
    pub fn new(path: PathBuf, devices: Arc<DeviceService>) -> Self {
        let sessions = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<HashMap<String, String>>(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            devices,
            sessions: RwLock::new(sessions),
            backends: Mutex::new(HashMap::new()),
        }
    }

    pub fn devices(&self) -> &Arc<DeviceService> {
        &self.devices
    }

    /// 已登记远程会话的最近已知状态（不打网络）。
    pub fn cached_statuses(&self) -> Vec<SessionStatusInfo> {
        let sessions = self
            .sessions
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        let backends = self.backends.lock().unwrap_or_else(|err| err.into_inner());
        sessions
            .iter()
            .filter_map(|(session_id, device_id)| {
                backends.get(device_id)?.cached_status(session_id)
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .is_empty()
    }

    pub fn device_backend(&self, device_id: &str) -> Arc<DeviceTerminalBackend> {
        self.backends
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .entry(device_id.to_string())
            .or_insert_with(|| {
                Arc::new(DeviceTerminalBackend::new(device_id, self.devices.clone()))
            })
            .clone()
    }

    pub fn device_of(&self, session_id: &str) -> Option<String> {
        self.sessions
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .get(session_id)
            .cloned()
    }

    pub fn backend_for_session(&self, session_id: &str) -> Option<Arc<DeviceTerminalBackend>> {
        let device_id = self.device_of(session_id)?;
        // 设备已被移除：登记作废，交回本地后端（会得到"会话不存在"）。
        self.devices.get(&device_id)?;
        Some(self.device_backend(&device_id))
    }

    pub fn register(&self, session_id: &str, device_id: &str) {
        let mut sessions = self.sessions.write().unwrap_or_else(|err| err.into_inner());
        sessions.insert(session_id.to_string(), device_id.to_string());
        self.persist(&sessions);
    }

    pub fn unregister(&self, session_id: &str) {
        let mut sessions = self.sessions.write().unwrap_or_else(|err| err.into_inner());
        if sessions.remove(session_id).is_some() {
            self.persist(&sessions);
        }
    }

    /// 移除设备时一并清掉它的会话登记。
    pub fn forget_device(&self, device_id: &str) {
        let mut sessions = self.sessions.write().unwrap_or_else(|err| err.into_inner());
        let before = sessions.len();
        sessions.retain(|_, owner| owner != device_id);
        if sessions.len() != before {
            self.persist(&sessions);
        }
        self.backends
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(device_id);
    }

    fn persist(&self, sessions: &HashMap<String, String>) {
        let result = serde_json::to_string_pretty(sessions)
            .map_err(anyhow::Error::from)
            .and_then(|json| write_atomic(&self.path, json));
        if let Err(error) = result {
            tracing::warn!(%error, "failed to persist remote session registry");
        }
    }
}

/// 透明路由：登记为远程的会话走对应设备，其余全部走本地后端。
///
/// 全局性的调用（列出全部状态、认领快照、launch 相关）只看本地：远程会话的状态由
/// 事件桥按会话轮询 / 推流，不能让每次全局查询都打一遍网络。
pub struct RoutingTerminalBackend {
    local: Arc<dyn TerminalBackend>,
    router: Arc<RemoteSessionRouter>,
}

impl RoutingTerminalBackend {
    pub fn new(local: Arc<dyn TerminalBackend>, router: Arc<RemoteSessionRouter>) -> Self {
        Self { local, router }
    }

    fn route(&self, session_id: &str) -> Arc<dyn TerminalBackend> {
        match self.router.backend_for_session(session_id) {
            Some(remote) => remote,
            None => self.local.clone(),
        }
    }
}

impl TerminalBackend for RoutingTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        self.local.create_session(request)
    }
    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        self.local.create_session_with_outcome(request)
    }
    fn create_session_published(
        &self,
        request: CreateSessionRequest,
        publisher: &SessionPublisher,
    ) -> AppResult<CreateSessionOutcome> {
        self.local.create_session_published(request, publisher)
    }
    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.route(session_id).write(session_id, data)
    }
    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.route(session_id).write_reply(session_id, data)
    }
    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.route(session_id)
            .submit_text_to_session(session_id, text)
    }
    fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        self.route(session_id).is_paste_ready(session_id)
    }
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.route(session_id).resize(session_id, cols, rows)
    }
    fn kill(&self, session_id: &str) -> AppResult<()> {
        let result = self.route(session_id).kill(session_id);
        if result.is_ok() {
            self.router.unregister(session_id);
        }
        result
    }
    fn release_owned_sessions(&self) -> AppResult<()> {
        self.local.release_owned_sessions()
    }
    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        let result = self.route(session_id).kill_with_reason(session_id, reason);
        if result.is_ok() {
            self.router.unregister(session_id);
        }
        result
    }
    fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        self.local.cancel_launch(launch_id)
    }
    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        let mut statuses = self.local.get_all_status()?;
        statuses.extend(self.router.cached_statuses());
        Ok(statuses)
    }
    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        self.route(session_id).get_session_status(session_id)
    }
    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        self.route(session_id).get_session_output(session_id, lines)
    }
    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        self.route(session_id)
            .get_session_replay_snapshot(session_id)
    }
    fn store_session_checkpoint(
        &self,
        session_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        self.route(session_id)
            .store_session_checkpoint(session_id, checkpoint)
    }
    fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        self.route(session_id)
            .get_session_recovery_snapshot(session_id)
    }
    fn ack_terminal_output(&self, session_id: &str, processed_end_seq: u64) {
        self.route(session_id)
            .ack_terminal_output(session_id, processed_end_seq)
    }
    fn get_terminal_flow_diagnostics(&self, session_id: &str) -> Option<OutputFlowDiagnostics> {
        self.route(session_id)
            .get_terminal_flow_diagnostics(session_id)
    }
    fn set_shared_mcp_url_override(&self, urls: Option<HashMap<String, String>>) {
        self.local.set_shared_mcp_url_override(urls)
    }
    fn apply_scrollback_setting(&self, scrollback_rows: u32) {
        self.local.apply_scrollback_setting(scrollback_rows)
    }
    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        self.local.find_session_id_by_launch_id(launch_id)
    }
    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        self.route(session_id).apply_hook_status(session_id, status)
    }
    fn set_resource_policy(
        &self,
        session_id: &str,
        policy: SessionResourcePolicy,
    ) -> AppResult<ResourcePolicyStatus> {
        self.route(session_id)
            .set_resource_policy(session_id, policy)
    }
    fn clear_job_memory_warning(&self, session_id: &str) -> AppResult<bool> {
        self.route(session_id).clear_job_memory_warning(session_id)
    }
    fn event_stream_url(&self, session_id: &str) -> Option<String> {
        self.route(session_id).event_stream_url(session_id)
    }
    fn adopt_session(&self, session_id: &str) -> AppResult<bool> {
        self.route(session_id).adopt_session(session_id)
    }
    fn release_session(&self, session_id: &str) -> AppResult<()> {
        self.route(session_id).release_session(session_id)
    }
    fn session_claims(&self) -> AppResult<HashMap<String, String>> {
        self.local.session_claims()
    }
    fn claims_supported(&self) -> bool {
        self.local.claims_supported()
    }
    fn automatic_write_authority(&self, session_id: &str) -> AppResult<AutomaticWriteAuthority> {
        self.route(session_id).automatic_write_authority(session_id)
    }
    fn adoption_snapshot(&self) -> AppResult<TerminalAdoptionSnapshot> {
        self.local.adoption_snapshot()
    }
    fn session_provenance(&self, session_id: &str) -> AppResult<Option<TerminalSessionProvenance>> {
        self.route(session_id).session_provenance(session_id)
    }
    fn terminal_link_context(&self, session_id: &str) -> AppResult<Option<TerminalLinkContext>> {
        self.route(session_id).terminal_link_context(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DeviceAddRequest, DeviceConnection};
    use crate::services::{
        MemoryDeviceTokenStore, SshConnectionService, SshCredentialService, SshMachineService,
    };

    fn devices(dir: &std::path::Path) -> Arc<DeviceService> {
        let credentials = Arc::new(SshCredentialService::new_memory());
        Arc::new(DeviceService::new(
            dir.join("devices.json"),
            Arc::new(MemoryDeviceTokenStore::default()),
            Arc::new(SshMachineService::new(
                dir.join("ssh-machines.json"),
                credentials.clone(),
            )),
            Arc::new(SshConnectionService::new(
                credentials,
                dir.join("ssh-known-hosts"),
            )),
        ))
    }

    #[test]
    fn registry_persists_and_drops_sessions_of_removed_devices() {
        let dir = tempfile::tempdir().expect("tempdir");
        let devices = devices(dir.path());
        let device = devices
            .add(DeviceAddRequest {
                name: "box".into(),
                connection: DeviceConnection::Direct {
                    base_url: "http://100.64.0.2:18765".into(),
                },
                token: Some("ccp_dev_x".into()),
            })
            .expect("device");
        let path = dir.path().join(REMOTE_SESSIONS_FILE);

        let router = RemoteSessionRouter::new(path.clone(), devices.clone());
        assert!(router.is_empty());
        router.register("s1", &device.id);
        assert!(router.backend_for_session("s1").is_some());
        assert!(router.backend_for_session("local").is_none());

        // 重启后登记仍在
        let reloaded = RemoteSessionRouter::new(path.clone(), devices.clone());
        assert_eq!(
            reloaded.device_of("s1").as_deref(),
            Some(device.id.as_str())
        );

        // 设备被删后不再路由（交回本地后端），forget_device 清理登记
        devices.remove(&device.id).expect("remove");
        assert!(reloaded.backend_for_session("s1").is_none());
        reloaded.forget_device(&device.id);
        assert!(reloaded.is_empty());
        assert!(RemoteSessionRouter::new(path, devices).is_empty());
    }
}
