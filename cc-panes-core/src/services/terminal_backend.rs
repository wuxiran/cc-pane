use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::models::{
    CreateSessionRequest, StoreCheckpointOutcome, TerminalCheckpoint, TerminalRecoverySnapshot,
    TerminalReplaySnapshot, TerminalSessionProvenance,
};
use crate::services::daemon_client::TerminalDaemonClient;
use crate::services::terminal_service::KillReason;
use crate::services::terminal_service::SessionOutput;
use crate::services::terminal_service::SessionStatus;
use crate::services::terminal_service::TerminalService;
use crate::services::{SessionStatusInfo, TerminalLinkContext};
use crate::utils::error::AppError;
use crate::utils::AppResult;

/// One generation-consistent daemon snapshot used by startup reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAdoptionSnapshot {
    pub claims_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_instance_id: Option<String>,
    pub captured_at_ms: u64,
    pub complete: bool,
    pub sessions: Vec<SessionStatusInfo>,
    pub claims: std::collections::HashMap<String, String>,
    pub provenance: std::collections::HashMap<String, TerminalSessionProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomaticWriteAuthority {
    ExclusiveInProcess,
    EnforcedLease { owner_instance_id: String },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateSessionOutcome {
    pub session_id: String,
    pub reused_existing: bool,
    pub resolved_model_id: Option<String>,
}

fn current_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Backend boundary for terminal session operations.
///
/// The default implementation delegates to the in-process `TerminalService`.
/// Future daemon support should implement this trait without changing the
/// Tauri IPC command contract.
pub trait TerminalBackend: Send + Sync {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String>;
    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        let expected_session_id = request.expected_saved_session_id.clone();
        let resolved_model_id = request.model_id.clone();
        let session_id = self.create_session(request)?;
        Ok(CreateSessionOutcome {
            reused_existing: expected_session_id.as_deref() == Some(session_id.as_str()),
            session_id,
            resolved_model_id,
        })
    }
    fn write(&self, session_id: &str, data: &str) -> AppResult<()>;

    /// 写入前端代答的终端查询回复。默认等同 `write`；持有 PTY 的实现覆盖它，
    /// 以便在 tty 回显开着时抑制——那种情况下回复会变成可见垃圾并污染输入队列。
    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.write(session_id, data)
    }
    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()>;
    /// Returns whether the terminal has enabled DEC private mode 2004.
    /// Backends without a readiness bridge return false.
    fn is_paste_ready(&self, _session_id: &str) -> AppResult<bool> {
        Ok(false)
    }
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()>;
    fn kill(&self, session_id: &str) -> AppResult<()>;
    /// 带来源的 kill。默认委托 `kill`（reason 丢失），真实后端覆盖之以便
    /// `session-killed` 事件携带来源、前端分流关标签/保留标签。
    fn kill_with_reason(&self, session_id: &str, _reason: KillReason) -> AppResult<()> {
        self.kill(session_id)
    }
    /// Cancel an in-flight launch. Backends that cannot cancel before a session id exists may
    /// still kill a session already indexed by launch id; the default is best-effort.
    fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        if let Some(session_id) = self.find_session_id_by_launch_id(launch_id)? {
            match self.kill_with_reason(&session_id, KillReason::LaunchTimeout) {
                Ok(()) | Err(AppError::NotFound(_)) => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        }
    }
    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>>;
    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>>;
    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput>;
    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>>;
    /// 存储前端上传的画面照片（M3b-1）。默认不支持：daemon 客户端等远端后端
    /// 在 M3b-2/3 才接线，mock 后端不受影响。
    fn store_session_checkpoint(
        &self,
        _session_id: &str,
        _checkpoint: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        Err(AppError::from("checkpoint not supported by this backend"))
    }
    /// 读取 checkpoint+delta 结构化恢复快照（M3b-1）。默认不支持，同上。
    fn get_session_recovery_snapshot(
        &self,
        _session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        Err(AppError::from("checkpoint not supported by this backend"))
    }
    /// 按 launch_id 反查会话 id（launch_task 推导 parent_session_id 用）。
    /// daemon 模式下会话建在 daemon 进程，必须走 backend 而非 app 本地 service。
    /// 默认返回 `None`（不支持反查的后端，如测试 mock）；真实后端覆盖之。
    fn find_session_id_by_launch_id(&self, _launch_id: &str) -> AppResult<Option<String>> {
        Ok(None)
    }
    /// 把 hook 状态机决定的新 status 写回会话（更新 status Mutex + emit）。
    /// daemon 模式下会话在 daemon，写回必须打到 daemon，否则前端桥接轮询看不到细分状态。
    /// 默认 no-op；真实后端覆盖之。
    fn apply_hook_status(&self, _session_id: &str, _status: SessionStatus) -> AppResult<()> {
        Ok(())
    }
    fn event_stream_url(&self, _session_id: &str) -> Option<String> {
        None
    }

    /// 接管一条已存在的会话：**必须先拿到写权限才算接管成功**（docs/61 评审 #1）。
    ///
    /// 返回 `Ok(false)` = 被别的实例持有或会话已消失，调用方应保持只读、不要挂 leaf。
    /// 默认实现返回 `true`：进程内后端不存在跨实例竞争。
    fn adopt_session(&self, _session_id: &str) -> AppResult<bool> {
        Ok(true)
    }

    /// 放弃写权限但**不杀 PTY**（detach）。默认 no-op。
    fn release_session(&self, _session_id: &str) -> AppResult<()> {
        Ok(())
    }

    /// 当前所有有效租约：sessionId → ownerInstanceId。默认空表。
    fn session_claims(&self) -> AppResult<std::collections::HashMap<String, String>> {
        Ok(std::collections::HashMap::new())
    }

    /// 后端所连 daemon 是否真的做写权限裁决。
    /// **默认 false（fail-closed）**：不确定就不要开自动接管（评审 #11）。
    fn claims_supported(&self) -> bool {
        false
    }

    /// Proves whether this backend may perform unattended terminal writes.
    /// Unknown implementations fail closed by default.
    fn automatic_write_authority(&self, _session_id: &str) -> AppResult<AutomaticWriteAuthority> {
        Ok(AutomaticWriteAuthority::Unavailable)
    }

    /// Complete adoption snapshot. Non-daemon backends expose statuses but no ownership facts.
    fn adoption_snapshot(&self) -> AppResult<TerminalAdoptionSnapshot> {
        Ok(TerminalAdoptionSnapshot {
            claims_supported: false,
            daemon_generation: None,
            owner_instance_id: None,
            captured_at_ms: current_epoch_millis(),
            complete: true,
            sessions: self.get_all_status()?,
            claims: std::collections::HashMap::new(),
            provenance: std::collections::HashMap::new(),
        })
    }

    fn session_provenance(
        &self,
        _session_id: &str,
    ) -> AppResult<Option<TerminalSessionProvenance>> {
        Ok(None)
    }

    fn terminal_link_context(&self, _session_id: &str) -> AppResult<Option<TerminalLinkContext>> {
        Ok(None)
    }
}

