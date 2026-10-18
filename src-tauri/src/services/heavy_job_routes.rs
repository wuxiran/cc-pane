//! 重负载门禁的 REST 面（docs/107 P6 / W8），挂在 orchestrator 路由 `/api/heavy-jobs/*`。
//!
//! 为什么放 orchestrator 而不是 daemon：WSL 会话只能到达 app 的 orchestrator
//! （`CC_PANES_API_BASE_URL` + 主机重写），到不了 daemon 的 127.0.0.1。
//!
//! 门禁纯逻辑在 `cc_panes_core::services::heavy_job_gate`；这里负责：
//! - 每次 acquire 前从设置重读 `GateConfig`（切开关即时生效）；
//! - 长轮询（≤ 25 s）：排队期间等 `release`/`reap` 的通知再重试，到点返回 `Queued`；
//! - 拿槽时下发 `set_resource_policy(lower_priority)`、归还时回填台账、位次变化发事件——
//!   三者都经 [`HeavyJobEnvironment`] 抽象，路由测试用记录器替身。
//!
//! 载荷（camelCase）：
//! - `POST /acquire {sessionId, cmd, wait?, label?, priority?}` →
//!   `{outcome:"granted", leaseId, sessionId, target, forced}` |
//!   `{outcome:"queued", position, total}` | `{outcome:"passthrough", reason}`
//! - `POST /release {leaseId, exitCode?, durationMs?}` → `{released}`
//! - `POST /heartbeat {leaseId}` → `{alive}`
//! - `GET /` → `GateSnapshot`

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use cc_panes_core::models::{ResourcePolicyStatus, SessionResourcePolicy};
use cc_panes_core::services::heavy_job_gate::{
    AcquireOutcome, AcquireRequest, GateConfig, HeavyJobGate, Lease, QueuePositions,
};
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tracing::{debug, info, warn};

/// 长轮询上限。ctl 客户端超时须大于它（ctl 用 35 s）。
pub const LONG_POLL_MAX: Duration = Duration::from_secs(25);
/// 无人轮询时的后台回收周期（持槽方 60 s 静默才回收，15 s 足够及时）。
const REAPER_INTERVAL: Duration = Duration::from_secs(15);
/// 发给前端的排队事件名。`queued:false` = 该会话不再排队（拿到槽 / 放弃 / 透传）。
pub const HEAVY_QUEUE_CHANGED_EVENT: &str = "heavy-queue-changed";
/// 门禁强制放行时写进台账 `offloaded_reason` 的标记。
pub const FORCED_REASON: &str = "gate-forced-timeout";

/// 门禁与外界的接缝：设置、资源策略、台账、事件。
pub trait HeavyJobEnvironment: Send + Sync {
    fn gate_config(&self) -> GateConfig;
    /// 拿到槽位（含强制放行）。实现应尽力下发 lower_priority，不得阻塞太久。
    fn on_granted(&self, lease: &Lease);
    /// 归还 / 回收。`exit_code` / `duration_ms` 只有 ctl 正常归还时才有。
    fn on_released(&self, lease: &Lease, exit_code: Option<i32>, duration_ms: Option<u64>);
    /// 某会话的排队位次变化；`None` = 不再排队。
    fn on_queue_changed(&self, session_id: &str, position: Option<(u32, u32)>);
}

pub struct HeavyJobGateState {
    token: String,
    gate: Mutex<HeavyJobGate>,
    notify: Notify,
    env: Arc<dyn HeavyJobEnvironment>,
    last_positions: Mutex<QueuePositions>,
    long_poll_max: Duration,
}

impl HeavyJobGateState {
    pub fn new(token: String, env: Arc<dyn HeavyJobEnvironment>) -> Self {
        Self::with_long_poll(token, env, LONG_POLL_MAX)
    }

    pub fn with_long_poll(
        token: String,
        env: Arc<dyn HeavyJobEnvironment>,
        long_poll_max: Duration,
    ) -> Self {
        let gate = HeavyJobGate::new(env.gate_config());
        Self {
            token,
            gate: Mutex::new(gate),
            notify: Notify::new(),
            env,
            last_positions: Mutex::new(QueuePositions::new()),
            long_poll_max,
        }
    }

