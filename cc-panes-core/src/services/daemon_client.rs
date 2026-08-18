use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::models::TerminalReplaySnapshot;
use crate::models::{
    CreateSessionRequest, StoreCheckpointOutcome, TerminalCheckpoint, TerminalRecoverySnapshot,
    TerminalSessionProvenance,
};
use crate::services::terminal_backend::TerminalAdoptionSnapshot;
use crate::services::terminal_service::KillReason;
use crate::services::terminal_service::SessionOutput;
use crate::services::terminal_service::SessionStatus;
use crate::services::SessionStatusInfo;
use crate::utils::error::AppError;
use crate::utils::AppResult;

/// 控制面短超时：health/status/write/resize 等快操作
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);
/// create_session 长超时：daemon 侧同步执行 WSL 冷启动 + 宿主探活 + 配置迁移 + spawn_pty
const CREATE_SESSION_TIMEOUT: Duration = Duration::from_secs(60);
/// kill 超时：daemon 侧同步跑 taskkill /T /F 杀进程树，系统负载高时会超过 2s
const KILL_SESSION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDaemonManifest {
    pub addr: String,
    pub token: String,
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDaemonStatus {
    pub status: String,
    pub version: String,
    pub pid: u32,
    pub addr: String,
    pub started_at: u64,
    pub session_count: usize,
    /// 桌面控制 WS 客户端数。`None` = 旧 daemon 无此字段（消费方应 fail-closed）。
    #[serde(default)]
    pub desktop_client_count: Option<usize>,
    /// daemon 是否支持写权限租约。`None` = 旧 daemon 无此字段。
    /// 消费方必须把缺失当作**不支持**并禁用自动接管——评审 #11：claim 路由 404
    /// 只保证"调用不报错"，完全没有互斥，把它当已授权会让两个实例同时写同一 PTY。
    #[serde(default)]
    pub claims_supported: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct TerminalDaemonClient {
    addr: String,
    token: String,
    timeout: Duration,
    create_timeout: Duration,
    kill_timeout: Duration,
    /// 本 app 进程的实例身份（docs/61 阶段 2）。随进程生成，重启即换新；
    /// 上个进程残留的租约靠 TTL 自然过期，不需要持久化。
    instance_id: String,
}

/// 进程级实例身份。同一进程内所有 daemon 客户端共享，重启后必然不同。
static APP_INSTANCE_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 本进程的实例 id。用 pid + 启动时刻，重启后不会与上一个进程撞号。
pub fn app_instance_id() -> &'static str {
    APP_INSTANCE_ID.get_or_init(|| {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        format!("app-{pid}-{nanos:x}")
    })
}

#[derive(Debug, Default)]
enum ResponseField<T> {
    #[default]
    Missing,
    Present(Option<T>),
}

impl<'de, T> Deserialize<'de> for ResponseField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self::Present)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionResponse {
    session_id: String,
    #[serde(default)]
    reused_existing: bool,
    #[serde(default)]
    resolved_model_id: ResponseField<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteSessionRequest<'a> {
    data: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitSessionRequest<'a> {
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResizeSessionRequest {
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookStatusRequest {
    status: SessionStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimSessionRequest<'a> {
    app_instance_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindByLaunchResponse {
    session_id: String,
}

impl TerminalDaemonClient {
    pub fn new(addr: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            addr: addr.into(),
            token: token.into(),
            timeout: DEFAULT_TIMEOUT,
            create_timeout: CREATE_SESSION_TIMEOUT,
            kill_timeout: KILL_SESSION_TIMEOUT,
            instance_id: app_instance_id().to_string(),
        }
    }

    /// 覆盖实例身份（测试用；生产走进程级 `app_instance_id()`）。
    pub fn with_instance_id(mut self, instance_id: impl Into<String>) -> Self {
        self.instance_id = instance_id.into();
        self
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_create_timeout(mut self, timeout: Duration) -> Self {
        self.create_timeout = timeout;
        self
    }

    pub fn with_kill_timeout(mut self, timeout: Duration) -> Self {
        self.kill_timeout = timeout;
        self
    }

    pub fn from_manifest(manifest: TerminalDaemonManifest) -> Self {
        Self::new(manifest.addr, manifest.token)
    }

    pub fn from_manifest_path(path: impl AsRef<Path>) -> AppResult<Self> {
        let data = std::fs::read_to_string(path).map_err(AppError::from)?;
        let manifest: TerminalDaemonManifest =
            serde_json::from_str(&data).map_err(|error| AppError::from(error.to_string()))?;
        Ok(Self::from_manifest(manifest))
    }

    pub fn addr(&self) -> &str {
        &self.addr
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn websocket_url(&self, session_id: &str) -> String {
        format!(
            "ws://{}/ws/{}?token={}&instanceId={}",
            self.addr,
            urlencoding::encode(session_id),
            urlencoding::encode(&self.token),
            urlencoding::encode(&self.instance_id)
        )
    }

    /// 客户端存在性控制连接 URL（kind: desktop 计入 desktopClientCount / web 不计入）。
    ///
    /// instanceId 与 per-session WS 用同一个（批3 闸门接线）：daemon 按它把
    /// control 连接上报的 hidden 集合关联到该实例的全部会话订阅。
    pub fn websocket_control_url(&self, kind: &str) -> String {
        format!(
            "ws://{}/ws/control?token={}&kind={}&instanceId={}",
            self.addr,
            urlencoding::encode(&self.token),
            urlencoding::encode(kind),
            urlencoding::encode(&self.instance_id)
        )
    }

    pub fn health(&self) -> AppResult<()> {
        self.get_json::<serde_json::Value>("/api/health", false)
            .map(|_| ())
    }

    pub fn status(&self) -> AppResult<TerminalDaemonStatus> {
        self.get_json("/api/daemon/status", true)
    }

    pub fn shutdown(&self) -> AppResult<()> {
        self.request_empty("POST", "/api/daemon/shutdown", true, None)
    }

    pub fn set_temporary_ssh_password(&self, machine_id: &str, password: &str) -> AppResult<()> {
        self.post_empty(
            "/api/ssh-credentials/temporary",
            true,
            &serde_json::json!({
                "machineId": machine_id,
                "password": password,
            }),
        )
    }

    pub fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        self.create_session_with_outcome(request)
            .map(|outcome| outcome.session_id)
    }

    pub fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<crate::services::CreateSessionOutcome> {
        let expected_session_id = request.expected_saved_session_id.clone();
        let requested_model_id = request.model_id.clone();
        let body =
            serde_json::to_string(&request).map_err(|error| AppError::from(error.to_string()))?;
        let response = self.request_with_timeout(
            "POST",
            "/api/sessions",
            true,
            Some(&body),
            self.create_timeout,
        )?;
        let parsed: CreateSessionResponse = parse_json_response(&response)?;
        Ok(crate::services::CreateSessionOutcome {
            reused_existing: parsed.reused_existing
                || expected_session_id.as_deref() == Some(parsed.session_id.as_str()),
            session_id: parsed.session_id,
            resolved_model_id: match parsed.resolved_model_id {
                ResponseField::Missing => requested_model_id,
                ResponseField::Present(model_id) => model_id,
            },
        })
    }

    pub fn list_sessions(&self) -> AppResult<Vec<SessionStatusInfo>> {
        self.get_json("/api/sessions", true)
    }

    pub fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
        let response = self.request("GET", &session_path(session_id, "/status"), true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        let status =
            serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))?;
        Ok(Some(status))
    }

    /// 探测 daemon 是否支持写权限租约（评审 #11 的 capability 协商）。
    ///
    /// 失败或字段缺失一律返回 `false`（fail-closed）：调用方据此禁用自动接管。
    pub fn claims_supported(&self) -> bool {
        self.status()
            .ok()
            .and_then(|status| status.claims_supported)
            .unwrap_or(false)
    }

    /// 申请或续租会话写权限（docs/61 阶段 2）。
    ///
    /// 返回 `Ok(true)` = 本实例持有；`Ok(false)` = 被别的实例持有（409）或新 daemon
    /// 明确返回 `SESSION_NOT_FOUND`，调用方应退化成只读，**不要重试抢占**。
    ///
    /// 老 daemon 的未知路由通常返回 404（部分实现返回 405），两者都兼容放行；但
    /// **不能**据此认为拿到了互斥——是否真有裁决要看 `claims_supported()`（评审 #11）。
    pub fn claim_session(&self, session_id: &str, ttl_ms: Option<u64>) -> AppResult<bool> {
        let body = serde_json::to_string(&ClaimSessionRequest {
            app_instance_id: &self.instance_id,
            ttl_ms,
        })
        .map_err(|error| AppError::from(error.to_string()))?;
        let response = self.request(
            "POST",
            &session_path(session_id, "/claim"),
            true,
            Some(&body),
        )?;
        let (status, body) = split_http_response(&response)?;
        match status {
            // 409 被他人持有，不该继续写。
            409 => Ok(false),
            // Axum 对未知路由也返回 404。只有新 daemon 的结构化错误码能证明会话
            // 确实不存在；其余 404 按旧 daemon 兼容处理，能力仍由 status 字段裁决。
            404 => {
                let code = serde_json::from_str::<serde_json::Value>(body)
                    .ok()
                    .and_then(|value| value.get("code")?.as_str().map(str::to_string));
                Ok(code.as_deref() != Some("SESSION_NOT_FOUND"))
            }
            // 405 路由不存在（老 daemon）：放行写入，但没有互斥保证。
            405 => Ok(true),
            code if (200..300).contains(&code) => Ok(true),
            code => Err(daemon_http_error(code, body)),
        }
    }

    /// 释放写权限租约。老 daemon 无此路由时静默成功。
    pub fn release_session_claim(&self, session_id: &str) -> AppResult<()> {
        let body = serde_json::to_string(&ClaimSessionRequest {
            app_instance_id: &self.instance_id,
            ttl_ms: None,
        })
        .map_err(|error| AppError::from(error.to_string()))?;
        let response = self.request(
            "DELETE",
            &session_path(session_id, "/claim"),
            true,
            Some(&body),
        )?;
        let (status, body) = split_http_response(&response)?;
        match status {
            404 | 405 | 409 => Ok(()),
            code if (200..300).contains(&code) => Ok(()),
            code => Err(daemon_http_error(code, body)),
        }
    }

    /// 当前所有有效租约：sessionId → ownerInstanceId。老 daemon 返回空表。
    pub fn list_session_claims(&self) -> AppResult<std::collections::HashMap<String, String>> {
        let response = self.request("GET", "/api/sessions/claims", true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 || status == 405 {
            return Ok(std::collections::HashMap::new());
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))
    }

    /// 已捕获的 resume id 身份事件全集，用于补拉 control 通道漏投的部分。
    ///
    /// 端点是后加的：旧 daemon 上必然 404/405，按既有分级原则降级成空列表
    /// （补拉本就是尽力而为的兜底，缺了只是回到没有兜底的状态）。
    pub fn list_identity_events(&self) -> AppResult<Vec<serde_json::Value>> {
        let response = self.request("GET", "/api/sessions/identity", true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 || status == 405 {
            return Ok(Vec::new());
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))?;
        Ok(parsed
            .get("events")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// 认领快照。
    ///
    /// daemon 是跨 app 重启存活的锚点：升级 app 后**旧 daemon 仍在跑**，
    /// 而本端点是后加的，旧 daemon 上必然 404。
    /// 直接把 404/405 当失败会让前端落到兜底文案「无法确认 daemon 会话归属」——
    /// 那是一条没有出路的死胡同，且恰好在版本错配（最需要提示）时触发。
    ///
    /// 按既有分级原则（同文件 `get_session_provenance` 已如此处理）：
    /// 端点**缺失** → 降级成「不支持认领」的空快照，让上层走已经设计好的
    /// `claims-unsupported` 路径（提示可人工接管）；其余错误仍然硬失败。
    pub fn adoption_snapshot(&self) -> AppResult<TerminalAdoptionSnapshot> {
        let response = self.request("GET", "/api/sessions/adoption-snapshot", true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 || status == 405 {
            tracing::warn!(
                status,
                "daemon has no adoption-snapshot endpoint (older binary); \
                 degrading to claims-unsupported instead of blocking restore"
            );
            return Ok(TerminalAdoptionSnapshot {
                claims_supported: false,
                daemon_generation: None,
                owner_instance_id: None,
                captured_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0),
                complete: false,
                sessions: self.list_sessions()?,
                claims: std::collections::HashMap::new(),
                provenance: std::collections::HashMap::new(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))
    }

    pub fn get_session_provenance(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalSessionProvenance>> {
        let response = self.request("GET", &session_path(session_id, "/provenance"), true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 || status == 405 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        serde_json::from_str(body)
            .map(Some)
            .map_err(|error| AppError::from(error.to_string()))
    }

    pub fn write_session(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.post_empty(
            &session_path(session_id, "/write"),
            true,
            &WriteSessionRequest { data },
        )
    }

    pub fn submit_text_to_session(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.post_empty(
            &session_path(session_id, "/submit"),
            true,
            &SubmitSessionRequest { text },
        )
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.post_empty(
            &session_path(session_id, "/resize"),
            true,
            &ResizeSessionRequest { cols, rows },
        )
    }

    pub fn kill_session(&self, session_id: &str) -> AppResult<()> {
        self.kill_session_with_reason(session_id, KillReason::Unknown)
    }

    /// 带来源的 kill。reason 走 query 参数：旧 daemon 忽略未知 query，天然向后兼容。
    pub fn kill_session_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()> {
        let path = format!(
            "{}?reason={}",
            session_path(session_id, ""),
            reason.as_str()
        );
        let response = self.request_with_timeout("DELETE", &path, true, None, self.kill_timeout)?;
        let (status, body) = split_http_response(&response)?;
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        Ok(())
    }

    /// Cancel a launch that may still be inside daemon-side synchronous creation. Older daemons
    /// do not expose the launch endpoint, so fall back to launch-id lookup plus idempotent kill.
    pub fn cancel_launch(&self, launch_id: &str) -> AppResult<()> {
        if launch_id.trim().is_empty() {
            return Ok(());
        }
        let path = format!("/api/launches/{}", urlencoding::encode(launch_id));
        let response = self.request_with_timeout("DELETE", &path, true, None, self.kill_timeout)?;
        let (status, body) = split_http_response(&response)?;
        if (200..300).contains(&status) {
            return Ok(());
        }
        if status == 404 || status == 405 {
            if let Some(session_id) = self.find_session_id_by_launch_id(launch_id)? {
                return self.kill_session_with_reason(&session_id, KillReason::LaunchTimeout);
            }
            return Ok(());
        }
        Err(daemon_http_error(status, body))
    }

    pub fn find_session_id_by_launch_id(&self, launch_id: &str) -> AppResult<Option<String>> {
        if launch_id.trim().is_empty() {
            return Ok(None);
        }
        let path = format!("/api/sessions-by-launch/{}", urlencoding::encode(launch_id));
        let response = self.request("GET", &path, true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        let parsed: FindByLaunchResponse =
            serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))?;
        Ok(Some(parsed.session_id))
    }

    pub fn apply_hook_status(&self, session_id: &str, status: SessionStatus) -> AppResult<()> {
        let body = serde_json::to_string(&HookStatusRequest { status })
            .map_err(|error| AppError::from(error.to_string()))?;
        let response = self.request(
            "POST",
            &session_path(session_id, "/hook-status"),
            true,
            Some(&body),
        )?;
        let (status_code, body) = split_http_response(&response)?;
        // 会话已退出（404）不算错误——状态回写本就是尽力而为。
        if status_code == 404 || (200..300).contains(&status_code) {
            return Ok(());
        }
        Err(daemon_http_error(status_code, body))
    }

    pub fn get_session_output(&self, session_id: &str, lines: usize) -> AppResult<SessionOutput> {
        self.get_json(
            &format!("{}?lines={}", session_path(session_id, "/output"), lines),
            true,
        )
    }

    pub fn get_session_replay_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalReplaySnapshot>> {
        let response = self.request("GET", &session_path(session_id, "/snapshot"), true, None)?;
        let (status, body) = split_http_response(&response)?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        let snapshot =
            serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))?;
        Ok(Some(snapshot))
    }

    /// 读取 checkpoint+delta 结构化恢复快照（M3b-3）。
    ///
    /// 404/405 分级同 upload_checkpoint：结构化 NOT_FOUND = 会话真没了
    /// （返回 Ok(None)，与旧 get_session_replay_snapshot 口径一致）；
    /// 无结构化 code = 旧 daemon 缺路由 → CHECKPOINT_UNSUPPORTED
    /// （调用方回落旧 /snapshot 端点）。
    pub fn get_session_recovery_snapshot(
        &self,
        session_id: &str,
    ) -> AppResult<Option<TerminalRecoverySnapshot>> {
        let response = self.request(
            "GET",
            &session_path(session_id, "/recovery-snapshot"),
            true,
            None,
        )?;
        let (status, body) = split_http_response(&response)?;
        let structured_code = |body: &str| {
            serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| value.get("code")?.as_str().map(str::to_string))
        };
        match status {
            code if (200..300).contains(&code) => {
                let snapshot = serde_json::from_str(body)
                    .map_err(|error| AppError::from(error.to_string()))?;
                Ok(Some(snapshot))
            }
            404 | 405 => {
                if structured_code(body).as_deref() == Some("NOT_FOUND") {
                    Ok(None)
                } else {
                    Err(AppError::coded(
                        "CHECKPOINT_UNSUPPORTED",
                        format!("daemon has no recovery-snapshot endpoint (HTTP {status})"),
                    ))
                }
            }
            code => Err(daemon_http_error(code, body)),
        }
    }

    /// 上传前端拍摄的终端画面照片（M3b-2）。
    ///
    /// - 200 → `Accepted { anchor_seq }`；
    /// - 409 + 结构化拒收 code → 对应 `Rejected*` 变体（拒收是**结果**不是错误，
    ///   幂等重试会拿到 STALE_ANCHOR）；409 的其他 code（如 SESSION_CLAIMED）仍是错误；
    /// - 404/405 无结构化 NOT_FOUND → 旧 daemon 无此路由，返回
    ///   `CHECKPOINT_UNSUPPORTED` 结构化错误（app 侧 capability 探测点，
    ///   首个命中后应关断防探测风暴）。
    pub fn upload_checkpoint(
        &self,
        session_id: &str,
        checkpoint: &TerminalCheckpoint,
    ) -> AppResult<StoreCheckpointOutcome> {
        let body =
            serde_json::to_string(checkpoint).map_err(|error| AppError::from(error.to_string()))?;
        let response = self.request(
            "POST",
            &session_path(session_id, "/checkpoint"),
            true,
            Some(&body),
        )?;
        let (status, body) = split_http_response(&response)?;
        let structured_code = |body: &str| {
            serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| value.get("code")?.as_str().map(str::to_string))
        };
        match status {
            code if (200..300).contains(&code) => {
                let value: serde_json::Value = serde_json::from_str(body)
                    .map_err(|error| AppError::from(error.to_string()))?;
                let anchor_seq = value
                    .get("anchorSeq")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        AppError::from("checkpoint upload response missing anchorSeq")
                    })?;
                Ok(StoreCheckpointOutcome::Accepted { anchor_seq })
            }
            409 => match structured_code(body).as_deref() {
                Some("STALE_ANCHOR") => Ok(StoreCheckpointOutcome::RejectedStaleAnchor),
                Some("ANCHOR_GAP") => Ok(StoreCheckpointOutcome::RejectedAnchorGap),
                Some("FUTURE_ANCHOR") => Ok(StoreCheckpointOutcome::RejectedFutureAnchor),
                Some("EPOCH_MISMATCH") => Ok(StoreCheckpointOutcome::RejectedEpochMismatch),
                Some("TOO_LARGE") => Ok(StoreCheckpointOutcome::RejectedTooLarge),
                // SESSION_CLAIMED 等其他 409：不是拒收裁决，按错误上抛。
                _ => Err(daemon_http_error(status, body)),
            },
            404 | 405 => {
                if structured_code(body).as_deref() == Some("NOT_FOUND") {
                    // 新 daemon 的会话不存在（与旧 daemon 的未知路由区分开）。
                    Err(AppError::NotFound(format!(
                        "session not found for checkpoint upload: {session_id}"
                    )))
                } else {
                    Err(AppError::coded(
                        "CHECKPOINT_UNSUPPORTED",
                        format!("daemon has no checkpoint endpoint (HTTP {status})"),
                    ))
                }
            }
            code => Err(daemon_http_error(code, body)),
        }
    }