#[derive(Clone)]
pub struct InProcessTerminalBackend {
    service: Arc<TerminalService>,
}

/// 续租间隔：取 daemon 侧 TTL(30s) 的三分之一，容忍两次连续失败仍不掉租。
const CLAIM_RENEW_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
/// 续租并发度。逐条同步续租撑不住规模：实测一个 daemon 可带 60+ 会话，
/// 单请求超时 2s，串行一轮最坏 120s，远超 30s TTL —— 租约会自己掉，
/// 然后被别的实例接手（docs/61 评审 #3）。
const CLAIM_RENEW_CONCURRENCY: usize = 16;
/// 一轮续租的总预算。超出即放弃本轮剩余项，等下一轮，
/// 避免慢 daemon 让续租线程无限堆积。
const CLAIM_RENEW_ROUND_BUDGET: std::time::Duration = std::time::Duration::from_secs(18);

/// 丢租通知钩子。续租线程跑在后台，丢租若只写日志，用户会遇到"这个终端突然
/// 打不了字了"而毫无解释（docs/61 评审 #3/#9）。宿主（Tauri/web）注册回调后
/// 可以把它转成事件推给前端，让 UI 切成持久只读态。
pub type ClaimLostHook = Box<dyn Fn(&str) + Send + Sync>;
static CLAIM_LOST_HOOK: std::sync::OnceLock<ClaimLostHook> = std::sync::OnceLock::new();

/// 注册丢租回调。只允许注册一次（后续调用被忽略），避免多处覆盖导致通知丢失。
pub fn set_claim_lost_hook(hook: ClaimLostHook) {
    let _ = CLAIM_LOST_HOOK.set(hook);
}

fn report_claim_lost(session_id: &str) {
    if let Some(hook) = CLAIM_LOST_HOOK.get() {
        hook(session_id);
    }
}