    /// 后台回收：ctl 全被 kill 时没人再来轮询，靠它清静默租约 / 失联等待者并发事件。
    pub fn spawn_reaper(self: &Arc<Self>) {
        let state = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(REAPER_INTERVAL);
            loop {
                ticker.tick().await;
                let Some(state) = state.upgrade() else {
                    break;
                };
                state.reap_now();
            }
        });
    }

    fn reap_now(&self) {
        let now = Instant::now();
        let (report, changed) = {
            let mut gate = self.gate.lock();
            gate.configure(self.env.gate_config());
            let report = gate.reap(now);
            let changed = self.diff_positions(&gate);
            (report, changed)
        };
        self.publish(changed);
        if !report.dropped_leases.is_empty() || !report.dropped_waiters.is_empty() {
            self.notify.notify_waiters();
        }
        for lease in &report.dropped_leases {
            warn!(
                lease = %lease.id,
                session = %lease.session_id,
                "[heavy-gate] lease reclaimed after heartbeat silence"
            );
            self.env.on_released(lease, None, None);
        }
        for session in &report.forced {
            warn!(session = %session, "[heavy-gate] waiter timed out; forced grant");
        }
    }

    /// 一次同步的 acquire 步骤（配置重读 + reap + acquire + 事件 diff）。
    fn step_acquire(&self, now: Instant, request: AcquireRequest) -> AcquireOutcome {
        let (outcome, report, changed) = {
            let mut gate = self.gate.lock();
            gate.configure(self.env.gate_config());
            let report = gate.reap(now);
            let outcome = gate.acquire(now, request);
            let changed = self.diff_positions(&gate);
            (outcome, report, changed)
        };
        self.publish(changed);
        for lease in &report.dropped_leases {
            warn!(lease = %lease.id, "[heavy-gate] lease reclaimed after heartbeat silence");
            self.env.on_released(lease, None, None);
        }
        if !report.dropped_leases.is_empty() {
            self.notify.notify_waiters();
        }
        if let AcquireOutcome::Granted(lease) = &outcome {
            info!(
                lease = %lease.id,
                session = %lease.session_id,
                cmd = %lease.cmd_normalized,
                forced = lease.forced,
                "[heavy-gate] slot granted"
            );
            self.env.on_granted(lease);
        }
        outcome
    }

    fn release(&self, lease_id: &str, exit_code: Option<i32>, duration_ms: Option<u64>) -> bool {
        let now = Instant::now();
        let (released, changed) = {
            let mut gate = self.gate.lock();
            gate.configure(self.env.gate_config());
            let released = gate.release(now, lease_id);
            let changed = self.diff_positions(&gate);
            (released, changed)
        };
        self.publish(changed);
        self.notify.notify_waiters();
        match released {
            Some(lease) => {
                debug!(lease = %lease.id, session = %lease.session_id, "[heavy-gate] released");
                self.env.on_released(&lease, exit_code, duration_ms);
                true
            }
            None => false,
        }
    }

    fn heartbeat(&self, lease_id: &str) -> bool {
        self.gate.lock().heartbeat(Instant::now(), lease_id)
    }

    /// 持锁期间计算位次变化；发事件留到放锁后。
    fn diff_positions(&self, gate: &HeavyJobGate) -> Vec<(String, Option<(u32, u32)>)> {
        let current = gate.queue_positions();
        let mut last = self.last_positions.lock();
        let mut changed = Vec::new();
        for (session, position) in &current {
            if last.get(session) != Some(position) {
                changed.push((session.clone(), Some(*position)));
            }
        }
        for session in last.keys() {
            if !current.contains_key(session) {
                changed.push((session.clone(), None));
            }
        }
        *last = current;
        changed
    }

    fn publish(&self, changed: Vec<(String, Option<(u32, u32)>)>) {
        for (session, position) in changed {
            self.env.on_queue_changed(&session, position);
        }
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| token == self.token)
    }
}

