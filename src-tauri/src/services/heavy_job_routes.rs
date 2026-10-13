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
use cc_panes_core::services::heavy_job_gate::{
    AcquireOutcome, AcquireRequest, GateConfig, HeavyJobGate, Lease, QueuePositions,
};
use parking_lot::Mutex;
use serde::Deserialize;
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

/// 真实环境：设置 → 配置；拿槽下发 lower_priority；归还回填台账；位次发 Tauri 事件。
pub struct AppHeavyJobEnvironment {
    settings: Arc<cc_panes_core::services::SettingsService>,
    terminal_backend: Arc<crate::services::TerminalBackendState>,
    ledger: Arc<cc_panes_core::repository::HeavyCommandsRepository>,
    emitter: Arc<dyn cc_panes_core::events::EventEmitter>,
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
        // 让路：BELOW_NORMAL（Windows Job）/ nice。EcoQoS 不在这里开——门禁只保证总量，
        // 效率模式是用户在资源管理器里的显式选择。daemon 后端是一次 HTTP，放 blocking 线程。
        let backend = self.terminal_backend.backend();
        let session_id = lease.session_id.clone();
        tokio::task::spawn_blocking(move || {
            let policy = cc_panes_core::models::SessionResourcePolicy {
                lower_priority: true,
                cpu_weight: None,
                eco_qos: false,
                memory_notify_bytes: None,
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
        // 台账行由 hook 记录器写（时长 / 退出码已在那边），这里只回填 target / 原因。
        let ledger = self.ledger.clone();
        let session_id = lease.session_id.clone();
        let cmd = lease.cmd_normalized.clone();
        let target = lease.target.as_str();
        let reason = lease.forced.then_some(FORCED_REASON);
        tokio::task::spawn_blocking(move || {
            if let Err(error) = ledger.mark_target(&session_id, &cmd, target, reason) {
                debug!(%error, "[heavy-gate] ledger mark_target failed (best effort)");
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