#[derive(Clone)]
pub struct DaemonTerminalBackend {
    client: TerminalDaemonClient,
    /// 本实例持有写权限的会话集合（docs/61 阶段 2）。
    /// 由创建者写入，续租线程按此表定期续约；丢租时移除并告警。
    ///
    /// 续租线程只持 `Weak`：本类型是 `Clone` 的，用 `Drop` 停线程会让任意一个克隆
    /// 析构就掐掉所有实例的续租。改成最后一个 backend 释放时 upgrade 失败自然退出。
    owned_sessions:
        Arc<std::sync::Mutex<std::collections::HashMap<String, Arc<OwnedSessionLease>>>>,
}

/// Per-session cancellation fence. Release and renewal serialize on this gate, so a renewal that
/// already took a snapshot cannot re-claim the daemon lease after detach has completed.
#[derive(Debug, Default)]
struct OwnedSessionLease {
    gate: std::sync::Mutex<()>,
}

impl InProcessTerminalBackend {
    pub fn new(service: Arc<TerminalService>) -> Self {
        Self { service }
    }
}

impl DaemonTerminalBackend {
    pub fn new(client: TerminalDaemonClient) -> Self {
        let owned_sessions = Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            String,
            Arc<OwnedSessionLease>,
        >::new()));
        // 续租线程：租约是 TTL 制，不续就会过期，别的实例便可接手。
        // 单独起线程而不是挂在请求路径上——用户长时间不操作的会话同样要保住写权限。
        {
            let client = client.clone();
            let owned = Arc::downgrade(&owned_sessions);
            if let Err(error) = std::thread::Builder::new()
                .name("cc-panes-claim-renew".to_string())
                .spawn(move || {
                    loop {
                        std::thread::sleep(CLAIM_RENEW_INTERVAL);
                        // 所有 backend 都已释放 → 退出，不再续租。
                        let Some(owned) = owned.upgrade() else { break };
                        let sessions: Vec<(String, Arc<OwnedSessionLease>)> = match owned.lock() {
                            Ok(guard) => guard
                                .iter()
                                .map(|(session_id, lease)| (session_id.clone(), lease.clone()))
                                .collect(),
                            Err(_) => continue,
                        };
                        let round_started = std::time::Instant::now();
                        // 分批并发续租：批内并行、批间检查预算。
                        for chunk in sessions.chunks(CLAIM_RENEW_CONCURRENCY) {
                            if round_started.elapsed() >= CLAIM_RENEW_ROUND_BUDGET {
                                tracing::warn!(
                                    remaining = sessions.len(),
                                    "claim renew round exceeded budget; deferring rest"
                                );
                                break;
                            }
                            let handles: Vec<_> = chunk
                                .iter()
                                .map(|(session_id, lease)| {
                                    let client = client.clone();
                                    let session_id = session_id.clone();
                                    let lease = lease.clone();
                                    let owned = owned.clone();
                                    std::thread::spawn(move || {
                                        let Ok(_gate) = lease.gate.lock() else {
                                            return (session_id, None);
                                        };
                                        let still_owned = owned
                                            .lock()
                                            .ok()
                                            .and_then(|guard| guard.get(&session_id).cloned())
                                            .is_some_and(|current| Arc::ptr_eq(&current, &lease));
                                        if !still_owned {
                                            return (session_id, None);
                                        }
                                        let outcome = client.claim_session(&session_id, None);
                                        (session_id, Some(outcome))
                                    })
                                })
                                .collect();

                            for handle in handles {
                                let Ok((session_id, Some(outcome))) = handle.join() else {
                                    continue;
                                };
                                match outcome {
                                    Ok(true) => {}
                                    Ok(false) => {
                                        // 被别的实例接手, 或会话已消失。不重试抢占：
                                        // 两个实例交替抢租约会让输入交错。
                                        tracing::warn!(
                                            session_id = %session_id,
                                            "lost session write claim; dropping to read-only"
                                        );
                                        if let Ok(mut guard) = owned.lock() {
                                            guard.remove(&session_id);
                                        }
                                        report_claim_lost(&session_id);
                                    }
                                    Err(error) => {
                                        tracing::debug!(
                                            session_id = %session_id,
                                            err = %error,
                                            "claim renew failed; will retry next tick"
                                        );
                                    }
                                }
                            }
                        }
                    }
                })
            {
                tracing::error!(err = %error, "failed to start session claim renew thread");
                report_claim_lost("");
            }
        }

        Self {
            client,
            owned_sessions,
        }
    }

    fn remember_owned(&self, session_id: &str) {
        if let Ok(mut owned) = self.owned_sessions.lock() {
            owned
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(OwnedSessionLease::default()));
        }
    }

    fn release_owned(&self, session_id: &str) -> AppResult<()> {
        let lease = self
            .owned_sessions
            .lock()
            .ok()
            .and_then(|owned| owned.get(session_id).cloned());
        let Some(lease) = lease else {
            return self.client.release_session_claim(session_id);
        };
        let _gate = lease
            .gate
            .lock()
            .map_err(|_| AppError::from("session claim release lock poisoned"))?;
        if let Ok(mut owned) = self.owned_sessions.lock() {
            if owned
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &lease))
            {
                owned.remove(session_id);
            }
        }
        self.client.release_session_claim(session_id)
    }
}