pub fn router(state: Arc<HeavyJobGateState>) -> Router {
    Router::new()
        .route("/", get(handle_list))
        .route("/acquire", post(handle_acquire))
        .route("/release", post(handle_release))
        .route("/heartbeat", post(handle_heartbeat))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcquireBody {
    session_id: String,
    cmd: String,
    #[serde(default)]
    wait: bool,
    #[serde(default)]
    label: Option<String>,
    /// 小者优先；缺省 1。前台会话的判定留给调用方（目前 ctl 不传 → 全 1）。
    #[serde(default)]
    priority: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseBody {
    lease_id: String,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatBody {
    lease_id: String,
}

fn unauthorized() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "Invalid or missing Bearer token" })),
    )
        .into_response()
}

fn outcome_json(outcome: &AcquireOutcome) -> serde_json::Value {
    match outcome {
        AcquireOutcome::Granted(lease) => serde_json::json!({
            "outcome": "granted",
            "leaseId": lease.id,
            "sessionId": lease.session_id,
            "target": lease.target.as_str(),
            "forced": lease.forced,
        }),
        AcquireOutcome::Queued { position, total } => serde_json::json!({
            "outcome": "queued",
            "position": position,
            "total": total,
        }),
        AcquireOutcome::Passthrough(reason) => serde_json::json!({
            "outcome": "passthrough",
            "reason": reason,
        }),
    }
}

async fn handle_acquire(
    headers: HeaderMap,
    State(state): State<Arc<HeavyJobGateState>>,
    Json(body): Json<AcquireBody>,
) -> axum::response::Response {
    if !state.authorized(&headers) {
        return unauthorized();
    }
    if body.session_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "sessionId is required" })),
        )
            .into_response();
    }
    let cmd_normalized = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| cc_panes_core::services::heavy_command_normalize::normalize(&body.cmd));
    let request = AcquireRequest {
        session_id: body.session_id.trim().to_string(),
        cmd_normalized,
        priority: body.priority.unwrap_or(1),
    };
    // 已在排队的会话再来轮询（ctl 每 ≤25 s 一次）：把当前位次再发一遍当心跳。前端的
    // `queued` chip 靠它续命（60 s TTL），丢一条 `queued:false` 不会留下永远不灭的 chip。
    let refresh = state
        .last_positions
        .lock()
        .get(&request.session_id)
        .copied();
    if let Some(position) = refresh {
        state
            .env
            .on_queue_changed(&request.session_id, Some(position));
    }
    let deadline = Instant::now() + state.long_poll_max;
    loop {
        let outcome = state.step_acquire(Instant::now(), request.clone());
        let now = Instant::now();
        if !matches!(outcome, AcquireOutcome::Queued { .. }) || !body.wait || now >= deadline {
            return Json(outcome_json(&outcome)).into_response();
        }
        let remaining = deadline.saturating_duration_since(now);
        tokio::select! {
            _ = state.notify.notified() => {}
            _ = tokio::time::sleep(remaining.min(Duration::from_secs(1))) => {}
        }
    }
}

async fn handle_release(
    headers: HeaderMap,
    State(state): State<Arc<HeavyJobGateState>>,
    Json(body): Json<ReleaseBody>,
) -> axum::response::Response {
    if !state.authorized(&headers) {
        return unauthorized();
    }
    let released = state.release(&body.lease_id, body.exit_code, body.duration_ms);
    Json(serde_json::json!({ "released": released })).into_response()
}

async fn handle_heartbeat(
    headers: HeaderMap,
    State(state): State<Arc<HeavyJobGateState>>,
    Json(body): Json<HeartbeatBody>,
) -> axum::response::Response {
    if !state.authorized(&headers) {
        return unauthorized();
    }
    let alive = state.heartbeat(&body.lease_id);
    Json(serde_json::json!({ "alive": alive })).into_response()
}

async fn handle_list(
    headers: HeaderMap,
    State(state): State<Arc<HeavyJobGateState>>,
) -> axum::response::Response {
    if !state.authorized(&headers) {
        return unauthorized();
    }
    state.reap_now();
    let snapshot = state.gate.lock().snapshot(Instant::now());
    Json(snapshot).into_response()
}

// ============ app 侧实现 ============

