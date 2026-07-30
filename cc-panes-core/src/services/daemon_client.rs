use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::models::TerminalReplaySnapshot;
use crate::models::{CreateSessionRequest, TerminalSessionProvenance};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionResponse {
    session_id: String,
    #[serde(default)]
    reused_existing: bool,
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

    /// 客户端存在性控制连接 URL（kind: desktop 计入 desktopClientCount / web 不计入）
    pub fn websocket_control_url(&self, kind: &str) -> String {
        format!(
            "ws://{}/ws/control?token={}&kind={}",
            self.addr,
            urlencoding::encode(&self.token),
            urlencoding::encode(kind)
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

    pub fn create_session(&self, request: CreateSessionRequest) -> AppResult<String> {
        self.create_session_with_outcome(request)
            .map(|outcome| outcome.session_id)
    }

    pub fn create_session_with_outcome(
        &self,
        request: CreateSessionRequest,
    ) -> AppResult<crate::services::CreateSessionOutcome> {
        let expected_session_id = request.expected_saved_session_id.clone();
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

fn daemon_http_error(status: u16, body: &str) -> AppError {
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
        let cases: Vec<(
            Box<dyn FnOnce(TerminalDaemonClient) -> AppResult<()>>,
            &str,
            &str,
        )> = vec![
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