    fn get_json<T>(&self, path: &str, authorize: bool) -> AppResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let response = self.request("GET", path, authorize, None)?;
        parse_json_response(&response)
    }

    fn post_empty<B>(&self, path: &str, authorize: bool, body: &B) -> AppResult<()>
    where
        B: Serialize,
    {
        let body =
            serde_json::to_string(body).map_err(|error| AppError::from(error.to_string()))?;
        self.request_empty("POST", path, authorize, Some(&body))
    }

    fn request_empty(
        &self,
        method: &str,
        path: &str,
        authorize: bool,
        body: Option<&str>,
    ) -> AppResult<()> {
        let response = self.request(method, path, authorize, body)?;
        let (status, body) = split_http_response(&response)?;
        if !(200..300).contains(&status) {
            return Err(daemon_http_error(status, body));
        }
        Ok(())
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        authorize: bool,
        body: Option<&str>,
    ) -> AppResult<String> {
        self.request_with_timeout(method, path, authorize, body, self.timeout)
    }

    /// 发起请求，read 阶段使用指定超时（create/kill 等 daemon 侧慢操作需要放宽）。
    /// connect / write 始终用短超时 `self.timeout`——连不上本机 daemon 就该 fail-fast。
    fn request_with_timeout(
        &self,
        method: &str,
        path: &str,
        authorize: bool,
        body: Option<&str>,
        read_timeout: Duration,
    ) -> AppResult<String> {
        let addr: SocketAddr = self
            .addr
            .parse()
            .map_err(|error| AppError::from(format!("invalid daemon addr: {error}")))?;
        let mut stream = TcpStream::connect_timeout(&addr, self.timeout).map_err(AppError::from)?;
        stream
            .set_read_timeout(Some(read_timeout))
            .map_err(AppError::from)?;
        stream
            .set_write_timeout(Some(self.timeout))
            .map_err(AppError::from)?;

        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n",
            self.addr
        );
        if authorize {
            request.push_str(&format!("Authorization: Bearer {}\r\n", self.token));
            // 声明实例身份，供 daemon 的写权限租约裁决（docs/61 阶段 2）。
            // 老 daemon 忽略这个头；新 daemon 在无租约时也放行，双向兼容。
            request.push_str(&format!("X-CC-Panes-Instance: {}\r\n", self.instance_id));
        }
        if let Some(body) = body {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        if let Some(body) = body {
            request.push_str(body);
        }

        stream
            .write_all(request.as_bytes())
            .map_err(AppError::from)?;
        let response = read_http_response(stream)?;
        Ok(response)
    }
}