/// 兜底环境：lib.rs 没来得及 manage 门禁状态时让路由仍可挂载，一律透传。
pub struct DisabledHeavyJobEnvironment;

impl HeavyJobEnvironment for DisabledHeavyJobEnvironment {
    fn gate_config(&self) -> GateConfig {
        GateConfig::disabled()
    }
    fn on_granted(&self, _lease: &Lease) {}
    fn on_released(&self, _lease: &Lease, _exit_code: Option<i32>, _duration_ms: Option<u64>) {}
    fn on_queue_changed(&self, _session_id: &str, _position: Option<(u32, u32)>) {}
}

/// 门禁对会话策略的**只升不降**决策（纯逻辑，便于测试）。
///
/// 审查 #1：拿槽时无脑下发 `{lower_priority:true, eco_qos:false}` 会把用户在资源管理器里
/// 选的"效率模式"关掉（`reapply_policy` 对已开过 EcoQoS 的 Job 会照 `eco_qos:false` 清掉）。
/// 所以：
/// - 拿槽：会话已经让路 / 已在效率模式 → 什么都不做；否则只加 `lower_priority`，
///   权重 / EcoQoS 保持原样，并记住拿槽前的策略；
/// - 归还：只有当前状态仍是门禁设的那样（让路且非效率模式）才还原；用户中途在
///   UI 里改过（比如切到效率模式）就不碰——那是更新的意图。
pub(crate) fn grant_policy(current: &ResourcePolicyStatus) -> Option<SessionResourcePolicy> {
    if current.lower_priority || current.eco_qos {
        return None;
    }
    Some(SessionResourcePolicy {
        lower_priority: true,
        cpu_weight: current.cpu_weight,
        eco_qos: current.eco_qos,
        memory_notify_bytes: None,
    })
}

pub(crate) fn restore_policy(
    saved: &SessionResourcePolicy,
    current: &ResourcePolicyStatus,
) -> Option<SessionResourcePolicy> {
    let still_gate_shape = current.lower_priority && !current.eco_qos;
    still_gate_shape.then_some(SessionResourcePolicy {
        lower_priority: saved.lower_priority,
        cpu_weight: current.cpu_weight,
        eco_qos: saved.eco_qos,
        memory_notify_bytes: None,
    })
}

/// 记住门禁改过的会话（按租约 id），归还时据此还原。
#[derive(Default)]
pub(crate) struct GateEscalations {
    saved: Mutex<HashMap<String, SessionResourcePolicy>>,
}

impl GateEscalations {
    /// 拿槽：返回要下发的策略；`None` = 不动。`current = None`（SSH / 旧 daemon /
    /// 会话不在）也不动——看不到现状就不该改。
    pub(crate) fn plan_grant(
        &self,
        lease_id: &str,
        current: Option<&ResourcePolicyStatus>,
    ) -> Option<SessionResourcePolicy> {
        let current = current?;
        let policy = grant_policy(current)?;
        self.saved.lock().insert(
            lease_id.to_string(),
            SessionResourcePolicy {
                lower_priority: current.lower_priority,
                cpu_weight: current.cpu_weight,
                eco_qos: current.eco_qos,
                memory_notify_bytes: None,
            },
        );
        Some(policy)
    }

    /// 归还：门禁没改过这张租约 → `None`；改过则按 [`restore_policy`] 决定。记录一律清掉。
    pub(crate) fn plan_release(
        &self,
        lease_id: &str,
        current: Option<&ResourcePolicyStatus>,
    ) -> Option<SessionResourcePolicy> {
        let saved = self.saved.lock().remove(lease_id)?;
        restore_policy(&saved, current?)
    }

    #[cfg(test)]
    pub(crate) fn tracked(&self) -> usize {
        self.saved.lock().len()
    }
}

/// 真实环境：设置 → 配置；拿槽只升不降地下发 lower_priority、归还还原；归还回填台账；
/// 位次发 Tauri 事件。
pub struct AppHeavyJobEnvironment {
    settings: Arc<cc_panes_core::services::SettingsService>,
    terminal_backend: Arc<crate::services::TerminalBackendState>,
    ledger: Arc<cc_panes_core::repository::HeavyCommandsRepository>,
    emitter: Arc<dyn cc_panes_core::events::EventEmitter>,
    escalations: Arc<GateEscalations>,
}