impl TerminalBackend for TerminalService {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        TerminalService::create_session(
            self,
            request.launch_id.as_deref(),
            &request.project_path,
            request.cols,
            request.rows,
            request.workspace_name.as_deref(),
            request.provider_id.as_deref(),
            request.model_id.as_deref(),
            request.provider_selection,
            request.launch_profile_id.as_deref(),
            request.workspace_path.as_deref(),
            request.workspace_snapshot_id.as_deref(),
            request.effective_cli_tool(),
            request.resume_id.as_deref(),
            request.skip_mcp,
            request.append_system_prompt.as_deref(),
            request.initial_prompt.as_deref(),
            request.yolo_mode,
            request.adapter_options.as_ref(),
            request.extra_env.as_ref(),
            request.ssh.as_ref(),
            request.wsl.as_ref(),
        )
        .map_err(|error| {
            error
                .downcast_ref::<AppError>()
                .cloned()
                .unwrap_or_else(|| AppError::from(error))
        })
    }

    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        TerminalService::create_session_with_outcome(
            self,
            request.launch_id.as_deref(),
            &request.project_path,
            request.cols,
            request.rows,
            request.workspace_name.as_deref(),
            request.provider_id.as_deref(),
            request.model_id.as_deref(),
            request.provider_selection,
            request.launch_profile_id.as_deref(),
            request.workspace_path.as_deref(),
            request.workspace_snapshot_id.as_deref(),
            request.effective_cli_tool(),
            request.resume_id.as_deref(),
            request.skip_mcp,
            request.append_system_prompt.as_deref(),
            request.initial_prompt.as_deref(),
            request.yolo_mode,
            request.adapter_options.as_ref(),
            request.extra_env.as_ref(),
            request.ssh.as_ref(),
            request.wsl.as_ref(),
        )
        .map_err(|error| {
            error
                .downcast_ref::<AppError>()
                .cloned()
                .unwrap_or_else(|| AppError::from(error))
        })
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        TerminalService::write(self, session_id, data).map_err(AppError::from)
    }

    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        TerminalService::write_reply(self, session_id, data).map_err(AppError::from)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        TerminalService::submit_text_to_session(self, session_id, text)
    }

    fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        TerminalService::is_paste_ready(self, session_id)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        TerminalService::resize(self, session_id, cols, rows).map_err(AppError::from)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        TerminalService::kill(self, session_id)
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        TerminalService::kill_with_reason(self, session_id, reason)
    }

    fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        TerminalService::cancel_launch(self, launch_id)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        TerminalService::get_all_status(self).map_err(AppError::from)
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        TerminalService::get_session_status(self, session_id).map_err(AppError::from)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        TerminalService::get_session_output(self, session_id, lines).map_err(AppError::from)
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        TerminalService::get_session_replay_snapshot(self, session_id).map_err(AppError::from)
    }

    fn store_session_checkpoint(
        &self,
        session_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        TerminalService::store_session_checkpoint(self, session_id, checkpoint)
    }

    fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        TerminalService::get_session_recovery_snapshot(self, session_id)
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        Ok(TerminalService::find_session_id_by_launch_id(
            self, launch_id,
        ))
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        TerminalService::apply_hook_status(self, session_id, status);
        Ok(())
    }

    fn terminal_link_context(&self, session_id: &str) -> AppResult<Option<TerminalLinkContext>> {
        TerminalService::terminal_link_context(self, session_id)
    }

    fn automatic_write_authority(&self, _session_id: &str) -> AppResult<AutomaticWriteAuthority> {
        Ok(AutomaticWriteAuthority::ExclusiveInProcess)
    }
}