fn session_path(session_id: &str, suffix: &str) -> String {
    format!(
        "/api/sessions/{}{}",
        urlencoding::encode(session_id),
        suffix
    )
}

fn read_http_response(mut stream: TcpStream) -> AppResult<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
                    && !bytes.is_empty() =>
            {
                break;
            }
            Err(error) => return Err(AppError::from(error)),
        }
    }
    String::from_utf8(bytes).map_err(|error| AppError::from(error.to_string()))
}

fn parse_json_response<T>(response: &str) -> AppResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let (status, body) = split_http_response(response)?;
    if !(200..300).contains(&status) {
        return Err(daemon_http_error(status, body));
    }
    serde_json::from_str(body).map_err(|error| AppError::from(error.to_string()))
}

/// daemon 因反序列化失败拒收请求（枚举新增变体但 daemon 二进制没重建）。
///
/// axum 对 body 反序列化失败返回 422，serde 的错误文本里带 `unknown variant`。
/// 这条在 CLI 工具（`CliTool`）新增变体时必踩：`tauri dev` **不重建** daemon，
/// `binaries/` 里躺着的是历史构建，新变体在 daemon 侧是未知枚举值。
/// 原始报错只有一句 `HTTP 422: ...unknown variant`，看不出该去重建什么。
///
/// **有意不收窄到 `cliTool`**：本函数服务所有 daemon 请求，评审曾建议加上
/// "错误文本必须同时提到 cliTool" 以免误报。但 unknown variant 型 422 的成因
/// 只有一个——app 发出了 daemon 的 serde 枚举不认识的值，即 daemon 比 app 旧。
/// 这对 `LaunchRuntime`、`TerminalBufferMode` 等任何枚举都成立，给出的修复动作
/// 也完全相同。收窄到 cliTool 反而会让这个守卫在下一个新增枚举上失效，
/// 而那正是它存在的意义。故提示语只说"枚举值"，不指名 CLI。
fn stale_daemon_hint(status: u16, body: &str) -> Option<String> {
    if status != 422 || !body.contains("unknown variant") {
        return None;
    }
    // 修复指引按构建环境区分：dev 下 daemon 是手工拷进 binaries/ 的，重建即可；
    // 安装版的 daemon 随安装包分发，用户侧的正解是升级应用而不是自己编译。
    let remedy = if cfg!(debug_assertions) {
        "需 `cargo build -p cc-panes-daemon` 并把新 exe 拷到 <target-dir>/debug/binaries/，\
         再杀掉旧 daemon 重启。注意 `tauri dev` 不会重建 external binaries。"
    } else {
        "请退出应用（含托盘）让 daemon 一并退出后重新启动；若仍复现，说明安装包内的 \
         daemon 与主程序版本不一致，需要重新安装/升级。"
    };
    Some(format!(
        "daemon 二进制过旧，无法识别本次请求中的枚举值（{body}）。{remedy}"
    ))
}