impl AppHeavyJobEnvironment {
    pub fn new(
        settings: Arc<cc_panes_core::services::SettingsService>,
        terminal_backend: Arc<crate::services::TerminalBackendState>,
        ledger: Arc<cc_panes_core::repository::HeavyCommandsRepository>,
        emitter: Arc<dyn cc_panes_core::events::EventEmitter>,
    ) -> Self {
        Self {
            settings,
            terminal_backend,
            ledger,
            emitter,
            escalations: Arc::new(GateEscalations::default()),
        }
    }
}

/// 读会话当前策略状态（daemon 后端是一次 HTTP；失败视为看不见 → `None`）。
fn current_policy_status(
    backend: &dyn cc_panes_core::services::TerminalBackend,
    session_id: &str,
) -> Option<ResourcePolicyStatus> {
    match backend.get_session_status(session_id) {
        Ok(status) => status.and_then(|status| status.resource_policy),
        Err(error) => {
            debug!(session = %session_id, %error, "[heavy-gate] status lookup failed");
            None
        }
    }
}

impl HeavyJobEnvironment for AppHeavyJobEnvironment {
    fn gate_config(&self) -> GateConfig {
        let performance = self.settings.get_settings().performance;
        GateConfig {
            enabled: performance.heavy_gate_enabled,
            slots:
                performance.effective_heavy_slots(
                    cc_panes_core::models::performance_settings::logical_cores(),
                ),
            timeout: Duration::from_secs(u64::from(performance.heavy_gate_timeout_secs)),
        }
    }

    fn on_granted(&self, lease: &Lease) {
        // 让路：BELOW_NORMAL（Windows Job）/ nice，**只升不降**：会话已让路 / 已在效率模式
        // 就不碰（见 [`grant_policy`]）。daemon 后端是两次 HTTP，放 blocking 线程。
        let backend = self.terminal_backend.backend();
        let escalations = Arc::clone(&self.escalations);
        let session_id = lease.session_id.clone();
        let lease_id = lease.id.clone();
        tokio::task::spawn_blocking(move || {
            let current = current_policy_status(backend.as_ref(), &session_id);
            let Some(policy) = escalations.plan_grant(&lease_id, current.as_ref()) else {
                debug!(session = %session_id, ?current, "[heavy-gate] policy left as-is on grant");
                return;
            };
            match backend.set_resource_policy(&session_id, policy) {
                Ok(status) => {
                    debug!(session = %session_id, ?status, "[heavy-gate] lower_priority applied")
                }
                Err(error) => {
                    debug!(session = %session_id, %error, "[heavy-gate] set_resource_policy failed (best effort)")
                }
            }
        });
    }

    fn on_released(&self, lease: &Lease, _exit_code: Option<i32>, _duration_ms: Option<u64>) {
        // 台账行由 hook 记录器写（时长 / 退出码已在那边），这里只回填 target / 原因；
        // 并把拿槽时改过的策略还原（用户中途改过就不碰，见 [`restore_policy`]）。
        let ledger = self.ledger.clone();
        let backend = self.terminal_backend.backend();
        let escalations = Arc::clone(&self.escalations);
        let session_id = lease.session_id.clone();
        let lease_id = lease.id.clone();
        let cmd = lease.cmd_normalized.clone();
        let target = lease.target.as_str();
        let reason = lease.forced.then_some(FORCED_REASON);
        tokio::task::spawn_blocking(move || {
            if let Err(error) = ledger.mark_target(&session_id, &cmd, target, reason) {
                debug!(%error, "[heavy-gate] ledger mark_target failed (best effort)");
            }
            let current = current_policy_status(backend.as_ref(), &session_id);
            if let Some(policy) = escalations.plan_release(&lease_id, current.as_ref()) {
                match backend.set_resource_policy(&session_id, policy) {
                    Ok(status) => {
                        debug!(session = %session_id, ?status, "[heavy-gate] policy restored")
                    }
                    Err(error) => {
                        debug!(session = %session_id, %error, "[heavy-gate] restore failed (best effort)")
                    }
                }
            }
        });
    }