impl TerminalBackend for InProcessTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        <TerminalService as TerminalBackend>::create_session(self.service.as_ref(), request)
    }

    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        <TerminalService as TerminalBackend>::create_session_with_outcome(
            self.service.as_ref(),
            request,
        )
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::write(self.service.as_ref(), session_id, data)
    }

    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::write_reply(self.service.as_ref(), session_id, data)
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::submit_text_to_session(
            self.service.as_ref(),
            session_id,
            text,
        )
    }

    fn is_paste_ready(&self, session_id: &str) -> AppResult<bool> {
        <TerminalService as TerminalBackend>::is_paste_ready(self.service.as_ref(), session_id)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        <TerminalService as TerminalBackend>::resize(self.service.as_ref(), session_id, cols, rows)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::kill(self.service.as_ref(), session_id)
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        <TerminalService as TerminalBackend>::kill_with_reason(
            self.service.as_ref(),
            session_id,
            reason,
        )
    }

    fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        <TerminalService as TerminalBackend>::cancel_launch(self.service.as_ref(), launch_id)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        <TerminalService as TerminalBackend>::get_all_status(self.service.as_ref())
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        <TerminalService as TerminalBackend>::get_session_status(self.service.as_ref(), session_id)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        <TerminalService as TerminalBackend>::get_session_output(
            self.service.as_ref(),
            session_id,
            lines,
        )
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        <TerminalService as TerminalBackend>::get_session_replay_snapshot(
            self.service.as_ref(),
            session_id,
        )
    }

    fn store_session_checkpoint(
        &self,
        session_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        <TerminalService as TerminalBackend>::store_session_checkpoint(
            self.service.as_ref(),
            session_id,
            checkpoint,
        )
    }

    fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        <TerminalService as TerminalBackend>::get_session_recovery_snapshot(
            self.service.as_ref(),
            session_id,
        )
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        <TerminalService as TerminalBackend>::find_session_id_by_launch_id(
            self.service.as_ref(),
            launch_id,
        )
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        <TerminalService as TerminalBackend>::apply_hook_status(
            self.service.as_ref(),
            session_id,
            status,
        )
    }

    fn terminal_link_context(&self, session_id: &str) -> AppResult<Option<TerminalLinkContext>> {
        self.service.terminal_link_context(session_id)
    }

    fn automatic_write_authority(&self, _session_id: &str) -> AppResult<AutomaticWriteAuthority> {
        Ok(AutomaticWriteAuthority::ExclusiveInProcess)
    }
}