fn daemon_http_error(status: u16, body: &str) -> AppError {
    if let Some(hint) = stale_daemon_hint(status, body) {
        return AppError::coded("DAEMON_BINARY_STALE", hint);
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let code = value.get("code").and_then(serde_json::Value::as_str);
        let message = value.get("message").and_then(serde_json::Value::as_str);
        if let (Some(code), Some(message)) = (code, message) {
            let params = value
                .get("params")
                .and_then(serde_json::Value::as_object)
                .map(|params| {
                    params
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                });
            return match params {
                Some(params) => AppError::coded_with_params(code, message, params),
                None => AppError::coded(code, message),
            };
        }
    }
    AppError::from(format!("daemon request failed with HTTP {status}: {body}"))
}

fn split_http_response(response: &str) -> AppResult<(u16, &str)> {
    let (head, body): (&str, &str) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| AppError::from("invalid daemon HTTP response"))?;
    let status_line = head
        .lines()
        .next()
        .ok_or_else(|| AppError::from("missing daemon HTTP status line"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| AppError::from("missing daemon HTTP status code"))?
        .parse::<u16>()
        .map_err(|error| AppError::from(format!("invalid daemon HTTP status code: {error}")))?;
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    use crate::models::CliTool;
    use crate::models::TerminalBufferMode;
    use crate::services::terminal_service::SessionStatus;

    use super::*;

    fn http_json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn empty_response(status: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n")
    }

    fn spawn_response_server(response: String) -> (SocketAddr, mpsc::Receiver<String>) {
        spawn_response_server_with_delay(response, Duration::ZERO)
    }

    /// 读完请求后先 sleep 再写响应，用于模拟 daemon 侧慢操作。
    fn spawn_response_server_with_delay(
        response: String,
        delay: Duration,
    ) -> (SocketAddr, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            let mut request_bytes = Vec::new();
            let mut chunk = [0_u8; 1024];
            let mut header_end = None;
            while header_end.is_none() {
                let n = stream.read(&mut chunk).expect("read request");
                if n == 0 {
                    break;
                }
                request_bytes.extend_from_slice(&chunk[..n]);
                header_end = request_bytes
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4);
            }
            if let Some(header_end) = header_end {
                let headers = String::from_utf8_lossy(&request_bytes[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                let body_read = request_bytes.len().saturating_sub(header_end);
                let mut remaining = content_length.saturating_sub(body_read);
                while remaining > 0 {
                    let n = stream.read(&mut chunk).expect("read request body");
                    if n == 0 {
                        break;
                    }
                    request_bytes.extend_from_slice(&chunk[..n]);
                    remaining = remaining.saturating_sub(n);
                }
            }
            let request = String::from_utf8(request_bytes).expect("utf8 request");
            tx.send(request).ok();
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        (addr, rx)
    }

    fn test_create_request() -> CreateSessionRequest {
        CreateSessionRequest {
            launch_id: Some("launch-1".to_string()),
            project_path: "/repo".to_string(),
            cols: 100,
            rows: 40,
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
            initial_prompt: Some("inspect".to_string()),
            yolo_mode: None,
            adapter_options: None,
            extra_env: None,
            ssh: None,
            wsl: None,
        }
    }

    #[test]
    fn reads_daemon_client_from_manifest_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let manifest_path = dir.path().join("daemon-manifest.json");
        std::fs::write(
            &manifest_path,
            r#"{"addr":"127.0.0.1:1234","token":"abc","pid":42,"startedAt":100}"#,
        )
        .expect("write manifest");

        let client = TerminalDaemonClient::from_manifest_path(&manifest_path).expect("client");

        assert_eq!(client.addr, "127.0.0.1:1234");
        assert_eq!(client.token, "abc");
    }

    #[test]
    fn websocket_url_encodes_session_token_and_instance() {
        let client = TerminalDaemonClient::new("127.0.0.1:1234", "a b").with_instance_id("inst a");

        assert_eq!(
            client.websocket_url("session/1"),
            "ws://127.0.0.1:1234/ws/session%2F1?token=a%20b&instanceId=inst%20a"
        );
    }

    #[test]
    fn sends_temporary_ssh_password_to_daemon() {
        let response = http_json_response("204 No Content", "");
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        client
            .set_temporary_ssh_password("machine-1", "temporary-secret")
            .expect("temporary password accepted");

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/ssh-credentials/temporary "));
        assert!(request.contains("Authorization: Bearer secret"));
        assert!(request.contains("\"machineId\":\"machine-1\""));
        assert!(request.contains("\"password\":\"temporary-secret\""));
    }

    // ===== checkpoint 上传（M3b-2）=====

    fn test_checkpoint_payload() -> TerminalCheckpoint {
        TerminalCheckpoint {
            checkpoint_epoch: 7,
            anchor_seq: 5,
            snapshot_ansi: "PHOTO".to_string(),
            buffer_mode: TerminalBufferMode::Normal,
            cols: 80,
            rows: 24,
            checkpointed_at_ms: 1,
        }
    }

    #[test]
    fn upload_checkpoint_maps_accepted_response() {
        let response = http_json_response("200 OK", r#"{"accepted":true,"anchorSeq":5}"#);
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let outcome = client
            .upload_checkpoint("s1", &test_checkpoint_payload())
            .expect("upload outcome");
        assert_eq!(outcome, StoreCheckpointOutcome::Accepted { anchor_seq: 5 });

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/s1/checkpoint "));
        assert!(request.contains("\"anchorSeq\":5"));
    }

    #[test]
    fn upload_checkpoint_maps_structured_409_to_rejection_not_error() {
        let response = http_json_response("409 Conflict", r#"{"code":"STALE_ANCHOR"}"#);
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let outcome = client
            .upload_checkpoint("s1", &test_checkpoint_payload())
            .expect("rejection is an outcome, not an error");
        assert_eq!(outcome, StoreCheckpointOutcome::RejectedStaleAnchor);
    }

    /// SESSION_CLAIMED 等其他 409 不是拒收裁决：必须按错误上抛，不能被
    /// 误映射成 stale（只读镜像会以为「照片只是旧了」而继续重拍）。
    #[test]
    fn upload_checkpoint_keeps_claim_conflict_as_error() {
        let response = http_json_response(
            "409 Conflict",
            r#"{"code":"SESSION_CLAIMED","message":"held","owner":"inst-b"}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let error = client
            .upload_checkpoint("s1", &test_checkpoint_payload())
            .expect_err("claim conflict must stay an error");
        assert_eq!(error.code(), Some("SESSION_CLAIMED"));
    }

    /// 旧 daemon 无此路由：错误必须可区分（capability 探测点，前端首个命中后关断）。
    #[test]
    fn upload_checkpoint_flags_missing_route_as_unsupported() {
        let response = http_json_response("404 Not Found", r#"{"message":"no route"}"#);
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let error = client
            .upload_checkpoint("s1", &test_checkpoint_payload())
            .expect_err("missing route must error");
        assert_eq!(error.code(), Some("CHECKPOINT_UNSUPPORTED"));
    }

    /// 新 daemon 的结构化 NOT_FOUND = 会话真不存在，与旧 daemon 缺路由区分开。
    #[test]
    fn upload_checkpoint_distinguishes_session_not_found_from_missing_route() {
        let response = http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let error = client
            .upload_checkpoint("s1", &test_checkpoint_payload())
            .expect_err("missing session must error");
        assert!(matches!(error, AppError::NotFound(_)));
    }

    // ===== recovery-snapshot 读链（M3b-3）=====
    //
    // 分级与 upload 侧同款：结构化 NOT_FOUND = 会话真没了（Ok(None)，正常事件）；
    // 无 code 的 404/405 = 旧 daemon 缺路由（CHECKPOINT_UNSUPPORTED，能力关断）。
    // 两者搞混的后果不对称——把「会话没了」错判成「能力不支持」会让 app 对
    // **所有**会话永久关掉 checkpoint 恢复，退回全量重放。

    #[test]
    fn recovery_snapshot_parses_checkpoint_and_delta() {
        let response = http_json_response(
            "200 OK",
            r#"{"checkpoint":{"checkpointEpoch":7,"anchorSeq":5,"snapshotAnsi":"PHOTO","bufferMode":"normal","cols":80,"rows":24,"checkpointedAtMs":1},"delta":"TAIL","bufferMode":"normal","endSeq":9,"checkpointEpoch":7}"#,
        );
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let snapshot = client
            .get_session_recovery_snapshot("s1")
            .expect("recovery snapshot")
            .expect("present snapshot");

        let checkpoint = snapshot.checkpoint.expect("checkpoint present");
        assert_eq!(checkpoint.snapshot_ansi, "PHOTO");
        assert_eq!(checkpoint.anchor_seq, 5);
        assert_eq!(snapshot.delta, "TAIL");
        assert_eq!(snapshot.end_seq, 9);
        assert_eq!(snapshot.checkpoint_epoch, 7);

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("GET /api/sessions/s1/recovery-snapshot "));
    }

    /// 无照片的会话：checkpoint 缺省为 null，delta 是全窗口——消费方只有一个形状。
    #[test]
    fn recovery_snapshot_tolerates_absent_checkpoint() {
        let response = http_json_response(
            "200 OK",
            r#"{"delta":"FULL","bufferMode":"normal","endSeq":3,"checkpointEpoch":0}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let snapshot = client
            .get_session_recovery_snapshot("s1")
            .expect("recovery snapshot")
            .expect("present snapshot");

        assert!(snapshot.checkpoint.is_none());
        assert_eq!(snapshot.delta, "FULL");
    }

    #[test]
    fn recovery_snapshot_structured_not_found_is_ok_none() {
        let response = http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        assert!(client
            .get_session_recovery_snapshot("gone")
            .expect("missing session is not an error")
            .is_none());
    }

    #[test]
    fn recovery_snapshot_bare_404_flags_missing_route_as_unsupported() {
        let response = http_json_response("404 Not Found", r#"{"message":"no route"}"#);
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let error = client
            .get_session_recovery_snapshot("s1")
            .expect_err("missing route must error");
        assert_eq!(error.code(), Some("CHECKPOINT_UNSUPPORTED"));
    }

    /// 旧 daemon 也可能把未知路由回成 405（路由表里有路径、没这个方法）。
    #[test]
    fn recovery_snapshot_405_flags_missing_route_as_unsupported() {
        let response = http_json_response("405 Method Not Allowed", r#"{"message":"nope"}"#);
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let error = client
            .get_session_recovery_snapshot("s1")
            .expect_err("missing route must error");
        assert_eq!(error.code(), Some("CHECKPOINT_UNSUPPORTED"));
    }

    // ===== 写权限租约（docs/61 阶段 2）=====

    #[test]
    fn authorized_requests_declare_instance_identity() {
        let response = http_json_response("204 No Content", "");
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_instance_id("inst-a")
            .with_timeout(Duration::from_secs(1));

        let _ = client.write_session("s1", "hi");

        let request = rx.recv().expect("captured request");
        assert!(request.contains("X-CC-Panes-Instance: inst-a"));
    }

    #[test]
    fn claim_returns_false_when_held_by_another_instance() {
        let response = http_json_response(
            "409 Conflict",
            r#"{"code":"SESSION_CLAIMED","owner":"inst-b"}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_instance_id("inst-a")
            .with_timeout(Duration::from_secs(1));

        assert!(!client.claim_session("s1", None).expect("claim result"));
    }

    /// 老 daemon 没有 claim 路由。拒绝写入只会让功能倒退，所以 404 视为"允许"。
    #[test]
    fn claim_treats_missing_route_as_granted() {
        let response = http_json_response("404 Not Found", r#"{"code":"NOT_FOUND"}"#);
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_instance_id("inst-a")
            .with_timeout(Duration::from_secs(1));

        assert!(client.claim_session("s1", None).expect("claim result"));
    }

    #[test]
    fn claim_returns_false_when_new_daemon_reports_missing_session() {
        let response = http_json_response(
            "404 Not Found",
            r#"{"code":"SESSION_NOT_FOUND","message":"session does not exist"}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_instance_id("inst-a")
            .with_timeout(Duration::from_secs(1));

        assert!(!client.claim_session("s1", None).expect("claim result"));
    }

    #[test]
    fn claim_sends_instance_id_and_ttl() {
        let response = http_json_response(
            "200 OK",
            r#"{"sessionId":"s1","owner":"inst-a","granted":true}"#,
        );
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_instance_id("inst-a")
            .with_timeout(Duration::from_secs(1));

        assert!(client.claim_session("s1", Some(45_000)).expect("claim"));

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/s1/claim HTTP/1.1"));
        assert!(request.contains(r#""appInstanceId":"inst-a""#));
        assert!(request.contains(r#""ttlMs":45000"#));
    }

    #[test]
    fn app_instance_id_is_stable_within_process() {
        assert_eq!(app_instance_id(), app_instance_id());
        assert!(app_instance_id().starts_with("app-"));
    }

    #[test]
    fn status_sends_bearer_token_and_parses_response() {
        let body = r#"{"status":"ok","version":"0.1.0","pid":7,"addr":"127.0.0.1:1","startedAt":10,"sessionCount":0}"#;
        let response = http_json_response("200 OK", body);
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let status = client.status().expect("daemon status");

        assert_eq!(status.status, "ok");
        assert_eq!(status.pid, 7);
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("GET /api/daemon/status HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer secret"));
    }

    #[test]
    fn health_does_not_send_bearer_token() {
        let response = http_json_response("200 OK", r#"{"status":"ok"}"#);
        let (addr, rx) = spawn_response_server(response.to_string());
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        client.health().expect("daemon health");

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("GET /api/health HTTP/1.1"));
        assert!(!request.contains("Authorization: Bearer"));
    }

    #[test]
    fn non_success_status_returns_error() {
        let response =
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n{\"code\":\"UNAUTHORIZED\"}";
        let result: AppResult<TerminalDaemonStatus> = parse_json_response(response);

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("HTTP 401"));
    }

    #[test]
    fn stale_daemon_hint_only_fires_on_unknown_variant_422() {
        let body = r#"{"error":"Failed to deserialize the JSON body into the target type: cliTool: unknown variant `deepseek`"}"#;
        let hint = stale_daemon_hint(422, body).expect("422 + unknown variant should hint");
        assert!(hint.contains("daemon 二进制过旧"));
        // 修复指引按构建环境分叉；测试跑在 debug 下走重建分支
        #[cfg(debug_assertions)]
        assert!(hint.contains("cargo build -p cc-panes-daemon"));
        #[cfg(not(debug_assertions))]
        assert!(hint.contains("重新安装"));

        // 非 CLI 的枚举同样命中——这是有意的，成因与修复动作完全一致
        assert!(
            stale_daemon_hint(422, r#"{"error":"runtimeKind: unknown variant `podman`"}"#)
                .is_some()
        );

        // 其它 422（字段缺失等）不该被误报成二进制过旧
        assert!(stale_daemon_hint(422, r#"{"error":"missing field `cols`"}"#).is_none());
        // 其它状态码即使含同样文本也不命中
        assert!(stale_daemon_hint(400, body).is_none());
    }

    #[test]
    fn daemon_http_error_surfaces_stale_binary_code() {
        let error = daemon_http_error(
            422,
            r#"{"error":"cliTool: unknown variant `deepseek`, expected one of ..."#,
        );
        assert!(error.to_string().contains("daemon 二进制过旧"));
    }

    #[test]
    fn create_session_posts_json_body_and_parses_session_id() {
        let response = http_json_response("201 Created", r#"{"sessionId":"session-1"}"#);
        let (addr, rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let session_id = client
            .create_session(test_create_request())
            .expect("create session");

        assert_eq!(session_id, "session-1");
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer secret"));
        assert!(request.contains("Content-Type: application/json"));
        assert!(request.contains(r#""projectPath":"/repo""#));
        assert!(request.contains(r#""initialPrompt":"inspect""#));
    }

    #[test]
    fn create_session_reports_daemon_reuse_of_a_replacement_session() {
        let response = http_json_response(
            "201 Created",
            r#"{"sessionId":"replacement-1","reusedExisting":true}"#,
        );
        let (addr, _rx) = spawn_response_server(response);
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let mut request = test_create_request();
        request.expected_saved_session_id = Some("missing-session".to_string());

        let outcome = client
            .create_session_with_outcome(request)
            .expect("create session outcome");

        assert_eq!(outcome.session_id, "replacement-1");
        assert!(outcome.reused_existing);
    }

    #[test]
    fn create_session_distinguishes_missing_and_explicit_null_resolved_model() {
        let mut request = test_create_request();
        request.model_id = Some("requested-model".to_string());
        let response = http_json_response("201 Created", r#"{"sessionId":"legacy"}"#);
        let (addr, _) = spawn_response_server(response);
        let legacy = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1))
            .create_session_with_outcome(request.clone())
            .expect("legacy response");
        assert_eq!(legacy.resolved_model_id.as_deref(), Some("requested-model"));

        let response = http_json_response(
            "201 Created",
            r#"{"sessionId":"native","resolvedModelId":null}"#,
        );
        let (addr, _) = spawn_response_server(response);
        let native = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1))
            .create_session_with_outcome(request)
            .expect("explicit null response");
        assert_eq!(native.resolved_model_id, None);
    }

    #[test]
    fn create_session_survives_slow_daemon_response() {
        let response = http_json_response("201 Created", r#"{"sessionId":"session-slow"}"#);
        let (addr, _rx) = spawn_response_server_with_delay(response, Duration::from_millis(600));
        // 短超时 200ms 但 create 走独立的 5s 长超时，慢响应不该被掐断
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_millis(200))
            .with_create_timeout(Duration::from_secs(5));

        let session_id = client
            .create_session(test_create_request())
            .expect("create session survives slow response");

        assert_eq!(session_id, "session-slow");
    }

    #[test]
    fn kill_survives_slow_daemon_response() {
        let response = empty_response("204 No Content");
        let (addr, _rx) = spawn_response_server_with_delay(response, Duration::from_millis(600));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_millis(200))
            .with_kill_timeout(Duration::from_secs(5));

        client
            .kill_session("session-1")
            .expect("kill survives slow response");
    }

    #[test]
    fn health_still_times_out_fast() {
        let response = http_json_response("200 OK", r#"{"status":"ok"}"#);
        let (addr, _rx) = spawn_response_server_with_delay(response, Duration::from_millis(600));
        // health 走短超时：慢 daemon 必须 fail-fast，不能被 create 的长超时污染
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_millis(200))
            .with_create_timeout(Duration::from_secs(5));

        assert!(client.health().is_err());
    }

    #[test]
    fn write_submit_resize_and_kill_use_rest_paths() {
        type RestCase = (
            Box<dyn FnOnce(TerminalDaemonClient) -> AppResult<()>>,
            &'static str,
            &'static str,
        );
        let cases: Vec<RestCase> = vec![
            (
                Box::new(|client| client.write_session("session A", "abc")),
                "POST /api/sessions/session%20A/write HTTP/1.1",
                r#""data":"abc""#,
            ),
            (
                Box::new(|client| client.submit_text_to_session("session-1", "run")),
                "POST /api/sessions/session-1/submit HTTP/1.1",
                r#""text":"run""#,
            ),
            (
                Box::new(|client| client.resize_session("session-1", 120, 32)),
                "POST /api/sessions/session-1/resize HTTP/1.1",
                r#""cols":120"#,
            ),
            (
                Box::new(|client| client.kill_session("session-1")),
                "DELETE /api/sessions/session-1?reason=unknown HTTP/1.1",
                "",
            ),
            (
                Box::new(|client| {
                    client.kill_session_with_reason("session-1", KillReason::OrphanReclaim)
                }),
                "DELETE /api/sessions/session-1?reason=orphan-reclaim HTTP/1.1",
                "",
            ),
        ];

        for (operation, expected_start, expected_body) in cases {
            let (addr, rx) = spawn_response_server(empty_response("204 No Content"));
            let client = TerminalDaemonClient::new(addr.to_string(), "secret")
                .with_timeout(Duration::from_secs(1));

            operation(client).expect("operation");

            let request = rx.recv().expect("captured request");
            assert!(request.starts_with(expected_start), "{request}");
            assert!(request.contains("Authorization: Bearer secret"));
            if !expected_body.is_empty() {
                assert!(request.contains(expected_body), "{request}");
            }
        }
    }

    #[test]
    fn list_status_output_and_snapshot_parse_terminal_payloads() {
        let status_body = r#"[{"sessionId":"session-1","status":"idle","lastOutputAt":10,"pid":42,"updatedAt":20}]"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", status_body));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let sessions = client.list_sessions().expect("list sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, SessionStatus::Idle);

        let status_body = r#"{"sessionId":"session-1","status":"exited","lastOutputAt":10,"pid":42,"exitCode":7,"updatedAt":20}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", status_body));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let status = client
            .get_session_status("session-1")
            .expect("session status")
            .expect("status exists");
        assert_eq!(status.status, SessionStatus::Exited);
        assert_eq!(status.exit_code, Some(7));

        let output_body = r#"{"sessionId":"session-1","lines":["ready"]}"#;
        let (addr, rx) = spawn_response_server(http_json_response("200 OK", output_body));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let output = client
            .get_session_output("session-1", 50)
            .expect("session output");
        assert_eq!(output.lines, vec!["ready"]);
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("GET /api/sessions/session-1/output?lines=50 HTTP/1.1"));

        let snapshot_body = r#"{"data":"\u001b[2J","bufferMode":"normal"}"#;
        let (addr, _) = spawn_response_server(http_json_response("200 OK", snapshot_body));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let snapshot = client
            .get_session_replay_snapshot("session-1")
            .expect("snapshot")
            .expect("some snapshot");
        assert_eq!(snapshot.buffer_mode, TerminalBufferMode::Normal);
    }

    #[test]
    fn find_session_id_by_launch_id_parses_and_maps_404_to_none() {
        // 命中：返回 sessionId。
        let (addr, rx) =
            spawn_response_server(http_json_response("200 OK", r#"{"sessionId":"sess-9"}"#));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        let found = client
            .find_session_id_by_launch_id("launch-9")
            .expect("lookup");
        assert_eq!(found, Some("sess-9".to_string()));
        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("GET /api/sessions-by-launch/launch-9 HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer secret"));

        // 未命中：404 → None，非错误。
        let (addr, _) = spawn_response_server(http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND"}"#,
        ));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        assert_eq!(
            client
                .find_session_id_by_launch_id("missing")
                .expect("lookup"),
            None
        );

        // 空 launch_id 直接 None，不发请求。
        let client = TerminalDaemonClient::new("127.0.0.1:1", "secret");
        assert_eq!(
            client.find_session_id_by_launch_id("  ").expect("lookup"),
            None
        );
    }

    #[test]
    fn apply_hook_status_posts_status_and_tolerates_404() {
        let (addr, rx) = spawn_response_server(empty_response("204 No Content"));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        client
            .apply_hook_status("sess-1", SessionStatus::ToolRunning)
            .expect("apply status");

        let request = rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sessions/sess-1/hook-status HTTP/1.1"));
        assert!(request.contains("Authorization: Bearer secret"));
        assert!(request.contains(r#""status":"toolRunning""#));

        // 会话已退出 → 404，仍视作成功（尽力而为）。
        let (addr, _) = spawn_response_server(http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND"}"#,
        ));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));
        client
            .apply_hook_status("gone", SessionStatus::Idle)
            .expect("404 tolerated");
    }

    #[test]
    fn missing_snapshot_maps_to_none() {
        let (addr, _) = spawn_response_server(http_json_response(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"Session not found"}"#,
        ));
        let client = TerminalDaemonClient::new(addr.to_string(), "secret")
            .with_timeout(Duration::from_secs(1));

        let snapshot = client
            .get_session_replay_snapshot("missing")
            .expect("snapshot result");

        assert!(snapshot.is_none());
    }
}