    fn on_queue_changed(&self, session_id: &str, position: Option<(u32, u32)>) {
        let payload = match position {
            Some((position, total)) => serde_json::json!({
                "sessionId": session_id,
                "position": position,
                "total": total,
                "queued": true,
            }),
            None => serde_json::json!({
                "sessionId": session_id,
                "position": 0,
                "total": 0,
                "queued": false,
            }),
        };
        if let Err(error) = self.emitter.emit(HEAVY_QUEUE_CHANGED_EVENT, payload) {
            debug!(%error, "[heavy-gate] failed to emit heavy-queue-changed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    type ReleasedRecord = (String, Option<i32>, Option<u64>);
    type QueueEvent = (String, Option<(u32, u32)>);

    struct RecordingEnv {
        config: Mutex<GateConfig>,
        granted: Mutex<Vec<String>>,
        released: Mutex<Vec<ReleasedRecord>>,
        queue_events: Mutex<Vec<QueueEvent>>,
    }

    impl RecordingEnv {
        fn with(config: GateConfig) -> Arc<Self> {
            Arc::new(Self {
                config: Mutex::new(config),
                granted: Mutex::new(Vec::new()),
                released: Mutex::new(Vec::new()),
                queue_events: Mutex::new(Vec::new()),
            })
        }
    }

    impl HeavyJobEnvironment for RecordingEnv {
        fn gate_config(&self) -> GateConfig {
            *self.config.lock()
        }
        fn on_granted(&self, lease: &Lease) {
            self.granted.lock().push(lease.session_id.clone());
        }
        fn on_released(&self, lease: &Lease, exit_code: Option<i32>, duration_ms: Option<u64>) {
            self.released
                .lock()
                .push((lease.session_id.clone(), exit_code, duration_ms));
        }
        fn on_queue_changed(&self, session_id: &str, position: Option<(u32, u32)>) {
            self.queue_events
                .lock()
                .push((session_id.to_string(), position));
        }
    }

    const TOKEN: &str = "test-token";

    fn status(lower_priority: bool, eco_qos: bool, cpu_weight: Option<u8>) -> ResourcePolicyStatus {
        ResourcePolicyStatus {
            outcome: cc_panes_core::models::PolicyOutcomeKind::Applied,
            reason: None,
            lower_priority,
            eco_qos,
            cpu_weight,
            wsl_scope: false,
        }
    }

    /// 审查 #1：拿槽只升不降——已让路 / 已效率模式的会话不动；普通会话只加 lower_priority
    /// 且保留权重。
    #[test]
    fn grant_only_escalates_and_keeps_user_choices() {
        assert_eq!(
            grant_policy(&status(true, false, None)),
            None,
            "already lowered"
        );
        assert_eq!(
            grant_policy(&status(false, true, None)),
            None,
            "eco qos is above"
        );
        assert_eq!(grant_policy(&status(true, true, Some(3))), None);
        assert_eq!(
            grant_policy(&status(false, false, Some(3))),
            Some(SessionResourcePolicy {
                lower_priority: true,
                cpu_weight: Some(3),
                eco_qos: false,
                memory_notify_bytes: None,
            }),
            "normal session: lower priority, weight untouched"
        );

        let escalations = GateEscalations::default();
        assert_eq!(
            escalations.plan_grant("L1", None),
            None,
            "unknown status → hands off"
        );
        assert_eq!(escalations.tracked(), 0);
        assert!(escalations
            .plan_grant("L2", Some(&status(false, true, None)))
            .is_none());
        assert_eq!(
            escalations.tracked(),
            0,
            "nothing to restore when nothing changed"
        );
        assert!(escalations
            .plan_grant("L3", Some(&status(false, false, Some(7))))
            .is_some());
        assert_eq!(escalations.tracked(), 1);
    }

    /// 审查 #1：归还只在状态仍是门禁设的形状时还原；用户中途改过（效率模式）就不碰。
    #[test]
    fn release_restores_only_what_the_gate_changed() {
        let escalations = GateEscalations::default();
        escalations.plan_grant("L1", Some(&status(false, false, Some(7))));
        assert_eq!(
            escalations.plan_release("L1", Some(&status(true, false, Some(7)))),
            Some(SessionResourcePolicy {
                lower_priority: false,
                cpu_weight: Some(7),
                eco_qos: false,
                memory_notify_bytes: None,
            })
        );
        assert_eq!(escalations.tracked(), 0, "record consumed");
        assert_eq!(
            escalations.plan_release("L1", Some(&status(true, false, None))),
            None,
            "second release of the same lease is a no-op"
        );

        // 用户在持槽期间切到效率模式：归还不还原
        escalations.plan_grant("L2", Some(&status(false, false, None)));
        assert_eq!(
            escalations.plan_release("L2", Some(&status(true, true, None))),
            None
        );
        assert_eq!(escalations.tracked(), 0);

        // 用户在持槽期间自己把让路关了：也不碰
        escalations.plan_grant("L3", Some(&status(false, false, None)));
        assert_eq!(
            escalations.plan_release("L3", Some(&status(false, false, None))),
            None
        );

        // 归还时看不到状态（会话已退出）：不碰
        escalations.plan_grant("L4", Some(&status(false, false, None)));
        assert_eq!(escalations.plan_release("L4", None), None);

        // 没拿过的租约：不碰
        assert_eq!(
            escalations.plan_release("never", Some(&status(true, false, None))),
            None
        );
    }

    fn enabled(slots: u32) -> GateConfig {
        GateConfig {
            enabled: true,
            slots,
            timeout: Duration::from_secs(300),
        }
    }

    fn app(env: Arc<RecordingEnv>, long_poll: Duration) -> Router {
        router(Arc::new(HeavyJobGateState::with_long_poll(
            TOKEN.to_string(),
            env,
            long_poll,
        )))
    }

    async fn post(
        app: &Router,
        path: &str,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn acquire(session: &str, wait: bool) -> serde_json::Value {
        serde_json::json!({ "sessionId": session, "cmd": "cargo build -p x", "wait": wait })
    }

    #[tokio::test]
    async fn rejects_missing_or_wrong_token() {
        let app = app(RecordingEnv::with(enabled(1)), Duration::from_millis(10));
        let (status, _) = post(&app, "/acquire", None, acquire("a", false)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = post(&app, "/acquire", Some("nope"), acquire("a", false)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = post(
            &app,
            "/release",
            None,
            serde_json::json!({ "leaseId": "x" }),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn disabled_gate_returns_passthrough_and_never_grants() {
        let env = RecordingEnv::with(GateConfig::disabled());
        let app = app(env.clone(), Duration::from_millis(10));
        let (status, json) = post(&app, "/acquire", Some(TOKEN), acquire("a", true)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["outcome"], "passthrough");
        assert_eq!(json["reason"], "gate disabled");
        assert!(env.granted.lock().is_empty());
    }

    #[tokio::test]
    async fn grants_then_long_poll_returns_queued_after_deadline_and_emits_position() {
        let env = RecordingEnv::with(enabled(1));
        let app = app(env.clone(), Duration::from_millis(60));

        let (_, first) = post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        assert_eq!(first["outcome"], "granted");
        assert_eq!(first["target"], "local");
        assert_eq!(first["forced"], false);
        assert_eq!(env.granted.lock().as_slice(), ["a".to_string()]);

        let started = Instant::now();
        let (_, second) = post(&app, "/acquire", Some(TOKEN), acquire("b", true)).await;
        assert!(
            started.elapsed() >= Duration::from_millis(60),
            "must long-poll"
        );
        assert_eq!(second["outcome"], "queued");
        assert_eq!(second["position"], 1);
        assert_eq!(second["total"], 1);
        assert_eq!(
            env.queue_events.lock().as_slice(),
            [("b".to_string(), Some((1, 1)))]
        );
    }

    /// 审查 #7：排队中的会话每次再来轮询都把位次再发一遍（前端 chip 的 TTL 续命），
    /// 首次入队不重复发。
    #[tokio::test]
    async fn re_polling_while_queued_refreshes_the_queue_event() {
        let env = RecordingEnv::with(enabled(1));
        let app = app(env.clone(), Duration::from_millis(10));
        post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        let (_, first) = post(&app, "/acquire", Some(TOKEN), acquire("b", false)).await;
        assert_eq!(first["outcome"], "queued");
        assert_eq!(
            env.queue_events.lock().as_slice(),
            [("b".to_string(), Some((1, 1)))],
            "first enqueue emits exactly once"
        );
        let (_, again) = post(&app, "/acquire", Some(TOKEN), acquire("b", false)).await;
        assert_eq!(again["outcome"], "queued");
        assert_eq!(
            env.queue_events.lock().as_slice(),
            [
                ("b".to_string(), Some((1, 1))),
                ("b".to_string(), Some((1, 1)))
            ],
            "re-poll refreshes the same position"
        );
        // 不排队的会话来轮询：没有可刷新的
        post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        assert_eq!(env.queue_events.lock().len(), 2);
    }

    #[tokio::test]
    async fn release_hands_over_slot_clears_queue_event_and_records_exit() {
        let env = RecordingEnv::with(enabled(1));
        let app = app(env.clone(), Duration::from_millis(10));
        let (_, first) = post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        let lease_id = first["leaseId"].as_str().unwrap().to_string();
        post(&app, "/acquire", Some(TOKEN), acquire("b", false)).await;

        let (_, hb) = post(
            &app,
            "/heartbeat",
            Some(TOKEN),
            serde_json::json!({ "leaseId": lease_id }),
        )
        .await;
        assert_eq!(hb["alive"], true);

        let (_, released) = post(
            &app,
            "/release",
            Some(TOKEN),
            serde_json::json!({ "leaseId": lease_id, "exitCode": 7, "durationMs": 1234 }),
        )
        .await;
        assert_eq!(released["released"], true);
        assert_eq!(
            env.released.lock().as_slice(),
            [("a".to_string(), Some(7), Some(1234))]
        );
        // b 不再排队（挂起授予）→ 事件 None
        assert_eq!(
            env.queue_events.lock().last(),
            Some(&("b".to_string(), None))
        );
        let (_, second) = post(&app, "/acquire", Some(TOKEN), acquire("b", false)).await;
        assert_eq!(second["outcome"], "granted");

        // 幂等 / 未知
        let (_, again) = post(
            &app,
            "/release",
            Some(TOKEN),
            serde_json::json!({ "leaseId": lease_id }),
        )
        .await;
        assert_eq!(again["released"], false);
        let (_, hb) = post(
            &app,
            "/heartbeat",
            Some(TOKEN),
            serde_json::json!({ "leaseId": "ghost" }),
        )
        .await;
        assert_eq!(hb["alive"], false);
    }

    #[tokio::test]
    async fn list_returns_snapshot_and_label_overrides_normalized_cmd() {
        let env = RecordingEnv::with(enabled(1));
        let app = app(env.clone(), Duration::from_millis(10));
        post(
            &app,
            "/acquire",
            Some(TOKEN),
            serde_json::json!({ "sessionId": "a", "cmd": "cd x && cargo test -p y", "label": "full test" }),
        )
        .await;
        post(&app, "/acquire", Some(TOKEN), acquire("b", false)).await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["enabled"], true);
        assert_eq!(json["held"][0]["cmdNormalized"], "full test");
        assert_eq!(json["held"][0]["target"], "local");
        assert_eq!(json["queue"][0]["sessionId"], "b");
        assert_eq!(json["queue"][0]["position"], 1);
    }

    #[tokio::test]
    async fn toggling_setting_live_is_honoured_on_next_acquire() {
        let env = RecordingEnv::with(GateConfig::disabled());
        let app = app(env.clone(), Duration::from_millis(10));
        let (_, json) = post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        assert_eq!(json["outcome"], "passthrough");
        *env.config.lock() = enabled(1);
        let (_, json) = post(&app, "/acquire", Some(TOKEN), acquire("a", false)).await;
        assert_eq!(json["outcome"], "granted");
    }
}