impl TerminalBackend for DaemonTerminalBackend {
    fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        self.create_session_with_outcome(request)
            .map(|outcome| outcome.session_id)
    }

    fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<CreateSessionOutcome> {
        let outcome = self.client.create_session_with_outcome(request)?;
        let session_id = &outcome.session_id;
        // 创建者即所有者：立刻 claim，之后由续租线程保活。
        // claim 失败不影响会话可用性（daemon 无租约时放行），所以只告警不回滚。
        match self.client.claim_session(session_id, None) {
            Ok(true) => {
                self.remember_owned(session_id);
            }
            Ok(false) => tracing::warn!(
                session_id = %session_id,
                "newly created session is already claimed by another instance"
            ),
            Err(error) => tracing::warn!(
                session_id = %session_id,
                err = %error,
                "failed to claim newly created session"
            ),
        }
        Ok(outcome)
    }

    fn write(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.client.write_session(session_id, data)
    }

    fn write_reply(&self, session_id: &str, data: &str) -> AppResult<()> {
        // 会话在 daemon 进程，ECHO 只能由持有 PTY 的那一侧判定，这里只负责把来源带过去。
        self.client
            .write_session_with_source(session_id, data, Some("system"))
    }

    fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.client.submit_text_to_session(session_id, text)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.client.resize_session(session_id, cols, rows)
    }

    fn kill(&self, session_id: &str) -> AppResult<()> {
        let result = self.client.kill_session(session_id);
        if result.is_ok() {
            if let Ok(mut owned) = self.owned_sessions.lock() {
                owned.remove(session_id);
            }
        }
        result
    }

    fn adopt_session(&self, session_id: &str) -> AppResult<bool> {
        let granted = self.client.claim_session(session_id, None)?;
        if granted {
            self.remember_owned(session_id);
        }
        Ok(granted)
    }

    fn release_session(&self, session_id: &str) -> AppResult<()> {
        self.release_owned(session_id)
    }

    fn session_claims(&self) -> AppResult<std::collections::HashMap<String, String>> {
        self.client.list_session_claims()
    }

    fn claims_supported(&self) -> bool {
        self.client.claims_supported()
    }

    fn automatic_write_authority(&self, session_id: &str) -> AppResult<AutomaticWriteAuthority> {
        if !self.client.claims_supported() {
            return Ok(AutomaticWriteAuthority::Unavailable);
        }

        let locally_owned = self
            .owned_sessions
            .lock()
            .ok()
            .is_some_and(|owned| owned.contains_key(session_id));
        if !locally_owned {
            return Ok(AutomaticWriteAuthority::Unavailable);
        }

        let live_session = self
            .client
            .get_session_status(session_id)
            .ok()
            .flatten()
            .is_some_and(|status| !status.status.is_terminal());
        if !live_session {
            return Ok(AutomaticWriteAuthority::Unavailable);
        }

        Ok(AutomaticWriteAuthority::EnforcedLease {
            owner_instance_id: self.client.instance_id().to_string(),
        })
    }

    fn adoption_snapshot(&self) -> AppResult<TerminalAdoptionSnapshot> {
        self.client.adoption_snapshot()
    }

    fn session_provenance(&self, session_id: &str) -> AppResult<Option<TerminalSessionProvenance>> {
        self.client.get_session_provenance(session_id)
    }

    fn terminal_link_context(&self, session_id: &str) -> AppResult<Option<TerminalLinkContext>> {
        let Some(status) = self.client.get_session_status(session_id)? else {
            return Ok(None);
        };
        if status.status.is_terminal() {
            return Ok(None);
        }
        Ok(self
            .client
            .get_session_provenance(session_id)?
            .map(|provenance| TerminalLinkContext {
                project_path: provenance.project_path,
                runtime_kind: provenance.runtime_kind,
            }))
    }

    fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        let result = self.client.kill_session_with_reason(session_id, reason);
        if result.is_ok() {
            if let Ok(mut owned) = self.owned_sessions.lock() {
                owned.remove(session_id);
            }
        }
        result
    }

    fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        self.client.cancel_launch(launch_id)
    }

    fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
        self.client.list_sessions()
    }

    fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        self.client.get_session_status(session_id)
    }

    fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        self.client.get_session_output(session_id, lines)
    }

    fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        self.client.get_session_replay_snapshot(session_id)
    }

    fn store_session_checkpoint(
        &self,
        session_id: &str,
        checkpoint: TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        // 转发 daemon REST（M3b-2）。旧 daemon 无此路由时 client 返回
        // CHECKPOINT_UNSUPPORTED 结构化错误，供前端 capability 探测关断。
        self.client.upload_checkpoint(session_id, &checkpoint)
    }

    fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        // 转发 daemon REST（M3b-3）。旧 daemon 缺路由 → CHECKPOINT_UNSUPPORTED，
        // 命令层回落旧 replay snapshot 包装成纯 delta 形状。
        self.client.get_session_recovery_snapshot(session_id)
    }

    fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        self.client.find_session_id_by_launch_id(launch_id)
    }

    fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        self.client.apply_hook_status(session_id, status)
    }

    fn event_stream_url(&self, session_id: &str) -> Option<String> {
        Some(self.client.websocket_url(session_id))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use crate::models::{CliTool, TerminalBufferMode};
    use crate::services::terminal_service::SessionStatus;

    use super::*;

    fn http_json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn spawn_response_server(response: String) -> (SocketAddr, mpsc::Receiver<String>) {
        spawn_response_sequence(vec![response])
    }

    fn spawn_response_sequence(responses: Vec<String>) -> (SocketAddr, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
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
                let request = String::from_utf8(request_bytes).expect("utf8 request");
                tx.send(request).ok();
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });
        (addr, rx)
    }

    fn backend_for(addr: SocketAddr) -> DaemonTerminalBackend {
        DaemonTerminalBackend::new(
            TerminalDaemonClient::new(addr.to_string(), "secret")
                .with_timeout(Duration::from_secs(1)),
        )
    }

    fn daemon_status_response(claims_supported: Option<bool>) -> String {
        let claims_supported = claims_supported
            .map(|value| format!(r#", "claimsSupported":{value}"#))
            .unwrap_or_default();
        http_json_response(
            "200 OK",
            &format!(
                r#"{{"status":"ok","version":"test","pid":1,"addr":"127.0.0.1:0","startedAt":1,"sessionCount":1{claims_supported}}}"#
            ),
        )
    }

    #[test]
    fn daemon_automatic_write_authority_fails_closed_for_legacy_daemon() {
        let (addr, _) = spawn_response_server(daemon_status_response(None));
        let backend = backend_for(addr);
        backend.remember_owned("s1");

        assert_eq!(
            backend
                .automatic_write_authority("s1")
                .expect("authority query"),
            AutomaticWriteAuthority::Unavailable
        );
    }

    #[test]
    fn daemon_automatic_write_authority_requires_local_owned_lease() {
        let (addr, _) = spawn_response_server(daemon_status_response(Some(true)));
        let backend = backend_for(addr);

        assert_eq!(
            backend
                .automatic_write_authority("s1")
                .expect("authority query"),
            AutomaticWriteAuthority::Unavailable
        );
    }

    #[test]
    fn daemon_automatic_write_authority_reports_enforced_owned_lease() {
        let live_session =
            r#"{"sessionId":"s1","status":"idle","lastOutputAt":10,"pid":42,"updatedAt":20}"#;
        let (addr, _) = spawn_response_sequence(vec![
            daemon_status_response(Some(true)),
            http_json_response("200 OK", live_session),
        ]);
        let backend = backend_for(addr);
        backend.remember_owned("s1");

        assert_eq!(
            backend
                .automatic_write_authority("s1")
                .expect("authority query"),
            AutomaticWriteAuthority::EnforcedLease {
                owner_instance_id: backend.client.instance_id().to_string(),
            }
        );
    }

    #[test]
    fn daemon_automatic_write_authority_rejects_exited_session() {
        let exited_session = r#"{"sessionId":"s1","status":"exited","lastOutputAt":10,"pid":42,"exitCode":0,"updatedAt":20}"#;
        let (addr, _) = spawn_response_sequence(vec![
            daemon_status_response(Some(true)),
            http_json_response("200 OK", exited_session),
        ]);
        let backend = backend_for(addr);
        backend.remember_owned("s1");

        assert_eq!(
            backend
                .automatic_write_authority("s1")
                .expect("authority query"),
            AutomaticWriteAuthority::Unavailable
        );
    }

    fn create_request() -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: None,
            project_path: "/repo".to_string(),
            cols: 120,
            rows: 30,
            workspace_name: None,
            provider_id: None,
            model_id: None,
            provider_selection: Default::default(),
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
            skip_mcp: false,
            append_system_prompt: None,
            initial_prompt: None,
            yolo_mode: None,
            adapter_options: None,
            extra_env: Some(std::collections::HashMap::from([(
                "RUNNER_ENV".to_string(),
                "1".to_string(),
            )])),
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn daemon_backend_maps_terminal_operations_to_client() {
        let (addr, rx) =
            spawn_response_server(http_json_response("201 Created", r#"{"sessionId":"s1"}"#));
        let backend = backend_for(addr);

        let session_id = backend.create_session(create_request()).expect("create");

        assert_eq!(session_id, "s1");
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions HTTP/1.1"));
        assert!(request.contains(r#""extraEnv":{"RUNNER_ENV":"1"}"#));

        let (addr, rx) = spawn_response_server(
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_string(),
        );
        let backend = backend_for(addr);

        backend.write("s1", "abc").expect("write");

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/s1/write HTTP/1.1"));
    }

    #[test]
    fn daemon_backend_maps_status_output_and_snapshot_payloads() {
        let status_body = r#"[{"sessionId":"s1","status":"exited","lastOutputAt":10,"pid":42,"exitCode":7,"updatedAt":20}]"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", status_body));
        let backend = backend_for(addr);

        let statuses = backend.get_all_status().expect("statuses");

        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, SessionStatus::Exited);
        assert_eq!(statuses[0].exit_code, Some(7));

        let output_body = r#"{"sessionId":"s1","lines":["ready"]}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", output_body));
        let backend = backend_for(addr);

        let output = backend.get_session_output("s1", 20).expect("output");

        assert_eq!(output.session_id, "s1");
        assert_eq!(output.lines, vec!["ready"]);

        let snapshot_body = r#"{"data":"\u001b[2J","bufferMode":"normal"}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", snapshot_body));
        let backend = backend_for(addr);

        let snapshot = backend
            .get_session_replay_snapshot("s1")
            .expect("snapshot")
            .expect("some snapshot");

        assert_eq!(snapshot.buffer_mode, TerminalBufferMode::Normal);
    }

    #[test]
    fn daemon_backend_maps_missing_snapshot_to_none() {
        let (addr, _) = spawn_response_server(http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
        ));
        let backend = backend_for(addr);

        let snapshot = backend
            .get_session_replay_snapshot("missing")
            .expect("result");

        assert!(snapshot.is_none());
    }

    #[test]
    fn daemon_backend_derives_terminal_link_context_from_provenance() {
        let status =
            r#"{"sessionId":"s1","status":"idle","lastOutputAt":10,"pid":42,"updatedAt":20}"#;
        let provenance = r#"{"sessionId":"s1","daemonGeneration":42,"birthNonce":"birth-1","projectPath":"C:/repo","runtimeKind":"wsl","cliTool":"codex","createdAtMs":100}"#;
        let (addr, rx) = spawn_response_sequence(vec![
            http_json_response("200 OK", status),
            http_json_response("200 OK", provenance),
        ]);
        let backend = backend_for(addr);

        let context = backend
            .terminal_link_context("s1")
            .expect("context query")
            .expect("provenance context");

        assert_eq!(context.project_path, "C:/repo");
        assert_eq!(context.runtime_kind, "wsl");
        assert!(rx
            .recv()
            .expect("status request")
            .starts_with("GET /api/sessions/s1/status HTTP/1.1"));
        assert!(rx
            .recv()
            .expect("provenance request")
            .starts_with("GET /api/sessions/s1/provenance HTTP/1.1"));
    }

    #[test]
    fn daemon_backend_fails_closed_without_provenance() {
        let status =
            r#"{"sessionId":"s1","status":"idle","lastOutputAt":10,"pid":42,"updatedAt":20}"#;
        let (addr, _) = spawn_response_sequence(vec![
            http_json_response("200 OK", status),
            http_json_response(
                "404 Not Found",
                r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
            ),
        ]);
        let backend = backend_for(addr);

        assert!(backend
            .terminal_link_context("missing")
            .expect("context query")
            .is_none());
    }

    /// 覆写守卫：trait 默认实现是 `Err("checkpoint not supported")`，
    /// 忘了覆写不会编译报错——只会让 daemon 模式下的 checkpoint 恢复静默退化成
    /// 「这个后端不支持」，全量重放，无任何报错。两个覆写各钉一条转发证据。
    #[test]
    fn daemon_backend_forwards_recovery_snapshot_instead_of_defaulting_to_unsupported() {
        let body = r#"{"checkpoint":null,"delta":"TAIL","bufferMode":"normal","endSeq":9,"checkpointEpoch":7}"#;
        let (addr, rx) = spawn_response_server(http_json_response("200 OK", body));
        let backend = backend_for(addr);

        let snapshot = backend
            .get_session_recovery_snapshot("s1")
            .expect("must not fall through to the unsupported default")
            .expect("present snapshot");

        assert_eq!(snapshot.delta, "TAIL");
        assert_eq!(snapshot.end_seq, 9);
        assert!(rx
            .recv()
            .expect("captured request")
            .starts_with("GET /api/sessions/s1/recovery-snapshot HTTP/1.1"));
    }

    #[test]
    fn daemon_backend_forwards_checkpoint_upload_instead_of_defaulting_to_unsupported() {
        let (addr, rx) = spawn_response_server(http_json_response(
            "200 OK",
            r#"{"accepted":true,"anchorSeq":5}"#,
        ));
        let backend = backend_for(addr);

        let outcome = backend
            .store_session_checkpoint(
                "s1",
                TerminalCheckpoint {
                    checkpoint_epoch: 7,
                    anchor_seq: 5,
                    snapshot_ansi: "PHOTO".to_string(),
                    buffer_mode: TerminalBufferMode::Normal,
                    cols: 80,
                    rows: 24,
                    checkpointed_at_ms: 1,
                },
            )
            .expect("must not fall through to the unsupported default");

        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 5 });
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/s1/checkpoint HTTP/1.1"));
        assert!(request.contains("\"snapshotAnsi\":\"PHOTO\""));
    }

    #[test]
    fn daemon_backend_fails_closed_for_exited_sessions() {
        let status = r#"{"sessionId":"s1","status":"exited","lastOutputAt":10,"pid":42,"exitCode":0,"updatedAt":20}"#;
        let (addr, rx) = spawn_response_server(http_json_response("200 OK", status));
        let backend = backend_for(addr);

        assert!(backend
            .terminal_link_context("s1")
            .expect("context query")
            .is_none());
        assert!(rx
            .recv()
            .expect("status request")
            .starts_with("GET /api/sessions/s1/status HTTP/1.1"));
    }
}
